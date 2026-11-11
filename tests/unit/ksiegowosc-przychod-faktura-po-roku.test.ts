import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { czytajEwidencje, czytajFakturyRoku } from '@/lib/ksiegowosc/ewidencja-dane';

/**
 * F11-C3: przychód z faktury za sprzedaż z roku R, wystawionej w roku R+1 po
 * 1 marca (faktura spóźniona albo wystawiona na żądanie nabywcy w ciągu
 * 3 miesięcy, art. 106b ust. 3 ustawy o VAT). Dzień przychodu to dzień
 * sprzedaży, nie później niż dzień wystawienia (art. 14 ust. 1c ustawy o PIT),
 * więc ten przychód należy do roku R. Do naprawy odczyt roku R brał faktury
 * wystawione najwyżej 60 dni po roku (stała z art. 106i ust. 7, który mówi
 * o fakturze wystawionej PRZED sprzedażą), a rok R+1 odrzucał je, bo dzień
 * przychodu wypada w R. Taka faktura ginęła z obu lat bez śladu.
 *
 * Atrapa Supabase stosuje filtry zapytania (eq, gte, lte, or) do wierszy, więc
 * test sprawdza, które faktury naprawdę wracają, a nie kształt zapytania.
 */

type Wiersz = Record<string, unknown>;
type Warunek = (w: Wiersz) => boolean;

const porownaj = (op: string, v: unknown, wartosc: string): boolean => {
  if (v === null || v === undefined) return false;
  const s = String(v);
  if (op === 'lte') return s <= wartosc;
  if (op === 'gte') return s >= wartosc;
  if (op === 'eq') return s === wartosc;
  throw new Error(`atrapa: nieznany operator ${op}`);
};

/** `kol.op.wartość,kol.op.wartość` jak w PostgREST `.or()`. */
function warunekLub(spec: string): Warunek {
  const czesci = spec.split(',').map((c) => {
    const [kol, op, ...reszta] = c.split('.');
    return { kol, op, wartosc: reszta.join('.') };
  });
  return (w) => czesci.some(({ kol, op, wartosc }) => porownaj(op, w[kol], wartosc));
}

function atrapa(faktury: Wiersz[], wersje: Wiersz[]): SupabaseClient {
  const from = (tabela: string) => {
    const stan = { head: false, warunki: [] as Warunek[] };
    const wynik = () => {
      if (tabela === 'invoices' && stan.head) return { count: 0, error: null };
      if (tabela === 'invoices') {
        const f = faktury.filter((w) => stan.warunki.every((c) => c(w)));
        return { data: f, count: f.length, error: null };
      }
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
            if (prop === 'eq') stan.warunki.push((w) => porownaj('eq', w[args[0] as string], String(args[1])));
            if (prop === 'gte') stan.warunki.push((w) => porownaj('gte', w[args[0] as string], String(args[1])));
            if (prop === 'lte') stan.warunki.push((w) => porownaj('lte', w[args[0] as string], String(args[1])));
            if (prop === 'or') stan.warunki.push(warunekLub(String(args[0])));
            return lancuch;
          };
        },
      },
    );
    return lancuch;
  };
  return { from } as unknown as SupabaseClient;
}

const PROFIL = { id: 'p1', valid_from: '2026-01-01', forma: 'ryczalt', stawka_domyslna: 1200, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null };

function faktura(id: string, numer: string, issue: string, sale: string | null): Wiersz {
  return {
    id,
    tenant_id: 'firma-1',
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_environment: process.env.KSEF_ENV,
    internal_number: numer,
    issue_date: issue,
    sale_date: sale,
    net_total: 1000,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    advance_invoice_ids: null,
    currency: 'PLN',
    ksef_number: `1234567890-${issue.replaceAll('-', '')}-0A1B2C-3D4E5F-6A`,
    buyer_data: { nip: '1234567890', name: 'Nabywca Testowy' },
    fp: null,
  };
}

const SPOZNIONA = faktura('f1', 'FV/3/2027', '2027-03-05', '2026-12-20');
const W_OKNIE = faktura('f2', 'FV/1/2027', '2027-01-10', '2026-12-28');
const MARZEC_ZA_MARZEC = faktura('f3', 'FV/4/2027', '2027-03-05', '2027-03-05');
const GRUDZIEN_ZA_STYCZEN = faktura('f4', 'FV/12/2026', '2026-12-20', '2027-01-10');
const PO_ROKU = faktura('f5', 'FV/1/2028', '2028-01-15', '2026-11-30');
const WSZYSTKIE = [SPOZNIONA, W_OKNIE, MARZEC_ZA_MARZEC, GRUDZIEN_ZA_STYCZEN, PO_ROKU];

const numery = async (rok: number) => {
  const wynik = await czytajFakturyRoku(atrapa(WSZYSTKIE, [PROFIL]), 'firma-1', rok, { kurs: vi.fn() });
  if (!wynik.ok) throw new Error(wynik.komunikat);
  return wynik.faktury.map((f) => f.numer).sort();
};

describe('F11-C3: przychód z faktury wystawionej po roku sprzedaży', () => {
  it('faktura z 5.03.2027 za sprzedaż z 20.12.2026 wraca w odczycie 2026', async () => {
    expect(await numery(2026)).toContain('FV/3/2027');
  });

  it('faktura wystawiona ponad rok po sprzedaży też wraca w roku sprzedaży', async () => {
    expect(await numery(2026)).toContain('FV/1/2028');
  });

  it('ewidencja 2026 ma spóźnioną fakturę w dniu sprzedaży, ewidencja 2027 jej nie liczy drugi raz', async () => {
    const e2026 = await czytajEwidencje(atrapa(WSZYSTKIE, [PROFIL]), 'firma-1', 2026, { kurs: vi.fn() });
    const e2027 = await czytajEwidencje(atrapa(WSZYSTKIE, [PROFIL]), 'firma-1', 2027, { kurs: vi.fn() });
    if (!e2026.ok || !e2027.ok) throw new Error('odczyt ewidencji nie powiódł się');
    expect(e2026.ewidencja.wiersze.filter((w) => w.dowod === 'FV/3/2027').map((w) => w.dataPrzychodu)).toEqual(['2026-12-20']);
    expect(e2027.ewidencja.wiersze.map((w) => w.dowod)).not.toContain('FV/3/2027');
  });

  it('straże: faktura w oknie 60 dni i faktura z grudnia za styczeń zostają w 2026, marzec za marzec w 2027', async () => {
    const r2026 = await numery(2026);
    expect(r2026).toEqual(expect.arrayContaining(['FV/1/2027', 'FV/12/2026']));
    expect(r2026).not.toContain('FV/4/2027');
    expect(await numery(2027)).toContain('FV/4/2027');
  });
});
