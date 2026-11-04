import { NextResponse, type NextRequest } from 'next/server';

import {
  isLegacyHostRedirectEnabled,
  legacyHostRedirectTarget,
  requestHost,
} from '@/lib/legacy-host-redirect';
import { siteUrl } from '@/lib/site';
import { updateSession } from '@/lib/supabase/middleware';
import { isTelemetryTunnelPath, passTelemetryTunnel } from '@/lib/telemetry-tunnel';

/**
 * Next.js 16+ Proxy (konwencja zamiast root `middleware.ts`) — każde żądanie
 * przed renderem. Logika sesji i reguł routingu: `lib/supabase/middleware.ts`.
 *
 * ─── PostHog (wizard często myli ten plik) ───
 * NIE wklejaj tu `import { PostHog } from 'posthog-node'` ani `const client = new PostHog(...)`.
 * Ten plik jest bundlowany pod Edge — `posthog-node` zwykle nie działa i psuje build.
 *
 * Gdzie jest to, o co prosi wizard:
 *   • Token (Project API Key): `.env.local` → `NEXT_PUBLIC_POSTHOG_KEY` (nie `phc_` w kodzie)
 *   • `new PostHog(...)`: `lib/analytics/posthog-node-client.ts` → `getPostHogNodeClient()`
 *   • `await client.shutdown()`: `lib/analytics/posthog-process-shutdown.ts`
 *     (rejestracja SIGINT/SIGTERM z `instrumentation.ts` przy starcie Node)
 *   • Przeglądarka ($pageview): `instrumentation-client.ts` → `initPosthogBrowser()`
 *   • Reverse proxy eventów: `next.config.ts` → `/ingest`
 */
export async function proxy(request: NextRequest) {
  // Stara domena faktflow.pl → faktway.pl (włączane LEGACY_HOST_REDIRECT=1).
  if (isLegacyHostRedirectEnabled()) {
    const target = legacyHostRedirectTarget({
      method: request.method,
      host: requestHost(request.headers),
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      target: siteUrl(),
    });
    if (target) return NextResponse.redirect(target, 308);
  }
  // Tunele PostHog i Sentry: bez sesji i bez ciasteczek (`lib/telemetry-tunnel.ts`).
  if (isTelemetryTunnelPath(request.nextUrl.pathname)) return passTelemetryTunnel(request);
  return await updateSession(request);
}

export const config = {
  // Lista rozszerzeń musi obejmować KAŻDY typ pliku serwowany z `public/`.
  // Czego tu nie ma, to leci przez bramkę auth i kończy przekierowaniem na
  // `/login` — dla obrazka widać to od razu, dla wideo objawia się tylko
  // cichym błędem dekodera w przeglądarce.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|mp4|webm|mov|woff|woff2)$).*)',
    // Tunel PostHog w całości, także pliki z rozszerzeniem z listy wyżej
    // i każdy zapis wielkości liter (Next przepisuje `/Ingest/…` tak samo):
    // tylko proxy zdejmuje z niego ciasteczka (`lib/telemetry-tunnel.ts`).
    '/:tunnel([iI][nN][gG][eE][sS][tT])/:path*',
  ],
};
