import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T3 (PLAN-PRAWDZIWE-DANE §4, §8): tabela stanów firmy → tryb danych.
 * `rozstrzygnijTryb` to czysta reguła; `kontekstDanych` / `trybDanych`
 * czytają dowód KSeF TEJ firmy, z której strona czyta dane (`ctx.tenantId`,
 * „Uwaga do F”), i lekko `ksef_history_sync` (00155) — z wynikiem z §4 przy
 * każdym wyjątku (G, G'). W trybie `synchronizacja` strona czyta PRAWDZIWE
 * dane; tryb tylko pozwala kartom powiedzieć „Pobieramy faktury z KSeF…”.
 */

type Proof = { verifiedAt: string | null; verifiedEnvironment: string | null };

const proofs = vi.hoisted(() => ({
  byTenant: {} as Record<string, Proof | Error | null>,
  calls: [] as Array<[string, string]>,
}));

vi.mock('@/lib/dashboard-shell-data', () => ({
  getTenantKsefProof: async (userId: string, tenantId: string) => {
    proofs.calls.push([userId, tenantId]);
    const proof = proofs.byTenant[tenantId];
    if (proof instanceof Error) throw proof;
    return proof ?? null;
  },
}));

const { kontekstDanych, rozstrzygnijTryb, trybDanych } = await import('@/lib/demo/tryb-danych');
type StrumienHistorii = import('@/lib/demo/tryb-danych').StrumienHistorii;
const { DEMO_TENANT } = await import('@/lib/demo/analizy-przykladowe');
const { configuredKsefEnvironment, hasConfiguredKsefProof } = await import('@/lib/ksef/claim-environment');

const NOW = new Date('2026-10-23T10:00:00Z');
const DAWNO = '2026-09-01T08:00:00Z';
const POL_GODZINY_TEMU = '2026-10-23T09:30:00Z';
const TRZY_GODZINY_TEMU = '2026-10-23T07:00:00Z';

const zweryfikowana: Proof = { verifiedAt: DAWNO, verifiedEnvironment: 'test' };

function strumien(fields: Partial<StrumienHistorii> = {}): StrumienHistorii {
  return {
    direction: 'outgoing',
    created_at: DAWNO,
    backfill_completed_at: null,
    client_paused_at: null,
    last_error_code: null,
    ...fields,
  };
}

const gotowy = (fields: Partial<StrumienHistorii> = {}) => strumien({ backfill_completed_at: DAWNO, ...fields });

describe('rozstrzygnijTryb — tabela stanów §4', () => {
  const cases: Array<[
    stan: string,
    opis: string,
    wejscie: Parameters<typeof rozstrzygnijTryb>[0],
    tryb: 'przyklad' | 'synchronizacja' | 'prawdziwe',
  ]> = [
    ['A', 'brak weryfikacji', { srodowisko: 'test', dowod: { verifiedAt: null, verifiedEnvironment: null }, strumienie: null, now: NOW }, 'przyklad'],
    ['A', 'środowisko bez daty weryfikacji', { srodowisko: 'test', dowod: { verifiedAt: null, verifiedEnvironment: 'test' }, strumienie: null, now: NOW }, 'przyklad'],
    ['H', 'weryfikacja z innego środowiska (TEST → PROD)', { srodowisko: 'production', dowod: zweryfikowana, strumienie: null, now: NOW }, 'przyklad'],
    ['H', 'data jest, środowiska brak', { srodowisko: 'test', dowod: { verifiedAt: DAWNO, verifiedEnvironment: null }, strumienie: null, now: NOW }, 'przyklad'],
    ["G''", 'brak KSEF_ENV — prawdziwe, nie przykład u każdej firmy', { srodowisko: null, dowod: zweryfikowana, strumienie: null, now: NOW }, 'prawdziwe'],
    ["G''", 'brak KSEF_ENV i brak weryfikacji', { srodowisko: null, dowod: { verifiedAt: null, verifiedEnvironment: null }, strumienie: null, now: NOW }, 'prawdziwe'],
    ['G', 'błąd odczytu dowodu', { srodowisko: 'test', dowod: 'blad', strumienie: null, now: NOW }, 'prawdziwe'],
    ["G'", 'błąd odczytu ksef_history_sync', { srodowisko: 'test', dowod: zweryfikowana, strumienie: 'blad', now: NOW }, 'prawdziwe'],
    ['B', 'strumień sprzedaży bez backfill_completed_at', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [strumien()], now: NOW }, 'synchronizacja'],
    ['B', 'strumienia jeszcze nie ma, weryfikacja < 2 h temu', { srodowisko: 'test', dowod: { verifiedAt: POL_GODZINY_TEMU, verifiedEnvironment: 'test' }, strumienie: [], now: NOW }, 'synchronizacja'],
    ['B', 'strumienia nie ma, sam strumień zakupów (zakupy nie przesądzają)', { srodowisko: 'test', dowod: { verifiedAt: POL_GODZINY_TEMU, verifiedEnvironment: 'test' }, strumienie: [gotowy({ direction: 'incoming' })], now: NOW }, 'synchronizacja'],
    ["B'", 'pobieranie sprzedaży wstrzymane przez klienta', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [strumien({ client_paused_at: POL_GODZINY_TEMU })], now: NOW }, 'prawdziwe'],
    ['E', 'certyfikat wygasł (pierwszeństwo przed B i B\')', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [strumien({ last_error_code: 'certificate_expired', client_paused_at: POL_GODZINY_TEMU })], now: NOW }, 'prawdziwe'],
    ['E', 'brak poświadczeń, historia już pobrana', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [gotowy({ last_error_code: 'credentials' })], now: NOW }, 'prawdziwe'],
    ['E', 'brak uprawnień', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [strumien({ last_error_code: 'permission' })], now: NOW }, 'prawdziwe'],
    ['B', 'błąd KSeF (nie certyfikat) nie jest stanem E', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [strumien({ last_error_code: 'ksef_unavailable' })], now: NOW }, 'synchronizacja'],
    ['C', 'historia sprzedaży pobrana', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [gotowy()], now: NOW }, 'prawdziwe'],
    ['C', 'zakupy w toku nie przedłużają B', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [gotowy(), strumien({ direction: 'incoming' })], now: NOW }, 'prawdziwe'],
    ['C', 'błąd certyfikatu tylko w strumieniu zakupów', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [gotowy(), strumien({ direction: 'incoming', last_error_code: 'certificate_expired' })], now: NOW }, 'prawdziwe'],
    ['C', 'pauza po pobraniu historii', { srodowisko: 'test', dowod: zweryfikowana, strumienie: [gotowy({ client_paused_at: POL_GODZINY_TEMU })], now: NOW }, 'prawdziwe'],
    ['C', 'bez strumienia 2 h po weryfikacji (Z4: firma bez poświadczeń)', { srodowisko: 'test', dowod: { verifiedAt: TRZY_GODZINY_TEMU, verifiedEnvironment: 'test' }, strumienie: [], now: NOW }, 'prawdziwe'],
    ['C', 'strumieni nie czytano', { srodowisko: 'test', dowod: zweryfikowana, strumienie: null, now: NOW }, 'prawdziwe'],
  ];

  it.each(cases)('%s — %s', (stan, _opis, wejscie, tryb) => {
    expect(rozstrzygnijTryb(wejscie)).toEqual({ tryb, stan });
  });

  it('zweryfikowana ⇔ hasConfiguredKsefProof (jedno źródło prawdy o weryfikacji)', () => {
    const srodowisko = configuredKsefEnvironment();
    expect(srodowisko).toBe('test');
    const dowody: Proof[] = [
      { verifiedAt: null, verifiedEnvironment: null },
      { verifiedAt: DAWNO, verifiedEnvironment: 'test' },
      { verifiedAt: DAWNO, verifiedEnvironment: 'production' },
      { verifiedAt: null, verifiedEnvironment: 'test' },
      { verifiedAt: DAWNO, verifiedEnvironment: null },
    ];
    for (const dowod of dowody) {
      const { tryb } = rozstrzygnijTryb({ srodowisko, dowod, strumienie: [gotowy()], now: NOW });
      expect(tryb !== 'przyklad').toBe(hasConfiguredKsefProof(dowod.verifiedAt, dowod.verifiedEnvironment));
    }
  });
});

// ─── kontekstDanych / trybDanych ────────────────────────────────────────────

interface HistoryRead {
  table: string;
  columns: string | null;
  filters: Array<[string, unknown]>;
}

/** Klient sesji z jedną tabelą `ksef_history_sync` (wynik albo błąd). */
function sesja(wynik: StrumienHistorii[] | { message: string } | Error) {
  const reads: HistoryRead[] = [];
  const client = {
    from(table: string) {
      if (wynik instanceof Error) throw wynik;
      const read: HistoryRead = { table, columns: null, filters: [] };
      reads.push(read);
      const builder = {
        select(columns: string) { read.columns = columns; return builder; },
        eq(column: string, value: unknown) { read.filters.push([column, value]); return builder; },
        then<T>(resolve: (v: { data: StrumienHistorii[] | null; error: { message: string } | null }) => T) {
          return Promise.resolve(
            Array.isArray(wynik) ? { data: wynik, error: null } : { data: null, error: wynik },
          ).then(resolve);
        },
      };
      return builder;
    },
  };
  return { supabase: client as never, reads };
}

const USER = { id: 'uzytkownik-1' };

beforeEach(() => {
  proofs.byTenant = { 'firma-a': zweryfikowana };
  proofs.calls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('kontekstDanych', () => {
  it('C: prawdziwy klient i firma, bez plakietki, data weryfikacji dla podpisów', async () => {
    const { supabase, reads } = sesja([gotowy()]);
    const ctx = await kontekstDanych({ supabase, tenantId: 'firma-a', user: USER }, NOW);
    expect(ctx).toEqual({
      tryb: 'prawdziwe',
      stan: 'C',
      demo: false,
      supabase,
      tenantId: 'firma-a',
      nowIso: NOW.toISOString(),
      verifiedAt: DAWNO,
      // E10: strumienia zakupów jeszcze nie ma — koszty z KSeF pełne od weryfikacji.
      kosztyKsefOd: DAWNO,
    });
    // Jedno lekkie zapytanie sesją (RLS), tylko kolumny z GRANT dla `authenticated` (00155).
    expect(reads).toEqual([{
      table: 'ksef_history_sync',
      columns: 'direction, created_at, backfill_completed_at, client_paused_at, last_error_code',
      filters: [['tenant_id', 'firma-a'], ['environment', 'test']],
    }]);
    expect(proofs.calls).toEqual([[USER.id, 'firma-a']]);
  });

  it('A: atrapa z danymi przykładowymi, firma-atrapa, bez odczytu ksef_history_sync', async () => {
    proofs.byTenant['firma-a'] = { verifiedAt: null, verifiedEnvironment: null };
    const { supabase, reads } = sesja([strumien()]);
    const ctx = await kontekstDanych({ supabase, tenantId: 'firma-a', user: USER }, NOW);
    expect(ctx).toMatchObject({ tryb: 'przyklad', stan: 'A', demo: true, tenantId: DEMO_TENANT, verifiedAt: null });
    expect(ctx.supabase).not.toBe(supabase);
    expect(reads).toEqual([]);
    const { data } = await ctx.supabase.from('invoices').select('id').eq('tenant_id', DEMO_TENANT);
    expect((data ?? []).length).toBeGreaterThan(5);
  });

  it('B: synchronizacja czyta PRAWDZIWE dane (nigdy przykład)', async () => {
    const { supabase } = sesja([strumien()]);
    const ctx = await kontekstDanych({ supabase, tenantId: 'firma-a', user: USER }, NOW);
    expect(ctx).toMatchObject({ tryb: 'synchronizacja', stan: 'B', demo: false, tenantId: 'firma-a' });
    expect(ctx.supabase).toBe(supabase);
  });

  it('F: tryb liczony dla firmy, z której strona czyta dane (ctx.tenantId)', async () => {
    proofs.byTenant = { 'firma-a': zweryfikowana, 'firma-b': { verifiedAt: null, verifiedEnvironment: null } };
    const { supabase } = sesja([gotowy()]);
    const a = await kontekstDanych({ supabase, tenantId: 'firma-a', user: USER }, NOW);
    const b = await kontekstDanych({ supabase, tenantId: 'firma-b', user: USER }, NOW);
    expect([a.tryb, a.tenantId]).toEqual(['prawdziwe', 'firma-a']);
    expect([b.tryb, b.tenantId]).toEqual(['przyklad', DEMO_TENANT]);
    expect(proofs.calls).toEqual([[USER.id, 'firma-a'], [USER.id, 'firma-b']]);
  });

  it('G: wyjątek przy odczycie dowodu → prawdziwe dane', async () => {
    proofs.byTenant['firma-a'] = new Error('poza żądaniem');
    const { supabase, reads } = sesja([strumien()]);
    const ctx = await kontekstDanych({ supabase, tenantId: 'firma-a', user: USER }, NOW);
    expect(ctx).toMatchObject({ tryb: 'prawdziwe', stan: 'G', demo: false, tenantId: 'firma-a', verifiedAt: null });
    expect(ctx.supabase).toBe(supabase);
    expect(reads).toEqual([]);
  });

  it('G: firmy nie ma w wierszach członkostwa → prawdziwe dane', async () => {
    proofs.byTenant = {};
    const { supabase } = sesja([]);
    expect(await trybDanych({ supabase, tenantId: 'firma-x', user: USER }, NOW)).toEqual({ tryb: 'prawdziwe', stan: 'G', verifiedAt: null, kosztyKsefOd: null });
  });

  it("G': błąd PostgREST-a albo wyjątek przy odczycie strumieni → prawdziwe dane jak C", async () => {
    const zBledem = sesja({ message: 'PGRST205' });
    expect(await trybDanych({ supabase: zBledem.supabase, tenantId: 'firma-a', user: USER }, NOW))
      .toEqual({ tryb: 'prawdziwe', stan: "G'", verifiedAt: DAWNO, kosztyKsefOd: DAWNO });
    const zWyjatkiem = sesja(new Error('sieć'));
    expect(await trybDanych({ supabase: zWyjatkiem.supabase, tenantId: 'firma-a', user: USER }, NOW))
      .toEqual({ tryb: 'prawdziwe', stan: "G'", verifiedAt: DAWNO, kosztyKsefOd: DAWNO });
  });

  it("G'': brak KSEF_ENV → prawdziwe dane u każdej firmy (dziś przykład)", async () => {
    vi.stubEnv('KSEF_ENV', '');
    proofs.byTenant['firma-a'] = { verifiedAt: null, verifiedEnvironment: null };
    const { supabase, reads } = sesja([]);
    const ctx = await kontekstDanych({ supabase, tenantId: 'firma-a', user: USER }, NOW);
    expect(ctx).toMatchObject({ tryb: 'prawdziwe', stan: "G''", demo: false, tenantId: 'firma-a', verifiedAt: null });
    expect(ctx.supabase).toBe(supabase);
    expect(reads).toEqual([]);
  });

  it('H: weryfikacja z innego środowiska → przykład', async () => {
    vi.stubEnv('KSEF_ENV', 'demo');
    const { supabase, reads } = sesja([gotowy()]);
    const ctx = await kontekstDanych({ supabase, tenantId: 'firma-a', user: USER }, NOW);
    expect(ctx).toMatchObject({ tryb: 'przyklad', stan: 'H', demo: true, tenantId: DEMO_TENANT, verifiedAt: null });
    expect(reads).toEqual([]);
  });

  it('E10: „KSeF od DD.MM” przy kosztach tylko, dopóki historia zakupów z KSeF się pobiera', async () => {
    const trybZ = async (strumienie: StrumienHistorii[] | { message: string }) =>
      (await trybDanych({ supabase: sesja(strumienie).supabase, tenantId: 'firma-a', user: USER }, NOW)).kosztyKsefOd;
    // Strumień zakupów skończył zaległość — koszty z KSeF są pełne, nota znika.
    expect(await trybZ([gotowy(), gotowy({ direction: 'incoming' })])).toBeNull();
    // Zakupy jeszcze się pobierają albo strumienia zakupów jeszcze nie ma — od weryfikacji.
    expect(await trybZ([gotowy(), strumien({ direction: 'incoming' })])).toBe(DAWNO);
    expect(await trybZ([gotowy()])).toBe(DAWNO);
    // Gotowa jest tylko sprzedaż — to nie przesądza o zakupach.
    expect(await trybZ([gotowy({ direction: 'outgoing' })])).toBe(DAWNO);
    // Błąd odczytu strumieni (G') — nie wiemy, więc zastrzeżenie zostaje.
    expect(await trybZ({ message: 'PGRST205' })).toBe(DAWNO);
    // Przed weryfikacją (przykład) — bez noty.
    proofs.byTenant['firma-a'] = { verifiedAt: null, verifiedEnvironment: null };
    expect(await trybZ([gotowy({ direction: 'incoming' })])).toBeNull();
  });

  it("B' i E z odczytu strumieni", async () => {
    const pauza = sesja([strumien({ client_paused_at: POL_GODZINY_TEMU })]);
    expect((await trybDanych({ supabase: pauza.supabase, tenantId: 'firma-a', user: USER }, NOW)).stan).toBe("B'");
    const certyfikat = sesja([gotowy({ last_error_code: 'certificate_expired' })]);
    expect((await trybDanych({ supabase: certyfikat.supabase, tenantId: 'firma-a', user: USER }, NOW)).stan).toBe('E');
  });
});
