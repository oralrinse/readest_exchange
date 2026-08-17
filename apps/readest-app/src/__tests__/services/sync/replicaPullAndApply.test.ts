import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  isUnlocked: vi.fn(() => false),
  decryptField: vi.fn(),
}));
vi.mock('@/libs/crypto/session', () => ({
  cryptoSession: {
    isUnlocked: () => cryptoMocks.isUnlocked(),
    decryptField: (...args: unknown[]) => cryptoMocks.decryptField(...args),
    encryptField: vi.fn(),
    forget: vi.fn(),
  },
}));

const passphraseMocks = vi.hoisted(() => ({
  ensure: vi.fn(async (_deps?: Record<string, unknown>) => {}),
  remember: vi.fn((_envelope: unknown) => {}),
}));
vi.mock('@/services/sync/passphraseGate', () => ({
  ensurePassphraseUnlocked: (deps?: Record<string, unknown>) => passphraseMocks.ensure(deps),
  rememberVerificationSample: (envelope: unknown) => passphraseMocks.remember(envelope),
}));

import { replicaPullAndApply, type PullAndApplyDeps } from '@/services/sync/replicaPullAndApply';
import { opdsCatalogAdapter } from '@/services/sync/adapters/opdsCatalog';
import { hlcPack } from '@/libs/crdt';
import { SyncError } from '@/libs/errors';
import type { CipherEnvelope, Hlc, ReplicaRow } from '@/types/replica';
import type { OPDSCatalog } from '@/types/opds';
import { useSettingsStore } from '@/store/settingsStore';
import type { SystemSettings } from '@/types/settings';

const NOW = 1_700_000_000_000;
const DEV = 'dev-a';

const baseRow = (overrides: Partial<ReplicaRow> = {}): ReplicaRow => ({
  user_id: 'u1',
  kind: 'opds_catalog',
  replica_id: 'opds-content-1',
  fields_jsonb: {
    name: { v: 'Gutenberg', t: hlcPack(NOW, 0, DEV) as Hlc, s: DEV },
    url: { v: 'https://example.com/opds', t: hlcPack(NOW, 1, DEV) as Hlc, s: DEV },
  },
  manifest_jsonb: null,
  deleted_at_ts: null,
  reincarnation: null,
  updated_at_ts: hlcPack(NOW, 1, DEV) as Hlc,
  schema_version: 1,
  ...overrides,
});

const makeDeps = (): PullAndApplyDeps<OPDSCatalog> => {
  const findByContentId = vi.fn((_id: string): OPDSCatalog | undefined => undefined);
  return {
    adapter: opdsCatalogAdapter,
    pull: vi.fn(async () => [] as ReplicaRow[]),
    findByContentId,
    applyRemote: vi.fn<(record: OPDSCatalog) => void>(),
    softDeleteByContentId: vi.fn(),
  } satisfies PullAndApplyDeps<OPDSCatalog>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('replicaPullAndApply (opds adapter — metadata-only orchestrator)', () => {
  test('no-op when pull returns no rows', async () => {
    const deps = makeDeps();
    await replicaPullAndApply(deps);
    expect(deps.applyRemote).not.toHaveBeenCalled();
  });

  test('skips entirely (no pull) when isAuthenticated returns false', async () => {
    const deps = {
      ...makeDeps(),
      isAuthenticated: vi.fn(async () => false),
    } satisfies PullAndApplyDeps<OPDSCatalog>;
    await replicaPullAndApply(deps);
    expect(deps.isAuthenticated).toHaveBeenCalledOnce();
    expect(deps.pull).not.toHaveBeenCalled();
    expect(deps.applyRemote).not.toHaveBeenCalled();
  });

  test('hydrateLocalStore runs before pull so applyRemote auto-persist does not wipe persisted entries', async () => {
    const order: string[] = [];
    const deps = {
      ...makeDeps(),
      hydrateLocalStore: vi.fn(async () => {
        order.push('hydrate');
      }),
    } satisfies PullAndApplyDeps<OPDSCatalog>;
    (deps.pull as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('pull');
      return [];
    });
    await replicaPullAndApply(deps);
    expect(order).toEqual(['hydrate', 'pull']);
  });

  test('proceeds when isAuthenticated returns true', async () => {
    const deps = {
      ...makeDeps(),
      isAuthenticated: vi.fn(async () => true),
    } satisfies PullAndApplyDeps<OPDSCatalog>;
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([baseRow()]);

    await replicaPullAndApply(deps);

    expect(deps.pull).toHaveBeenCalledOnce();
    expect(deps.applyRemote).toHaveBeenCalledOnce();
    const applied = (deps.applyRemote as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OPDSCatalog;
    expect(applied.name).toBe('Gutenberg');
    expect(applied.url).toBe('https://example.com/opds');
  });

  test('alive row with existing local entry: applies and merges updates', async () => {
    const local: OPDSCatalog = {
      id: 'opds-content-1',
      contentId: 'opds-content-1',
      name: 'Old Name',
      url: 'https://example.com/opds',
      addedAt: NOW,
    };
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([baseRow()]);
    (deps.findByContentId as ReturnType<typeof vi.fn>).mockReturnValue(local);

    await replicaPullAndApply(deps);

    expect(deps.applyRemote).toHaveBeenCalledOnce();
    const applied = (deps.applyRemote as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OPDSCatalog;
    expect(applied.name).toBe('Gutenberg');
  });

  test('tombstoned row (no reincarnation): soft-delete the local entry if alive', async () => {
    const tombstone = hlcPack(NOW + 1000, 0, DEV) as Hlc;
    const row = baseRow({
      deleted_at_ts: tombstone,
      updated_at_ts: tombstone,
      reincarnation: null,
    });
    const local: OPDSCatalog = {
      id: 'opds-content-1',
      contentId: 'opds-content-1',
      name: 'Gutenberg',
      url: 'https://example.com/opds',
      addedAt: NOW,
    };
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
    (deps.findByContentId as ReturnType<typeof vi.fn>).mockReturnValue(local);

    await replicaPullAndApply(deps);

    expect(deps.softDeleteByContentId).toHaveBeenCalledWith('opds-content-1');
    expect(deps.applyRemote).not.toHaveBeenCalled();
  });

  test('tombstoned row with no local entry: still invokes softDelete so the store can scrub provider-side state', async () => {
    const tombstone = hlcPack(NOW + 1000, 0, DEV) as Hlc;
    const row = baseRow({
      deleted_at_ts: tombstone,
      updated_at_ts: tombstone,
      reincarnation: null,
    });
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([row]);

    await replicaPullAndApply(deps);

    expect(deps.softDeleteByContentId).toHaveBeenCalledWith('opds-content-1');
    expect(deps.applyRemote).not.toHaveBeenCalled();
  });

  test('reincarnated row (alive again): applied as alive', async () => {
    const tombstone = hlcPack(NOW, 0, DEV) as Hlc;
    const row = baseRow({
      deleted_at_ts: tombstone,
      reincarnation: 'epoch-1',
      updated_at_ts: hlcPack(NOW + 1000, 0, DEV) as Hlc,
    });
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([row]);

    await replicaPullAndApply(deps);

    expect(deps.applyRemote).toHaveBeenCalledOnce();
    const applied = (deps.applyRemote as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OPDSCatalog;
    expect(applied.reincarnation).toBe('epoch-1');
  });

  test('malformed row (missing url): skipped, no apply', async () => {
    const row = baseRow();
    delete (row.fields_jsonb as Record<string, unknown>)['url'];
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([row]);

    await replicaPullAndApply(deps);

    expect(deps.applyRemote).not.toHaveBeenCalled();
  });

  test('multiple rows: each applied independently', async () => {
    const r1 = baseRow({
      replica_id: 'opds-A',
      fields_jsonb: {
        ...baseRow().fields_jsonb,
        name: { v: 'Feed A', t: hlcPack(NOW, 0, DEV) as Hlc, s: DEV },
      },
    });
    const r2 = baseRow({
      replica_id: 'opds-B',
      fields_jsonb: {
        ...baseRow().fields_jsonb,
        name: { v: 'Feed B', t: hlcPack(NOW, 0, DEV) as Hlc, s: DEV },
      },
    });
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([r1, r2]);

    await replicaPullAndApply(deps);

    expect(deps.applyRemote).toHaveBeenCalledTimes(2);
  });

  test('one malformed row does not block others', async () => {
    const goodRow = baseRow({ replica_id: 'opds-good' });
    const badRow = baseRow({ replica_id: 'opds-bad' });
    delete (badRow.fields_jsonb as Record<string, unknown>)['url'];
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([badRow, goodRow]);

    await replicaPullAndApply(deps);

    expect(deps.applyRemote).toHaveBeenCalledOnce();
  });
});

describe('replicaPullAndApply credentials category gate (opds adapter)', () => {
  const cipher: CipherEnvelope = {
    c: 'CIPHERTEXT',
    i: 'IV',
    s: 'SALTID',
    alg: 'AES-GCM',
    h: 'INTEGRITY',
  };

  const setCredentialsCategory = (enabled: boolean | undefined): void => {
    const map = enabled === undefined ? {} : { credentials: enabled };
    useSettingsStore.setState({
      settings: { syncCategories: map } as never,
    } as never);
  };

  const opdsRow = (): ReplicaRow => ({
    user_id: 'u1',
    kind: 'opds_catalog',
    replica_id: 'opds-content-1',
    fields_jsonb: {
      name: { v: 'Project Gutenberg', t: hlcPack(NOW, 0, DEV) as Hlc, s: DEV },
      url: { v: 'https://example.com/opds', t: hlcPack(NOW, 1, DEV) as Hlc, s: DEV },
      // Cipher envelopes wrapped in CRDT field envelopes — same shape
      // the publish path emits when credentials sync is on.
      username: { v: cipher, t: hlcPack(NOW, 2, DEV) as Hlc, s: DEV },
      password: { v: cipher, t: hlcPack(NOW, 3, DEV) as Hlc, s: DEV },
    },
    manifest_jsonb: null,
    deleted_at_ts: null,
    reincarnation: null,
    updated_at_ts: hlcPack(NOW, 3, DEV) as Hlc,
    schema_version: 1,
  });

  beforeEach(() => {
    cryptoMocks.isUnlocked.mockReset();
    cryptoMocks.isUnlocked.mockReturnValue(false);
    cryptoMocks.decryptField.mockReset();
    passphraseMocks.ensure.mockReset();
    passphraseMocks.ensure.mockResolvedValue(undefined);
    passphraseMocks.remember.mockReset();
  });

  afterEach(() => {
    useSettingsStore.setState({ settings: undefined as unknown as SystemSettings } as never);
  });

  test('strips cipher fields and never prompts when credentials sync is OFF (default)', async () => {
    setCredentialsCategory(undefined); // default OFF
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([opdsRow()]);

    await replicaPullAndApply(deps);

    // Plaintext metadata applied — the row itself isn't gated.
    expect(deps.applyRemote).toHaveBeenCalledOnce();
    const applied = (deps.applyRemote as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OPDSCatalog;
    expect(applied.name).toBe('Project Gutenberg');
    expect(applied.url).toBe('https://example.com/opds');
    // Cipher payloads were stripped before unpack — no plaintext, no
    // ciphertext bleeds through to the local store.
    expect(applied.username).toBeUndefined();
    expect(applied.password).toBeUndefined();

    // Passphrase gate was NEVER prompted — there were no cipher fields
    // left to decrypt by the time captureCipherTexts ran.
    expect(passphraseMocks.ensure).not.toHaveBeenCalled();
    // Decrypt was NEVER attempted — credentials gate short-circuited
    // before the middleware ran.
    expect(cryptoMocks.decryptField).not.toHaveBeenCalled();
  });

  test('strips cipher fields when credentials sync is explicitly OFF', async () => {
    setCredentialsCategory(false);
    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([opdsRow()]);

    await replicaPullAndApply(deps);

    const applied = (deps.applyRemote as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OPDSCatalog;
    expect(applied.username).toBeUndefined();
    expect(applied.password).toBeUndefined();
    expect(passphraseMocks.ensure).not.toHaveBeenCalled();
  });

  test('prompts and decrypts as before when credentials sync is ON', async () => {
    setCredentialsCategory(true);
    cryptoMocks.isUnlocked.mockReturnValue(false);
    // Simulate the gate flipping to unlocked after prompt.
    passphraseMocks.ensure.mockImplementation(async () => {
      cryptoMocks.isUnlocked.mockReturnValue(true);
    });
    cryptoMocks.decryptField.mockImplementation(async (env: unknown) => {
      // Pretend the username decrypts to 'alice' and the password to 'pw'.
      const c = (env as CipherEnvelope).c;
      return c === 'CIPHERTEXT' ? 'plain' : 'plain';
    });

    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([opdsRow()]);

    await replicaPullAndApply(deps);

    // Gate prompted (cipher present + locked + cipher fingerprint not seen).
    expect(passphraseMocks.ensure).toHaveBeenCalledTimes(1);
    expect(cryptoMocks.decryptField).toHaveBeenCalledTimes(2);
  });

  test('re-prompts and recovers when the session holds the wrong passphrase', async () => {
    setCredentialsCategory(true);
    // The stranded-device state (issue #5068): the session reports unlocked
    // because a wrong passphrase was accepted and keychained, so the locked-
    // path prompt never fires — every decrypt just fails.
    cryptoMocks.isUnlocked.mockReturnValue(true);
    let rightKey = false;
    cryptoMocks.decryptField.mockImplementation(async () => {
      if (!rightKey) throw new SyncError('DECRYPT', 'AES-GCM decryption failed');
      return 'plain';
    });
    passphraseMocks.ensure.mockImplementation(async () => {
      rightKey = true;
    });

    const deps = makeDeps();
    (deps.pull as ReturnType<typeof vi.fn>).mockResolvedValue([opdsRow()]);

    await replicaPullAndApply(deps);

    // The bad passphrase is thrown away (keychain included) and re-asked for,
    // once — then both fields decrypt on the retry.
    expect(passphraseMocks.ensure).toHaveBeenCalledTimes(1);
    expect(passphraseMocks.ensure.mock.calls[0]![0]).toMatchObject({ invalidate: true });
    const applied = (deps.applyRemote as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OPDSCatalog;
    expect(applied.username).toBe('plain');
    expect(applied.password).toBe('plain');
  });
});
