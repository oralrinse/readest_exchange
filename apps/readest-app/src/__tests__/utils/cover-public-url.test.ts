import { describe, it, expect } from 'vitest';
import type { Book } from '@/types/book';
import { getPublicCoverUrl, isPublicImageUrl } from '@/utils/cover';

// Readest Cloud storage was removed, so covers are no longer published to a
// public bucket. A cover already backed by a public URL is returned as-is;
// otherwise there is no public URL to hand out (exports / Readwise / Discord
// degrade gracefully to coverless).

const makeBook = (hash: string, overrides: Partial<Book> = {}): Book =>
  ({
    hash,
    coverHash: `md5of${hash}`,
    title: 'T',
    author: 'A',
    ...overrides,
  }) as Book;

describe('isPublicImageUrl', () => {
  it('accepts http(s) URLs and rejects local ones', () => {
    expect(isPublicImageUrl('https://example.com/c.png')).toBe(true);
    expect(isPublicImageUrl('http://example.com/c.png')).toBe(true);
    expect(isPublicImageUrl('http://localhost:3000/c.png')).toBe(false);
    expect(isPublicImageUrl('http://127.0.0.1/c.png')).toBe(false);
    expect(isPublicImageUrl('https://asset.localhost/c.png')).toBe(false);
    expect(isPublicImageUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isPublicImageUrl(undefined)).toBe(false);
    expect(isPublicImageUrl(null)).toBe(false);
  });
});

describe('getPublicCoverUrl', () => {
  it('reuses an already-public coverImageUrl', async () => {
    const book = makeBook('aaa1', { coverImageUrl: 'https://example.com/cover.jpg' });

    await expect(getPublicCoverUrl(book)).resolves.toBe('https://example.com/cover.jpg');
  });

  it('returns undefined for a device-local cover URL (no public bucket anymore)', async () => {
    const book = makeBook('bbb2', { coverImageUrl: 'https://asset.localhost/cover.png' });

    await expect(getPublicCoverUrl(book)).resolves.toBeUndefined();
  });

  it('returns undefined when the book has no coverImageUrl', async () => {
    await expect(getPublicCoverUrl(makeBook('ccc3'))).resolves.toBeUndefined();
  });
});
