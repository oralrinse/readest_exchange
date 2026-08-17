import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { createAppLocalStore } from '@/services/sync/file/appLocalStore';

/**
 * Regression test for the library-clobber data-loss path: when "Sync now"
 * runs while the library store hasn't loaded yet (the app launched straight
 * into the reader / settings, never mounting the Library view), the engine's
 * addBookToLibrary / updateBookMetadata used to merge against the EMPTY
 * in-memory library and persist a downloaded book (or a metadata update) as
 * the *entire* library, wiping everything already on disk. The store bridge
 * now hydrates from disk first.
 */

const makeBook = (hash: string, overrides: Partial<Book> = {}): Book => ({
  hash,
  format: 'EPUB',
  title: `Book ${hash}`,
  sourceTitle: `Book ${hash}`,
  author: 'A',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

let savedLibrary: Book[] | null;
let appService: AppService;
let envConfig: EnvConfigType;

const onDisk = [makeBook('a'), makeBook('b')];

beforeEach(() => {
  savedLibrary = null;
  // Simulate the unloaded store: the user hasn't visited the Library view.
  useLibraryStore.setState({ library: [], libraryLoaded: false, hashIndex: new Map() });
  appService = {
    loadLibraryBooks: vi.fn(async () => onDisk.map((b) => ({ ...b }))),
    saveLibraryBooks: vi.fn(async (books: Book[]) => {
      savedLibrary = books;
    }),
    generateCoverImageUrl: vi.fn(async () => 'blob:cover'),
    deleteBook: vi.fn(async () => {}),
    // resolveLocalSource's managed-miss fallback lists the per-hash dir; default
    // to empty so tests that exercise the no-source path keep resolving null.
    readDirectory: vi.fn(async () => []),
  } as unknown as AppService;
  envConfig = { getAppService: async () => appService } as unknown as EnvConfigType;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const makeStore = () =>
  createAppLocalStore({ appService, settings: {} as SystemSettings, envConfig });

describe('createAppLocalStore — library hydration (data-loss guard)', () => {
  test('addBookToLibrary keeps existing on-disk books when the store is unloaded', async () => {
    await makeStore().addBookToLibrary(makeBook('c'));

    expect(appService.loadLibraryBooks).toHaveBeenCalledTimes(1);
    expect(savedLibrary).not.toBeNull();
    const hashes = savedLibrary!.map((b) => b.hash).sort();
    // The downloaded book is appended; a, b must survive (no clobber to [c]).
    expect(hashes).toEqual(['a', 'b', 'c']);
  });

  test('updateBookMetadata does not wipe the library when the store is unloaded', async () => {
    await makeStore().updateBookMetadata(makeBook('a', { title: 'New Title', updatedAt: 9 }));

    expect(appService.loadLibraryBooks).toHaveBeenCalled();
    expect(savedLibrary).not.toBeNull();
    const hashes = savedLibrary!.map((b) => b.hash).sort();
    // Both books survive; a is updated in place, b is untouched.
    expect(hashes).toEqual(['a', 'b']);
    expect(savedLibrary!.find((b) => b.hash === 'a')!.title).toBe('New Title');
  });

  test('addBookToLibrary merges against an already-loaded store without reloading', async () => {
    useLibraryStore.getState().setLibrary([makeBook('a'), makeBook('b')]);
    await makeStore().addBookToLibrary(makeBook('c'));

    expect(appService.loadLibraryBooks).not.toHaveBeenCalled();
    expect(savedLibrary!.map((b) => b.hash).sort()).toEqual(['a', 'b', 'c']);
  });

  test('deleteBookLocally removes the managed copy and persists the tombstone (#4860)', async () => {
    useLibraryStore.getState().setLibrary([makeBook('a'), makeBook('b')]);

    await makeStore().deleteBookLocally(makeBook('a', { deletedAt: 500 }));

    // The managed local copy is removed via the 'local' delete action.
    expect(appService.deleteBook).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'a' }),
      'local',
    );
    // The tombstone is persisted and the other book survives.
    expect(savedLibrary!.map((b) => b.hash).sort()).toEqual(['a', 'b']);
    expect(savedLibrary!.find((b) => b.hash === 'a')!.deletedAt).toBe(500);
    // The deleted book drops off the visible shelf.
    expect(useLibraryStore.getState().visibleLibrary.map((b) => b.hash)).toEqual(['b']);
  });

  test('markBooksUploaded stamps the live rows, not the engine snapshot (#5084)', async () => {
    // The engine captured `a` at the start of a long run; meanwhile the user
    // read it and saved progress. The stamp must not roll that back.
    useLibraryStore.getState().setLibrary([makeBook('a', { progress: [42, 100] }), makeBook('b')]);

    await makeStore().markBooksUploaded(['a'], 900);

    const stamped = savedLibrary!.find((b) => b.hash === 'a')!;
    expect(stamped.uploadedAt).toBe(900);
    expect(stamped.progress).toEqual([42, 100]);
    // Books the engine didn't confirm keep their (absent) cloud state.
    expect(savedLibrary!.find((b) => b.hash === 'b')!.uploadedAt).toBeFalsy();
  });

  test('markBooksUploaded hydrates from disk when the store is unloaded', async () => {
    await makeStore().markBooksUploaded(['a'], 900);

    expect(appService.loadLibraryBooks).toHaveBeenCalled();
    expect(savedLibrary!.map((b) => b.hash).sort()).toEqual(['a', 'b']);
    expect(savedLibrary!.find((b) => b.hash === 'a')!.uploadedAt).toBe(900);
  });
});

/**
 * #5265 — the residue of #5084. Devices that synced on a pre-#5087 build hold
 * library rows carrying a PEER's absolute `filePath`, adopted from the shared
 * library.json. The upload source resolvers preferred that path blindly, so a
 * book whose managed copy `Books/<hash>/…` was sitting right there resolved to
 * 'no-source': the engine never confirmed the file, never stamped
 * `uploadedAt`, and the row stayed classified as a purely-local book — which is
 * what lets "Remove from Device Only" end in a cloud-and-device delete that GCs
 * the book off Google Drive.
 *
 * `resolveBookContentSource` already documents the right precedence ("prefer the
 * managed copy when it exists; book.filePath is device-local and can outlive a
 * prior in-place/import mode"); these resolvers must follow it.
 */
describe('createAppLocalStore — a stale filePath must not mask the managed copy (#5265)', () => {
  const STALE = 'C:\\Users\\other-device\\Books\\Book h1.epub';

  beforeEach(() => {
    appService.exists = vi.fn(async (path: string) => path !== STALE);
    appService.openFile = vi.fn(async () => new File([new Uint8Array(4)], 'h1.epub'));
    appService.resolveFilePath = vi.fn(async (path: string) => `/root/Books/${path}`);
  });

  test('loadBookFile reads the managed copy when filePath points nowhere', async () => {
    const bytes = await makeStore().loadBookFile(makeBook('h1', { filePath: STALE }));

    expect(bytes).not.toBeNull();
    expect(bytes!.size).toBe(4);
    expect(appService.openFile).toHaveBeenCalledWith('h1/Book h1.epub', 'Books');
  });

  test('resolveLocalBookPath resolves the managed copy when filePath points nowhere', async () => {
    const src = await makeStore().resolveLocalBookPath(makeBook('h1', { filePath: STALE }));

    expect(src).not.toBeNull();
    expect(src!.path).toBe('/root/Books/h1/Book h1.epub');
    expect(appService.resolveFilePath).toHaveBeenCalledWith('h1/Book h1.epub', 'Books');
  });

  test('an in-place book still uploads from its external source', async () => {
    const inPlace = '/home/reader/Calibre/Book h1.epub';
    // No managed copy — only the user's own file at an external location.
    appService.exists = vi.fn(async (path: string) => path === inPlace);

    const src = await makeStore().resolveLocalBookPath(makeBook('h1', { filePath: inPlace }));

    expect(src!.path).toBe('/root/Books/' + inPlace);
    expect(appService.resolveFilePath).toHaveBeenCalledWith(inPlace, 'None');
  });

  test('a book on no device at all is still reported as having no source', async () => {
    appService.exists = vi.fn(async () => false);

    expect(await makeStore().loadBookFile(makeBook('h1', { filePath: STALE }))).toBeNull();
    expect(await makeStore().resolveLocalBookPath(makeBook('h1', { filePath: STALE }))).toBeNull();
  });
});

/**
 * CBZ (and any zip-image format) has no OPF metadata, so DocumentLoader falls
 * back to the raw file name for the title — `sourceTitle` keeps the extension
 * (e.g. `情绪病 1-64 - bundle.cbz`). `getLocalBookFilename` appends its own
 * extension on top, producing `…bundle.cbz.cbz`, which never matches what the
 * importer wrote to `Books/<hash>/…bundle.cbz`. The managed probe then misses
 * and — because a managed import leaves `filePath` null — the book is judged
 * `no-source`, so the file never uploads and never earns `uploadedAt`.
 */
describe('createAppLocalStore — sourceTitle with extension must not hide the real file (CBZ)', () => {
  const cbzBook = (hash = 'h1'): Book =>
    makeBook(hash, {
      format: 'CBZ',
      title: '情绪病 1-64 - bundle',
      sourceTitle: '情绪病 1-64 - bundle.cbz',
    });
  const REAL = '情绪病 1-64 - bundle.cbz';

  beforeEach(() => {
    // The reconstructed managed path (`h1/情绪病 1-64 - bundle.cbz.cbz`) misses.
    appService.exists = vi.fn(async () => false);
    appService.openFile = vi.fn(async () => new File([new Uint8Array(4)], REAL));
    appService.resolveFilePath = vi.fn(async (path: string) => `/root/Books/${path}`);
  });

  test('resolveLocalBookPath finds the real cbz inside the per-hash dir', async () => {
    appService.readDirectory = vi.fn(async () => [
      { path: REAL, size: 100 },
      { path: 'cover.png', size: 10 },
      { path: 'config.json', size: 5 },
    ]);

    const src = await makeStore().resolveLocalBookPath(cbzBook());

    expect(src).not.toBeNull();
    expect(src!.path).toBe(`/root/Books/h1/${REAL}`);
    expect(appService.readDirectory).toHaveBeenCalledWith('h1', 'Books');
  });

  test('loadBookFile reads the real cbz instead of reporting no-source', async () => {
    appService.readDirectory = vi.fn(async () => [{ path: REAL, size: 100 }]);

    const bytes = await makeStore().loadBookFile(cbzBook());

    expect(bytes).not.toBeNull();
    expect(appService.openFile).toHaveBeenCalledWith(`h1/${REAL}`, 'Books');
  });

  test('a dir holding no book file still resolves to no-source', async () => {
    appService.readDirectory = vi.fn(async () => [{ path: 'cover.png', size: 10 }]);

    expect(await makeStore().resolveLocalBookPath(cbzBook())).toBeNull();
    expect(await makeStore().loadBookFile(cbzBook())).toBeNull();
  });

  test('an unreadable dir keeps the no-source verdict instead of throwing', async () => {
    appService.readDirectory = vi.fn(async () => {
      throw new Error('EACCES');
    });

    expect(await makeStore().resolveLocalBookPath(cbzBook())).toBeNull();
  });
});
