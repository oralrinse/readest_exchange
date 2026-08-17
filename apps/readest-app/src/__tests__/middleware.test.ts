import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const coep = (path: string) =>
  middleware(new NextRequest(`http://localhost:3000${path}`)).headers.get(
    'Cross-Origin-Embedder-Policy',
  );

describe('middleware CORS preflight', () => {
  const preflight = (requestedHeaders?: string) =>
    middleware(
      new NextRequest('https://web.readest.com/api/sync', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://tauri.localhost',
          'access-control-request-method': 'POST',
          ...(requestedHeaders && { 'access-control-request-headers': requestedHeaders }),
        },
      }),
    );

  it('echoes the requested headers instead of a wildcard so the preflight cache covers Authorization', () => {
    // The Fetch spec excludes Authorization from wildcard matching in the
    // preflight cache, so `Allow-Headers: *` forces a fresh OPTIONS round trip
    // before every authenticated API call despite Max-Age (readest-web was
    // serving ~4M preflights/day because of this).
    const res = preflight('authorization,content-type');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('authorization,content-type');
    expect(res.headers.get('Vary')).toContain('Access-Control-Request-Headers');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('allows Authorization and Content-Type when the preflight requests no headers', () => {
    const res = preflight();
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
  });
});

describe('middleware cross-origin isolation headers', () => {
  it('applies require-corp on every document route (no /s share landing anymore)', () => {
    // Readest Cloud share links were removed — the /s landing that needed
    // COEP credentialless for its cross-origin R2 cover <img> is gone, so
    // every document route gets the same require-corp.
    expect(coep('/s')).toBe('require-corp');
    expect(coep('/s/Qmup0X1A8ovl2FmKJKA8mB')).toBe('require-corp');
  });

  it('keeps the stricter require-corp on every document route', () => {
    expect(coep('/')).toBe('require-corp');
    expect(coep('/library')).toBe('require-corp');
    // Must not be caught by a naive startsWith('/s').
    expect(coep('/settings')).toBe('require-corp');
    expect(coep('/search')).toBe('require-corp');
  });

  it('always pairs COOP same-origin on document responses', () => {
    const res = middleware(new NextRequest('http://localhost:3000/s/tok'));
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('does not put COEP on /api routes', () => {
    const res = middleware(new NextRequest('http://localhost:3000/api/opds/proxy/tok'));
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
  });
});
