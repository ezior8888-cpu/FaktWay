import { NextResponse, type NextRequest } from 'next/server';

/**
 * Tunele telemetrii: ścieżki, które Next przepisuje na serwery zewnętrzne —
 * PostHog (`/ingest/*`, `next.config.ts` → `rewrites()`) i Sentry
 * (`tunnelRoute: '/monitoring'`, reguła `/monitoring(/?)` z `withSentryConfig`).
 * Bez względu na wielkość liter — tak dopasowuje przepisania Next (bez
 * `experimental.caseSensitiveRoutes`), więc `/Ingest/e` też idzie do PostHog.
 */
export function isTelemetryTunnelPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return (
    path === '/ingest' ||
    path.startsWith('/ingest/') ||
    path === '/monitoring' ||
    path === '/monitoring/'
  );
}

/**
 * Przepuszcza żądanie tunelu bez sesji Supabase i bez ciasteczek.
 *
 * Next wysyła do serwera docelowego nagłówki żądania z listy, którą oddaje
 * proxy, a każdy inny nagłówek odpowiedzi proxy dokleja do tego żądania
 * (`next/dist/server/lib/router-utils/resolve-routes.js`). Odpowiedź proxy
 * przy przepisaniu na zewnętrzny adres w ogóle nie trafia do przeglądarki.
 * Stąd dwie zasady:
 *  - bez `createServerClient`: sesja odświeżona tutaj nie dotarłaby do
 *    przeglądarki (zostałaby ze zużytym refresh tokenem), a nowe tokeny
 *    poszłyby w `set-cookie` do PostHog albo Sentry;
 *  - bez nagłówka `cookie`: ciasteczka sesji i wyboru firmy nie są
 *    potrzebne ani PostHog, ani Sentry.
 */
export function passTelemetryTunnel(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  return NextResponse.next({ request: { headers } });
}
