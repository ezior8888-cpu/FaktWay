import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { isMaintenanceMode, MAINTENANCE_PATH } from '@/lib/feature-flags/maintenance';

import { isMobilePanelAllowed, mobilePanelMode } from '@/lib/mobile-access';
import { isLocalDevEnv } from '@/lib/security/environment';

import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_HEADER, isUuid } from './active-org';

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
  '/share-target',
  '/gdpr',
] as const;

const PUBLIC_API_PREFIXES = [
  '/api/health',
  '/api/status',
  '/api/portal',
  '/api/email',
  // Dev-only diagnostyka (route sam zwraca 404 na production)
  '/api/dev',
] as const;

// Stripe authenticates this one endpoint with its raw-body signature.
// Billing APIs and any nested paths must still require a user session.
const PUBLIC_API_EXACT = ['/api/stripe/webhook'] as const;

const STATIC_PUBLIC_EXACT = [
  '/manifest.webmanifest',
  '/sw.js',
  '/monitoring', // Sentry `tunnelRoute`
  // Dla wyszukiwarek i podglądów linków. Bez tego (do 1.10.2026) wszystkie trzy
  // kończyły się przekierowaniem na /login.
  '/robots.txt',
  '/sitemap.xml',
  '/opengraph-image',
  MAINTENANCE_PATH, // tu kieruje bramka przerwy technicznej — musi być osiągalna
] as const;

/**
 * Ścieżki obsługiwane BEZ klienta Supabase: proxy nie czyta sesji, nie
 * odświeża ciasteczek i nie woła GoTrue (przy kluczu HS256 każde sprawdzenie
 * sesji to wywołanie sieciowe). Tylko trasy, które nie zależą od tego, kto
 * pyta, i nie zwracają danych firmy. Odpowiedź nie niesie `Set-Cookie`, więc
 * trasa może ją oznaczyć jako cache'owalną.
 * `exact` — tylko `path`; `prefix` — `path` albo `path/…`. Trasy API dawaj
 * jako `exact`: sąsiednie trasy (`/api/ksef/...`) zostają za bramką.
 */
const NO_SESSION_PATHS: readonly { path: string; match: 'exact' | 'prefix' }[] = [
  // baner KSeF w każdej karcie panelu (plan skalowania, sesja 1)
  { path: '/api/ksef/health', match: 'exact' },
];

export function isNoSessionPath(pathname: string): boolean {
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
 * Trasy dostępne bez sesji (marketing + auth + wybrane API + statyczne).
 * Całość `/api/*` NIE jest publiczna — tylko jawne prefiksy (bezpieczeństwo).
 */
export function isPublicPath(pathname: string): boolean {
  if (isNoSessionPath(pathname)) return true;
  // PostHog reverse proxy — musi być publiczny (skrypt ładuje się przed logowaniem).
  if (pathname.startsWith('/ingest')) return true;
  if (isMarketingPath(pathname)) return true;
  if (STATIC_PUBLIC_EXACT.some((p) => pathname === p)) return true;
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
 * BUG-008: telefony (nie tablety) nie wchodzą do panelu aplikacji — dostają
 * tylko landing + stronę `/mobile`. Blokada jest ZDEJMOWANA przełącznikiem
 * `NEXT_PUBLIC_MOBILE_PANEL` (zob. `lib/mobile-access.ts`); domyślnie stoi.
 * `Android` bez `Mobile` w UA to tablet — celowo przepuszczany, podobnie iPad.
 */
const PHONE_UA_RE = /iPhone|iPod|Windows Phone|Android(?=.*\bMobile\b)/i;

function isPhoneUserAgent(ua: string | null): boolean {
  return ua !== null && PHONE_UA_RE.test(ua);
}

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

  function withSessionCookies(response: NextResponse): NextResponse {
    for (const cookie of supabaseResponse.cookies.getAll()) response.cookies.set(cookie);
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
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
      global: isUuid(activeOrgCookie)
        ? { headers: { [ACTIVE_ORG_HEADER]: activeOrgCookie } }
        : undefined,
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

  // ─── BUG-008: blokada aplikacji na telefonie, zdejmowana przełącznikiem ───
  // Domyślnie telefon widzi wyłącznie strony marketingowe (+ /mobile), a każda
  // inna nawigacja HTML (login, register, onboarding, dashboard…) → /mobile.
  // Filtr `accept: text/html` chroni asety (sw.js, manifest, /ingest,
  // /monitoring) i fetch'e RSC przed zbędnym przekierowaniem.
  const isPhone = isPhoneUserAgent(request.headers.get('user-agent'));
  const wantsHtml =
    request.headers.get('accept')?.includes('text/html') ?? false;

  // W trybie `allowlist` o wstępie decyduje `userId` — a tego przed
  // zalogowaniem nie ma. Bez tej furtki konto z listy nie miałoby JAK się
  // zalogować z telefonu: `/login` jest trasą panelu i odbijałoby się na
  // `/mobile`, czyli w kółko. Sam ekran logowania nie odsłania niczego, czego
  // nie widać z komputera.
  const phoneNeedsAuthRoute =
    userId === null &&
    mobilePanelMode() === 'allowlist' &&
    isAuthPublicPath(path);

  const phoneBlocked =
    isPhone &&
    !phoneNeedsAuthRoute &&
    !isMobilePanelAllowed({ userId, isDevEnv: isLocalDevEnv() });

  if (phoneBlocked && wantsHtml && !isApi && !isMarketingPath(path)) {
    const url = request.nextUrl.clone();
    url.pathname = '/mobile';
    url.search = '';
    const res = NextResponse.redirect(url);
    for (const c of supabaseResponse.cookies.getAll()) res.cookies.set(c);
    return res;
  }

  // Zalogowany na landing z telefonu BEZ wstępu zostaje na landingu — nie ma
  // dokąd iść. Telefon wpuszczony jedzie na `APP_HOME` jak każdy inny klient.
  if (userId && path === '/' && !phoneBlocked) {
    const url = request.nextUrl.clone();
    url.pathname = APP_HOME;
    url.search = '';
    const res = NextResponse.redirect(url);
    for (const c of supabaseResponse.cookies.getAll()) res.cookies.set(c);
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
    for (const c of supabaseResponse.cookies.getAll()) res.cookies.set(c);
    return res;
  }

  if (userId && (path === '/login' || path === '/register')) {
    const url = request.nextUrl.clone();
    url.pathname = APP_HOME;
    url.search = '';
    const res = NextResponse.redirect(url);
    for (const c of supabaseResponse.cookies.getAll()) res.cookies.set(c);
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
  if (userId && !isPublicPath(path)) {
    const state = await getVerifiedMfaState(supabase).catch(() => null);
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
      for (const cookie of supabaseResponse.cookies.getAll()) res.cookies.set(cookie);
      return res;
    }
    if (state.status === 'challenge_required') {
      if (isApi) return denyApi('mfa_required', 403);
      const url = request.nextUrl.clone();
      url.pathname = '/login/two-factor';
      url.search = '';
      url.searchParams.set('redirect', path);
      const res = NextResponse.redirect(url);
      for (const cookie of supabaseResponse.cookies.getAll()) res.cookies.set(cookie);
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
      for (const c of supabaseResponse.cookies.getAll()) res.cookies.set(c);
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
    for (const c of supabaseResponse.cookies.getAll()) res.cookies.set(c);
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
