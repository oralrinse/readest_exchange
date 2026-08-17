import { WebDAVSettings } from '@/types/settings';
import { isTauriAppPlatform } from '@/services/environment';
import {
  createProgressThrottle,
  tauriDownload,
  tauriUpload,
  type ProgressHandler,
  type ProgressPayload,
} from '@/utils/transfer';
import {
  FileEntry,
  FileHead,
  FileSyncError,
  FileSyncErrorCode,
  FileSyncProvider,
  StreamProgress,
} from '@/services/sync/file/provider';
import {
  WebDAVConfig,
  WebDAVRequestError,
  buildBasicAuthHeader,
  buildRequestUrl,
  deleteDirectory,
  ensureDirectory,
  getFile,
  getFileBinary,
  headFile,
  listDirectory,
  normalizeRootPath,
  putFile,
  putFileBinary,
} from './client';

/**
 * WebDAV implementation of {@link FileSyncProvider} — the first concrete
 * backend for the provider-agnostic file-sync engine.
 *
 * Responsibilities unique to this layer:
 *   - own the WebDAV transport config (serverUrl + Basic-auth credentials);
 *   - translate the transport client's {@link WebDAVRequestError} into the
 *     engine's neutral {@link FileSyncError} so nothing above this file
 *     knows the backend is WebDAV;
 *   - own streaming upload/download (URL + auth + the Tauri-side
 *     `tauriUpload`/`tauriDownload`), keeping gigabyte-scale book payloads out
 *     of the JS heap. Streaming is exposed only on Tauri; on web the engine
 *     falls back to buffered {@link FileSyncProvider.writeBinary}/`readBinary`.
 */

const mapError = (e: unknown): FileSyncError => {
  if (e instanceof FileSyncError) return e;
  if (e instanceof WebDAVRequestError) {
    const code: FileSyncErrorCode =
      e.code === 'AUTH_FAILED'
        ? 'AUTH_FAILED'
        : e.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : e.code === 'NETWORK'
            ? 'NETWORK'
            : e.status === 409
              ? 'CONFLICT'
              : 'UNKNOWN';
    return new FileSyncError(e.message, code, e.status);
  }
  return new FileSyncError(e instanceof Error ? e.message : String(e), 'UNKNOWN');
};

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    throw mapError(e);
  }
};

export const createWebDAVProvider = (settings: WebDAVSettings): FileSyncProvider => {
  const config: WebDAVConfig = {
    serverUrl: settings.serverUrl,
    username: settings.username,
    password: settings.password,
  };

  const provider: FileSyncProvider = {
    rootPath: normalizeRootPath(settings.rootPath),
    readText: (path) => wrap(() => getFile(config, path)),
    readBinary: (path) => wrap(() => getFileBinary(config, path)),
    head: (path): Promise<FileHead | null> => wrap(() => headFile(config, path)),
    list: (path): Promise<FileEntry[]> => wrap(() => listDirectory(config, path)),
    writeText: (path, body, contentType) => wrap(() => putFile(config, path, body, contentType)),
    writeBinary: (path, body, contentType) =>
      wrap(() => putFileBinary(config, path, body, contentType)),
    ensureDir: (paths) => wrap(() => ensureDirectory(config, paths)),
    deleteDir: (path) => wrap(() => deleteDirectory(config, path)),
  };

  if (isTauriAppPlatform()) {
    const authHeaders = (): Record<string, string> => ({
      Authorization: buildBasicAuthHeader(settings.username, settings.password),
    });

    // The Tauri transfer primitives emit per-chunk progress via a Channel.
    // `runTransfer` wraps one so that:
    //   1. byte progress is throttled to ~250ms and forwarded as StreamProgress
    //      (the sync UI renders "Uploading 1.2 GB / 1.1 GB" instead of freezing
    //      for the whole gigabyte — progress signals were being dropped before);
    //   2. a transfer that goes silent for `STALL_TIMEOUT_MS` rejects locally
    //      instead of awaiting forever. This is the last line of defence for
    //      links the Rust `read_timeout` can't cover (older APKs, a wedged
    //      command); a live-but-slow transfer keeps re-arming the timer via
    //      every progress chunk, so it can never false-positive.
    const STALL_TIMEOUT_MS = 90_000;
    const runTransfer = (
      onProgress: ((p: StreamProgress) => void) | undefined,
      start: (handler: ProgressHandler) => Promise<unknown>,
    ): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const settle = (ok: boolean) => {
          if (settled) return;
          settled = true;
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = null;
          resolve(ok);
        };
        const armStall = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            stallTimer = null;
            console.warn('WebDAVProvider: transfer stalled, rejecting');
            settle(false);
          }, STALL_TIMEOUT_MS);
        };
        const throttle = createProgressThrottle(
          (p: ProgressPayload) =>
            onProgress?.({
              progress: p.progress,
              total: p.total,
              transferSpeed: p.transferSpeed,
            }),
          250,
        );
        // Any progress chunk re-arms the stall timer — the link is alive.
        const handler: ProgressHandler = (p) => {
          throttle.push(p);
          armStall();
        };
        armStall();
        start(handler)
          .then(() => {
            throttle.flush();
            settle(true);
          })
          .catch((e) => {
            console.warn('WebDAVProvider: transfer failed', e);
            settle(false);
          });
      });

    provider.uploadStream = async (remotePath, localPath, onProgress) => {
      const url = buildRequestUrl(settings.serverUrl, remotePath);
      return runTransfer(onProgress, (handler) =>
        // tauriUpload's TS type says Map, but the Rust command accepts a JSON
        // object → HashMap<String, String>; pass the headers object directly.
        tauriUpload(
          url,
          localPath,
          'PUT',
          handler,
          authHeaders() as unknown as Map<string, string>,
        ),
      );
    };
    provider.downloadStream = async (remotePath, localPath, onProgress) => {
      const url = buildRequestUrl(settings.serverUrl, remotePath);
      return runTransfer(onProgress, (handler) =>
        tauriDownload(url, localPath, handler, authHeaders()),
      );
    };
  }

  return provider;
};
