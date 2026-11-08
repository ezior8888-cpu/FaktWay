import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Odczyt KPiR (plan księgowości JDG, K7): komunikat zależy od przyczyny.
 * Koszt z KSeF w walucie bez przeglądu kursu odsyła do Kosztów, a błąd
 * zapytania o waluty to zwykły błąd odczytu z ponowieniem. Wersje profilu
 * podane przez wołającego nie są czytane drugi raz. Atrapy dla bazy, faktur,
 * wpisów i środowiska KSeF; strażnik walut jest prawdziwy.
 */

const SKALA: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'skala',
  stawkaDomyslna: null,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: false,
  nrsZus: null,
  najem: false,
};

const mocks = vi.hoisted(() => ({
  waluty: { data: [] as unknown[] | null, error: null as unknown },
  odczytyProfilu: 0,
}));

vi.mock('@/lib/ksiegowosc/ewidencja-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ewidencja-dane')>()),
  czytajFakturyRoku: async () => ({ ok: true, faktury: [], kursy: new Map() }),
}));
vi.mock('@/lib/ksiegowosc/wpisy-reczne', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wpisy-reczne')>()),
  czytajWpisyKpir: async () => [],
}));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => {
    mocks.odczytyProfilu += 1;
    return [SKALA];
  },
}));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'test' }));
vi.mock('@/lib/expenses/ksef-environment', () => ({
  filterExpensesForKsefEnvironment: async (_c: unknown, _t: string, _e: string, wiersze: unknown[]) => wiersze,
}));
vi.mock('@/lib/exports/data-fetcher', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/data-fetcher')>()),
  attachKsefNumbers: async () => undefined,
}));

const { czytajKpir, KOMUNIKAT_WALUTA_KOSZTU } = await import('@/lib/ksiegowosc/kpir-dane');
const { KOMUNIKAT_ODCZYT } = await import('@/lib/ksiegowosc/ewidencja-dane');

const KOSZT_KSEF = {
  id: 'k1',
  source: 'ksef_inbox',
  ksef_invoice_id: 'f-ksef-1',
  issue_date: '2026-03-12',
  document_number: 'FZ/1',
  document_type: 'invoice',
  seller_name: 'Dostawca',
  seller_nip: '5260001246',
  seller_address: 'Kraków',
  net_amount: 300,
  vat_amount: 69,
  gross_amount: 369,
  vat_deductible_amount: 69,
  kpir_column: 'col_13',
  category_label: 'Usługi',
  is_reviewed: false,
  ocr_extracted_data: null,
};

function lancuch(wynik: () => unknown) {
  const l: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'in']) l[m] = () => l;
  l.range = async () => wynik();
  l.then = (ok: (v: unknown) => unknown, blad: (e: unknown) => unknown) => Promise.resolve(wynik()).then(ok, blad);
  return l;
}

const client = {
  from: (tabela: string) => {
    if (tabela === 'expenses') return lancuch(() => ({ data: [KOSZT_KSEF], count: 1, error: null }));
    if (tabela === 'invoices') return lancuch(() => mocks.waluty);
    throw new Error(tabela);
  },
} as unknown as import('@supabase/supabase-js').SupabaseClient;

beforeEach(() => {
  mocks.waluty = { data: [], error: null };
  mocks.odczytyProfilu = 0;
});

describe('odczyt KPiR', () => {
  it('błąd zapytania o waluty faktur KSeF to błąd odczytu, a nie koszt czekający na przegląd kursu', async () => {
    mocks.waluty = { data: null, error: { message: 'boom' } };
    expect(await czytajKpir(client, 'firma-1', 2026)).toEqual({ ok: false, komunikat: KOMUNIKAT_ODCZYT });
  });

  it('koszt z KSeF w EUR bez przeglądu kursu: komunikat z odesłaniem do Kosztów', async () => {
    mocks.waluty = { data: [{ id: 'f-ksef-1', currency: 'EUR' }], error: null };
    expect(await czytajKpir(client, 'firma-1', 2026)).toEqual({ ok: false, komunikat: KOMUNIKAT_WALUTA_KOSZTU });
  });

  it('wersje profilu od wołającego nie są czytane drugi raz', async () => {
    mocks.waluty = { data: [{ id: 'f-ksef-1', currency: 'PLN' }], error: null };
    const wynik = await czytajKpir(client, 'firma-1', 2026, { wersje: [SKALA] });
    if (!wynik.ok) throw new Error(wynik.komunikat);
    expect(wynik.kpir.wiersze.map((w) => [w.dowod, w.kwoty.k13])).toEqual([['FZ/1', 30_000]]);
    expect(mocks.odczytyProfilu).toBe(0);
  });
});
