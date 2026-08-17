import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import type { Book } from '@/types/book';

/**
 * `pullLibrary` in useBooksSync.ts runs two independent legs:
 *
 *   - the file sync pass, when at least one file backend (WebDAV, Google
 *     Drive, S3, OneDrive) is enabled — it works signed out;
 *   - the native account pull, which runs UNCONDITIONALLY once signed in
 *     (Readest Cloud storage was removed; the account-level metadata
 *     channel remains).
 *
 * With a signed-in user (as every test below mocks), the native pull is
 * always expected; the file pass is expected exactly when a backend is
 * enabled. These tests pin that routing plus the verbose-toast-fires-once
 * invariant and the combined book-count toast.
 */

const appService = vi.hoisted(() => ({
  saveLibraryBooks: vi.fn(async () => {}),
  generateCoverImageUrl: vi.fn(async () => 'blob:cover'),
}));

const syncState = vi.hoisted(() => ({
  useSyncInited: true,
  syncedBooks: null as Book[] | null,
  syncBooks: vi.fn(async (_books?: Book[], _op?: string, _since?: number) => 0),
  // Kept falsy so the auto-sync effect's 'both' branch (which is not what
  // these tests are about) never fires and never contends with pullLibrary
  // over the shared isPullingRef guard. See the module doc comment above.
  lastSyncedAtBooks: 0,
}));

// Per-test-settable routing input, read by the mocked cloudSyncProvider
// function below instead of being hardcoded to one scenario.
const routing = vi.hoisted(() => ({
  backends: [] as ('webdav' | 'gdrive' | 's3' | 'onedrive')[],
}));

const runFileLibrarySyncPass = vi.hoisted(() =>
  vi.fn(async (): Promise<{ booksSynced: number } | null> => ({ booksSynced: 1 })),
);

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService }),
}));

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: {} }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation:
    () =>
    (text: string, params?: Record<string, string | number>): string => {
      if (!params) return text;
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
        text,
      );
    },
}));

vi.mock('@/hooks/useSync', () => ({
  useSync: () => syncState,
}));

vi.mock('@/services/sync/cloudSyncProvider', () => ({
  getActiveFileSyncBackends: () => routing.backends,
}));

vi.mock('@/services/sync/file/runLibrarySync', () => ({
  runFileLibrarySyncPass,
}));

const { useBooksSync } = await import('@/app/library/hooks/useBooksSync');
const { useLibraryStore } = await import('@/store/libraryStore');
const { eventDispatcher } = await import('@/utils/event');

beforeEach(() => {
  vi.clearAllMocks();
  syncState.syncedBooks = null;
  syncState.lastSyncedAtBooks = 0;
  routing.backends = [];
  useLibraryStore.setState({ library: [], libraryLoaded: true, isSyncing: false });
});

afterEach(() => {
  // Without this, a hook instance left mounted from a prior test can
  // re-render (its `pullLibrary` callback is unstable across renders because
  // the mocked useEnv returns a fresh `envConfig` object every time) when a
  // later test mutates the shared zustand stores, re-firing its effects with
  // that later test's routing values and polluting its mock call counts.
  cleanup();
});

describe('useBooksSync pullLibrary routing', () => {
  it('runs both the file pass and the native pull when a file backend is enabled', async () => {
    routing.backends = ['gdrive'];

    renderHook(() => useBooksSync());

    // The mount effect calls pullLibrary() once automatically; this is the
    // critical assertion — a check that only the file pass ran would not
    // catch a regression that returns before the native pull ever starts.
    await waitFor(() => expect(runFileLibrarySyncPass).toHaveBeenCalled());
    await waitFor(() => expect(syncState.syncBooks).toHaveBeenCalled());

    const pullCalls = syncState.syncBooks.mock.calls.filter((call) => call[1] === 'pull');
    expect(pullCalls.length).toBeGreaterThan(0);
  });

  it('runs only the native pull when no file backend is enabled', async () => {
    routing.backends = [];

    renderHook(() => useBooksSync());

    await waitFor(() => expect(syncState.syncBooks).toHaveBeenCalled());
    const pullCalls = syncState.syncBooks.mock.calls.filter((call) => call[1] === 'pull');
    expect(pullCalls.length).toBeGreaterThan(0);
    expect(runFileLibrarySyncPass).not.toHaveBeenCalled();
  });

  it('toasts exactly once for a verbose pull when a file backend is enabled', async () => {
    routing.backends = ['gdrive'];

    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    const { result } = renderHook(() => useBooksSync());

    // Let the mount effect's non-verbose pullLibrary() call settle first so it
    // doesn't contend with the explicit call below over isPullingRef.
    await waitFor(() => expect(runFileLibrarySyncPass).toHaveBeenCalled());
    await waitFor(() => expect(syncState.syncBooks).toHaveBeenCalled());

    dispatchSpy.mockClear();
    runFileLibrarySyncPass.mockClear();
    syncState.syncBooks.mockClear();

    await act(async () => {
      await result.current.pullLibrary(false, true);
    });

    const toastCalls = dispatchSpy.mock.calls.filter(([event]) => event === 'toast');
    expect(toastCalls).toHaveLength(1);
  });

  it('sums the books synced across both legs in the single combined toast', async () => {
    routing.backends = ['gdrive'];

    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    const { result } = renderHook(() => useBooksSync());

    await waitFor(() => expect(runFileLibrarySyncPass).toHaveBeenCalled());
    await waitFor(() => expect(syncState.syncBooks).toHaveBeenCalled());

    dispatchSpy.mockClear();
    runFileLibrarySyncPass.mockClear();
    syncState.syncBooks.mockClear();
    runFileLibrarySyncPass.mockResolvedValueOnce({ booksSynced: 2 });
    syncState.syncBooks.mockResolvedValueOnce(5);

    await act(async () => {
      await result.current.pullLibrary(false, true);
    });

    const toastCalls = dispatchSpy.mock.calls.filter(([event]) => event === 'toast');
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.[1]).toMatchObject({ type: 'info', message: '7 book(s) synced' });
  });

  it('still reports a combined success when the file pass fails but the native pull succeeds', async () => {
    routing.backends = ['gdrive'];

    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    const { result } = renderHook(() => useBooksSync());

    await waitFor(() => expect(runFileLibrarySyncPass).toHaveBeenCalled());
    await waitFor(() => expect(syncState.syncBooks).toHaveBeenCalled());

    dispatchSpy.mockClear();
    runFileLibrarySyncPass.mockClear();
    syncState.syncBooks.mockClear();
    // An expired Drive token throws inside the pass; the pass itself catches
    // it per-backend and returns null when every backend it ran failed.
    runFileLibrarySyncPass.mockResolvedValueOnce(null);
    syncState.syncBooks.mockResolvedValueOnce(4);

    await act(async () => {
      await result.current.pullLibrary(false, true);
    });

    const toastCalls = dispatchSpy.mock.calls.filter(([event]) => event === 'toast');
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.[1]).toMatchObject({ type: 'info', message: '4 book(s) synced' });
  });
});
