import { Book } from '@/types/book';

/**
 * True when the URL is fetchable by external services (Readwise, markdown
 * readers), i.e. not a local dev server or the Tauri asset protocol.
 */
export const isPublicImageUrl = (url?: string | null): url is string =>
  !!url && /^https?:\/\/(?!localhost|127\.|asset\.localhost)/.test(url);

/**
 * Resolve a publicly accessible cover image URL for the book, or undefined
 * when none can be provided. Readest Cloud storage was removed, so there is no
 * public bucket to publish the local cover.png to anymore — an already-public
 * `coverImageUrl` from the book metadata is the only source left. External
 * consumers (Readwise, markdown export) tolerate `undefined` and simply omit
 * the cover.
 */
export const getPublicCoverUrl = async (book: Book): Promise<string | undefined> => {
  if (isPublicImageUrl(book.coverImageUrl)) return book.coverImageUrl;
  return undefined;
};
