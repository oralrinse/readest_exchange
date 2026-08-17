import { describe, test, expect } from 'vitest';
import type { SystemSettings } from '@/types/settings';

import {
  applySyncBooksAutoEnable,
  cloudProviderDisplayName,
  cloudProvidersDisplayName,
  getActiveFileSyncBackends,
  getEnabledFileSyncBackends,
  resolveCloudSyncGate,
  settingsKeyForBackend,
} from '@/services/sync/cloudSyncProvider';

const makeSettings = (overrides: Partial<SystemSettings> = {}): SystemSettings =>
  ({
    webdav: { enabled: false },
    googleDrive: { enabled: false },
    ...overrides,
  }) as SystemSettings;

const s = (partial: Partial<SystemSettings>): SystemSettings => partial as SystemSettings;

describe('resolveCloudSyncGate', () => {
  test('no backends by default, never paused', () => {
    expect(resolveCloudSyncGate(makeSettings())).toEqual({
      backends: [],
      paused: false,
    });
  });

  test('third-party backends are active and never paused', () => {
    const settings = makeSettings({ googleDrive: { enabled: true } } as Partial<SystemSettings>);
    expect(resolveCloudSyncGate(settings)).toEqual({
      backends: ['gdrive'],
      paused: false,
    });
  });
});

describe('applySyncBooksAutoEnable (upgrade migration for already-enabled providers)', () => {
  test('flips syncBooks on for an enabled webdav provider, mutating the given settings', () => {
    const settings = makeSettings({
      webdav: { enabled: true, syncBooks: false },
    } as Partial<SystemSettings>);
    expect(applySyncBooksAutoEnable(settings)).toBe(true);
    expect(settings.webdav?.syncBooks).toBe(true);
  });

  test('flips syncBooks on for an enabled gdrive provider', () => {
    const settings = makeSettings({
      googleDrive: { enabled: true, syncBooks: false },
    } as Partial<SystemSettings>);
    expect(applySyncBooksAutoEnable(settings)).toBe(true);
    expect(settings.googleDrive?.syncBooks).toBe(true);
  });

  test('no-op when no backend is enabled', () => {
    const settings = makeSettings();
    expect(applySyncBooksAutoEnable(settings)).toBe(false);
    expect(settings.webdav?.syncBooks).toBeUndefined();
  });

  test('no-op when syncBooks is already on', () => {
    const settings = makeSettings({
      webdav: { enabled: true, syncBooks: true },
    } as Partial<SystemSettings>);
    expect(applySyncBooksAutoEnable(settings)).toBe(false);
  });

  test('flips syncBooks on for every enabled provider when multiple are enabled', () => {
    const settings = makeSettings({
      webdav: { enabled: true, syncBooks: false },
      googleDrive: { enabled: true, syncBooks: false },
    } as Partial<SystemSettings>);
    expect(applySyncBooksAutoEnable(settings)).toBe(true);
    expect(settings.webdav?.syncBooks).toBe(true);
    expect(settings.googleDrive?.syncBooks).toBe(true);
  });
});

describe('settingsKeyForBackend', () => {
  test('maps each backend kind to its settings slice', () => {
    expect(settingsKeyForBackend('webdav')).toBe('webdav');
    expect(settingsKeyForBackend('gdrive')).toBe('googleDrive');
    expect(settingsKeyForBackend('s3')).toBe('s3');
    expect(settingsKeyForBackend('onedrive')).toBe('onedrive');
  });
});

describe('cloudProviderDisplayName', () => {
  test('names every provider kind', () => {
    expect(cloudProviderDisplayName('webdav')).toBe('WebDAV');
    expect(cloudProviderDisplayName('gdrive')).toBe('Google Drive');
    expect(cloudProviderDisplayName('s3')).toBe('S3');
    expect(cloudProviderDisplayName('onedrive')).toBe('OneDrive');
  });
});

// Moved from src/__tests__/services/sync/file/providerRegistry.test.ts: the
// function itself moved from providerRegistry.ts into this module.
describe('getEnabledFileSyncBackends', () => {
  test('lists only switched-on backends in a stable order', () => {
    expect(getEnabledFileSyncBackends(s({}))).toEqual([]);
    expect(getEnabledFileSyncBackends(s({ webdav: { enabled: true } } as never))).toEqual([
      'webdav',
    ]);
    expect(
      getEnabledFileSyncBackends(
        s({ webdav: { enabled: true }, googleDrive: { enabled: true } } as never),
      ),
    ).toEqual(['webdav', 'gdrive']);
    expect(
      getEnabledFileSyncBackends(
        s({ webdav: { enabled: false }, googleDrive: { enabled: true } } as never),
      ),
    ).toEqual(['gdrive']);
  });

  test("getEnabledFileSyncBackends includes 'onedrive' when enabled", () => {
    expect(getEnabledFileSyncBackends(s({ onedrive: { enabled: true } } as never))).toContain(
      'onedrive',
    );
  });
});

describe('resolveCloudSyncGate (backends together)', () => {
  test('reports every enabled backend in fixed order', () => {
    const settings = s({
      googleDrive: { enabled: true } as never,
      webdav: { enabled: true } as never,
    });
    const gate = resolveCloudSyncGate(settings);
    expect(gate).toEqual({ backends: ['webdav', 'gdrive'], paused: false });
  });

  test('never pauses any backend', () => {
    const settings = s({
      googleDrive: { enabled: true } as never,
      webdav: { enabled: true } as never,
    });
    const gate = resolveCloudSyncGate(settings);
    expect(gate.backends).toEqual(['webdav', 'gdrive']);
    expect(gate.paused).toBe(false);
    expect(getActiveFileSyncBackends(settings)).toEqual(['webdav', 'gdrive']);
  });
});

describe('cloudProvidersDisplayName', () => {
  test('joins provider names for the "synced via" copy', () => {
    expect(cloudProvidersDisplayName(['webdav', 'gdrive'])).toBe('WebDAV, Google Drive');
  });
});

describe('icloud backend kind', () => {
  test('getEnabledFileSyncBackends appends icloud last', () => {
    expect(
      getEnabledFileSyncBackends(
        s({ webdav: { enabled: true }, icloud: { enabled: true } } as never),
      ),
    ).toEqual(['webdav', 'icloud']);
  });

  test('settingsKeyForBackend maps icloud to its own slice', () => {
    expect(settingsKeyForBackend('icloud')).toBe('icloud');
  });

  test('cloudProviderDisplayName names iCloud', () => {
    expect(cloudProviderDisplayName('icloud')).toBe('iCloud');
  });

  test('applySyncBooksAutoEnable flips syncBooks on for an enabled icloud', () => {
    const settings = s({ icloud: { enabled: true, syncBooks: false } } as never);
    expect(applySyncBooksAutoEnable(settings)).toBe(true);
    expect(settings.icloud?.syncBooks).toBe(true);
  });
});
