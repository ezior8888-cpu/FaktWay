// app/sw.ts
// Service worker dla FaktWay — offline caching + push notifications
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist } from 'serwist';
import { deleteLegacyRuntimeCaches, isPublicStaticAsset } from '@/lib/security/service-worker-cache';

// Augmentacja typów — SW ma własny scope globalny (`injectionPoint` domyślnie `self.__SW_MANIFEST`)
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: (self.__SW_MANIFEST ?? []).filter((entry) =>
    isPublicStaticAsset(new URL(typeof entry === 'string' ? entry : entry.url, self.location.origin), self.location.origin),
  ),
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ url, request }) =>
        request.method === 'GET' &&
        !request.headers.has('authorization') &&
        !request.headers.has('RSC') &&
        isPublicStaticAsset(url, self.location.origin),
      handler: new CacheFirst({
        cacheName: 'faktflow-public-static-v1',
        plugins: [new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 7 * 24 * 60 * 60 })],
      }),
    },
    // No offline fallback to a previous user's page or document after logout.
    { matcher: () => true, handler: new NetworkOnly() },
  ],
});

self.addEventListener('activate', (event) => {
  event.waitUntil(deleteLegacyRuntimeCaches(self.caches));
});

// Push notification handler (subskrypcja — zadanie 17.7)
//
// PRZYCISKI AKCJI (krok 23 toru B): agent może dołożyć do powiadomienia
// jeden przycisk — „pokaż” przy propozycji do decyzji albo „cofnij” przy
// czynności, którą zrobił sam. Nic się przez nie nie wysyła: przycisk otwiera
// aplikację na właściwej karcie, bo zgoda na wysyłkę zapada po obejrzeniu
// podglądu, a nie na ekranie blokady telefonu.
//
// `tag` = klucz sprawy. Dwa zdarzenia tej samej sprawy mają ten sam tag, więc
// drugie POWIADOMIENIE PODMIENIA pierwsze zamiast się obok niego kłaść.
// Bez tego klient po dniu ma osiem powiadomień o jednej fakturze.
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json() as {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    url?: string;
    tag?: string;
    actions?: { action: string; title: string }[];
    /** dokąd prowadzi konkretny przycisk, gdy inaczej niż `url` */
    actionUrls?: Record<string, string>;
  };

  const notificationOpts: NotificationOptions & {
    vibrate?: number[];
    actions?: { action: string; title: string }[];
  } = {
    body: data.body,
    icon: data.icon ?? '/icons/icon-192x192.png',
    // Android rysuje plakietkę z samej przezroczystości, więc biała sylwetka znaku.
    badge: data.badge ?? '/icons/badge-72x72.png',
    tag: data.tag,
    // `renotify` bez `tag` jest błędem — stąd warunek.
    ...(data.tag ? { renotify: true } : {}),
    actions: data.actions?.slice(0, 2),
    data: { url: data.url ?? '/', actionUrls: data.actionUrls ?? {} },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, notificationOpts),
  );
});

// Klik w notyfikację — otwórz odpowiednią stronę w aplikacji
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const payload = event.notification.data as {
    url?: string;
    actionUrls?: Record<string, string>;
  };

  // Kliknięcie w przycisk prowadzi tam, gdzie ta konkretna akcja ma sens
  // (np. karta z paskiem cofnięcia); kliknięcie w samo powiadomienie —
  // do sprawy.
  const targetUrl =
    (event.action ? payload?.actionUrls?.[event.action] : undefined) ??
    payload?.url ??
    '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(targetUrl) && 'focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }),
  );
});

serwist.addEventListeners();
