import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteLegacyRuntimeCaches, isPublicStaticAsset } from '@/lib/security/service-worker-cache';

const worker = vi.hoisted(() => ({
  options: null as unknown,
  events: new Map<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void>(),
}));
vi.mock('serwist', () => ({
  Serwist: class {
    constructor(options: unknown) { worker.options = options; }
    addEventListeners() {}
  },
  CacheFirst: class {},
  ExpirationPlugin: class {},
  NetworkOnly: class {},
}));

const origin = 'https://app.example.test';

describe('service worker: cache never crosses account boundaries', () => {
  it.each([
    '/dashboard', '/invoices', '/expenses/id', '/accountant/private-token',
    '/api/gdpr/export', '/api/invoices/id/pdf', '/api/invoices/batch-pdf?from=2026-09-01',
    '/invoices?_rsc=token', '/_next/data/build/dashboard.json',
    '/_next/image?url=https%3A%2F%2Fstorage.example.test%2Fprivate.png',
    '/private.xml', '/private.csv', '/private.jpg',
    '/_next/static/chunks/app.js?token=private', '/_next/static/chunks/app.js.map',
    'https://storage.example.test/tenant-a/invoice.png?X-Amz-Signature=test',
    'https://other.example.test/_next/static/app.js',
  ])('does not persist private or dynamically generated response %s', (url) => {
    expect(isPublicStaticAsset(new URL(url, origin), origin)).toBe(false);
  });

  it.each([
    '/_next/static/chunks/app-abc123.js', '/_next/static/css/app.css',
    '/_next/static/media/font.woff2', '/icons/icon-192x192.png', '/favicon.ico', '/icon.svg',
  ])('allows a known public static resource %s', (url) => {
    expect(isPublicStaticAsset(new URL(url, origin), origin)).toBe(true);
  });

  it('deletes legacy page, API, RSC, image and cross-origin caches but preserves new static assets', async () => {
    const names = [
      'apis', 'pages-rsc', 'pages-rsc-prefetch', 'pages', 'others', 'cross-origin',
      'static-data-assets', 'static-image-assets', 'next-image', 'next-data', 'start-url',
      'faktflow-public-static-v1', 'serwist-precache-v2-current',
    ];
    const remove = vi.fn().mockResolvedValue(true);
    await deleteLegacyRuntimeCaches({ keys: async () => names, delete: remove });
    expect(remove.mock.calls.map(([name]) => name)).toEqual(names.slice(0, -2));
  });
});

describe('service worker integration', () => {
  beforeEach(() => { vi.resetModules(); worker.events.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('applies the allowlist to precache/runtime routes and cleans stale data during activation', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('self', {
      location: { origin },
      __SW_MANIFEST: [
        { url: '/_next/static/chunks/app.js', revision: 'one' },
        { url: '/dashboard', revision: 'one' },
        { url: '/api/gdpr/export', revision: 'one' },
        '/icon.svg',
      ],
      caches: { keys: async () => ['apis', 'pages-rsc', 'faktflow-public-static-v1'], delete: remove },
      addEventListener: (type: string, listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void) => worker.events.set(type, listener),
    });
    await import('@/app/sw');
    const { NetworkOnly } = await import('serwist');
    const options = worker.options as {
      precacheEntries: Array<{ url: string; revision: string } | string>;
      runtimeCaching: Array<{
        matcher: (input: { url: URL; request: Request }) => boolean;
        handler: unknown;
      }>;
    };
    expect(options.precacheEntries).toEqual([
      { url: '/_next/static/chunks/app.js', revision: 'one' }, '/icon.svg',
    ]);
    expect(options.runtimeCaching).toHaveLength(2);
    const staticRoute = options.runtimeCaching[0]!;
    const staticUrl = new URL('/_next/static/chunks/app.js', origin);
    expect(staticRoute.matcher({ url: staticUrl, request: new Request(staticUrl) })).toBe(true);
    expect(staticRoute.matcher({
      url: staticUrl, request: new Request(staticUrl, { headers: { RSC: '1' } }),
    })).toBe(false);
    expect(staticRoute.matcher({
      url: staticUrl, request: new Request(staticUrl, { headers: { authorization: 'Bearer fake' } }),
    })).toBe(false);
    const privateUrl = new URL('/api/gdpr/export', origin);
    expect(staticRoute.matcher({ url: privateUrl, request: new Request(privateUrl) })).toBe(false);
    expect(options.runtimeCaching[1]!.handler).toBeInstanceOf(NetworkOnly);
    let cleanup: Promise<unknown> | undefined;
    worker.events.get('activate')!({ waitUntil: (promise) => { cleanup = promise; } });
    await cleanup;
    expect(remove.mock.calls.map(([name]) => name)).toEqual(['apis', 'pages-rsc']);
  });
});
