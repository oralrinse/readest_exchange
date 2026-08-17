import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/access', () => ({
  getUserID: vi.fn(),
}));

vi.mock('@/services/sync/replicaSync', () => ({
  getReplicaSync: vi.fn(),
}));

const cryptoMocks = vi.hoisted(() => ({
  isUnlocked: vi.fn(() => true),
  encryptField: vi.fn(async (v: string) => ({ v, kdf: 'mock' })),
}));

vi.mock('@/libs/crypto/session', () => ({
  cryptoSession: {
    isUnlocked: () => cryptoMocks.isUnlocked(),
    encryptField: (v: string) => cryptoMocks.encryptField(v),
    decryptField: vi.fn(),
    forget: vi.fn(),
  },
}));

import { getUserID } from '@/utils/access';
import { getReplicaSync } from '@/services/sync/replicaSync';
import { publishReplicaDelete, publishReplicaUpsert } from '@/services/sync/replicaPublish';
import { clearReplicaAdapters, registerReplicaAdapter } from '@/services/sync/replicaRegistry';
import { opdsCatalogAdapter } from '@/services/sync/adapters/opdsCatalog';
import type { OPDSCatalog } from '@/types/opds';
import { HlcGenerator } from '@/libs/crdt';
import type { ReplicaRow } from '@/types/replica';

const NOW = 1_700_000_000_000;
const DEV = 'dev-a';

const baseCatalog = (overrides: Partial<OPDSCatalog> = {}): OPDSCatalog => ({
  id: 'local-cat-1',
  contentId: 'content-hash-abc',
  name: 'Gutenberg',
  url: 'https://example.com/opds',
  addedAt: NOW,
  ...overrides,
});

const makeFakeCtx = () => {
  const hlc = new HlcGenerator(DEV, () => NOW);
  const manager = {
    markDirty: vi.fn(),
    flush: vi.fn(),
    pull: vi.fn(),
    startAutoSync: vi.fn(),
    stopAutoSync: vi.fn(),
    pendingCount: vi.fn(() => 0),
    pendingKeys: vi.fn(() => []),
  };
  return { manager, hlc, deviceId: DEV };
};

const upsertCatalog = (catalog: OPDSCatalog): Promise<void> =>
  publishReplicaUpsert('opds_catalog', catalog, catalog.contentId!, catalog.reincarnation);

beforeEach(() => {
  vi.clearAllMocks();
  clearReplicaAdapters();
  registerReplicaAdapter(opdsCatalogAdapter);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearReplicaAdapters();
});

describe('publishReplicaUpsert (opds_catalog adapter)', () => {
  test('no-ops when replicaSync is not initialized', async () => {
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await upsertCatalog(baseCatalog());
    expect(getUserID).not.toHaveBeenCalled();
  });

  test('no-ops when no adapter registered for the kind', async () => {
    clearReplicaAdapters();
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await upsertCatalog(baseCatalog());
    expect(ctx.manager.markDirty).not.toHaveBeenCalled();
  });

  test('no-ops when user not authenticated', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await upsertCatalog(baseCatalog());
    expect(ctx.manager.markDirty).not.toHaveBeenCalled();
  });

  test('builds + markDirty a kind=opds_catalog row keyed by contentId', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    const catalog = baseCatalog({ name: 'Gutenberg Concise' });
    await upsertCatalog(catalog);

    expect(ctx.manager.markDirty).toHaveBeenCalledOnce();
    const row = ctx.manager.markDirty.mock.calls[0]![0];
    expect(row.user_id).toBe('user-1');
    expect(row.kind).toBe('opds_catalog');
    expect(row.replica_id).toBe('content-hash-abc');
    expect(row.fields_jsonb['name']?.v).toBe('Gutenberg Concise');
    expect(row.fields_jsonb['url']?.v).toBe('https://example.com/opds');
    expect(row.deleted_at_ts).toBe(null);
    expect(row.schema_version).toBe(1);
  });

  test('every field gets a fresh HLC stamp + deviceId', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await upsertCatalog(baseCatalog());
    const row = ctx.manager.markDirty.mock.calls[0]![0] as ReplicaRow;
    for (const env of Object.values(row.fields_jsonb)) {
      expect(env.s).toBe(DEV);
      expect(env.t).toMatch(/^[0-9a-f]+-[0-9a-f]+-dev-a$/);
    }
  });

  test('updated_at_ts is the maximum of all field HLCs', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await upsertCatalog(baseCatalog());
    const row = ctx.manager.markDirty.mock.calls[0]![0] as ReplicaRow;
    const fieldHlcs = Object.values(row.fields_jsonb).map((e) => e.t);
    const maxField = fieldHlcs.reduce((a, b) => (a > b ? a : b));
    expect(row.updated_at_ts >= maxField).toBe(true);
  });

  test('reincarnation token propagates to the row (revives a tombstoned row)', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await upsertCatalog(baseCatalog({ reincarnation: 'epoch-1' }));
    const row = ctx.manager.markDirty.mock.calls[0]![0] as ReplicaRow;
    expect(row.reincarnation).toBe('epoch-1');
  });

  test('reincarnation defaults to null when absent (first import or live re-import)', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await upsertCatalog(baseCatalog());
    const row = ctx.manager.markDirty.mock.calls[0]![0] as ReplicaRow;
    expect(row.reincarnation).toBe(null);
  });
});

describe('publishReplicaDelete', () => {
  test('no-ops when replicaSync is not initialized', async () => {
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await publishReplicaDelete('opds_catalog', 'content-hash-abc');
    expect(getUserID).not.toHaveBeenCalled();
  });

  test('no-ops when user not authenticated', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await publishReplicaDelete('opds_catalog', 'content-hash-abc');
    expect(ctx.manager.markDirty).not.toHaveBeenCalled();
  });

  test('produces a tombstoned row (deleted_at_ts set)', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await publishReplicaDelete('opds_catalog', 'content-hash-abc');
    expect(ctx.manager.markDirty).toHaveBeenCalledOnce();
    const row = ctx.manager.markDirty.mock.calls[0]![0];
    expect(row.replica_id).toBe('content-hash-abc');
    expect(row.kind).toBe('opds_catalog');
    expect(row.deleted_at_ts).not.toBe(null);
  });

  test('tombstone HLC matches updated_at_ts (remove-wins ordering)', async () => {
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await publishReplicaDelete('opds_catalog', 'content-hash-abc');
    const row = ctx.manager.markDirty.mock.calls[0]![0];
    expect(row.updated_at_ts).toBe(row.deleted_at_ts);
  });
});

describe('publishReplica* sync category gate', () => {
  // When the user disables a category (e.g., opds_catalog) the publish
  // path is a silent no-op. The local store stays mutable; the data
  // just doesn't fan out to the server. Re-enabling resumes pushes
  // automatically — no manual flush required.
  const disableCategory = async (category: string): Promise<void> => {
    const { useSettingsStore } = await import('@/store/settingsStore');
    useSettingsStore.setState({
      settings: { syncCategories: { [category]: false } } as never,
    } as never);
  };

  const restoreCategories = async (): Promise<void> => {
    const { useSettingsStore } = await import('@/store/settingsStore');
    useSettingsStore.setState({ settings: undefined } as never);
  };

  afterEach(async () => {
    await restoreCategories();
  });

  test('publishReplicaUpsert is a no-op when its kind is disabled', async () => {
    await disableCategory('opds_catalog');
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await upsertCatalog(baseCatalog());
    expect(ctx.manager.markDirty).not.toHaveBeenCalled();
  });

  test('publishReplicaDelete is a no-op when its kind is disabled', async () => {
    await disableCategory('opds_catalog');
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    await publishReplicaDelete('opds_catalog', 'content-hash-abc');
    expect(ctx.manager.markDirty).not.toHaveBeenCalled();
  });

  test('settings is force-enabled when dictionary is on (dependency cascade)', async () => {
    // settings: false but dictionary: true (the dependent) → settings
    // must still publish, otherwise dictionary cross-device sync breaks.
    const { useSettingsStore } = await import('@/store/settingsStore');
    useSettingsStore.setState({
      settings: { syncCategories: { settings: false, dictionary: true } } as never,
    } as never);
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    const { settingsAdapter } = await import('@/services/sync/adapters/settings');
    registerReplicaAdapter(settingsAdapter);
    await publishReplicaUpsert('settings', { name: 'singleton', patch: {} }, 'singleton');
    expect(ctx.manager.markDirty).toHaveBeenCalled();
  });

  test('settings publish is gated when both settings AND its dependent (dictionary) are off', async () => {
    const { useSettingsStore } = await import('@/store/settingsStore');
    useSettingsStore.setState({
      settings: { syncCategories: { settings: false, dictionary: false } } as never,
    } as never);
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');
    const { settingsAdapter } = await import('@/services/sync/adapters/settings');
    registerReplicaAdapter(settingsAdapter);
    await publishReplicaUpsert('settings', { name: 'singleton', patch: {} }, 'singleton');
    expect(ctx.manager.markDirty).not.toHaveBeenCalled();
  });
});

describe('publishReplicaUpsert credentials gate', () => {
  // The 'credentials' meta-toggle defaults OFF. When OFF, the publish
  // pipeline must drop adapter.encryptedFields from the packed row so
  // sensitive fields (OPDS username/password, kosync credentials,
  // readwise/hardcover tokens) never leave the device. Plaintext fields
  // (catalog name/url, etc.) still ship — the row itself isn't gated,
  // only its encrypted slots.
  const setCredentialsCategory = async (enabled: boolean | undefined): Promise<void> => {
    const { useSettingsStore } = await import('@/store/settingsStore');
    const map = enabled === undefined ? {} : { credentials: enabled };
    useSettingsStore.setState({
      settings: { syncCategories: map } as never,
    } as never);
  };

  const restoreSettings = async (): Promise<void> => {
    const { useSettingsStore } = await import('@/store/settingsStore');
    useSettingsStore.setState({ settings: undefined } as never);
  };

  afterEach(async () => {
    await restoreSettings();
    cryptoMocks.isUnlocked.mockReset();
    cryptoMocks.isUnlocked.mockReturnValue(true);
    cryptoMocks.encryptField.mockReset();
    cryptoMocks.encryptField.mockImplementation(async (v: string) => ({ v, kdf: 'mock' }));
  });

  test('drops encryptedFields from the packed row when credentials sync is OFF (default)', async () => {
    // No syncCategories map at all → credentials defaults OFF.
    await setCredentialsCategory(undefined);
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');

    await publishReplicaUpsert(
      'opds_catalog',
      {
        id: 'cat-1',
        name: 'Project Gutenberg',
        url: 'https://example.com/opds',
        username: 'alice',
        password: 'hunter2',
      },
      'cat-content-id',
    );

    expect(ctx.manager.markDirty).toHaveBeenCalledOnce();
    const row = ctx.manager.markDirty.mock.calls[0]![0] as ReplicaRow;
    // Plaintext metadata still ships
    expect(row.fields_jsonb['name']?.v).toBe('Project Gutenberg');
    expect(row.fields_jsonb['url']?.v).toBe('https://example.com/opds');
    // Encrypted fields are dropped entirely (no plaintext leak, no cipher attempt)
    expect(row.fields_jsonb['username']).toBeUndefined();
    expect(row.fields_jsonb['password']).toBeUndefined();
    // Crypto session was never invoked — credentials OFF short-circuited
    // the field set before the middleware could even check unlock state.
    expect(cryptoMocks.encryptField).not.toHaveBeenCalled();
  });

  test('drops encryptedFields when credentials sync is explicitly disabled', async () => {
    await setCredentialsCategory(false);
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');

    await publishReplicaUpsert(
      'opds_catalog',
      { id: 'cat-1', name: 'PG', url: 'u', username: 'alice', password: 'pw' },
      'cat-content-id',
    );

    const row = ctx.manager.markDirty.mock.calls[0]![0] as ReplicaRow;
    expect(row.fields_jsonb['username']).toBeUndefined();
    expect(row.fields_jsonb['password']).toBeUndefined();
  });

  test('encrypts the fields normally when credentials sync is ON', async () => {
    await setCredentialsCategory(true);
    const ctx = makeFakeCtx();
    (getReplicaSync as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    (getUserID as ReturnType<typeof vi.fn>).mockResolvedValue('user-1');

    await publishReplicaUpsert(
      'opds_catalog',
      { id: 'cat-1', name: 'PG', url: 'u', username: 'alice', password: 'pw' },
      'cat-content-id',
    );

    const row = ctx.manager.markDirty.mock.calls[0]![0] as ReplicaRow;
    // Encrypted slots present (cipher envelope shape from our mock)
    expect(row.fields_jsonb['username']?.v).toEqual({ v: 'alice', kdf: 'mock' });
    expect(row.fields_jsonb['password']?.v).toEqual({ v: 'pw', kdf: 'mock' });
    expect(cryptoMocks.encryptField).toHaveBeenCalledTimes(2);
  });
});
