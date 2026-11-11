import { readFileSync } from 'node:fs';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.4, część 2: akcja „Identyfikator zbiorczy” na liście „Do zapłaty”.
 *
 * Prawdziwe: akcja `utworzIdentyfikatorZbiorczyAction`, odczyt kosztów
 * (`wczytajKosztyDoPliku`), lista i grupy, klient KSeF z `ksefFetch`,
 * walidator odpowiedzi, opisy błędów. Zastąpione: sesja i baza (atrapa
 * klienta z RPC 00191 w pamięci), poświadczenia i sesja KSeF, HTTP (`fetch`),
 * audyt, `revalidatePath`, Sentry.
 *
 * API KSeF nie jest idempotentne (każde wywołanie może dać nowy identyfikator,
 * a faktura mieści najwyżej 132), więc wynik trafia do bazy, a ponowne
 * kliknięcie dla tego samego zestawu faktur oddaje zapisany identyfikator bez
 * pytania KSeF. Zachowanie RPC na prawdziwej bazie: `tests/rls-identyfikator-zbiorczy.test.ts`.
 */

interface Wpis {
  id: string;
  status: 'pending' | 'ready' | 'failed';
  attempt: string;
  identifier: string | null;
  error_code: string | null;
  seller_nip: string;
  numbers: string[];
}

const s = vi.hoisted(() => ({
  wiersze: [] as Record<string, unknown>[],
  rola: 'owner',
  tabela: new Map<string, Wpis>(),
  licznik: 0,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  zapytaniaWydatkow: 0,
  claimError: null as null | { code: string; message: string },
  completeError: null as null | { code: string; message: string },
  credentials: vi.fn(),
  getSession: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(async (_entry: unknown) => undefined),
  auditSystem: vi.fn(async (_entry: unknown) => undefined),
  revalidate: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

function rpc(fn: string, args: Record<string, unknown>) {
  s.rpcCalls.push([fn, args]);
  const wynik = (data: unknown) => Promise.resolve({ data, error: null });
  if (fn === 'claim_ksef_collective_identifier') {
    if (s.claimError) return Promise.resolve({ data: null, error: s.claimError });
    const numbers = [...(args.p_ksef_numbers as string[])].sort();
    const key = `${String(args.p_environment)}|${numbers.join(',')}`;
    const attempt = `0a0b0c0d-aaaa-4000-8000-${String(++s.licznik).padStart(12, '0')}`;
    const row = s.tabela.get(key);
    if (!row) {
      const id = `0a0b0c0d-bbbb-4000-8000-${String(s.licznik).padStart(12, '0')}`;
      s.tabela.set(key, { id, status: 'pending', attempt, identifier: null, error_code: null, seller_nip: String(args.p_seller_nip), numbers });
      return wynik({ status: 'claimed', id, attempt });
    }
    if (row.status === 'ready') return wynik({ status: 'ready', id: row.id, identifier: row.identifier });
    if (row.status === 'pending') return wynik({ status: 'in_progress', id: row.id });
    Object.assign(row, { status: 'pending', attempt, error_code: null });
    return wynik({ status: 'claimed', id: row.id, attempt });
  }
  const row = [...s.tabela.values()].find((r) => r.id === args.p_id);
  if (fn === 'complete_ksef_collective_identifier') {
    if (s.completeError) return Promise.resolve({ data: null, error: s.completeError });
    if (!row) return wynik({ status: 'refused', code: 'not_found' });
    if (row.status === 'ready') return wynik({ status: 'already_ready', identifier: row.identifier });
    if (row.status !== 'pending' || row.attempt !== args.p_attempt) return wynik({ status: 'refused', code: 'stale_attempt' });
    Object.assign(row, { status: 'ready', identifier: args.p_identifier });
    return wynik({ status: 'ready', identifier: row.identifier });
  }
  if (fn === 'fail_ksef_collective_identifier') {
    if (!row || row.status !== 'pending' || row.attempt !== args.p_attempt) return wynik({ status: 'refused', code: 'stale_attempt' });
    Object.assign(row, { status: 'failed', error_code: args.p_error_code });
    return wynik({ status: 'failed' });
  }
  throw new Error(`nieoczekiwane RPC ${fn}`);
}

function klient() {
  return {
    rpc,
    from(tabela: string) {
      if (tabela !== 'expenses') throw new Error(`nieoczekiwana tabela ${tabela}`);
      const stan: { ids: string[] } = { ids: [] };
      const b = {
        select() { return b; },
        eq() { return b; },
        in(_k: string, ids: string[]) { stan.ids = ids; return b; },
        then(ok: (v: unknown) => unknown, nie?: (e: unknown) => unknown) {
          s.zapytaniaWydatkow += 1;
          const ids = new Set(stan.ids);
          return Promise.resolve({ data: s.wiersze.filter((w) => ids.has(String(w.id))), error: null }).then(ok, nie);
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
    requireOrgRole: vi.fn(async (role: string[]) => {
      if (!role.includes(s.rola)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return { supabase: klient(), tenantId: '0a0b0c0d-0000-4000-8000-0000000000aa', user: { id: 'u-1' }, role: s.rola };
    }),
  };
});
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/admin-queries')>()),
  getTenantKsefCredentials: s.credentials,
}));
vi.mock('@/lib/ksef/session-cache', () => ({ ksefSessionCache: { getSession: s.getSession, invalidate: s.invalidate } }));
vi.mock('@/lib/ksef/rate-limiter', () => ({ ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() } }));
vi.mock('@/lib/audit/log', () => ({ logAudit: s.audit, logAuditWithResult: vi.fn(async () => true) }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: s.auditSystem }));
vi.mock('next/cache', () => ({ revalidatePath: s.revalidate }));
vi.mock('@sentry/nextjs', () => ({ captureException: s.captureException, captureMessage: s.captureMessage }));

const NIP_A = '1111111111';
const NIP_B = '1234567890';
const WEKTOR = '1111111111-IZ202607-65ED02180000-E7';
const ksef = (nip: string, n: number) => `${nip}-20261105-0A1B2C3D4E${String(n).padStart(2, '0')}-7A`;
const id = (n: number) => `0a0b0c0d-0000-4000-8000-${String(n).padStart(12, '0')}`;

function wiersz(n: number, pola: Record<string, unknown> = {}, nip = NIP_A): Record<string, unknown> {
  return {
    id: id(n),
    seller_name: 'Dostawca Testowy sp. z o.o.',
    seller_nip: nip,
    seller_address: null,
    document_number: `FV/${n}/11/2026`,
    gross_amount: 1230,
    vat_amount: 230,
    payment_due_date: '2026-11-20',
    payment_account: 'PL61109010140000071219812874',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    faktura: { ksef_number: ksef(nip, n), internal_number: `FV/${n}/11/2026`, currency: 'PLN', ksef_environment: 'test' },
    ...pola,
  };
}

const fetchMock = vi.fn();
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wyjatek = (kod: number, details: string[] = []) => ({
  exception: { exceptionDetailList: [{ exceptionCode: kod, exceptionDescription: 'x', details }], timestamp: '2026-11-11T10:00:00Z' },
});

const rpcNazwy = () => s.rpcCalls.map(([fn]) => fn);

async function akcja(ids: string[]) {
  const { utworzIdentyfikatorZbiorczyAction } = await import('@/app/actions/identyfikator-zbiorczy');
  return utworzIdentyfikatorZbiorczyAction(ids);
}

beforeEach(() => {
  s.wiersze = [wiersz(1), wiersz(2)];
  s.rola = 'owner';
  s.tabela = new Map();
  s.licznik = 0;
  s.rpcCalls = [];
  s.zapytaniaWydatkow = 0;
  s.claimError = null;
  s.completeError = null;
  s.credentials.mockReset();
  s.credentials.mockResolvedValue({ type: 'token', nip: NIP_B, token: 'a'.repeat(24) });
  s.getSession.mockReset();
  s.getSession.mockResolvedValue({
    accessToken: 'b'.repeat(24),
    refreshToken: 'c'.repeat(24),
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    nip: NIP_B,
  });
  s.invalidate.mockReset();
  s.audit.mockClear();
  s.auditSystem.mockClear();
  s.revalidate.mockReset();
  s.captureException.mockReset();
  s.captureMessage.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({ collectiveIdentifierNumber: WEKTOR }, 201));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('identyfikator zbiorczy: tworzenie i ponowne kliknięcie', () => {
  it('właściciel: KSeF nadaje identyfikator, wynik trafia do bazy, Wydatki się odświeżają', async () => {
    const wynik = await akcja([id(1), id(2)]);

    expect(wynik).toEqual({ success: true, identyfikator: WEKTOR, status: 'utworzony', zapisany: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      invoices: [{ ksefNumber: ksef(NIP_A, 1) }, { ksefNumber: ksef(NIP_A, 2) }],
    });
    expect(s.rpcCalls[0]).toEqual([
      'claim_ksef_collective_identifier',
      { p_environment: 'test', p_seller_nip: NIP_A, p_ksef_numbers: [ksef(NIP_A, 1), ksef(NIP_A, 2)] },
    ]);
    expect(s.rpcCalls[1]).toEqual([
      'complete_ksef_collective_identifier',
      { p_id: expect.any(String), p_attempt: expect.any(String), p_identifier: WEKTOR },
    ]);
    expect(s.revalidate).toHaveBeenCalledWith('/expenses');
  });

  it('ponowne kliknięcie dla tego samego zestawu (także w innej kolejności): zapisany identyfikator, bez KSeF', async () => {
    await akcja([id(1), id(2)]);

    const drugie = await akcja([id(2), id(1)]);

    expect(drugie).toEqual({ success: true, identyfikator: WEKTOR, status: 'zapisany_wczesniej', zapisany: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.credentials).toHaveBeenCalledTimes(1);
    expect(rpcNazwy()).toEqual([
      'claim_ksef_collective_identifier',
      'complete_ksef_collective_identifier',
      'claim_ksef_collective_identifier',
    ]);
  });

  it('dwa kliknięcia naraz: drugie dostaje „właśnie powstaje”, KSeF pytany raz', async () => {
    let zwolnij: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((ok) => { zwolnij = ok; }));

    const pierwsze = akcja([id(1), id(2)]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const drugie = await akcja([id(1), id(2)]);
    zwolnij(json({ collectiveIdentifierNumber: WEKTOR }, 201));

    expect(drugie).toMatchObject({ success: false, error: expect.stringContaining('właśnie powstaje') });
    expect(await pierwsze).toMatchObject({ success: true, identyfikator: WEKTOR });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('identyfikator nadany, a zapis w bazie padł: klient i tak go dostaje, a audyt ma numer', async () => {
    s.completeError = { code: '08006', message: 'connection failure' };

    const wynik = await akcja([id(1), id(2)]);

    expect(wynik).toEqual({ success: true, identyfikator: WEKTOR, status: 'utworzony', zapisany: false });
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'expense.collective_identifier_created',
        metadata: expect.objectContaining({ identifier: WEKTOR, zapisany: false, ksefNumbers: [ksef(NIP_A, 1), ksef(NIP_A, 2)] }),
      }),
    );
  });
});

describe('identyfikator zbiorczy: role', () => {
  it.each(['member', 'accountant'])('%s: odmowa bez bazy, poświadczeń i KSeF', async (rola) => {
    s.rola = rola;

    const wynik = await akcja([id(1), id(2)]);

    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('właściciel albo administrator') });
    expect(s.rpcCalls).toEqual([]);
    expect(s.zapytaniaWydatkow).toBe(0);
    expect(s.credentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('administrator: identyfikator powstaje', async () => {
    s.rola = 'admin';
    await expect(akcja([id(1), id(2)])).resolves.toMatchObject({ success: true, identyfikator: WEKTOR });
  });
});

describe('identyfikator zbiorczy: granice wyboru (bez bazy zapisu i bez KSeF)', () => {
  function bezZapisuIKsef() {
    expect(s.rpcCalls).toEqual([]);
    expect(s.credentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it('różni dostawcy (różny NIP sprzedawcy): odmowa z powodem', async () => {
    s.wiersze = [wiersz(1), wiersz(2), wiersz(3, {}, NIP_B), wiersz(4, {}, NIP_B)];
    const wynik = await akcja([id(1), id(2), id(3), id(4)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('są od różnych dostawców') });
    bezZapisuIKsef();
  });

  it('faktura bez numeru KSeF: odmowa z numerem faktury', async () => {
    s.wiersze = [wiersz(1), wiersz(2), wiersz(3, { faktura: { ksef_number: null, internal_number: 'FV/3/11/2026', currency: 'PLN', ksef_environment: 'test' } })];
    const wynik = await akcja([id(1), id(2), id(3)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('FV/3/11/2026') });
    expect((wynik as { error: string }).error).toContain('nie ma numeru KSeF');
    bezZapisuIKsef();
  });

  it('faktura już zapłacona: odmowa z numerem faktury i odświeżeniem', async () => {
    s.wiersze = [wiersz(1), wiersz(2, { paid_at: '2026-11-10' }), wiersz(3)];
    const wynik = await akcja([id(1), id(2), id(3)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('Faktura FV/2/11/2026 nie jest już na liście') });
    expect((wynik as { error: string }).error).toContain('Odśwież stronę');
    bezZapisuIKsef();
  });

  it('koszt spoza firmy albo usunięty: odmowa z odświeżeniem', async () => {
    const wynik = await akcja([id(1), id(9)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('Odśwież stronę') });
    bezZapisuIKsef();
  });

  it('MPP i bez MPP w jednym wyborze: odmowa z powodem', async () => {
    s.wiersze = [wiersz(1, { payment_split: true }), wiersz(2, { payment_split: true }), wiersz(3), wiersz(4)];
    const wynik = await akcja([id(1), id(2), id(3), id(4)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('osobno dla faktur z MPP i bez MPP') });
    bezZapisuIKsef();
  });

  it('nie wiadomo, czy jest MPP: odmowa z numerem faktury', async () => {
    s.wiersze = [wiersz(1), wiersz(2, { payment_split: null })];
    const wynik = await akcja([id(1), id(2)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('Nie wiadomo, czy faktura FV/2/11/2026 ma') });
    bezZapisuIKsef();
  });

  it.each([
    ['jedna faktura', [id(1)]],
    ['powtórzony koszt', [id(1), id(1)]],
    ['zły identyfikator kosztu', ['exp-1', id(2)]],
  ])('%s: odmowa bez odczytu kosztów', async (_opis, ids) => {
    const wynik = await akcja(ids);
    expect(wynik).toMatchObject({ success: false });
    expect(s.zapytaniaWydatkow).toBe(0);
    bezZapisuIKsef();
  });

  it('bez środowiska KSeF aplikacji: odmowa bez bazy i KSeF', async () => {
    vi.stubEnv('KSEF_ENV', '');
    const wynik = await akcja([id(1), id(2)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('pomocy FaktWay') });
    bezZapisuIKsef();
  });
});

describe('identyfikator zbiorczy: błędy po drodze (fail-closed z wyjściem)', () => {
  it('KSeF 71002: wpis „failed” z kodem, komunikat z numerem faktury; następne kliknięcie pyta KSeF jeszcze raz', async () => {
    fetchMock.mockResolvedValueOnce(json(wyjatek(71002, [ksef(NIP_A, 2)]), 400));

    const pierwsze = await akcja([id(1), id(2)]);

    expect(pierwsze).toMatchObject({ success: false, error: expect.stringContaining('FV/2/11/2026') });
    expect((pierwsze as { error: string }).error).toContain('132');
    expect(s.rpcCalls[1]).toEqual([
      'fail_ksef_collective_identifier',
      { p_id: expect.any(String), p_attempt: expect.any(String), p_error_code: 'ksef_71002', p_detail: null },
    ]);

    const drugie = await akcja([id(1), id(2)]);
    expect(drugie).toMatchObject({ success: true, identyfikator: WEKTOR, status: 'utworzony' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('odpowiedź KSeF ze złą sumą kontrolną: wpis „failed”, identyfikator nie trafia do klienta, Sentry', async () => {
    fetchMock.mockResolvedValue(json({ collectiveIdentifierNumber: '1111111111-IZ202607-65ED02180000-E8' }, 201));

    const wynik = await akcja([id(1), id(2)]);

    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('nie pokazujemy') });
    expect(JSON.stringify(wynik)).not.toContain('65ED02180000');
    expect(s.rpcCalls.map(([fn, a]) => [fn, a.p_error_code])).toContainEqual(['fail_ksef_collective_identifier', 'invalid_response']);
    // Surowa odpowiedź idzie tylko do audytu w bazie (szczegół porażki), nie do klienta i nie do Sentry.
    expect(s.rpcCalls.find(([fn]) => fn === 'fail_ksef_collective_identifier')![1].p_detail).toBe(
      'format: 1111111111-IZ202607-65ED02180000-E8',
    );
    expect(s.captureMessage).toHaveBeenCalled();
    expect(JSON.stringify(s.captureMessage.mock.calls)).not.toContain('65ED02180000');
  });

  it('firma bez połączenia z KSeF: wpis „failed”, komunikat z Ustawieniami, bez wywołania KSeF', async () => {
    const { KsefCredentialsError } = await import('@/lib/supabase/admin-queries');
    s.credentials.mockRejectedValue(new KsefCredentialsError('missing', 'Tenant nie ma skonfigurowanych credentials KSeF'));

    const wynik = await akcja([id(1), id(2)]);

    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('Podłącz KSeF') });
    expect(s.rpcCalls.map(([fn, a]) => [fn, a.p_error_code])).toContainEqual(['fail_ksef_collective_identifier', 'credentials_missing']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('przed migracją 00191 (brak funkcji w bazie): komunikat o aktualizacji, bez KSeF', async () => {
    s.claimError = { code: 'PGRST202', message: 'Could not find the function public.claim_ksef_collective_identifier' };

    const wynik = await akcja([id(1), id(2)]);

    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('po aktualizacji FaktWay') });
    expect(s.credentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inny błąd bazy przy rezerwacji: komunikat, bez KSeF', async () => {
    s.claimError = { code: '57014', message: 'canceling statement due to statement timeout' };

    const wynik = await akcja([id(1), id(2)]);

    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('Spróbuj ponownie') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('migracja 00191: tekst', () => {
  let sql = '';
  let bezCial = '';
  beforeAll(() => {
    sql = readFileSync('supabase/migrations/00191_ksef_collective_identifiers.sql', 'utf8');
    bezCial = sql.replace(/\$\$[\s\S]*?\$\$/g, '');
  });

  it('nagłówek: PRZED wdrożeniem, tabela z tenant_id i RLS, odczyt tylko własnej firmy', () => {
    expect(sql.split('\n').slice(0, 40).join('\n')).toMatch(/PRZED wdrożeniem/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ksef_collective_identifiers \(/);
    expect(sql).toMatch(/tenant_id UUID NOT NULL REFERENCES public\.tenants\(id\) ON DELETE CASCADE/);
    expect(sql).toContain('ALTER TABLE public.ksef_collective_identifiers ENABLE ROW LEVEL SECURITY;');
    expect(sql).toMatch(/FOR SELECT\s+TO authenticated\s+USING \(tenant_id = public\.get_current_tenant_id\(\)\)/);
  });

  it('jeden wiersz na zestaw faktur w firmie i środowisku (UNIQUE), bez zapisu z sesji poza RPC', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON public\.ksef_collective_identifiers \(tenant_id, ksef_environment, invoices_key\)/);
    expect(bezCial).toContain('REVOKE ALL ON public.ksef_collective_identifiers FROM PUBLIC, anon, authenticated, service_role;');
    expect(bezCial).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.ksef_collective_identifiers TO authenticated/);
    // Żeton próby nie jest do odczytu dla sesji: kolumny wymienione jawnie, bez `attempt`.
    const grantSelect = /GRANT SELECT \(([^)]*)\)\s+ON public\.ksef_collective_identifiers TO authenticated;/.exec(bezCial)?.[1] ?? '';
    expect(grantSelect).toContain('identifier');
    expect(grantSelect).not.toMatch(/\battempt\b/);
  });

  it.each(['claim_ksef_collective_identifier', 'complete_ksef_collective_identifier', 'fail_ksef_collective_identifier'])(
    '%s: SECURITY DEFINER, sesja, rola owner/admin (bez member i księgowej), EXECUTE tylko authenticated',
    (fn) => {
      const cialo = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]*?\\$\\$;`).exec(sql)?.[0] ?? '';
      expect(cialo).toContain('SECURITY DEFINER');
      expect(cialo).toContain("SET search_path = ''");
      expect(cialo).toContain('auth.uid() IS NULL');
      // Rola sprawdzona i odmowa 42501, zanim funkcja czegokolwiek dotknie.
      expect(cialo).toMatch(
        /IF NOT \(public\.has_org_role\(v_tenant_id, 'owner'\) OR public\.has_org_role\(v_tenant_id, 'admin'\)\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = '42501';/,
      );
      expect(cialo).not.toContain("'member'");
      expect(cialo).not.toContain("'accountant'");
      expect(bezCial).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated, service_role;`));
      expect(bezCial).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated;`));
    },
  );

  it('audyt w audit_logs w tej samej transakcji: utworzenie i porażka', () => {
    expect(sql).toContain("'expense.collective_identifier_created'");
    expect(sql).toContain("'expense.collective_identifier_failed'");
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });
});
