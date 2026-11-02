import type { ReactNode } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sesja 9 planu skalowania (REQ-04, CAC-09): jedno sprawdzenie sesji i jedno
 * zapytanie o członkostwo na render RSC. Produkcja podpisuje sesje kluczem
 * HS256, więc każde `getUser()` to wywołanie GoTrue przez sieć (db-1), a każde
 * zapytanie o członkostwo — PostgREST.
 *
 * Prawdziwe: layout panelu, layout ustawień, strony (Pulpit, KSeF w
 * ustawieniach, szczegół faktury), `getPageContext`, `lib/dashboard-shell-data`,
 * klienci Supabase z `lib/supabase/server` (`@supabase/ssr` i `supabase-js`).
 * Zastąpione: sieć (`fetch` — atrapa GoTrue i PostgREST, która liczy
 * wywołania), `next/headers`, `next/navigation` i komponenty klienckie
 * szkieletu bez związku z sesją.
 *
 * `cache()` z Reacta poza renderem RSC niczego nie pamięta (samo przekazuje
 * wywołanie), więc tu dostaje pamięć jednego żądania: klucz to funkcja
 * i argumenty (wartości proste po wartości, obiekty po tożsamości — jak
 * w React), a poza „żądaniem” — bez pamięci.
 *
 * Next 16 w renderze RSC skleja identyczne GET (memoizacja `fetch`), więc
 * powtórzone `getUser()` z tym samym tokenem szło dotąd do sieci raz. Test
 * liczy wywołania w kodzie (`getUser`, `memberships`) i osobno to, co wyjdzie
 * do sieci (`siec*`). Sklejanie znika przy `signal` (limity czasu, sesja 5),
 * a zapytania o członkostwo o różnych adresach nie sklejały się nigdy.
 */

const ATRAPA = 'https://atrapa.supabase.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';

type Wiersz = Record<string, unknown>;

type Wezel = Map<unknown, unknown>;

/** Jedno żądanie do atrapy: ścieżka, token z `Authorization`, klucz memoizacji `fetch` w Next. */
type Wywolanie = { sciezka: string; bearer: string | null; klucz: string };

const h = vi.hoisted(() => ({
  /** Pamięć bieżącego żądania RSC (`null` = poza renderem): drzewo funkcja → argumenty → wynik. */
  zadanie: null as Map<unknown, unknown> | null,
  WYNIK: Symbol('wynik'),
  BLAD: Symbol('blad'),
  ciasteczka: new Map<string, string>(),
  /** Token dostępu z ciasteczka sesji. */
  token: '',
  /** Zapytania do atrapy, w kolejności. */
  wywolania: [] as Wywolanie[],
  uzytkownik: null as Wiersz | null,
  tabele: {} as Record<string, Wiersz[]>,
  /** Tabela, której odczyt kończy się błędem 500. */
  awaria: null as string | null,
}));

vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        if (!h.zadanie) return fn(...args);
        let wezel = h.zadanie as Wezel;
        for (const klucz of [fn, ...args]) {
          let dalej = wezel.get(klucz) as Wezel | undefined;
          if (!dalej) {
            dalej = new Map();
            wezel.set(klucz, dalej);
          }
          wezel = dalej;
        }
        // Wyjątek synchroniczny też zostaje w pamięci (React: `s = 2`).
        if (wezel.has(h.BLAD)) throw wezel.get(h.BLAD);
        if (!wezel.has(h.WYNIK)) {
          try {
            wezel.set(h.WYNIK, fn(...args));
          } catch (e) {
            wezel.set(h.BLAD, e);
            throw e;
          }
        }
        return wezel.get(h.WYNIK) as R;
      },
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (h.ciasteczka.has(name) ? { name, value: h.ciasteczka.get(name)! } : undefined),
    getAll: () => [...h.ciasteczka].map(([name, value]) => ({ name, value })),
    has: (name: string) => h.ciasteczka.has(name),
    set: () => {
      throw new Error('Server Component nie zapisuje ciasteczek');
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

// Szkielet: komponenty klienckie bez związku z sesją. `AppHeader` renderuje
// swój `profile`, bo w nim siedzi serwerowe menu profilu z listą firm.
vi.mock('@/components/dashboard/app-header', () => ({
  AppHeader: ({ profile }: { profile: ReactNode }) => <header>{profile}</header>,
}));
vi.mock('@/components/dashboard/profile-menu', () => ({
  ProfileMenu: ({ company }: { company: string | null }) => <span data-firma={company ?? ''} />,
}));
vi.mock('@/components/support/support-widget', () => ({
  SupportWidget: ({ articleTitles }: { articleTitles: Record<string, string> }) => (
    <span data-artykuly={Object.keys(articleTitles).length} />
  ),
}));
vi.mock('@/components/dashboard/dashboard-route-flags', () => ({ DashboardRouteFlags: () => null }));
vi.mock('@/components/dashboard/app-sidebar', () => ({ AppSidebar: () => null }));
vi.mock('@/components/dashboard/bottom-nav', () => ({ BottomNav: () => null }));
vi.mock('@/components/dashboard/footer', () => ({ Footer: () => null }));
vi.mock('@/components/dashboard/prefetch-dashboard-routes', () => ({ PrefetchDashboardRoutes: () => null }));
vi.mock('@/components/dashboard/shell-scroll-memory', () => ({ ShellScrollMemory: () => null }));
vi.mock('@/components/dashboard/exports-route-client', () => ({ PrefetchExportsRoute: () => null }));
vi.mock('@/components/dashboard/welcome-modal', () => ({ WelcomeModal: () => null }));
vi.mock('@/components/auth/idle-watcher', () => ({ IdleWatcher: () => null }));
vi.mock('@/components/pwa/install-prompt-lazy', () => ({ InstallPrompt: () => null }));
vi.mock('@/components/analytics/analytics-identify', () => ({ AnalyticsIdentify: () => null }));
vi.mock('@/app/(dashboard)/_components/ksef-health-banner-client', () => ({ KsefHealthBannerClient: () => null }));
// Baner KSeF czyta stan z Redisa, nie z sesji.
vi.mock('@/lib/ksef/health-status', () => ({ getKsefHealthSnapshot: async () => null }));
vi.mock('@/components/ui/portal-container', async (original) => ({
  ...(await original<typeof import('@/components/ui/portal-container')>()),
  PortalContainerProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/sidebar', async (original) => ({
  ...(await original<typeof import('@/components/ui/sidebar')>()),
  SidebarInset: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SidebarProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/tooltip', async (original) => ({
  ...(await original<typeof import('@/components/ui/tooltip')>()),
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
// Ustawienia i szczegół faktury: liście klienckie z akcjami serwera.
vi.mock('@/components/settings/finora/settings-view', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/settings/certificate-upload', () => ({ CertificateUpload: () => null }));
vi.mock('@/components/settings/complete-nip-form', () => ({ CompleteNipForm: () => null }));
vi.mock('@/components/invoices/invoice-detail-view', () => ({ InvoiceDetailView: () => null }));
vi.mock('@/app/(dashboard)/settings/security/_components/password-change-card', () => ({ PasswordChangeCard: () => null }));
vi.mock('@/app/(dashboard)/settings/security/_components/two-factor-card', () => ({
  TwoFactorCard: ({ isEnabled }: { isEnabled: boolean }) => <span data-2fa={String(isEnabled)} />,
}));
vi.mock('@/components/pwa/notifications-settings', () => ({ NotificationsSettings: () => null }));
vi.mock('@/app/(dashboard)/settings/notifications/_components/email-preferences', () => ({ EmailPreferences: () => null }));

const { default: DashboardLayout } = await import('@/app/(dashboard)/layout');
const { default: DashboardHomePage } = await import('@/app/(dashboard)/dashboard/page');
const { default: SettingsLayout } = await import('@/app/(dashboard)/settings/layout');
const { default: KsefSettingsPage } = await import('@/app/(dashboard)/settings/ksef/page');
const { default: InvoiceDetailPage } = await import('@/app/(dashboard)/invoices/[id]/page');
const { default: SecuritySettingsPage } = await import('@/app/(dashboard)/settings/security/page');
const { default: NotificationsPage } = await import('@/app/(dashboard)/settings/notifications/page');
const { getPageContext, getPageContextWithRole } = await import('@/lib/supabase/page-context');
const { KSEF_RESEND_SOURCE_COLUMN_KEYS } = await import('@/lib/invoices/ksef-requeue-event');

// ─── Atrapa GoTrue + PostgREST ──────────────────────────────────────────

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Filtry `kolumna=eq.wartość` z adresu PostgREST; reszta filtrów bez skutku. */
function pasuje(wiersz: Wiersz, url: URL): boolean {
  for (const [kolumna, warunek] of url.searchParams) {
    if (!warunek.startsWith('eq.')) continue;
    if (String(wiersz[kolumna]) !== warunek.slice(3)) return false;
  }
  return true;
}

/**
 * Klucz jak w memoizacji `fetch` Nexta 16 w renderze RSC
 * (`next/dist/server/lib/dedupe-fetch.js`): identyczne GET/HEAD — adres
 * i nagłówki — idą do sieci raz; z `signal` albo inną metodą zawsze osobno.
 */
function kluczMemoizacji(req: Request, init: RequestInit | undefined, n: number): string {
  if (init?.signal || (req.method !== 'GET' && req.method !== 'HEAD')) return `osobne-${n}`;
  return JSON.stringify([req.method, req.url, [...req.headers].filter(([k]) => k !== 'traceparent' && k !== 'tracestate')]);
}

async function atrapaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== ATRAPA) throw new Error(`nieoczekiwane wywołanie sieci: ${req.url}`);
  h.wywolania.push({
    sciezka: url.pathname,
    bearer: req.headers.get('authorization')?.replace(/^Bearer /u, '') ?? null,
    klucz: kluczMemoizacji(req, init, h.wywolania.length),
  });

  if (url.pathname === '/auth/v1/user') {
    const token = req.headers.get('authorization')?.replace(/^Bearer /u, '');
    if (!h.uzytkownik || !token) return json({ code: 401, msg: 'brak sesji' }, 401);
    return json(h.uzytkownik);
  }
  // Odczyt kluczem serwisowym (zgody e-mail w Powiadomieniach) — nie sprawdza sesji.
  if (url.pathname.startsWith('/auth/v1/admin/users/')) return json(h.uzytkownik);

  // Żadna z renderowanych stron dziś nie woła RPC; licznik `rpc` pilnuje, że tak zostaje.
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\//u);
  if (rpc) return json(null);

  const tabela = url.pathname.match(/^\/rest\/v1\/([^/]+)$/u)?.[1];
  if (!tabela) throw new Error(`nieobsłużona ścieżka atrapy: ${url.pathname}`);
  if (h.awaria === tabela) return json({ code: 'XX000', message: 'awaria bazy' }, 500);

  const wiersze = (h.tabele[tabela] ?? []).filter((w) => pasuje(w, url));
  const zakres = { 'content-range': `0-${Math.max(wiersze.length - 1, 0)}/${wiersze.length}` };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: zakres });
  if (req.headers.get('accept') === 'application/vnd.pgrst.object+json') {
    return wiersze.length === 1
      ? json(wiersze[0], 200, zakres)
      : json({ code: 'PGRST116', message: 'oczekiwano jednego wiersza' }, 406);
  }
  return json(wiersze, 200, zakres);
}

function base64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

/** Ciasteczko sesji `@supabase/ssr` (nazwa z hosta adresu Supabase). */
function zalogujCiasteczkiem(userId: string): void {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ sub: userId, exp, aud: 'authenticated', role: 'authenticated' }),
    'podpis',
  ].join('.');
  const session = {
    access_token: accessToken,
    refresh_token: 'odswiez-atrapa',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    user: { id: userId, aud: 'authenticated' },
  };
  h.token = accessToken;
  h.ciasteczka.set('sb-atrapa-auth-token', `base64-${base64url(session)}`);
}

function uzytkownik(id: string, extra: Wiersz = {}): Wiersz {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'jan@example.test',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: 'Jan Atrapa' },
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function czlonkostwo(org: string, extra: Wiersz = {}): Wiersz {
  return {
    user_id: USER_ID,
    organization_id: org,
    role: 'owner',
    status: 'active',
    tenants: { name: 'Firma Atrapa', nip: '1234567890', ksef_verified_at: '2026-09-01T08:00:00Z', ksef_verified_environment: 'test' },
    ...extra,
  };
}

// ─── Render jednego żądania ─────────────────────────────────────────────

const czyGetUser = (w: Wywolanie) => w.sciezka === '/auth/v1/user';
const czyMemberships = (w: Wywolanie) => w.sciezka === '/rest/v1/memberships';

/**
 * Wywołania w jednym żądaniu. `getUser` i `memberships` to wywołania w kodzie;
 * `siec*` — ile z nich wyjdzie do sieci po memoizacji `fetch` w Next (identyczne
 * GET sklejone). `gotrueInne` to pozostałe wywołania GoTrue (np. odczyt kluczem
 * serwisowym), `rpc` — funkcje bazy.
 */
function liczniki() {
  const ile = (p: (w: Wywolanie) => boolean) => h.wywolania.filter(p).length;
  const roznych = (p: (w: Wywolanie) => boolean) => new Set(h.wywolania.filter(p).map((w) => w.klucz)).size;
  return {
    getUser: ile(czyGetUser),
    memberships: ile(czyMemberships),
    siecGetUser: roznych(czyGetUser),
    siecMemberships: roznych(czyMemberships),
    gotrueInne: ile((w) => w.sciezka.startsWith('/auth/v1/') && !czyGetUser(w)),
    rpc: ile((w) => w.sciezka.startsWith('/rest/v1/rpc/')),
  };
}

/** Cel sesji 9: jedno sprawdzenie sesji i jedno zapytanie o członkostwo, nic poza tym. */
const RAZ = { getUser: 1, memberships: 1, siecGetUser: 1, siecMemberships: 1, gotrueInne: 0, rpc: 0 };

/** Jedno żądanie RSC: pełne drzewo (z asynchronicznymi dziećmi), bez błędów renderu. */
async function wyrenderuj(drzewo: ReactNode): Promise<string> {
  const bledy: unknown[] = [];
  h.zadanie = new Map();
  try {
    const { prelude } = await prerenderToNodeStream(<>{drzewo}</>, { onError: (e) => void bledy.push(e) });
    let out = '';
    for await (const chunk of prelude) out += String(chunk);
    expect(bledy).toEqual([]);
    return out;
  } finally {
    h.zadanie = null;
  }
}

/** Wywołanie poza drzewem, ale w pamięci jednego żądania (np. dwa `getPageContext`). */
async function wZadaniu<T>(fn: () => Promise<T>): Promise<T> {
  h.zadanie = new Map();
  try {
    return await fn();
  } finally {
    h.zadanie = null;
  }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ATRAPA);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'klucz-anon-atrapa');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'klucz-serwisowy-atrapa');
  vi.stubGlobal('fetch', vi.fn(atrapaFetch));
  h.zadanie = null;
  h.ciasteczka.clear();
  h.wywolania = [];
  h.awaria = null;
  h.uzytkownik = uzytkownik(USER_ID);
  h.tabele = {
    memberships: [czlonkostwo(ORG)],
    tenants: [{ id: ORG, name: 'Firma Atrapa', nip: '1234567890', has_ksef_credentials: true, ksef_certificate_expiry: null }],
  };
  zalogujCiasteczkiem(USER_ID);
  h.ciasteczka.set('ksef.active_org', ORG);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Liczba wywołań na render ───────────────────────────────────────────

describe('jedno sprawdzenie sesji i jedno zapytanie o członkostwo na render', () => {
  it('/dashboard, pełne wejście (layout + Pulpit)', async () => {
    const out = await wyrenderuj(
      <DashboardLayout>
        <DashboardHomePage />
      </DashboardLayout>,
    );
    expect(out).toContain('data-firma="Firma Atrapa"');
    expect(liczniki()).toEqual(RAZ);
  });

  it('/dashboard, miękka nawigacja (sama strona, layout się nie renderuje)', async () => {
    await wyrenderuj(<DashboardHomePage />);
    expect(liczniki()).toEqual(RAZ);
  });

  it('/settings/ksef, pełne wejście (layout panelu + layout ustawień + strona)', async () => {
    const out = await wyrenderuj(
      <DashboardLayout>
        <SettingsLayout>
          <KsefSettingsPage />
        </SettingsLayout>
      </DashboardLayout>,
    );
    expect(out).toContain('Skonfigurowano połączenie');
    expect(liczniki()).toEqual(RAZ);
  });

  it('/settings/ksef, miękka nawigacja z innej zakładki ustawień (sama strona)', async () => {
    await wyrenderuj(<KsefSettingsPage />);
    expect(liczniki()).toEqual(RAZ);
  });

  it.each([
    ['zweryfikowany TOTP', [{ id: 'f1', factor_type: 'totp', status: 'verified' }], 'true'],
    ['TOTP w trakcie włączania', [{ id: 'f1', factor_type: 'totp', status: 'unverified' }], 'false'],
    ['bez czynników', undefined, 'false'],
  ])('/settings/security, pełne wejście (%s): 2FA z tego samego odczytu użytkownika', async (_opis, factors, wlaczone) => {
    h.uzytkownik = uzytkownik(USER_ID, factors ? { factors } : {});
    const out = await wyrenderuj(
      <DashboardLayout>
        <SettingsLayout>
          <SecuritySettingsPage searchParams={Promise.resolve({})} />
        </SettingsLayout>
      </DashboardLayout>,
    );
    expect(out).toContain(`data-2fa="${wlaczone}"`);
    expect(liczniki()).toEqual(RAZ);
  });

  // Zgody e-mail czyta `getEmailConsents` przez `auth.admin.getUserById`
  // (GoTrue kluczem serwisowym) — tak było przed tym PR; osobne ustalenie.
  it('/settings/notifications, pełne wejście', async () => {
    await wyrenderuj(
      <DashboardLayout>
        <SettingsLayout>
          <NotificationsPage />
        </SettingsLayout>
      </DashboardLayout>,
    );
    expect(liczniki()).toEqual({ ...RAZ, gotrueInne: 1 });
  });

  it('/settings/ksef: tożsamość Google z tego samego odczytu użytkownika', async () => {
    h.uzytkownik = uzytkownik(USER_ID, { identities: [{ provider: 'google' }] });
    const out = await wyrenderuj(<KsefSettingsPage />);
    expect(out).toContain('Połączone');
    expect(liczniki().getUser).toBe(1);
  });

  // Rolę w firmie TEJ faktury strona czyta sesją klienta (RLS), nie kluczem
  // serwisowym z wierszy layoutu (INV-13, `zapis-oryginalu-ekran`) — stąd
  // drugie zapytanie o członkostwo przy pełnym wejściu. Osobne ustalenie w PR.
  it('/invoices/[id]: jedno sprawdzenie sesji; rola faktury sesją klienta', async () => {
    h.tabele.invoices = [{
      ...Object.fromEntries(KSEF_RESEND_SOURCE_COLUMN_KEYS.map((k) => [k, null])),
      id: INVOICE_ID,
      tenant_id: ORG,
      ksef_status: 'accepted',
      invoice_type: 'VAT',
      direction: 'outgoing',
      invoice_line_items: [],
    }];
    const params = () => Promise.resolve({ id: INVOICE_ID });

    await wyrenderuj(
      <DashboardLayout>
        <InvoiceDetailPage params={params()} />
      </DashboardLayout>,
    );
    expect(liczniki()).toEqual({ ...RAZ, memberships: 2, siecMemberships: 2 });
    // Layout: klucz serwisowy (wszystkie członkostwa); strona: token użytkownika (RLS).
    expect(h.wywolania.filter(czyMemberships).map((w) => w.bearer)).toEqual(['klucz-serwisowy-atrapa', h.token]);

    h.wywolania = [];
    await wyrenderuj(<InvoiceDetailPage params={params()} />);
    expect(liczniki()).toEqual(RAZ);
    expect(h.wywolania.find(czyMemberships)?.bearer).toBe(h.token);
  });

  it('pamięć tylko w obrębie żądania: dwa rendery = dwa sprawdzenia', async () => {
    await wyrenderuj(<DashboardHomePage />);
    await wyrenderuj(<DashboardHomePage />);
    expect(liczniki()).toMatchObject({ getUser: 2, memberships: 2 });
  });
});

// ─── getPageContext: zachowanie bez zmian ───────────────────────────────

describe('getPageContext', () => {
  it('kształt kontekstu: klient sesji, użytkownik, firma z ciasteczka, rola z jej wiersza', async () => {
    const ctx = await wZadaniu(() => getPageContext());
    expect(ctx.user).toEqual({ id: USER_ID, email: 'jan@example.test' });
    expect(ctx.tenantId).toBe(ORG);
    expect(ctx.role).toBe('owner');
    // Decyzja o dostępie kluczem serwisowym, dane strony — klientem z sesji (RLS).
    expect(h.wywolania.find(czyMemberships)?.bearer).toBe('klucz-serwisowy-atrapa');
    await ctx.supabase.from('tenants').select('id');
    expect(h.wywolania.at(-1)).toMatchObject({ sciezka: '/rest/v1/tenants', bearer: h.token });
  });

  it('dwa wywołania w jednym żądaniu: jedno sprawdzenie sesji i jedno zapytanie', async () => {
    const [a, b] = await wZadaniu(() => Promise.all([getPageContext(), getPageContext()]));
    expect(a).toBe(b);
    expect(liczniki()).toEqual(RAZ);
  });

  it('rola z wiersza firmy z ciasteczka, nie z pierwszego wiersza', async () => {
    h.tabele.memberships = [czlonkostwo(ORG, { role: 'owner' }), czlonkostwo(ORG_B, { role: 'accountant' })];
    h.ciasteczka.set('ksef.active_org', ORG_B);
    const ctx = await wZadaniu(() => getPageContext());
    expect(ctx.tenantId).toBe(ORG_B);
    expect(ctx.role).toBe('accountant');
  });

  it('wiersz bez roli → member', async () => {
    h.tabele.memberships = [czlonkostwo(ORG, { role: null })];
    expect((await wZadaniu(() => getPageContext())).role).toBe('member');
  });

  it('bez sesji → /login', async () => {
    h.ciasteczka.delete('sb-atrapa-auth-token');
    await expect(wZadaniu(() => getPageContext())).rejects.toThrow('redirect:/login');
  });

  it('sesja odrzucona przez GoTrue → /login', async () => {
    h.uzytkownik = null;
    await expect(wZadaniu(() => getPageContext())).rejects.toThrow('redirect:/login');
  });

  it.each([
    ['brak ciasteczka firmy', () => h.ciasteczka.delete('ksef.active_org')],
    ['ciasteczko, które nie jest UUID', () => h.ciasteczka.set('ksef.active_org', 'nie-uuid')],
    ['obca firma w ciasteczku', () => h.ciasteczka.set('ksef.active_org', ORG_B)],
    ['członkostwo nieaktywne', () => (h.tabele.memberships = [czlonkostwo(ORG, { status: 'invited' })])],
    ['członkostwo innego użytkownika', () => (h.tabele.memberships = [czlonkostwo(ORG, { user_id: ORG_B })])],
  ])('%s → /onboarding', async (_opis, ustaw) => {
    ustaw();
    await expect(wZadaniu(() => getPageContext())).rejects.toThrow('redirect:/onboarding');
  });

  it('błąd zapytania o członkostwo to błąd strony, nie /onboarding (jak w layoucie)', async () => {
    h.awaria = 'memberships';
    const proba = wZadaniu(() => getPageContext());
    await expect(proba).rejects.toMatchObject({ message: 'awaria bazy' });
  });

  it('getPageContextWithRole: rola spoza listy → fallback; z listy → kontekst', async () => {
    h.tabele.memberships = [czlonkostwo(ORG, { role: 'member' })];
    await expect(wZadaniu(() => getPageContextWithRole('owner'))).rejects.toThrow('redirect:/settings');
    await expect(wZadaniu(() => getPageContextWithRole(['owner', 'admin'], '/dashboard'))).rejects.toThrow('redirect:/dashboard');
    expect((await wZadaniu(() => getPageContextWithRole(['owner', 'member']))).role).toBe('member');
  });

  it('drugie żądanie innego użytkownika dostaje swoje dane (nic w pamięci modułu)', async () => {
    const a = await wZadaniu(() => getPageContext());
    const INNY = '55555555-5555-4555-8555-555555555555';
    h.uzytkownik = uzytkownik(INNY, { email: 'ola@example.test' });
    h.tabele.memberships = [czlonkostwo(ORG, { user_id: INNY, role: 'accountant' })];
    zalogujCiasteczkiem(INNY);
    const b = await wZadaniu(() => getPageContext());
    expect(a.user.id).toBe(USER_ID);
    expect(b.user).toEqual({ id: INNY, email: 'ola@example.test' });
    expect(b.role).toBe('accountant');
  });
});
