import type { SystemSettings } from '@/types/settings';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';

/**
 * The cloud sync provider kind for library data (book files, book rows,
 * progress, notes). Readest Cloud storage was removed — the only providers are
 * the third-party file-sync backends. Account-level data (settings replicas,
 * reading stats) always syncs via the account channel while signed in,
 * regardless of this selection.
 */
export type CloudSyncProviderKind = FileSyncBackendKind;

/** Settings slice key for a third-party backend kind. */
export const settingsKeyForBackend = (
  kind: FileSyncBackendKind,
): 'webdav' | 'googleDrive' | 's3' | 'onedrive' | 'icloud' =>
  kind === 'gdrive' ? 'googleDrive' : kind;

/** Human-readable provider name (product names — deliberately untranslated). */
export const cloudProviderDisplayName = (kind: FileSyncBackendKind): string =>
  kind === 'gdrive'
    ? 'Google Drive'
    : kind === 'webdav'
      ? 'WebDAV'
      : kind === 's3'
        ? 'S3'
        : kind === 'onedrive'
          ? 'OneDrive'
          : 'iCloud';

/**
 * The third-party backends the user has switched on, in a STABLE order that
 * every loop, list, and sync pass in the app relies on.
 */
export const getEnabledFileSyncBackends = (
  settings: SystemSettings | null | undefined,
): FileSyncBackendKind[] => {
  const enabled: FileSyncBackendKind[] = [];
  if (settings?.webdav?.enabled) enabled.push('webdav');
  if (settings?.googleDrive?.enabled) enabled.push('gdrive');
  if (settings?.s3?.enabled) enabled.push('s3');
  if (settings?.onedrive?.enabled) enabled.push('onedrive');
  if (settings?.icloud?.enabled) enabled.push('icloud');
  return enabled;
};

/** Comma-joined product names, for the "Synced via {{provider}}" copy. */
export const cloudProvidersDisplayName = (kinds: FileSyncBackendKind[]): string =>
  kinds.map(cloudProviderDisplayName).join(', ');

export interface CloudSyncGate {
  /** Third-party backends the user switched on, in the fixed webdav/gdrive/s3/onedrive/icloud order. */
  backends: FileSyncBackendKind[];
  /**
   * Whether the enabled third-party backends are paused. Always false — the
   * premium cloud-sync paywall was removed, so switching a backend on means it
   * runs. Kept as a field so any consumer that reads `.paused` stays valid.
   */
  paused: boolean;
}

export const resolveCloudSyncGate = (
  settings: SystemSettings | null | undefined,
): CloudSyncGate => {
  const backends = getEnabledFileSyncBackends(settings);
  return {
    backends,
    paused: false,
  };
};

/** The backends that may actually run right now. */
export const getActiveFileSyncBackends = (
  settings: SystemSettings | null | undefined,
): FileSyncBackendKind[] => resolveCloudSyncGate(settings).backends;

/**
 * One-time upgrade migration helper (appService migrate20260706): when
 * provider selection shipped, users who already had WebDAV/Drive enabled had
 * their book uploads gated off — with syncBooks at its old `false` default
 * their books would back up nowhere. Flip syncBooks on for every enabled
 * backend. Mutates `settings` in place (the migration runner saves the same
 * snapshot afterwards) and returns whether anything changed.
 */
export const applySyncBooksAutoEnable = (settings: SystemSettings): boolean => {
  let changed = false;
  for (const kind of getEnabledFileSyncBackends(settings)) {
    // A switch (rather than a generically-keyed write) keeps each branch's
    // settings slice type intact; `settings[key] = { ...slice, syncBooks }`
    // does not typecheck when `key` is a union of literal keys.
    switch (kind) {
      case 'webdav':
        if (settings.webdav && !settings.webdav.syncBooks) {
          settings.webdav = { ...settings.webdav, syncBooks: true };
          changed = true;
        }
        break;
      case 'gdrive':
        if (settings.googleDrive && !settings.googleDrive.syncBooks) {
          settings.googleDrive = { ...settings.googleDrive, syncBooks: true };
          changed = true;
        }
        break;
      case 's3':
        if (settings.s3 && !settings.s3.syncBooks) {
          settings.s3 = { ...settings.s3, syncBooks: true };
          changed = true;
        }
        break;
      case 'onedrive':
        if (settings.onedrive && !settings.onedrive.syncBooks) {
          settings.onedrive = { ...settings.onedrive, syncBooks: true };
          changed = true;
        }
        break;
      case 'icloud':
        if (settings.icloud && !settings.icloud.syncBooks) {
          settings.icloud = { ...settings.icloud, syncBooks: true };
          changed = true;
        }
        break;
    }
  }
  return changed;
};
