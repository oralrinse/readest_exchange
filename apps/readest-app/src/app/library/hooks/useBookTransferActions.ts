import { useCallback } from 'react';
import type { Book } from '@/types/book';
import type { EnvConfigType } from '@/services/environment';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { getActiveFileSyncBackends } from '@/services/sync/cloudSyncProvider';
import { runFileBookDownload, runFileBookUpload } from '@/services/sync/file/runLibrarySync';

interface BookDownloadOptions {
  // Bulk callers (the select-mode Download action, #5244) report one summary
  // toast for the whole batch instead of one per book — a group can hold
  // hundreds.
  silent?: boolean;
}

/**
 * Explicit per-book Upload/Download routing (#5062) — the destinations are the
 * third-party file sync providers (WebDAV / Drive / S3 / OneDrive) currently
 * switched on. Readest Cloud storage was removed, so there is no queue-backed
 * upload/download path anymore. Extracted out of the huge library page
 * component so this routing (previously untested) can be exercised directly
 * with `renderHook`, the same pattern already used for {@link useBooksSync}
 * and {@link useLibraryFileSync}.
 */
export const useBookTransferActions = (
  envConfig: EnvConfigType,
  updateBook: (envConfig: EnvConfigType, book: Book) => Promise<void>,
) => {
  const _ = useTranslation();

  const handleBookUpload = useCallback(
    async (book: Book, _syncBooks = true) => {
      const settingsNow = useSettingsStore.getState().settings;
      const backends = getActiveFileSyncBackends(settingsNow);

      // An explicit Upload must reach EVERY destination the user selected
      // (#5062), not just the first one.
      const pushed = backends.length > 0 ? await runFileBookUpload(envConfig, book) : false;

      if (pushed) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 2000,
          message: _('Book uploaded: {{title}}', { title: book.title }),
        });
        return true;
      }
      // An explicit Upload action must never silently no-op.
      eventDispatcher.dispatch('toast', {
        type: backends.length > 0 ? 'error' : 'info',
        timeout: 5000,
        message:
          backends.length > 0
            ? _('Failed to upload book: {{title}}', { title: book.title })
            : _('Turn on a provider in Cloud Sync settings to upload this book'),
      });
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleBookDownload = useCallback(
    async (book: Book, downloadOptions: BookDownloadOptions = {}) => {
      const { silent = false } = downloadOptions;
      const settingsNow = useSettingsStore.getState().settings;
      const backends = getActiveFileSyncBackends(settingsNow);
      if (backends.length > 0) {
        const ok = await runFileBookDownload(envConfig, book);
        if (ok) await updateBook(envConfig, book);
        if (!silent) {
          eventDispatcher.dispatch('toast', {
            type: ok ? 'info' : 'error',
            timeout: 2000,
            message: ok
              ? _('Book downloaded: {{title}}', { title: book.title })
              : _('Failed to download book: {{title}}', { title: book.title }),
          });
        }
        return ok;
      }
      // No file backend to fetch from — report clearly instead of silently
      // no-op'ing (the explicit Download action must never do that).
      if (!silent) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 5000,
          message: _('Turn on a provider in Cloud Sync settings to download this book'),
        });
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { handleBookUpload, handleBookDownload };
};
