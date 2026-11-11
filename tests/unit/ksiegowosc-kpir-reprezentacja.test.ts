// F11-C2: koszty „Reprezentacja” poza KPiR (art. 23 ust. 1 pkt 23 ustawy o PIT). Przygotowanie jak w ksiegowosc-kpir-dane.test.ts.
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
  zaplacone: [] as unknown[],
  bladZaplat: null as { code: string; message: string } | null,
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

const { czytajKpir } = await import('@/lib/ksiegowosc/kpir-dane');

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

let KOSZTY: unknown[] = [KOSZT_KSEF];

function lancuch(wynik: () => unknown) {
  const l: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'in']) l[m] = () => l;
  l.range = async () => wynik();
  l.then = (ok: (v: unknown) => unknown, blad: (e: unknown) => unknown) => Promise.resolve(wynik()).then(ok, blad);
  return l;
}

const client = {
  from: (tabela: string) => {
    if (tabela === 'expenses') return lancuch(() => ({ data: KOSZTY, count: KOSZTY.length, error: null }));
    if (tabela === 'invoices') return lancuch(() => mocks.waluty);
    if (tabela === 'tax_settlements') return lancuch(() => ({ data: mocks.bladZaplat ? null : mocks.zaplacone, count: mocks.zaplacone.length, error: mocks.bladZaplat }));
    // Spisy z natury (K7.4) mają własny test odczytu; tu żadnych.
    if (tabela === 'ledger_inventory_counts') return lancuch(() => ({ data: [], count: 0, error: null }));
    throw new Error(tabela);
  },
} as unknown as import('@supabase/supabase-js').SupabaseClient;

beforeEach(() => {
  mocks.waluty = { data: [], error: null };
  mocks.odczytyProfilu = 0;
  mocks.zaplacone = [];
  mocks.bladZaplat = null;
});

describe('F11-C2: koszty reprezentacji nie są kosztem KPiR', () => {
  it('koszt z kategorią „Reprezentacja” (np. restauracja ze Skrzynki) nie daje wiersza KPiR; zwykły koszt zostaje', async () => {
    mocks.waluty = { data: [{ id: 'f-ksef-1', currency: 'PLN' }], error: null };
    KOSZTY = [KOSZT_KSEF, { ...KOSZT_KSEF, id: 'k2', ksef_invoice_id: null, source: 'ocr_photo', document_number: 'R/7', category_label: 'Reprezentacja' }];
    const wynik = await czytajKpir(client, 'firma-1', 2026, { wersje: [SKALA] });
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    const dowody = JSON.stringify(wynik);
    expect(dowody).toContain('FZ/1');
    expect(dowody).not.toContain('R/7');
    KOSZTY = [KOSZT_KSEF];
  });
});
