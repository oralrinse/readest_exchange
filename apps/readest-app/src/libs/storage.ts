import { AppService } from '@/types/system';
import { tauriDownload, webDownload, ProgressHandler, ProgressPayload } from '@/utils/transfer';
import { isWebAppPlatform } from '@/services/environment';

export const createProgressHandler = (
  totalFiles: number,
  completedFilesRef: { count: number },
  onProgress?: ProgressHandler,
) => {
  return (progress: ProgressPayload) => {
    const fileProgress = progress.progress / progress.total;
    const overallProgress = ((completedFilesRef.count + fileProgress) / totalFiles) * 100;

    if (onProgress) {
      onProgress({
        progress: overallProgress,
        total: 100,
        transferSpeed: progress.transferSpeed,
      });
    }
  };
};

type DownloadFileParams = {
  appService: AppService;
  dst: string;
  url: string;
  headers?: Record<string, string>;
  singleThreaded?: boolean;
  skipSslVerification?: boolean;
  onProgress?: ProgressHandler;
};

/**
 * Download `url` (a pre-signed URL from a file-sync backend, an OPDS catalog,
 * or any direct download link) into `dst` via the platform downloader. Readest
 * Cloud storage was removed, so there is no account-scoped `/storage/download`
 * branch anymore — every caller has an explicit `url`.
 */
export const downloadFile = async ({
  appService,
  dst,
  url,
  headers,
  singleThreaded,
  skipSslVerification,
  onProgress,
}: DownloadFileParams) => {
  if (!url) {
    throw new Error('No download URL available');
  }

  if (isWebAppPlatform()) {
    const { headers: responseHeaders, blob } = await webDownload(url, onProgress, headers);
    await appService.writeFile(dst, 'None', await blob.arrayBuffer());
    return responseHeaders;
  } else {
    return await tauriDownload(
      url,
      dst,
      onProgress,
      headers,
      undefined,
      singleThreaded,
      skipSslVerification,
    );
  }
};
