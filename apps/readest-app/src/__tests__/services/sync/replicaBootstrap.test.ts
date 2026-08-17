import { afterEach, describe, expect, test } from 'vitest';

import {
  __resetBootstrapForTests,
  bootstrapReplicaAdapters,
} from '@/services/sync/replicaBootstrap';
import {
  clearReplicaAdapters,
  getReplicaAdapter,
  listReplicaAdapters,
} from '@/services/sync/replicaRegistry';
import { opdsCatalogAdapter } from '@/services/sync/adapters/opdsCatalog';
import { settingsAdapter } from '@/services/sync/adapters/settings';

afterEach(() => {
  clearReplicaAdapters();
  __resetBootstrapForTests();
});

describe('bootstrapReplicaAdapters', () => {
  test('registers the opds_catalog adapter', () => {
    bootstrapReplicaAdapters();
    expect(getReplicaAdapter('opds_catalog')).toBe(opdsCatalogAdapter);
  });

  test('registers the settings adapter', () => {
    bootstrapReplicaAdapters();
    expect(getReplicaAdapter('settings')).toBe(settingsAdapter);
  });

  test('is idempotent: calling twice is a no-op (does not throw)', () => {
    bootstrapReplicaAdapters();
    bootstrapReplicaAdapters();
    expect(listReplicaAdapters()).toHaveLength(2);
  });

  test('registers the current allowlist (metadata-only kinds only)', () => {
    bootstrapReplicaAdapters();
    const kinds = listReplicaAdapters().map((a) => a.kind);
    expect(kinds).toEqual(['opds_catalog', 'settings']);
  });

  test('the dictionary / font / texture adapters are gone (binary transfers removed)', () => {
    bootstrapReplicaAdapters();
    expect(getReplicaAdapter('dictionary')).toBeUndefined();
    expect(getReplicaAdapter('font')).toBeUndefined();
    expect(getReplicaAdapter('texture')).toBeUndefined();
  });
});
