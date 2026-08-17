import type { ReplicaRow } from '@/types/replica';

export interface ReplicaAdapter<T = unknown> {
  kind: string;
  schemaVersion: number;
  pack(replica: T): Record<string, unknown>;
  unpack(fields: Record<string, unknown>): T;
  computeId(input: T): Promise<string>;
  /**
   * Build a local record from a pulled replica row. Used by the generic
   * pull orchestrator to dispatch row → record translation without
   * knowing the kind. Returns null when the row's fields are malformed
   * (missing required fields).
   */
  unpackRow(row: ReplicaRow): T | null;
  /**
   * Field names whose values are encrypted before push and decrypted
   * after pull. The publish/pull middleware handles the crypto round
   * trip via the active CryptoSession; pack/unpack always see plain
   * values. Absent or empty means the kind has no encrypted fields.
   *
   * Encryption is best-effort: if the session isn't unlocked, encrypted
   * fields are dropped from the push (the row syncs without them) and
   * decrypt failure on pull is logged + the field is omitted from the
   * unpacked record so local plaintext copies are preserved.
   */
  encryptedFields?: readonly string[];
}

const registry = new Map<string, ReplicaAdapter<unknown>>();

export const registerReplicaAdapter = <T>(adapter: ReplicaAdapter<T>): void => {
  if (registry.has(adapter.kind)) {
    throw new Error(`Replica adapter for kind="${adapter.kind}" is already registered`);
  }
  registry.set(adapter.kind, adapter as ReplicaAdapter<unknown>);
};

export const getReplicaAdapter = <T = unknown>(kind: string): ReplicaAdapter<T> | undefined =>
  registry.get(kind) as ReplicaAdapter<T> | undefined;

export const listReplicaAdapters = (): ReplicaAdapter<unknown>[] => Array.from(registry.values());

export const clearReplicaAdapters = (): void => {
  registry.clear();
};
