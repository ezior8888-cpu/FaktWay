/**
 * The Cache API does not enforce HTTP no-store. Cache only static build assets
 * and public icons; HTML, RSC, API responses and signed document URLs stay online.
 */
export function isPublicStaticAsset(url: URL, origin: string): boolean {
  if (url.origin !== origin || url.search || url.hash) return false;
  return (
    (url.pathname.startsWith('/_next/static/') &&
      /\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|webp|avif|svg|ico)$/.test(url.pathname)) ||
    // Logo i ikony z `public/` (docs/brand/logo/zrodla/aplikacja.py).
    (url.pathname.startsWith('/icons/') && /\.png$/.test(url.pathname)) ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/icon.svg'
  );
}

const LEGACY_RUNTIME_CACHES = new Set([
  'google-fonts-webfonts', 'google-fonts-stylesheets', 'static-font-assets',
  'static-image-assets', 'next-static-js-assets', 'next-image',
  'static-audio-assets', 'static-video-assets', 'static-js-assets',
  'static-style-assets', 'next-data', 'static-data-assets', 'apis',
  'pages-rsc-prefetch', 'pages-rsc', 'pages', 'others', 'cross-origin', 'start-url',
]);

/** Remove data saved by the previous defaultCache policy on worker activation. */
export async function deleteLegacyRuntimeCaches(
  storage: Pick<CacheStorage, 'keys' | 'delete'>,
): Promise<void> {
  const names = await storage.keys();
  await Promise.all(
    names.filter((name) => LEGACY_RUNTIME_CACHES.has(name)).map((name) => storage.delete(name)),
  );
}
