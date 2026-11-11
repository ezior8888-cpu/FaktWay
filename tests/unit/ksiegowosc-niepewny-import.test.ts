import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { zWiersza } from '@/lib/ksiegowosc/profil';
import { czytajEwidencje, czytajFakturyRoku } from '@/lib/ksiegowosc/ewidencja-dane';
import { zbudujKpir } from '@/lib/ksiegowosc/kpir';

/**
 * F11-C4: ewidencja i KPiR liczyły faktury z importu KSeF, którym JPK odmawia,
 * bo ich danych FaktWay nie zna pewnie:
 *  - import sprzed odczytu daty sprzedaży i adnotacji z pliku KSeF (C5b): data
 *    sprzedaży nieznana, więc przychód mógł wejść w zły miesiąc;
 *  - pozycje z różnymi datami sprzedaży albo nieczytelna data (`saleDates.unclear`);
 *  - sumy faktury nieznane (`lineAmountTotalsUnknown`): netto 0 i faktura
 *    znikała po cichu.
 * Teraz każda taka faktura to brak z numerem i wyjściem (jak FP), a miesiąc
 * nie ma sum. Ścieżka: `czytajEwidencje` na atrapie bazy; KPiR z tych samych
 * faktur przez `zbudujKpir`.
 */

type Wiersz = Record<string, unknown>;

function atrapa(faktury: Wiersz[], wersje: Wiersz[]): SupabaseClient {
  const from = (tabela: string) => {
    const stan = { head: false };
    const wynik = () => {
      if (tabela === 'invoices' && stan.head) return { count: 0, error: null };
      if (tabela === 'invoices') return { data: faktury, count: faktury.length, error: null };
      if (tabela === 'invoice_line_items') return { data: [], count: 0, error: null };
      if (tabela === 'tax_profiles') return { data: wersje, error: null };
      if (tabela === 'ledger_manual_entries') return { data: [], count: 0, error: null };
      throw new Error(`nieoczekiwana tabela ${tabela}`);
    };
    const lancuch: Record<string, unknown> = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then') return (ok: (v: unknown) => unknown, nie: (e: unknown) => unknown) => Promise.resolve().then(wynik).then(ok, nie);
          return (...args: unknown[]) => {
            if (prop === 'select' && (args[1] as { head?: boolean } | undefined)?.head) stan.head = true;
            return lancuch;
          };
        },
      },
    );
    return lancuch;
  };
  return { from } as unknown as SupabaseClient;
}

const PROFIL_RYCZALT = { id: 'p1', valid_from: '2026-01-01', forma: 'ryczalt', stawka_domyslna: 1200, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null };

function faktura(id: string, numer: string, z: Wiersz = {}): Wiersz {
  return {
    id,
    internal_number: numer,
    issue_date: '2026-09-03',
    sale_date: '2026-09-03',
    net_total: 1000,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    advance_invoice_ids: null,
    currency: 'PLN',
    ksef_number: '1234567890-20260903-0A1B2C-3D4E5F-6A',
    buyer_data: { nip: '1234567890', name: 'Nabywca Testowy' },
    fp: null,
    origin: 'ksef_import',
    import_adnotacje: { splitPayment: false },
    import_daty_niejasne: null,
    import_sumy_nieznane: null,
    ...z,
  };
}

const PRZED_ODCZYTEM = faktura('f1', 'FA/1/09/2026', { import_adnotacje: null });
const ROZNE_DATY = faktura('f2', 'FA/2/09/2026', { import_daty_niejasne: 'true' });
const BEZ_SUM = faktura('f3', 'FA/3/09/2026', { import_sumy_nieznane: 'true', net_total: 0 });
const PEWNA = faktura('f4', 'FA/4/09/2026');
const Z_FAKTWAY = faktura('f5', 'FV/5/09/2026', { origin: 'app', import_adnotacje: null });

describe('F11-C4: faktury z importu, których danych FaktWay nie zna pewnie', () => {
  it.each([
    [PRZED_ODCZYTEM, 'FA/1/09/2026'],
    [ROZNE_DATY, 'FA/2/09/2026'],
    [BEZ_SUM, 'FA/3/09/2026'],
  ])('ewidencja: brak z numerem zamiast wiersza (%#)', async (f, numer) => {
    const wynik = await czytajEwidencje(atrapa([f, PEWNA], [PROFIL_RYCZALT]), 'firma-1', 2026, { kurs: vi.fn() });
    if (!wynik.ok) throw new Error(wynik.komunikat);
    const braki = wynik.ewidencja.braki.filter((b) => b.dokument === numer);
    expect(braki).toHaveLength(1);
    expect(braki[0]?.komunikat).toContain(numer);
    expect(wynik.ewidencja.wiersze.map((w) => w.dowod)).not.toContain(numer);
  });

  it('straże: pewna faktura z importu i faktura z FaktWay bez adnotacji importu wchodzą do ewidencji', async () => {
    const wynik = await czytajEwidencje(atrapa([PEWNA, Z_FAKTWAY], [PROFIL_RYCZALT]), 'firma-1', 2026, { kurs: vi.fn() });
    if (!wynik.ok) throw new Error(wynik.komunikat);
    expect(wynik.ewidencja.braki).toEqual([]);
    expect(wynik.ewidencja.wiersze.map((w) => w.dowod).sort()).toEqual(['FA/4/09/2026', 'FV/5/09/2026']);
  });

  it('KPiR z tych samych faktur: braki dla trzech niepewnych, wiersz dla pewnej', async () => {
    const odczyt = await czytajFakturyRoku(atrapa([PRZED_ODCZYTEM, ROZNE_DATY, BEZ_SUM, PEWNA], [PROFIL_RYCZALT]), 'firma-1', 2026, { kurs: vi.fn() });
    if (!odczyt.ok) throw new Error(odczyt.komunikat);
    const wersje = [zWiersza({ ...PROFIL_RYCZALT, id: 'p2', forma: 'skala', stawka_domyslna: null } as unknown as Parameters<typeof zWiersza>[0])];
    const kpir = zbudujKpir({ rok: 2026, faktury: odczyt.faktury, koszty: [], wpisy: [], wersje, kursy: odczyt.kursy });
    expect(kpir.braki.map((b) => b.dokument).sort()).toEqual(['FA/1/09/2026', 'FA/2/09/2026', 'FA/3/09/2026']);
    expect(kpir.wiersze.map((w) => w.dowod)).toEqual(['FA/4/09/2026']);
  });
});
