import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.2, część 4: akcje „Nadaj uprawnienie w KSeF”, „Sprawdź stan”
 * i „Odbierz” w Ustawieniach, zakładka Księgowa (tylko właściciel).
 *
 * Prawdziwe: akcje (`app/actions/uprawnienia-ksef.ts`), model i komunikaty
 * (`lib/accountant/uprawnienia-ksef.ts`), klient KSeF z `ksefFetch`
 * (`lib/ksef/uprawnienia.ts`). Zastąpione: sesja i baza (atrapa klienta z RPC
 * 00195 w pamięci, z tymi samymi regułami co SQL), krok kodu, flaga, poświadczenia
 * i sesja KSeF, HTTP (`fetch` udający KSeF: operacje asynchroniczne ze statusem,
 * lista uprawnień w kontekście firmy, odebranie po identyfikatorze), audyt,
 * `revalidatePath`, Sentry.
 *
 * Nadanie w KSeF jest asynchroniczne (202 i numer operacji, potem status 100
 * albo 200) i nie wolno nadać go dwa razy, więc: rezerwacja w bazie przed
 * wywołaniem, a każda nowa próba najpierw pyta KSeF o aktywne uprawnienia biura.
 * Zachowanie RPC na prawdziwej bazie: `tests/rls-uprawnienia-ksef.test.ts`.
 */

const FIRMA = '0a0b0c0d-0000-4000-8000-0000000000aa';
const INNA_FIRMA = '0a0b0c0d-0000-4000-8000-0000000000bb';
const NIP_FIRMY = '1234567890';
const NIP_BIURA = '1111111111';
const NAZWA = 'Biuro Rachunkowe Testowe sp. z o.o.';
const PIEC_MINUT = 5 * 60_000;

interface Wpis {
  id: string;
  tenant: string;
  env: string;
  nip: string;
  name: string;
  scopes: string[];
  delegate: boolean;
  status: string;
  attempt: string;
  refs: string[];
  ksefCode: number | null;
  ksefDesc: string | null;
  errorCode: string | null;
  claimedAt: number;
  checkedAt: number | null;
  grantedAt: number | null;
  revokedAt: number | null;
}

interface Uprawnienie {
  nip: string;
  scope: string;
  delegate: boolean;
}

const s = vi.hoisted(() => ({
  rola: 'owner',
  aktywnaFirma: '0a0b0c0d-0000-4000-8000-0000000000aa',
  /** `tenants.nip` aktywnej firmy w atrapie bazy (RPC odmawia nadania temu NIP-owi). */
  nipFirmyWBazie: '1234567890',
  krok: null as null | { success: false; error: string; mfaStepUp?: true },
  flaga: true as boolean | 'blad',
  tabela: new Map<string, unknown>(),
  licznik: 0,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  rpcError: {} as Record<string, { code: string; message: string } | undefined>,
  odczytWierszy: 0,
  credentials: vi.fn(),
  getSession: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(async (_entry: unknown) => undefined),
  auditSystem: vi.fn(async (_entry: unknown) => undefined),
  revalidate: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ─── baza: RPC 00195 w pamięci (te same reguły co SQL) ─────────────────

const tabela = () => s.tabela as Map<string, Wpis>;
const wynik = (data: unknown) => Promise.resolve({ data, error: null });
const DOZWOLONE_ZAKRESY = ['InvoiceRead', 'InvoiceRead,InvoiceWrite'];

function nipPoprawny(nip: unknown): nip is string {
  if (typeof nip !== 'string' || !/^[1-9](([0-9][1-9])|([1-9][0-9]))[0-9]{7}$/.test(nip)) return false;
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const suma = wagi.reduce((acc, w, i) => acc + w * Number(nip[i]), 0) % 11;
  return suma !== 10 && suma === Number(nip[9]);
}

function rpc(fn: string, args: Record<string, unknown>) {
  s.rpcCalls.push([fn, args]);
  const blad = s.rpcError[fn];
  if (blad) return Promise.resolve({ data: null, error: blad });
  const teraz = Date.now();
  const proba = () => `0a0b0c0d-aaaa-4000-8000-${String(++s.licznik).padStart(12, '0')}`;

  if (fn === 'claim_ksef_permission_grant') {
    if (s.rola !== 'owner') return Promise.resolve({ data: null, error: { code: '42501', message: 'Only the owner grants KSeF permissions' } });
    if (!['test', 'demo', 'production'].includes(String(args.p_environment))) return wynik({ status: 'refused', code: 'invalid_environment' });
    if (!nipPoprawny(args.p_subject_nip)) return wynik({ status: 'refused', code: 'invalid_nip' });
    if (args.p_subject_nip === s.nipFirmyWBazie) return wynik({ status: 'refused', code: 'own_nip' });
    const name = String(args.p_subject_name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 5 || name.length > 90) return wynik({ status: 'refused', code: 'invalid_name' });
    const scopes = [...new Set(args.p_scopes as string[])].sort();
    if (scopes.length !== (args.p_scopes as string[]).length || !DOZWOLONE_ZAKRESY.includes(scopes.join(','))) {
      return wynik({ status: 'refused', code: 'invalid_scopes' });
    }
    if (typeof args.p_can_delegate !== 'boolean') return wynik({ status: 'refused', code: 'invalid_delegate' });
    const row = [...tabela().values()].find((r) => r.tenant === s.aktywnaFirma && r.env === args.p_environment && r.nip === args.p_subject_nip);
    const attempt = proba();
    if (!row) {
      const id = `0a0b0c0d-bbbb-4000-8000-${String(s.licznik).padStart(12, '0')}`;
      tabela().set(id, {
        id, tenant: s.aktywnaFirma, env: String(args.p_environment), nip: args.p_subject_nip, name, scopes,
        delegate: args.p_can_delegate, status: 'grant_pending', attempt, refs: [], ksefCode: null, ksefDesc: null,
        errorCode: null, claimedAt: teraz, checkedAt: null, grantedAt: null, revokedAt: null,
      });
      return wynik({ status: 'claimed', id, attempt, takeover: false });
    }
    if (row.status === 'granted' || row.status === 'revoke_failed') return wynik({ status: 'already_granted', id: row.id, scopes: row.scopes });
    if (row.status === 'grant_in_progress') return wynik({ status: 'awaiting_ksef', id: row.id });
    if (row.status === 'revoke_pending' || row.status === 'revoke_in_progress') return wynik({ status: 'revoke_in_progress', id: row.id });
    if (row.status === 'grant_pending' && row.claimedAt > teraz - PIEC_MINUT) return wynik({ status: 'in_progress', id: row.id });
    Object.assign(row, {
      status: 'grant_pending', attempt, name, scopes, delegate: args.p_can_delegate, refs: [], ksefCode: null,
      ksefDesc: null, errorCode: null, claimedAt: teraz, checkedAt: null, grantedAt: null, revokedAt: null,
    });
    return wynik({ status: 'claimed', id: row.id, attempt, takeover: true });
  }

  const row = tabela().get(String(args.p_id));
  const moj = row && row.tenant === s.aktywnaFirma ? row : undefined;

  if (fn === 'claim_ksef_permission_revoke') {
    if (s.rola !== 'owner') return Promise.resolve({ data: null, error: { code: '42501', message: 'Only the owner revokes KSeF permissions' } });
    if (!moj) return wynik({ status: 'refused', code: 'not_found' });
    if (moj.env !== args.p_environment) return wynik({ status: 'refused', code: 'env_mismatch' });
    const swiezy = moj.status === 'revoke_pending' && moj.claimedAt > teraz - PIEC_MINUT;
    if (moj.status === 'granted' || moj.status === 'revoke_failed' || (moj.status === 'revoke_pending' && !swiezy)) {
      Object.assign(moj, { status: 'revoke_pending', attempt: proba(), refs: [], ksefCode: null, ksefDesc: null, errorCode: null, claimedAt: teraz, checkedAt: null });
      return wynik({ status: 'claimed', id: moj.id, attempt: moj.attempt, subject_nip: moj.nip, subject_name: moj.name, scopes: moj.scopes });
    }
    const biuro = { subject_nip: moj.nip, subject_name: moj.name };
    if (swiezy) return wynik({ status: 'in_progress', id: moj.id, ...biuro });
    if (moj.status === 'revoke_in_progress') return wynik({ status: 'awaiting_ksef', id: moj.id, ...biuro });
    if (moj.status === 'revoked') return wynik({ status: 'already_revoked', id: moj.id, ...biuro });
    return wynik({ status: 'not_granted', id: moj.id, row_status: moj.status, ...biuro });
  }

  const zapisz = (status: string, pola: Partial<Wpis>) => {
    Object.assign(moj!, pola, { status });
    if (status === 'granted') moj!.grantedAt = teraz;
    if (status === 'revoked') moj!.revokedAt = teraz;
    return wynik({ status: 'saved', row_status: status });
  };
  const refsPoprawne = (refs: unknown) => Array.isArray(refs) && refs.every((r) => typeof r === 'string' && /^[0-9A-Za-z-]{36}$/.test(r));

  if (fn === 'finish_ksef_permission_attempt') {
    if (s.rola !== 'owner') return Promise.resolve({ data: null, error: { code: '42501', message: 'owner' } });
    if (!moj) return wynik({ status: 'refused', code: 'not_found' });
    if (!['grant_pending', 'revoke_pending'].includes(moj.status) || moj.attempt !== args.p_attempt) return wynik({ status: 'refused', code: 'stale_attempt' });
    const dozwolone = moj.status === 'grant_pending' ? ['grant_in_progress', 'granted', 'grant_failed'] : ['revoke_in_progress', 'revoked', 'revoke_failed'];
    const status = String(args.p_status);
    if (!dozwolone.includes(status)) return wynik({ status: 'refused', code: 'invalid_status' });
    const refs = (args.p_references ?? []) as string[];
    if (!refsPoprawne(refs)) return wynik({ status: 'refused', code: 'invalid_reference' });
    if (status === 'grant_in_progress' && refs.length !== 1) return wynik({ status: 'refused', code: 'invalid_reference' });
    if (status === 'revoke_in_progress' && refs.length < 1) return wynik({ status: 'refused', code: 'invalid_reference' });
    const kod = typeof args.p_error_code === 'string' && /^[a-z0-9_]{1,64}$/.test(args.p_error_code) ? args.p_error_code : null;
    return zapisz(status, {
      refs,
      ksefCode: (args.p_ksef_code as number | null) ?? null,
      ksefDesc: (args.p_ksef_description as string | null) ?? null,
      errorCode: status.endsWith('_failed') ? (kod ?? 'unknown') : kod,
      checkedAt: args.p_ksef_code == null ? null : teraz,
    });
  }

  if (fn === 'record_ksef_permission_check') {
    if (s.rola !== 'owner') return Promise.resolve({ data: null, error: { code: '42501', message: 'owner' } });
    if (!moj) return wynik({ status: 'refused', code: 'not_found' });
    if (!['grant_in_progress', 'revoke_in_progress'].includes(moj.status)) return wynik({ status: 'refused', code: 'not_in_progress', row_status: moj.status });
    if (JSON.stringify(args.p_references) !== JSON.stringify(moj.refs)) return wynik({ status: 'refused', code: 'stale_check' });
    const dozwolone = moj.status === 'grant_in_progress' ? ['grant_in_progress', 'granted', 'grant_failed'] : ['revoke_in_progress', 'revoked', 'revoke_failed'];
    const status = String(args.p_status);
    if (!dozwolone.includes(status)) return wynik({ status: 'refused', code: 'invalid_status' });
    const kod = typeof args.p_error_code === 'string' && /^[a-z0-9_]{1,64}$/.test(args.p_error_code) ? args.p_error_code : null;
    return zapisz(status, {
      ksefCode: (args.p_ksef_code as number | null) ?? null,
      ksefDesc: (args.p_ksef_description as string | null) ?? null,
      errorCode: status.endsWith('_failed') ? (kod ?? 'unknown') : kod,
      checkedAt: teraz,
    });
  }
  throw new Error(`nieoczekiwane RPC ${fn}`);
}

/** Odczyt wiersza kluczem sesji: RLS przepuszcza tylko aktywną firmę. */
function klient() {
  return {
    rpc,
    from(nazwa: string) {
      if (nazwa !== 'ksef_permission_grants') throw new Error(`nieoczekiwana tabela ${nazwa}`);
      const filtr: Record<string, unknown> = {};
      const b = {
        select() { return b; },
        eq(kolumna: string, wartosc: unknown) { filtr[kolumna] = wartosc; return b; },
        maybeSingle() {
          s.odczytWierszy += 1;
          const w = tabela().get(String(filtr.id));
          if (!w || w.tenant !== s.aktywnaFirma) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({
            data: {
              id: w.id,
              ksef_environment: w.env,
              subject_nip: w.nip,
              subject_name: w.name,
              scopes: w.scopes,
              can_delegate: w.delegate,
              status: w.status,
              operation_references: w.refs,
              ksef_status_code: w.ksefCode,
              ksef_status_description: w.ksefDesc,
              error_code: w.errorCode,
              claimed_at: new Date(w.claimedAt).toISOString(),
              checked_at: w.checkedAt ? new Date(w.checkedAt).toISOString() : null,
              granted_at: w.grantedAt ? new Date(w.grantedAt).toISOString() : null,
              revoked_at: w.revokedAt ? new Date(w.revokedAt).toISOString() : null,
            },
            error: null,
          });
        },
      };
      return b;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return {
    ActionAuthError,
    requireUserAndActiveOrg: vi.fn(async (formTenant?: { expectedTenantId: unknown }) => {
      if (formTenant && formTenant.expectedTenantId !== s.aktywnaFirma) {
        throw new ActionAuthError('Aktywna firma zmieniła się od otwarcia formularza. Odśwież tę stronę.');
      }
      return { supabase: klient(), tenantId: s.aktywnaFirma, user: { id: 'u-1' }, role: s.rola };
    }),
  };
});
vi.mock('@/lib/auth/access-grant-mfa', () => ({ requireCodeForAccessGrant: vi.fn(async () => s.krok) }));
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlagForExecution: vi.fn(async (flaga: string) => {
    if (flaga !== 'ksefPermissionsEnabled') throw new Error(`nieoczekiwana flaga ${flaga}`);
    if (s.flaga === 'blad') throw new Error('odczyt flagi');
    return s.flaga;
  }),
  getGlobalFlag: vi.fn(async () => s.flaga === true),
}));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/admin-queries')>()),
  getTenantKsefCredentials: s.credentials,
}));
vi.mock('@/lib/ksef/session-cache', () => ({ ksefSessionCache: { getSession: s.getSession, invalidate: s.invalidate } }));
vi.mock('@/lib/ksef/rate-limiter', () => ({ ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() } }));
vi.mock('@/lib/audit/log', () => ({ logAudit: s.audit }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: s.auditSystem }));
vi.mock('next/cache', () => ({ revalidatePath: s.revalidate }));
vi.mock('@sentry/nextjs', () => ({ captureException: s.captureException, captureMessage: s.captureMessage }));

// ─── KSeF: atrapa HTTP w kształcie ze specyfikacji ──────────────────────

interface Operacja {
  kod: number;
  efekt: () => void;
}

const k = {
  aktywne: new Map<string, Uprawnienie>(),
  operacje: new Map<string, Operacja>(),
  numer: 0,
  kodNowejOperacji: 200,
  nadanie: null as null | (() => Response | Promise<Response>),
  odebranie: null as null | ((id: string) => Response | null),
  stan: null as null | (() => Response | Promise<Response>),
  zapytanie: null as null | (() => Response | Promise<Response>),
  wywolania: [] as Array<{ method: string; path: string; body: Record<string, unknown> | undefined }>,
};
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const OPISY: Record<number, string> = {
  100: 'Operacja przyjęta do realizacji',
  200: 'Operacja zakończona sukcesem',
  420: 'Użyte poświadczenia nie mają uprawnień do wykonania tej operacji',
  450: 'Operacja niedozwolona dla wskazanego identyfikatora lub jego typu',
};
const nowyNumer = () => `20261111-EG-${String(++k.numer).padStart(10, '0')}-0000000000-00`;
const noweId = () => `0c9a72e8-f344-457f-9c16-${String(++k.numer).padStart(12, '0')}`;

function dodajOperacje(efekt: () => void): string {
  const numer = nowyNumer();
  k.operacje.set(numer, { kod: k.kodNowejOperacji, efekt });
  if (k.kodNowejOperacji === 200) efekt();
  return numer;
}
function zakonczOperacje(numer: string, kod: number) {
  const op = k.operacje.get(numer)!;
  op.kod = kod;
  if (kod === 200) op.efekt();
}
function nadaneWKsef(scopes: string[] = ['InvoiceRead'], nip = NIP_BIURA, delegate = true) {
  for (const scope of scopes) k.aktywne.set(noweId(), { nip, scope, delegate });
}

async function atrapaKsef(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  expect(u.origin).toBe('https://api-test.ksef.mf.gov.pl');
  const path = u.pathname.replace(/^\/v2/, '');
  const method = init.method ?? 'GET';
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  k.wywolania.push({ method, path, body });
  if (method === 'POST' && path === '/permissions/query/persons/grants') {
    if (k.zapytanie) return k.zapytanie();
    const nip = (body!.authorizedIdentifier as { value: string }).value;
    const typy = body!.permissionTypes as string[];
    const permissions = [...k.aktywne.entries()]
      .filter(([, p]) => p.nip === nip && typy.includes(p.scope))
      .map(([id, p]) => ({
        id,
        authorizedIdentifier: { type: 'Nip', value: p.nip },
        authorIdentifier: { type: 'Nip', value: NIP_FIRMY },
        permissionScope: p.scope,
        description: 'Dostęp biura rachunkowego nadany w FaktWay',
        permissionState: 'Active',
        startDate: '2026-11-11T10:41:11+00:00',
        canDelegate: p.delegate,
      }));
    return json({ permissions, hasMore: false }, 200);
  }
  if (method === 'POST' && path === '/permissions/entities/grants') {
    if (k.nadanie) return k.nadanie();
    const nip = (body!.subjectIdentifier as { value: string }).value;
    const uprawnienia = body!.permissions as Array<{ type: string; canDelegate: boolean }>;
    const numer = dodajOperacje(() => {
      for (const p of uprawnienia) k.aktywne.set(noweId(), { nip, scope: p.type, delegate: p.canDelegate });
    });
    return json({ referenceNumber: numer }, 202);
  }
  if (method === 'DELETE' && path.startsWith('/permissions/common/grants/')) {
    const id = decodeURIComponent(path.split('/').pop()!);
    const zastepcza = k.odebranie?.(id);
    if (zastepcza) return zastepcza;
    const numer = dodajOperacje(() => k.aktywne.delete(id));
    return json({ referenceNumber: numer }, 202);
  }
  if (method === 'GET' && path.startsWith('/permissions/operations/')) {
    if (k.stan) return k.stan();
    const op = k.operacje.get(decodeURIComponent(path.split('/').pop()!));
    if (!op) return json({ title: 'Gone', status: 410, detail: 'Operacja wygasła i nie jest już dostępna.' }, 410);
    return json({ status: { code: op.kod, description: OPISY[op.kod] ?? 'Operacja zakończona niepowodzeniem' } }, 200);
  }
  throw new Error(`nieoczekiwane wywołanie KSeF ${method} ${path}`);
}

const fetchMock = vi.fn(atrapaKsef);
const wywolaniaKsef = () => k.wywolania.map((w) => `${w.method} ${w.path.replace(/\/[0-9A-Za-z-]{36}$/, '/…')}`);
const nadaniaKsef = () => k.wywolania.filter((w) => w.method === 'POST' && w.path === '/permissions/entities/grants');
const rpcNazwy = () => s.rpcCalls.map(([fn]) => fn);
const jedyny = () => {
  const wiersze = [...tabela().values()];
  expect(wiersze).toHaveLength(1);
  return wiersze[0]!;
};

const formularz = (pola: Record<string, unknown> = {}) => ({
  firma: FIRMA,
  nip: NIP_BIURA,
  nazwa: NAZWA,
  zakres: 'odczyt',
  przekazanie: true,
  ...pola,
});

async function akcje() {
  return import('@/app/actions/uprawnienia-ksef');
}
async function nadaj(pola: Record<string, unknown> = {}) {
  const { nadajUprawnienieKsefAction } = await akcje();
  return nadajUprawnienieKsefAction(formularz(pola) as Parameters<typeof nadajUprawnienieKsefAction>[0]);
}
async function sprawdz(id: string) {
  const { sprawdzUprawnienieKsefAction } = await akcje();
  return sprawdzUprawnienieKsefAction(id);
}
async function odbierz(id: string) {
  const { odbierzUprawnienieKsefAction } = await akcje();
  return odbierzUprawnienieKsefAction(id);
}

beforeEach(() => {
  s.rola = 'owner';
  s.aktywnaFirma = FIRMA;
  s.nipFirmyWBazie = NIP_FIRMY;
  s.krok = null;
  s.flaga = true;
  s.tabela = new Map();
  s.licznik = 0;
  s.rpcCalls = [];
  s.rpcError = {};
  s.odczytWierszy = 0;
  s.credentials.mockReset();
  s.credentials.mockResolvedValue({ type: 'token', nip: NIP_FIRMY, token: 'a'.repeat(24) });
  s.getSession.mockReset();
  s.getSession.mockResolvedValue({
    accessToken: 'b'.repeat(24),
    refreshToken: 'c'.repeat(24),
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    nip: NIP_FIRMY,
  });
  s.invalidate.mockReset();
  s.audit.mockClear();
  s.auditSystem.mockClear();
  s.revalidate.mockReset();
  s.captureException.mockReset();
  s.captureMessage.mockReset();
  k.aktywne = new Map();
  k.operacje = new Map();
  k.numer = 0;
  k.kodNowejOperacji = 200;
  k.nadanie = null;
  k.odebranie = null;
  k.stan = null;
  k.zapytanie = null;
  k.wywolania = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('nadanie: właściciel, KSeF przyjmuje', () => {
  it('rezerwacja, sprawdzenie aktywnych, nadanie, numer operacji w bazie, status 200: nadane', async () => {
    const w = await nadaj();

    expect(w).toMatchObject({ success: true, stan: 'granted' });
    expect((w as { komunikat: string }).komunikat).toContain(NAZWA);
    expect(wywolaniaKsef()).toEqual([
      'POST /permissions/query/persons/grants',
      'POST /permissions/entities/grants',
      'GET /permissions/operations/…',
    ]);
    expect(nadaniaKsef()[0]!.body).toEqual({
      subjectIdentifier: { type: 'Nip', value: NIP_BIURA },
      permissions: [{ type: 'InvoiceRead', canDelegate: true }],
      description: expect.stringContaining(NAZWA),
      subjectDetails: { fullName: NAZWA },
    });
    expect(rpcNazwy()).toEqual(['claim_ksef_permission_grant', 'finish_ksef_permission_attempt', 'record_ksef_permission_check']);
    expect(s.rpcCalls[0]![1]).toEqual({
      p_environment: 'test',
      p_subject_nip: NIP_BIURA,
      p_subject_name: NAZWA,
      p_scopes: ['InvoiceRead'],
      p_can_delegate: true,
    });
    expect(s.rpcCalls[1]![1]).toMatchObject({ p_status: 'grant_in_progress', p_references: [expect.stringMatching(/^[0-9A-Za-z-]{36}$/)] });
    expect(s.rpcCalls[2]![1]).toMatchObject({ p_status: 'granted', p_ksef_code: 200 });
    expect(jedyny()).toMatchObject({ status: 'granted', nip: NIP_BIURA, scopes: ['InvoiceRead'], delegate: true, ksefCode: 200 });
    expect(s.revalidate).toHaveBeenCalledWith('/settings/accountant');
  });

  it('odczyt i wystawianie bez przekazania pracownikom: dwa uprawnienia z canDelegate false', async () => {
    await nadaj({ zakres: 'odczyt_i_wystawianie', przekazanie: false });

    expect(nadaniaKsef()[0]!.body!.permissions).toEqual([
      { type: 'InvoiceRead', canDelegate: false },
      { type: 'InvoiceWrite', canDelegate: false },
    ]);
    expect(jedyny()).toMatchObject({ status: 'granted', scopes: ['InvoiceRead', 'InvoiceWrite'], delegate: false });
  });

  it('KSeF jeszcze przetwarza (status 100): w toku, z „Sprawdź stan”; potem 200 przy sprawdzeniu', async () => {
    k.kodNowejOperacji = 100;

    const w = await nadaj();

    expect(w).toMatchObject({ success: true, stan: 'grant_in_progress' });
    expect((w as { komunikat: string }).komunikat).toMatch(/Sprawdź stan/);
    const wiersz = jedyny();
    expect(wiersz).toMatchObject({ status: 'grant_in_progress', ksefCode: 100 });

    zakonczOperacje(wiersz.refs[0]!, 200);
    const sprawdzenie = await sprawdz(wiersz.id);

    expect(sprawdzenie).toMatchObject({ success: true, stan: 'granted' });
    expect(jedyny().status).toBe('granted');
    expect(nadaniaKsef()).toHaveLength(1);
  });

  it('biuro ma już to uprawnienie w KSeF (np. z Aplikacji Podatnika): bez drugiego nadania, nadane', async () => {
    nadaneWKsef(['InvoiceRead']);

    const w = await nadaj();

    expect(w).toMatchObject({ success: true, stan: 'granted' });
    expect((w as { komunikat: string }).komunikat).toMatch(/już/);
    expect(nadaniaKsef()).toHaveLength(0);
    expect(rpcNazwy()).toEqual(['claim_ksef_permission_grant', 'finish_ksef_permission_attempt']);
    expect(s.rpcCalls[1]![1]).toMatchObject({ p_status: 'granted', p_references: [] });
  });

  it('biuro ma już uprawnienie z innym ustawieniem przekazania pracownikom: nadane z uwagą, bez drugiego nadania', async () => {
    nadaneWKsef(['InvoiceRead'], NIP_BIURA, false);

    const w = await nadaj({ przekazanie: true });

    expect(w).toMatchObject({ success: true, stan: 'granted' });
    expect((w as { komunikat: string }).komunikat).toMatch(/inne ustawienie przekazania/);
    expect(nadaniaKsef()).toHaveLength(0);
    expect(jedyny()).toMatchObject({ status: 'granted', errorCode: 'delegate_mismatch' });
  });

  it('biuro ma już odczyt, właściciel chce też wystawiania: KSeF dostaje tylko brakujące InvoiceWrite', async () => {
    nadaneWKsef(['InvoiceRead']);

    await nadaj({ zakres: 'odczyt_i_wystawianie' });

    expect(nadaniaKsef()).toHaveLength(1);
    expect(nadaniaKsef()[0]!.body!.permissions).toEqual([{ type: 'InvoiceWrite', canDelegate: true }]);
    expect(jedyny()).toMatchObject({ status: 'granted', scopes: ['InvoiceRead', 'InvoiceWrite'] });
  });
});

describe('ponowienie bez drugiego nadania', () => {
  it('drugie kliknięcie po nadaniu: zapisany stan, bez KSeF i bez poświadczeń', async () => {
    await nadaj();
    const przed = k.wywolania.length;

    const drugie = await nadaj();

    expect(drugie).toMatchObject({ success: true, stan: 'granted' });
    expect((drugie as { komunikat: string }).komunikat).toMatch(/ma już uprawnienie/);
    expect(k.wywolania.length).toBe(przed);
    expect(s.credentials).toHaveBeenCalledTimes(1);
    expect(nadaniaKsef()).toHaveLength(1);
  });

  it('dwa kliknięcia naraz: drugie „właśnie trwa”, KSeF dostaje jedno nadanie', async () => {
    let zwolnij: (r: Response) => void = () => undefined;
    k.nadanie = () => new Promise<Response>((ok) => { zwolnij = ok; });

    const pierwsze = nadaj();
    await vi.waitFor(() => expect(nadaniaKsef()).toHaveLength(1));
    const drugie = await nadaj();
    k.nadanie = null;
    zwolnij(json({ referenceNumber: dodajOperacje(() => nadaneWKsef(['InvoiceRead'])) }, 202));

    expect(drugie).toMatchObject({ success: false, error: expect.stringContaining('właśnie trwa') });
    expect(await pierwsze).toMatchObject({ success: true, stan: 'granted' });
    expect(nadaniaKsef()).toHaveLength(1);
  });

  it('nadanie w toku w KSeF: kolejne „Nadaj” odsyła do „Sprawdź stan”, bez nowego nadania', async () => {
    k.kodNowejOperacji = 100;
    await nadaj();

    const drugie = await nadaj();

    expect(drugie).toMatchObject({ success: true, stan: 'grant_in_progress' });
    expect((drugie as { komunikat: string }).komunikat).toMatch(/Sprawdź stan/);
    expect(nadaniaKsef()).toHaveLength(1);
  });

  it('przerwa po wysłaniu, przed zapisem numeru (np. restart): po 5 minutach nowa próba znajduje uprawnienie w KSeF i nie nadaje drugi raz', async () => {
    s.rpcError.finish_ksef_permission_attempt = { code: '08006', message: 'connection failure' };
    const pierwsze = await nadaj();
    // KSeF przyjął nadanie, FaktWay nie zapisał numeru: klient dostaje numer operacji, a audyt go ma.
    expect(pierwsze).toMatchObject({ success: true, stan: 'grant_in_progress' });
    expect((pierwsze as { komunikat: string }).komunikat).toMatch(/20261111-EG-/);
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'accountant.ksef_permission_grant_sent',
        metadata: expect.objectContaining({ references: [expect.stringMatching(/^20261111-EG-/)], zapisany: false }),
      }),
    );
    expect(nadaniaKsef()).toHaveLength(1);
    s.rpcError = {};

    // W ciągu 5 minut: próba w toku.
    expect(await nadaj()).toMatchObject({ success: false, error: expect.stringContaining('właśnie trwa') });
    // Po 5 minutach: przejęcie, najpierw lista z KSeF.
    jedyny().claimedAt -= PIEC_MINUT + 1000;
    const trzecie = await nadaj();

    expect(trzecie).toMatchObject({ success: true, stan: 'granted' });
    expect(nadaniaKsef()).toHaveLength(1);
    expect(jedyny().status).toBe('granted');
  });

  it('KSeF nie odpowiedział na nadanie (timeout po wysłaniu): „nie nadano” z wyjaśnieniem; ponowienie po przetworzeniu nie nadaje drugi raz', async () => {
    k.nadanie = () => {
      // KSeF przyjął i przetworzył nadanie, ale odpowiedź nie doszła.
      nadaneWKsef(['InvoiceRead']);
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };

    const pierwsze = await nadaj();

    expect(pierwsze).toMatchObject({ success: false, error: expect.stringMatching(/drugi raz/) });
    expect(jedyny()).toMatchObject({ status: 'grant_failed', errorCode: 'timeout' });
    k.nadanie = null;

    const drugie = await nadaj();

    expect(drugie).toMatchObject({ success: true, stan: 'granted' });
    expect(nadaniaKsef()).toHaveLength(1);
  });
});

describe('granice: rola, obca firma, zły NIP, flaga, krok kodu, środowisko', () => {
  it.each(['admin', 'member', 'accountant'])('%s: odmowa bez bazy i bez KSeF', async (rola) => {
    s.rola = rola;

    for (const wynikAkcji of [await nadaj(), await odbierz('0a0b0c0d-bbbb-4000-8000-000000000001'), await sprawdz('0a0b0c0d-bbbb-4000-8000-000000000001')]) {
      expect(wynikAkcji).toMatchObject({ success: false, error: expect.stringMatching(/właściciel/) });
    }
    expect(s.rpcCalls).toEqual([]);
    expect(s.odczytWierszy).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formularz otwarty dla innej firmy niż aktywna (druga karta): odmowa przed bazą i KSeF', async () => {
    const w = await nadaj({ firma: INNA_FIRMA });

    expect(w).toMatchObject({ success: false, error: expect.stringContaining('Aktywna firma zmieniła się') });
    expect(s.rpcCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uprawnienie obcej firmy (identyfikator spoza aktywnej): „nie znaleziono”, bez KSeF', async () => {
    await nadaj();
    const id = jedyny().id;
    s.aktywnaFirma = INNA_FIRMA;
    k.wywolania = [];

    expect(await odbierz(id)).toMatchObject({ success: false, error: expect.stringMatching(/Nie znaleziono/) });
    expect(await sprawdz(id)).toMatchObject({ success: false, error: expect.stringMatching(/Nie znaleziono/) });
    expect(k.wywolania).toEqual([]);
    expect(jedyny().status).toBe('granted');
  });

  it.each([
    ['błędna suma kontrolna (fikcyjny NIP repo)', { nip: NIP_FIRMY }],
    ['za krótki', { nip: '111111111' }],
    ['litery', { nip: '11111111AB' }],
  ])('zły NIP biura (%s): odmowa przed czymkolwiek', async (_opis, pola) => {
    const w = await nadaj(pola);

    expect(w).toMatchObject({ success: false, error: expect.stringMatching(/NIP/) });
    expect(s.rpcCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NIP biura równy NIP-owi firmy (sprawdza baza, `own_nip`): komunikat o NIP-ie firmy, bez wiersza i KSeF', async () => {
    // Firma z NIP-em o poprawnej sumie kontrolnej: formularz go przepuszcza, baza porównuje z `tenants.nip`.
    s.nipFirmyWBazie = '2222222222';

    const w = await nadaj({ nip: '222-222-22-22' });

    expect(w).toMatchObject({ success: false, error: expect.stringMatching(/NIP Twojej firmy/) });
    expect(s.rpcCalls[0]![1]).toMatchObject({ p_subject_nip: '2222222222' });
    expect(tabela().size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flaga wyłączona: odmowa z wyjściem (Aplikacja Podatnika), bez bazy i KSeF', async () => {
    s.flaga = false;

    for (const wynikAkcji of [await nadaj(), await odbierz('0a0b0c0d-bbbb-4000-8000-000000000001'), await sprawdz('0a0b0c0d-bbbb-4000-8000-000000000001')]) {
      expect(wynikAkcji).toMatchObject({ success: false, error: expect.stringMatching(/Aplikacji Podatnika/) });
    }
    expect(s.rpcCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('błąd odczytu flagi: odmowa (włącznik zamknięty), bez bazy i KSeF', async () => {
    s.flaga = 'blad';

    expect(await nadaj()).toMatchObject({ success: false, error: expect.stringMatching(/Spróbuj ponownie/) });
    expect(s.rpcCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sesja po biometrii na koncie z 2FA: odmowa z przejściem na ekran kodu, bez bazy i KSeF', async () => {
    s.krok = { success: false, mfaStepUp: true, error: 'Nadanie uprawnienia w KSeF wymaga potwierdzenia kodem z aplikacji.' };

    expect(await nadaj()).toEqual(s.krok);
    expect(s.rpcCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('baza odmawia kroku kodu (code_step_required): przejście na ekran kodu', async () => {
    s.rpcError.claim_ksef_permission_grant = { code: '42501', message: 'code_step_required' };

    expect(await nadaj()).toMatchObject({ success: false, mfaStepUp: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('brak KSEF_ENV: odmowa bez bazy i KSeF', async () => {
    vi.stubEnv('KSEF_ENV', '');

    expect(await nadaj()).toMatchObject({ success: false, error: expect.stringMatching(/środowiska KSeF/) });
    expect(s.rpcCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('baza bez funkcji 00195 (kod przed migracją): komunikat „po aktualizacji”, bez KSeF', async () => {
    s.rpcError.claim_ksef_permission_grant = { code: 'PGRST202', message: 'Could not find the function' };

    expect(await nadaj()).toMatchObject({ success: false, error: expect.stringMatching(/aktualizacji/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('błędy KSeF przy nadaniu: stan „nie nadano” z kodem i komunikat z wyjściem', () => {
  const blad = (status: number, body: unknown, headers: Record<string, string> = {}) => () => json(body, status, headers);

  it.each([
    ['403 (brak CredentialsManage)', blad(403, { title: 'Forbidden', status: 403 }), 'http_403', /CredentialsManage/],
    ['429 z Retry-After', blad(429, { status: { code: 429, description: 'Too Many Requests', details: [] } }, { 'retry-after': '120' }), 'http_429', /za 2 min/],
    [
      '400 z kodem 21405',
      blad(400, { exception: { exceptionDetailList: [{ exceptionCode: 21405, exceptionDescription: 'Błąd walidacji danych wejściowych.' }] } }),
      'ksef_21405',
      /21405/,
    ],
    ['503', blad(503, 'Service Unavailable'), 'http_5xx', /drugi raz/],
  ])('%s', async (_opis, odpowiedz, kod, tekst) => {
    k.nadanie = odpowiedz;

    const w = await nadaj();

    expect(w).toMatchObject({ success: false, error: expect.stringMatching(tekst) });
    expect((w as { error: string }).error).toContain(NAZWA);
    expect(jedyny()).toMatchObject({ status: 'grant_failed', errorCode: kod });
  });

  it('401: sesja KSeF wyrzucona z pamięci, „nie nadano”, kolejna próba od nowa', async () => {
    k.nadanie = blad(401, { title: 'Unauthorized', status: 401 });

    expect(await nadaj()).toMatchObject({ success: false });
    expect(s.invalidate).toHaveBeenCalledWith(NIP_FIRMY, 'test');
    expect(jedyny()).toMatchObject({ status: 'grant_failed', errorCode: 'http_401' });

    k.nadanie = null;
    expect(await nadaj()).toMatchObject({ success: true, stan: 'granted' });
  });

  it('KSeF odrzucił operację (status 420): „nie nadano” z kodem 420 i wyjściem', async () => {
    k.kodNowejOperacji = 420;

    const w = await nadaj();

    expect(w).toMatchObject({ success: false, error: expect.stringMatching(/420/) });
    expect(jedyny()).toMatchObject({ status: 'grant_failed', errorCode: 'status_420', ksefCode: 420 });
  });

  it('firma bez połączenia z KSeF: „nie nadano” i wskazówka, gdzie połączyć', async () => {
    const { KsefCredentialsError } = await import('@/lib/supabase/admin-queries');
    s.credentials.mockRejectedValue(new KsefCredentialsError('missing', 'brak'));

    const w = await nadaj();

    expect(w).toMatchObject({ success: false, error: expect.stringMatching(/Ustawieniach/) });
    expect(jedyny()).toMatchObject({ status: 'grant_failed', errorCode: 'credentials_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('brak sprawdzenia statusu po nadaniu (sieć): nadanie zostaje „w toku”, bez błędu dla klienta', async () => {
    k.stan = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    };

    const w = await nadaj();

    expect(w).toMatchObject({ success: true, stan: 'grant_in_progress' });
    expect(jedyny().status).toBe('grant_in_progress');
  });

  it('błąd techniczny (zła odpowiedź KSeF na nadanie) idzie do Sentry', async () => {
    k.nadanie = () => json({ cos: 'innego' }, 202);

    expect(await nadaj()).toMatchObject({ success: false });
    expect(jedyny()).toMatchObject({ status: 'grant_failed', errorCode: 'invalid_response' });
    expect(s.captureException.mock.calls.length + s.captureMessage.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('sprawdzenie stanu', () => {
  it('nadanie przetworzone po 30 dniach (410, operacja wygasła): decyduje lista uprawnień w KSeF', async () => {
    k.kodNowejOperacji = 100;
    await nadaj();
    const wiersz = jedyny();
    k.operacje.clear();
    nadaneWKsef(['InvoiceRead']);

    expect(await sprawdz(wiersz.id)).toMatchObject({ success: true, stan: 'granted' });
  });

  it('410 i brak uprawnienia w KSeF: „nie nadano” z kodem operation_expired', async () => {
    k.kodNowejOperacji = 100;
    await nadaj();
    const wiersz = jedyny();
    k.operacje.clear();

    expect(await sprawdz(wiersz.id)).toMatchObject({ success: false });
    expect(jedyny()).toMatchObject({ status: 'grant_failed', errorCode: 'operation_expired' });
  });

  it('wiersz bez operacji w toku (nadane): bez KSeF, obecny stan', async () => {
    await nadaj();
    k.wywolania = [];

    expect(await sprawdz(jedyny().id)).toMatchObject({ success: true, stan: 'granted' });
    expect(k.wywolania).toEqual([]);
  });

  it('identyfikator spoza formatu: odmowa bez bazy', async () => {
    expect(await sprawdz('nie-uuid')).toMatchObject({ success: false });
    expect(s.odczytWierszy).toBe(0);
  });
});

describe('odebranie', () => {
  it('nadane odczyt i wystawianie: lista z KSeF, dwa odebrania, status 200, lista pusta: odebrane', async () => {
    await nadaj({ zakres: 'odczyt_i_wystawianie' });
    const id = jedyny().id;
    k.wywolania = [];

    const w = await odbierz(id);

    expect(w).toMatchObject({ success: true, stan: 'revoked' });
    expect(wywolaniaKsef()).toEqual([
      'POST /permissions/query/persons/grants',
      'DELETE /permissions/common/grants/…',
      'DELETE /permissions/common/grants/…',
      'GET /permissions/operations/…',
      'GET /permissions/operations/…',
      'POST /permissions/query/persons/grants',
    ]);
    expect(k.aktywne.size).toBe(0);
    expect(jedyny()).toMatchObject({ status: 'revoked' });
    expect(rpcNazwy().slice(-3)).toEqual(['claim_ksef_permission_revoke', 'finish_ksef_permission_attempt', 'record_ksef_permission_check']);
  });

  it('w KSeF nie ma już aktywnego uprawnienia (odebrane w Aplikacji Podatnika): odebrane bez DELETE, z uwagą', async () => {
    await nadaj();
    k.aktywne.clear();
    k.wywolania = [];

    const w = await odbierz(jedyny().id);

    expect(w).toMatchObject({ success: true, stan: 'revoked' });
    expect((w as { komunikat: string }).komunikat).toMatch(/nie było/);
    expect(wywolaniaKsef()).toEqual(['POST /permissions/query/persons/grants']);
    expect(jedyny()).toMatchObject({ status: 'revoked', errorCode: 'not_found_in_ksef' });
  });

  it('ponowne „Odbierz” po odebraniu: bez KSeF', async () => {
    await nadaj();
    await odbierz(jedyny().id);
    k.wywolania = [];

    expect(await odbierz(jedyny().id)).toMatchObject({ success: true, stan: 'revoked' });
    expect(k.wywolania).toEqual([]);
  });

  it('drugie odebranie odrzucone (403): w KSeF zostało wystawianie, stan „nie odebrano”; ponowienie odbiera resztę', async () => {
    await nadaj({ zakres: 'odczyt_i_wystawianie' });
    const id = jedyny().id;
    const doOdmowy = [...k.aktywne.entries()].find(([, p]) => p.scope === 'InvoiceWrite')![0];
    k.odebranie = (permissionId) => (permissionId === doOdmowy ? json({ title: 'Forbidden', status: 403 }, 403) : null);

    const w = await odbierz(id);

    expect(w).toMatchObject({ success: false });
    expect(jedyny()).toMatchObject({ status: 'revoke_failed' });
    expect([...k.aktywne.values()].map((p) => p.scope)).toEqual(['InvoiceWrite']);

    k.odebranie = null;
    expect(await odbierz(id)).toMatchObject({ success: true, stan: 'revoked' });
    expect(k.aktywne.size).toBe(0);
  });

  it('KSeF przetwarza odebranie (status 100): w toku, potem „Sprawdź stan” kończy', async () => {
    await nadaj();
    const id = jedyny().id;
    k.kodNowejOperacji = 100;

    expect(await odbierz(id)).toMatchObject({ success: true, stan: 'revoke_in_progress' });
    const wiersz = jedyny();
    zakonczOperacje(wiersz.refs[0]!, 200);

    expect(await sprawdz(id)).toMatchObject({ success: true, stan: 'revoked' });
  });

  it('odebranie nadania, które się nie powiodło: „nie ma czego odbierać”, bez KSeF', async () => {
    k.kodNowejOperacji = 420;
    await nadaj();
    k.wywolania = [];

    expect(await odbierz(jedyny().id)).toMatchObject({ success: false, error: expect.stringMatching(/nie jest nadane/) });
    expect(k.wywolania).toEqual([]);
  });

  it('po odebraniu można nadać ponownie', async () => {
    await nadaj();
    await odbierz(jedyny().id);

    expect(await nadaj({ zakres: 'odczyt_i_wystawianie' })).toMatchObject({ success: true, stan: 'granted' });
    expect(jedyny()).toMatchObject({ status: 'granted', scopes: ['InvoiceRead', 'InvoiceWrite'] });
  });
});
