import { isReplicaRowAlive } from '@/libs/replicaInterpret';
import type { ReplicaRow } from '@/types/replica';
import type { ReplicaAdapter } from './replicaRegistry';
import {
  captureCipherTexts,
  cipherTextsChanged,
  collectDecryptSuccess,
  decryptRowFields,
  firstCipherEnvelope,
  type DecryptRowHooks,
} from './replicaCryptoMiddleware';
import { ensurePassphraseUnlocked, rememberVerificationSample } from './passphraseGate';
import { isCredentialsSyncEnabled } from './syncCategories';
import { cryptoSession } from '@/libs/crypto/session';

export interface ReplicaLocalRecord {
  name: string;
  deletedAt?: number;
  /**
   * Per-field cipher fingerprint of the last successfully-decrypted
   * pull. Used to skip the passphrase prompt when nothing's changed
   * since last apply. See replicaCryptoMiddleware.captureCipherTexts.
   */
  lastSeenCipher?: Record<string, string>;
}

export interface PullAndApplyDeps<T extends ReplicaLocalRecord> {
  /** Replica adapter for this kind. Provides unpackRow. */
  adapter: ReplicaAdapter<T>;
  /** Pulls rows for this kind. Boot caller passes since=null for full sync. */
  pull(): Promise<ReplicaRow[]>;
  /** Looks up an existing local record by its cross-device contentId. */
  findByContentId(contentId: string): T | undefined;
  /** Adds a remote-sourced record to the local store WITHOUT republishing. */
  applyRemote(record: T): void;
  /**
   * Tombstones the local entry whose contentId matches. Implementer
   * looks up by contentId and removes it from the local store, but
   * skips re-publishing the tombstone — the row is already tombstoned
   * server-side; we just observed that fact.
   */
  softDeleteByContentId(contentId: string): void;
  /**
   * Hydrates the local store from disk before the orchestrator queries
   * findByContentId. Without this, applyRemote's auto-persist round-
   * trip overwrites persisted entries that hadn't yet been pulled into
   * the in-memory store by a feature mount.
   */
  hydrateLocalStore?(): Promise<void>;
  /**
   * Optional auth precheck. When provided and resolves to false, the
   * orchestrator skips the entire pull (no network call, no warnings).
   */
  isAuthenticated?(): Promise<boolean>;
  /**
   * When true, encrypted-field cipher payloads are decrypted
   * best-effort but the orchestrator NEVER triggers the passphrase
   * gate for this kind. Cipher fields silently drop when the session
   * is locked, leaving the local copy intact. Use for kinds where
   * spam-prompting on every pull would be jarring (e.g., the bundled
   * `settings` row, which pulls on every library mount). The user
   * unlocks via an explicit Settings → Sync action; the next pull
   * cycle then decrypts cleanly.
   */
  silentDecrypt?: boolean;
  /**
   * Called when one or more cipher fields failed to decrypt because
   * the cipher's `saltId` no longer exists in `replica_keys` (orphan
   * after an out-of-band server reset). Adapters that persist a
   * "previously published" fingerprint per encrypted path should
   * clear it so the next save re-encrypts the still-locally-held
   * plaintext under the current salt — overwriting the orphan
   * cipher on the server. No-op when the kind has no such fingerprint
   * to invalidate.
   */
  onSaltNotFound?(paths: readonly string[]): void;
}

const applyRow = async <T extends ReplicaLocalRecord>(
  row: ReplicaRow,
  deps: PullAndApplyDeps<T>,
): Promise<void> => {
  const local = deps.findByContentId(row.replica_id);

  // Decrypt encrypted-field cipher payloads in place so unpackRow sees
  // plaintext. The prompt-decision heuristic compares the row's
  // incoming ciphers against the local record's last-seen-cipher
  // fingerprint:
  //   * fingerprint matches → we already have the plaintext for this
  //     exact ciphertext; skip the prompt + decrypt entirely
  //   * fingerprint differs (or local has no fingerprint yet) AND
  //     session is locked → prompt the gate so we can decrypt the new
  //     value (covers fresh device + password rotation on Device A)
  //   * session already unlocked → just decrypt; no prompt
  // Cancel / failure leaves the field absent; the store's applyRemote
  // merge preserves any local plaintext copy.
  const encryptedFields = deps.adapter.encryptedFields;
  // Credentials meta-toggle (default OFF): when the user hasn't opted
  // in, every cipher payload in this row's encrypted slots gets stripped
  // before we even capture the cipher fingerprint. The decrypt loop
  // sees nothing, the prompt never fires, and the adapter unpacks
  // without the credential fields. The store's applyRemote merge keeps
  // any local plaintext copy intact (same code path as the locked-
  // session case).
  if (encryptedFields && encryptedFields.length > 0 && !isCredentialsSyncEnabled()) {
    for (const field of encryptedFields) {
      delete row.fields_jsonb[field];
    }
  }
  const beforeDecrypt = captureCipherTexts(row.fields_jsonb, encryptedFields);
  const localLastSeen = local?.lastSeenCipher;

  // Hand the gate a cipher envelope from this row so an entered passphrase
  // can be verified before it's accepted — and so the Settings → Enter
  // passphrase action has something to verify against later.
  const sample = firstCipherEnvelope(row.fields_jsonb, encryptedFields);
  if (sample) rememberVerificationSample(sample);

  const needsPrompt =
    !deps.silentDecrypt &&
    !cryptoSession.isUnlocked() &&
    Object.keys(beforeDecrypt).length > 0 &&
    cipherTextsChanged(beforeDecrypt, localLastSeen);
  const hooks: DecryptRowHooks = {};
  if (needsPrompt) {
    hooks.onLocked = (verifyWith) => ensurePassphraseUnlocked({ verifyWith, auto: true });
  }
  if (!deps.silentDecrypt) {
    // A wrong passphrase must always be recoverable, fingerprint heuristic or
    // not: the session it came from claims to be unlocked, so the locked-path
    // prompt above never fires and the user would otherwise be stuck with an
    // undismissable "wrong passphrase" toast and nowhere to re-enter it.
    hooks.onWrongPassphrase = (verifyWith) =>
      ensurePassphraseUnlocked({ verifyWith, invalidate: true, auto: true });
  }
  const decryptResult = await decryptRowFields(row.fields_jsonb, encryptedFields, undefined, hooks);
  if (decryptResult.saltNotFound.length > 0 && deps.onSaltNotFound) {
    deps.onSaltNotFound(decryptResult.saltNotFound);
  }

  // Build the lastSeenCipher fingerprint to attach to the unpacked
  // record. Only fields whose decrypt succeeded contribute — a failed
  // decrypt leaves the previous fingerprint in place so we'll re-try
  // (and re-prompt) on the next pull.
  const decryptedThisRound = collectDecryptSuccess(row.fields_jsonb, beforeDecrypt);
  const mergedLastSeen =
    Object.keys(decryptedThisRound).length > 0 || localLastSeen
      ? { ...(localLastSeen ?? {}), ...decryptedThisRound }
      : undefined;

  const alive = isReplicaRowAlive(row);

  if (!alive) {
    // Always invoke softDeleteByContentId on a tombstoned row, even
    // when no local record matches. Kinds that seed companion state
    // from a separate replica use this hook to scrub it; others
    // self-no-op when no local exists, so the unconditional call is
    // safe.
    deps.softDeleteByContentId(row.replica_id);
    return;
  }

  // Metadata-only kinds: always re-apply the unpacked row so per-field
  // updates merge into the local copy: renames pushed from another
  // device, newly-decrypted credentials that weren't available on the
  // previous pull (session was locked then), etc. The store's
  // applyRemote merge preserves identity-stable local state.
  const record = deps.adapter.unpackRow(row);
  if (!record) return;
  if (mergedLastSeen) record.lastSeenCipher = mergedLastSeen;
  deps.applyRemote(record);
};

/**
 * Generic pull-side dispatcher for any replica kind. Walks rows since
 * the last cursor advance and applies each via applyRow. Errors per
 * row are isolated — one bad row never blocks the others.
 *
 * The opds_catalog and settings adapters share this orchestrator;
 * per-kind translation lives entirely in the adapter's unpackRow.
 */
export const replicaPullAndApply = async <T extends ReplicaLocalRecord>(
  deps: PullAndApplyDeps<T>,
): Promise<void> => {
  if (deps.isAuthenticated && !(await deps.isAuthenticated())) return;
  if (deps.hydrateLocalStore) {
    await deps.hydrateLocalStore();
  }
  const rows = await deps.pull();
  for (const row of rows) {
    try {
      await applyRow(row, deps);
    } catch (err) {
      console.warn('replica pull row apply failed', { replicaId: row.replica_id, err });
    }
  }
};
