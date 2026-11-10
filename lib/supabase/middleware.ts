import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getPanelMfaState } from '@/lib/auth/panel-mfa';
import { PASSKEY_SESSION_COOKIE } from '@/lib/auth/passkey/session-marker';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { isMaintenanceMode, MAINTENANCE_PATH } from '@/lib/feature-flags/maintenance';
import { isTelemetryTunnelPath } from '@/lib/telemetry-tunnel';

import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_HEADER, isUuid } from './active-org';
import { createAuthUserFetch } from './auth-user-fetch';

/**
 * Ścieżki marketingowe — dostęp bez logowania (spec 19.1.3).
 * Dopasowanie: dokładnie `p` albo prefiks `p/`.
 */
export const MARKETING_PATHS = [
  '/',
  '/pricing',
  '/blog',
  '/vs',
  '/kalkulator-oszczednosci',
  '/kontakt',
  '/legal',
  '/pomoc',
  '/mobile',
  '/about',
] as const;

const AUTH_PUBLIC_PREFIXES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/auth',
  '/onboarding',
  '/invite',
  '/accountant',
  // Od sesji 31 planu skalowania `/share-target` jest poza matcherem proxy
  // (`proxy.ts`) i sam sprawdza sesję. Wpis zostaje jako zabezpieczenie:
  // gdyby trasa wróciła pod proxy, POST bez sesji nie może skończyć się
  // przekierowaniem, które gubi ciało.
  '/share-target',
  '/gdpr',
] as const;

const PUBLIC_API_PREFIXES = [
  '/api/health',
  '/api/status',
  '/api/portal',
  '/api/email',
  // Logowanie biometrią jest przed sesją. Dodawanie i usuwanie urządzeń
  // (`/api/auth/passkey`, `/register`, `/[id]`) zostaje za bramką.
  '/api/auth/passkey/login',
  // Dev-only diagnostyka (route sam zwraca 404 na production)
  '/api/dev',
] as const;

// Stripe authenticates this one endpoint with its raw-body signature.
// Billing APIs and any nested paths must still require a user session.
const PUBLIC_API_EXACT = ['/api/stripe/webhook'] as const;

/**
 * Ścieżki obsługiwane BEZ klienta Supabase: proxy nie czyta sesji, nie
 * odświeża ciasteczek i nie woła GoTrue (przy kluczu HS256 każde sprawdzenie
 * sesji to wywołanie sieciowe). Tylko trasy, które nie zależą od tego, kto
 * pyta, i nie zwracają danych firmy. Odpowiedź nie niesie `Set-Cookie`, więc
 * trasa może ją oznaczyć jako cache'owalną. Wszystkie są publiczne
 * (`isPublicPath`).
 * `exact` — tylko `path`; `prefix` — `path` albo `path/…`. Trasy API dawaj
 * jako `exact`: sąsiednie trasy (`/api/ksef/...`) zostają za bramką.
 */
const NO_SESSION_PATHS: readonly { path: string; match: 'exact' | 'prefix' }[] = [
  // baner KSeF w każdej karcie panelu (plan skalowania, sesja 1)
  { path: '/api/ksef/health', match: 'exact' },
  // stan wdrożenia dla workflowu `obrazy.yml`; trasa sama sprawdza token
  // (plan usprawnień 3.1)
  { path: '/api/ops/deploy-state', match: 'exact' },
  // Pliki techniczne (plan skalowania, sesja 2). Przeglądarka sprawdza `/sw.js`
  // przy pełnych nawigacjach w zasięgu workera i pobiera manifest, a roboty
  // wyszukiwarek pobierają `robots.txt` i `sitemap.xml`. Żaden nie zależy od
  // tego, kto pyta. `robots.txt` i `sitemap.xml` muszą zostać publiczne:
  // do 1.10.2026 kończyły się przekierowaniem na /login.
  { path: '/sw.js', match: 'exact' },
  { path: '/manifest.webmanifest', match: 'exact' },
  { path: '/robots.txt', match: 'exact' },
  { path: '/sitemap.xml', match: 'exact' },
  // Podgląd linku: obrazek statyczny, ten sam dla każdego. Do 1.10.2026
  // kończył się przekierowaniem na /login.
  { path: '/opengraph-image', match: 'exact' },
  // Tu kieruje bramka przerwy technicznej, więc musi być osiągalna. Strona jest
  // statyczna i nie czyta sesji, a powrót do panelu znów przechodzi bramkę.
  { path: MAINTENANCE_PATH, match: 'exact' },
];

export function isNoSessionPath(pathname: string): boolean {
  // Tunele PostHog i Sentry mają własny mechanizm (`lib/telemetry-tunnel.ts`,
  // wołany w `proxy.ts` przed `updateSession`: zdejmuje też ciasteczka).
  // Delegacja zamiast drugiego wpisu — jedna lista, żeby obie ścieżki nie
  // rozjechały się przy następnej zmianie przepisań w `next.config.ts`.
  if (isTelemetryTunnelPath(pathname)) return true;
  return NO_SESSION_PATHS.some(({ path, match }) =>
    pathname === path || (match === 'prefix' && pathname.startsWith(`${path}/`)),
  );
}

export function isMarketingPath(pathname: string): boolean {
  return MARKETING_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Trasy dostępne bez sesji (techniczne + marketing + auth + wybrane API).
 * Całość `/api/*` NIE jest publiczna — tylko jawne prefiksy (bezpieczeństwo).
 */
export function isPublicPath(pathname: string): boolean {
  // Obejmuje `NO_SESSION_PATHS` i tunele telemetrii (PostHog musi być
  // publiczny: skrypt ładuje się przed logowaniem). `startsWith('/ingest')`
  // robiło publicznymi też `/ingestion` i `/ingest-raport`, których Next
  // nie przepisuje do PostHog.
  if (isNoSessionPath(pathname)) return true;
  if (isMarketingPath(pathname)) return true;
  if (pathname.startsWith('/api/')) {
    return PUBLIC_API_EXACT.some((p) => pathname === p) || PUBLIC_API_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
  }
  return isAuthPublicPath(pathname);
}

/** Trasy logowania/rejestracji — dostępne bez sesji. */
export function isAuthPublicPath(pathname: string): boolean {
  return AUTH_PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

const APP_HOME = '/dashboard';

/**
 * Proxy / „middleware” — odświeżenie sesji Supabase + reguły routingu.
 *
 * Reguły:
 *  0. Zalogowany na `/` (landing) → `APP_HOME` (pulpit aplikacji).
 *  1. Niezalogowany na trasie spoza `isPublicPath` → `/login?redirect=…`.
 *  2. Zalogowany na /login lub /register → `APP_HOME`.
 *  3. Bootstrap `ksef.active_org` na chronionych trasach (bez /onboarding, bez /api).
 *  4. /onboarding — bez redirectu z proxy (soft-nav loop); strona sama decyduje.
 */
export async function updateSession(request: NextRequest) {
  // Przed `createServerClient`: bez klienta nie ma `getClaims()` ani
  // odświeżenia ciasteczek (zob. `NO_SESSION_PATHS`).
  if (isNoSessionPath(request.nextUrl.pathname)) return NextResponse.next();

  let supabaseResponse = NextResponse.next({ request });
  // Nagłówki, które `@supabase/ssr` podaje w `setAll` razem z ciasteczkami
  // sesji (`Cache-Control: private, no-store…`, `Expires`, `Pragma`). Odpowiedź
  // z odświeżonym ciasteczkiem nie może trafić do wspólnego cache'u (CDN,
  // reverse proxy) — oddałby cudzą sesję następnemu klientowi. Next nie
  // nadpisuje `Cache-Control` ustawionego w proxy, więc ten nagłówek wygrywa
  // też z `public, s-maxage` trasy i z cache'em statycznej strony. Jadą z KAŻDĄ
  // odpowiedzią niosącą ciasteczka sesji, dlatego kopiuje je `withSessionCookies`.
  let sessionCacheHeaders: Record<string, string> = {};

  function withSessionCookies(response: NextResponse): NextResponse {
    for (const cookie of supabaseResponse.cookies.getAll()) response.cookies.set(cookie);
    for (const [name, value] of Object.entries(sessionCacheHeaders)) response.headers.set(name, value);
    return response;
  }
  function denyApi(error: string, status: number): NextResponse {
    return withSessionCookies(NextResponse.json({ error }, {
      status, headers: { 'Cache-Control': 'no-store' },
    }));
  }

  const activeOrgCookie = request.cookies.get(ACTIVE_ORG_COOKIE)?.value;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
          sessionCacheHeaders = headers;
          for (const [name, value] of Object.entries(headers)) supabaseResponse.headers.set(name, value);
        },
      },
      global: {
        // Wszystkie sprawdzenia tokenu w tym żądaniu dzielą jedną odpowiedź GoTrue.
        fetch: createAuthUserFetch(),
        ...(isUuid(activeOrgCookie) ? { headers: { [ACTIVE_ORG_HEADER]: activeOrgCookie } } : {}),
      },
    },
  );

  // Audyt przedlaunchowy (blok A5): `getClaims()` zamiast `getUser()`.
  // `getUser()` robił sieciowy round-trip do GoTrue na KAŻDE żądanie HTML —
  // przy kilku tysiącach userów to główny mnożnik latencji proxy.
  // `getClaims()`:
  //   - odświeża sesję jak dotąd (network tylko gdy token wygasł),
  //   - przy asymetrycznych JWT signing keys weryfikuje podpis LOKALNIE
  //     (JWKS cache — zero round-tripów w hot path),
  //   - przy legacy HS256 sam spada do `getUser()` — zachowanie identyczne
  //     jak przed zmianą, więc migracja kluczy w dashboardzie Supabase
  //     jest przełącznikiem wydajności, nie warunkiem poprawności.
  // Trade-off: przy weryfikacji lokalnej unieważniona sesja (force-logout)
  // żyje w proxy do wygaśnięcia access tokenu (~1h max). Akceptowalne:
  // każda mutacja i odczyt danych przechodzi przez Server Action / route,
  // które robią pełny `auth.getUser()` w `requireUserAndActiveOrg()`.
  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims.sub ?? null;

  const path = request.nextUrl.pathname;
  const isApi = path === '/api' || path.startsWith('/api/');
  const isAdmin = path === '/admin' || path.startsWith('/admin/');

  // Zalogowany na landingu jedzie na `APP_HOME`, także z telefonu: panel jest
  // dostępny na każdym urządzeniu (FaktWay 1.0, bez bramki BUG-008).
  if (userId && path === '/') {
    const url = request.nextUrl.clone();
    url.pathname = APP_HOME;
    url.search = '';
    const res = NextResponse.redirect(url);
    withSessionCookies(res);
    return res;
  }

  if (!userId && !isPublicPath(path)) {
    if (isApi) {
      return denyApi('not_authenticated', 401);
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', path);
    const res = NextResponse.redirect(url);
    withSessionCookies(res);
    return res;
  }

  if (userId && (path === '/login' || path === '/register')) {
    const url = request.nextUrl.clone();
    url.pathname = APP_HOME;
    url.search = '';
    const res = NextResponse.redirect(url);
    withSessionCookies(res);
    return res;
  }

  // AUD-63: przerwa techniczna (`maintenanceMode`) blokuje panel zalogowanego,
  // także onboarding (zapisy w bazie). Poza bramką: strony publiczne, /admin
  // (operator) i logowanie. Przed MFA i danymi firmy — w przerwie nie
  // dotykamy bazy bardziej, niż trzeba.
  const isOnboarding = path === '/onboarding' || path.startsWith('/onboarding/');
  if (userId && !isAdmin && (!isPublicPath(path) || isOnboarding) && await isMaintenanceMode()) {
    if (isApi) return denyApi('maintenance', 503);
    const url = request.nextUrl.clone();
    url.pathname = MAINTENANCE_PATH;
    url.search = '';
    return withSessionCookies(NextResponse.redirect(url));
  }

  // Recheck authoritative factors and the claims of the exact session token.
  // The SDK's no-argument AAL helper reads session.user from client cookies.
  // Private APIs must enforce the same policy as HTML before any org lookup.
  // Sesja po biometrii (znacznik tej sesji) przechodzi przez panel bez kodu;
  // `/admin` zawsze wymaga prawdziwego kodu, a tu zachowujemy też głęboki link.
  if (userId && !isPublicPath(path)) {
    const state = await (isAdmin
      ? getVerifiedMfaState(supabase)
      : getPanelMfaState(supabase, () => request.cookies.get(PASSKEY_SESSION_COOKIE)?.value)
    ).catch(() => null);
    const verificationFailed = !state ||
      (state.status !== 'unauthenticated' && state.user.id !== userId);
    if (verificationFailed) {
      return isApi
        ? denyApi('session_verification_failed', 503)
        : withSessionCookies(new NextResponse('Nie udało się zweryfikować sesji. Spróbuj ponownie.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        }));
    }
    if (state.status === 'unauthenticated') {
      if (isApi) return denyApi('not_authenticated', 401);
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.search = '';
      url.searchParams.set('redirect', path);
      const res = NextResponse.redirect(url);
      withSessionCookies(res);
      return res;
    }
    if (state.status === 'challenge_required') {
      if (isApi) return denyApi('mfa_required', 403);
      const url = request.nextUrl.clone();
      url.pathname = '/login/two-factor';
      url.search = '';
      url.searchParams.set('redirect', path);
      const res = NextResponse.redirect(url);
      withSessionCookies(res);
      return res;
    }
  }

  const needsBootstrap =
    !!userId && !isPublicPath(path) && !isApi && !isAdmin && !isUuid(activeOrgCookie);

  if (needsBootstrap) {
    const { data: candidates } = await supabase
      .from('memberships')
      .select('organization_id, joined_at')
      .eq('user_id', userId!)
      .eq('status', 'active')
      .order('joined_at', { ascending: false })
      .limit(50);

    const memberships = candidates ?? [];

    if (memberships.length === 0) {
      const url = request.nextUrl.clone();
      url.pathname = '/onboarding';
      url.search = '';
      const res = NextResponse.redirect(url);
      withSessionCookies(res);
      return res;
    }

    const { data: profile } = await supabase
      .from('users')
      .select('last_active_tenant_id')
      .eq('id', userId!)
      .maybeSingle();

    const lastActive = profile?.last_active_tenant_id ?? null;
    const preferred = memberships.find((m) => m.organization_id === lastActive);
    const choice = preferred?.organization_id ?? memberships[0]!.organization_id;

    const targetUrl = request.nextUrl.clone();
    const res = NextResponse.redirect(targetUrl);
    withSessionCookies(res);
    res.cookies.set({
      name: ACTIVE_ORG_COOKIE,
      value: choice,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  return supabaseResponse;
}
