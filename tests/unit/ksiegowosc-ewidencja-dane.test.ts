import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { czytajEwidencje, KOMUNIKAT_ODCZYT, KOMUNIKAT_SRODOWISKO, kontrahentJpk, rodzajFaktury } from '@/lib/ksiegowosc/ewidencja-dane';
import { kwotaNaGrosze, wpisSchema } from '@/lib/ksiegowosc/wpisy-reczne';

/**
 * Odczyt ewidencji (plan księgowości JDG, K3) na atrapie Supabase, która
 * zapisuje wywołania: te same filtry co KPiR (PLAN-FINORA §2.4), okno
 * wystawienia 60 dni za rokiem, FP, waluty i komunikaty fail-closed.
 */

type Wywolanie = { tabela: string; metoda: string; args: unknown[] };

interface Dane {
  faktury?: Record<string, unknown>[];
  pozycje?: Record<string, unknown>[];
  wersje?: Record<string, unknown>[];
  wpisy?: Record<string, unknown>[] | 'brak_tabeli';
  niepelneSrodowisko?: number;
  bladFaktur?: boolean;
}

function atrapa(dane: Dane) {
  const wywolania: Wywolanie[] = [];
  const from = (tabela: string) => {
    const stan = { head: false, tylkoZeStawka: false, ids: null as string[] | null };
    const wynik = () => {
      if (tabela === 'invoices' && stan.head) return { count: dane.niepelneSrodowisko ?? 0, error: null };
      if (tabela === 'invoices') {
        if (dane.bladFaktur) return { data: null, count: null, error: { message: 'timeout' } };
        const f = dane.faktury ?? [];
        return { data: f, count: f.length, error: null };
      }
      if (tabela === 'invoice_line_items') {
        const p = (dane.pozycje ?? []).filter(
          (x) => (!stan.ids || stan.ids.includes(x.invoice_id as string)) && (!stan.tylkoZeStawka || x.ryczalt_rate !== null),
        );
        return { data: p, count: p.length, error: null };
      }
      if (tabela === 'tax_profiles') return { data: dane.wersje ?? [], error: null };
      if (tabela === 'ledger_manual_entries') {
        if (dane.wpisy === 'brak_tabeli') return { data: null, count: null, error: { code: 'PGRST205', message: 'brak tabeli' } };
        const w = dane.wpisy ?? [];
        return { data: w, count: w.length, error: null };
      }
      throw new Error(`nieoczekiwana tabela ${tabela}`);
    };
    const lancuch: Record<string, unknown> = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then') return (ok: (v: unknown) => unknown, nie: (e: unknown) => unknown) => Promise.resolve().then(wynik).then(ok, nie);
          return (...args: unknown[]) => {
            wywolania.push({ tabela, metoda: String(prop), args });
            if (prop === 'select' && (args[1] as { head?: boolean } | undefined)?.head) stan.head = true;
            if (prop === 'not') stan.tylkoZeStawka = true;
            if (prop === 'in' && args[0] === 'invoice_id') stan.ids = args[1] as string[];
            return lancuch;
          };
        },
      },
    );
    return lancuch;
  };
  return { client: { from } as unknown as SupabaseClient, wywolania };
}

const PROFIL = { id: 'p1', valid_from: '2026-01-01', forma: 'ryczalt', stawka_domyslna: 1200, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null };

function faktura(z: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    internal_number: 'FV/1/2026',
    issue_date: '2026-03-10',
    sale_date: '2026-03-10',
    net_total: 1000,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    advance_invoice_ids: null,
    currency: 'PLN',
    ksef_number: '1234567890-20260310-0A1B2C-3D4E5F-6A',
    buyer_data: { nip: '123-456-78-90', name: 'Nabywca' },
    fp: null,
    ...z,
  };
}

describe('czytajEwidencje: zapytania jak w KPiR', () => {
  it('faktury outgoing przyjęte w aktywnym środowisku, okno wystawienia do 60 dni za rokiem, stronami po id', async () => {
    const { client, wywolania } = atrapa({ faktury: [faktura()], wersje: [PROFIL] });
    const wynik = await czytajEwidencje(client, 'firma-1', 2026, { kurs: vi.fn() });
    expect(wynik.ok).toBe(true);
    const faktur = wywolania.filter((w) => w.tabela === 'invoices').slice(-9);
    expect(faktur.map((w) => [w.metoda, ...w.args.slice(0, 2)])).toEqual([
      ['select', expect.stringContaining('fp:fa3_data->ksefMarkers->>fp'), { count: 'exact' }],
      ['eq', 'tenant_id', 'firma-1'],
      ['eq', 'direction', 'outgoing'],
      ['eq', 'ksef_status', 'accepted'],
      ['eq', 'ksef_environment', process.env.KSEF_ENV],
      ['gte', 'issue_date', '2026-01-01'],
      ['lte', 'issue_date', '2027-03-01'],
      ['order', 'id', { ascending: true }],
      ['range', 0, 499],
    ]);
    if (!wynik.ok) return;
    expect(wynik.ewidencja.wiersze.map((w) => [w.dowod, w.kwotaGr, w.stawkaPb, w.idKontrahenta])).toEqual([['FV/1/2026', 1_000_00, 1200, '1234567890']]);
  });

  it('FP z fa3_data, kontrahent z UE i faktura w EUR po kursie sprzed dnia przychodu', async () => {
    const kurs = vi.fn().mockResolvedValue({ found: true, gapDays: 1, rate: { currency: 'EUR', mid: 4.25, tableNo: '048/A/NBP/2026', effectiveDate: '2026-03-09' } });
    const { client } = atrapa({
      wersje: [PROFIL],
      faktury: [
        faktura({ id: 'a', internal_number: 'FV/FP', fp: 'true' }),
        faktura({ id: 'b', internal_number: 'FV/EUR', currency: 'eur', net_total: 100, buyer_data: { vatUeNumber: 'EL 123456789' } }),
      ],
    });
    const wynik = await czytajEwidencje(client, 'firma-1', 2026, { kurs });
    if (!wynik.ok) throw new Error(wynik.komunikat);
    expect(kurs).toHaveBeenCalledWith('EUR', '2026-03-10');
    // Krok 1.2 planu kompletnej aplikacji (świadoma zmiana testu): FP daje brak
    // zamiast pominięcia, do reguły pokrycia raportem kasy (następny PR, G30).
    expect(wynik.ewidencja.pominiete).toEqual([]);
    expect(wynik.ewidencja.braki.map((b) => b.dokument)).toEqual(['FV/FP']);
    expect(wynik.ewidencja.wiersze.map((w) => [w.dowod, w.kwotaGr, w.krajKontrahenta, w.idKontrahenta])).toEqual([['FV/EUR', 425_00, 'GR', '123456789']]);
  });

  it('pozycje z własną stawką dzielą fakturę; pozycje czyta się tylko dla takich faktur', async () => {
    const { client } = atrapa({
      wersje: [PROFIL],
      faktury: [faktura()],
      pozycje: [
        { id: 'l1', invoice_id: 'f1', net_amount: 400, ryczalt_rate: 8.5 },
        { id: 'l2', invoice_id: 'f1', net_amount: 600, ryczalt_rate: null },
      ],
    });
    const wynik = await czytajEwidencje(client, 'firma-1', 2026, { kurs: vi.fn() });
    if (!wynik.ok) throw new Error(wynik.komunikat);
    expect(wynik.ewidencja.wiersze.map((w) => [w.stawkaPb, w.kwotaGr])).toEqual([[850, 400_00], [1200, 600_00]]);
  });

  it('przyjęte faktury bez środowiska KSeF albo błąd odczytu: brak kwot, komunikat po polsku', async () => {
    expect(await czytajEwidencje(atrapa({ niepelneSrodowisko: 2 }).client, 'firma-1', 2026)).toEqual({ ok: false, komunikat: KOMUNIKAT_SRODOWISKO });
    expect(await czytajEwidencje(atrapa({ bladFaktur: true }).client, 'firma-1', 2026)).toEqual({ ok: false, komunikat: KOMUNIKAT_ODCZYT });
  });

  it('przed wgraniem 00167 brak tabeli wpisów to brak wpisów, nie awaria', async () => {
    const wynik = await czytajEwidencje(atrapa({ faktury: [], wersje: [PROFIL], wpisy: 'brak_tabeli' }).client, 'firma-1', 2026);
    expect(wynik).toMatchObject({ ok: true, wpisy: [] });
  });
});

describe('mapowanie faktury', () => {
  it('rodzaj: korekta po invoice_kind albo typie KOR, zaliczki odejmuje tylko final (jak KPiR)', () => {
    expect(rodzajFaktury('correction', null)).toBe('korekta');
    expect(rodzajFaktury('regular', 'KOR_ZAL')).toBe('korekta');
    expect(rodzajFaktury('final', 'ROZ')).toBe('rozliczenie');
    expect(rodzajFaktury('regular', 'ROZ')).toBe('zwykla');
    expect(rodzajFaktury('regular', 'ZAL')).toBe('zaliczka');
  });

  it('kontrahent: NIP bez kresek, VAT UE z krajem, osoba bez identyfikatora pusta', () => {
    expect(kontrahentJpk({ nip: 'PL 123-456-78-90' })).toEqual({ kraj: 'PL', identyfikator: '1234567890' });
    expect(kontrahentJpk({ vatUeNumber: 'DE123456789' })).toEqual({ kraj: 'DE', identyfikator: '123456789' });
    expect(kontrahentJpk({ noIdMarker: true, name: 'Jan' })).toEqual({ kraj: null, identyfikator: null });
  });
});

describe('wpis ręczny: kwota i schemat', () => {
  it('kwota z formularza na grosze dokładnie, bez float', () => {
    expect(kwotaNaGrosze('1 234,56')).toBe(123456);
    expect(kwotaNaGrosze('-12,5')).toBe(-1250);
    expect(kwotaNaGrosze('100')).toBe(10000);
    expect(kwotaNaGrosze('0,07')).toBe(7);
    expect(kwotaNaGrosze('1,234')).toBeNull();
    expect(kwotaNaGrosze('abc')).toBeNull();
  });

  it('schemat: stawka ze słownika JPK_EWP, numer dowodu bez spacji na brzegach, pusty opis to null', () => {
    const ok = wpisSchema.safeParse({ rodzaj: 'inny', dataPrzychodu: '2026-02-01', dokument: '  DW/1  ', kwota: '10', stawkaPb: 1250, opis: '  ' });
    expect(ok.success && ok.data).toMatchObject({ dokument: 'DW/1', kwota: 1000, stawkaPb: 1250, opis: null });
    expect(wpisSchema.safeParse({ rodzaj: 'inny', dataPrzychodu: '2026-02-01', dokument: 'DW/1', kwota: '10', stawkaPb: 2300, opis: null }).success).toBe(false);
    expect(wpisSchema.safeParse({ rodzaj: 'inny', dataPrzychodu: '2025-12-31', dokument: 'DW/1', kwota: '10', stawkaPb: 300, opis: null }).success).toBe(false);
  });
});
