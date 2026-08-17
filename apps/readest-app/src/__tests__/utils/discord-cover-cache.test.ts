import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';

// Readest Cloud storage was removed — there is no public bucket to publish a
// processed cover to anymore. Rich Presence updates with title/author and a
// null coverUrl; the old upload/backoff/negative-cache machinery is gone.

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

const BOOK = {
  hash: 'bookhash1234',
  title: 'Lord of the Flies',
  author: 'William Golding',
  coverHash: 'coverhashabcd',
} as Book;

const makeAppService = (): AppService => ({ isDesktopApp: true }) as unknown as AppService;

const loadDiscord = async () => {
  vi.resetModules();
  return import('@/utils/discord');
};

const lastPresence = () =>
  invokeMock.mock.calls.filter((c) => c[0] === 'update_book_presence').at(-1)?.[1] as
    | {
        presence: {
          bookHash: string;
          title: string;
          author: string | null;
          coverUrl: string | null;
          sessionStart: number;
        };
      }
    | undefined;

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
});

describe('Discord presence without Readest Cloud cover upload', () => {
  it('updates presence with title/author and a null coverUrl', async () => {
    const { updateDiscordPresence } = await loadDiscord();
    await updateDiscordPresence(BOOK, 12345, makeAppService());

    const call = lastPresence();
    expect(call?.presence).toMatchObject({
      bookHash: 'bookhash1234',
      title: 'Lord of the Flies',
      author: 'William Golding',
      coverUrl: null,
      sessionStart: 12345,
    });
  });

  it('does not attempt to upload, resolve, or read any cover file', async () => {
    const { updateDiscordPresence } = await loadDiscord();
    const spies = {
      uploadFileToCloud: vi.fn(),
      exists: vi.fn(),
      resolveFilePath: vi.fn(),
      writeFile: vi.fn(),
    };
    const appService = {
      isDesktopApp: true,
      ...spies,
    } as unknown as AppService;

    await updateDiscordPresence(BOOK, 12345, appService);

    expect(spies.uploadFileToCloud).not.toHaveBeenCalled();
    expect(spies.exists).not.toHaveBeenCalled();
    expect(spies.resolveFilePath).not.toHaveBeenCalled();
    expect(spies.writeFile).not.toHaveBeenCalled();
  });

  it('keeps presence updates idempotent on repeat ticks (no caching machinery)', async () => {
    const { updateDiscordPresence } = await loadDiscord();
    const appService = makeAppService();

    await updateDiscordPresence(BOOK, 12345, appService);
    await updateDiscordPresence(BOOK, 12346, appService);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(lastPresence()?.presence.sessionStart).toBe(12346);
  });

  it('is a no-op outside the desktop app', async () => {
    const { updateDiscordPresence } = await loadDiscord();
    const appService = { isDesktopApp: false } as unknown as AppService;

    await updateDiscordPresence(BOOK, 12345, appService);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('clears presence without touching covers', async () => {
    const { clearDiscordPresence } = await loadDiscord();

    await clearDiscordPresence(makeAppService());

    expect(invokeMock).toHaveBeenCalledWith('clear_book_presence');
  });
});
