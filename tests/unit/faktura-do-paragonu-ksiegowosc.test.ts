import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables } from './helpers/baza-w-pamieci';

vi.mock('@/lib/exports/issuer-address', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/issuer-address')>()),
  readIssuerRegisteredAddress: async () => ({
    voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', buildingNumber: '1', city: 'Warszawa', postCode: '00-001',
  }),
}));

import { importedContentFlags } from '@/lib/exports/data-fetcher';
import { amountsOf, JpkDocumentNotSupportedError, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { jpkFaBlocker } from '@/lib/exports/jpk-fa-readiness';
import { brakiOkresu, zbudujEwidencje, type FakturaEwidencji, type WpisReczny } from '@/lib/ksiegowosc/ewidencja';
import { czytajEwidencje } from '@/lib/ksiegowosc/ewidencja-dane';
import { zbudujKpir, type WpisKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';

/**
 * Faktura do paragonu (FP) w module księgowości i w JPK (plan kompletnej
 * aplikacji, krok 1.2). Art. 109 ust. 3d ustawy o VAT: FP nie zwiększa
 * sprzedaży ani podatku należnego, bo sprzedaż weszła z kasy. Zasada 2 planu
 * księgowości: FP nie jest drugim przychodem, sprzedaż wchodzi z raportu kasy.
 *
 * Część 1 (#509) dawała przy FP zawsze brak i odmowę JPK. Część 2 (świadome
 * zmiany przypadków niżej): FP jest poza ewidencją i KPiR, gdy raport kasy
 * z miesiąca paragonu ją obejmuje (reguła pokrycia, szczegóły
 * w `faktura-do-paragonu-pokrycie-kasy.test.ts`), a JPK_V7M wykazuje ją typem
 * dokumentu FP bez podatku należnego (`faktura-do-paragonu-jpk-v7m.test.ts`).
 * FP nie staje się po cichu drugim przychodem ani nie znika; JPK_FA odmawia
 * (bez oznaczenia FP w strukturze).
 */

const RYCZALT: WersjaProfilu = {
  id: 'p1', validFrom: '2026-01-01', forma: 'ryczalt', stawkaDomyslna: 1200,
  zusEtap: 'pelny', zusOd: null, chorobowe: false, nrsZus: null, najem: false,
};
const SKALA: WersjaProfilu = { ...RYCZALT, forma: 'skala', stawkaDomyslna: null };

function fakturaFp(z: Partial<FakturaEwidencji> = {}): FakturaEwidencji {
  return {
    id: 'fp-1',
    numer: 'FV/5/11/2026',
    dataWystawienia: '2026-11-09',
    dataSprzedazy: '2026-10-15',
    rodzaj: 'zwykla',
    nettoGr: 1_000_00,
    waluta: 'PLN',
    numerKsef: null,
    fp: true,
    kontrahent: { kraj: 'PL', identyfikator: '1234567890', nazwa: 'Klient Sp. z o.o.', adres: 'ul. Klienta 10' },
    rozliczoneZaliczkiGr: 0,
    pozycje: null,
    ...z,
  };
}

const raportKasy = (dzien: string): WpisReczny => ({
  id: `rk-${dzien}`, rodzaj: 'raport_kasy', dataPrzychodu: dzien, dataWpisu: dzien,
  dokument: `RK/${dzien}`, kwotaGr: 5_000_00, stawkaPb: 1200, opis: null,
});

describe('ewidencja ryczałtu: FP nie jest drugim przychodem i nie znika', () => {
  it('FP: brak z numerem faktury i wyjściem, bez wiersza przychodu, miesiąc bez sum', () => {
    const e = zbudujEwidencje({ rok: 2026, faktury: [fakturaFp()], wpisy: [], wersje: [RYCZALT], kursy: new Map() });
    expect(e.wiersze).toEqual([]);
    expect(e.pominiete).toEqual([]);
    expect(e.braki).toEqual([
      expect.objectContaining({ dokument: 'FV/5/11/2026', dzien: '2026-10-15' }),
    ]);
    expect(e.braki[0]!.komunikat).toMatch(/FV\/5\/11\/2026.*do paragonu.*nie jest przychodem.*Pomocy/);
    expect(brakiOkresu(e, '2026-10-01', '2026-10-31')).toHaveLength(1);
  });

  it('FP z raportem kasy z miesiąca paragonu (5000 zł, FP 1000 zł): poza ewidencją, przychód tylko z raportu (bez FP)', () => {
    // Krok 1.2, część 2 (świadoma zmiana testu): w części 1 ten przypadek dawał
    // brak; reguła pokrycia raportem kasy (miesiąc i kwoty) wyłącza FP z przychodu.
    const e = zbudujEwidencje({ rok: 2026, faktury: [fakturaFp()], wpisy: [raportKasy('2026-10-31')], wersje: [RYCZALT], kursy: new Map() });
    expect(e.wiersze.map((w) => w.dowod)).toEqual(['RK/2026-10-31']);
    expect(e.braki).toEqual([]);
    expect(e.pominiete.map((p) => p.numer)).toEqual(['FV/5/11/2026']);
  });
});

describe('KPiR: ta sama zasada co ewidencja', () => {
  const wpisKasy = (data: string): WpisKpir => ({
    id: `rk-${data}`, data, dokument: `RK/${data}`, kolumna: 'k7', kwotaGr: 5_000_00, opis: null,
  });

  it('FP: brak z numerem faktury, bez wiersza przychodu', () => {
    const k = zbudujKpir({ rok: 2026, faktury: [fakturaFp()], koszty: [], wpisy: [], wersje: [SKALA], kursy: new Map() });
    expect(k.wiersze).toEqual([]);
    expect(k.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
    expect(k.braki[0]!.komunikat).toMatch(/do paragonu.*księgi.*Pomocy/);
  });

  it('FP z wpisem kolumny 7 bez rodzaju dowodu: dalej brak (to nie raport kasy), przychód tylko z wpisu', () => {
    // Krok 1.2, część 2: FP obejmuje tylko wpis z rodzajem „raport_kasy” (z bazy
    // zawsze go ma, `czytajWpisyKpir`); przypadek z rodzajem jest w
    // `faktura-do-paragonu-pokrycie-kasy.test.ts`.
    const k = zbudujKpir({ rok: 2026, faktury: [fakturaFp()], koszty: [], wpisy: [wpisKasy('2026-10-31')], wersje: [SKALA], kursy: new Map() });
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7])).toEqual([['RK/2026-10-31', 5_000_00]]);
    expect(k.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
    expect(k.pominiete).toEqual([]);
  });
});

describe('odczyt ewidencji: FP wystawiona w FaktWay (fa3_data.receipt) jest FP', () => {
  it('wiersz z paragonem w fa3_data dostaje fp, tak jak FP z importu', async () => {
    const tables: MemoryTables = {
      invoices: [{
        id: 'fp-app', tenant_id: 'firma-1', direction: 'outgoing', ksef_status: 'accepted', ksef_environment: process.env.KSEF_ENV,
        internal_number: 'FV/5/11/2026', issue_date: '2026-11-09', sale_date: '2026-10-15', net_total: 1000,
        invoice_kind: 'regular', invoice_type: 'VAT', advance_invoice_ids: null, currency: 'PLN', ksef_number: null,
        buyer_data: { nip: '1234567890', name: 'Klient' },
        fa3_data: { receipt: { receiptNumber: '000123', receiptDate: '2026-10-15', cashRegisterNumber: 'ABC1234567890' } },
      }],
      invoice_line_items: [],
      tax_profiles: [{ id: 'p1', tenant_id: 'firma-1', valid_from: '2026-01-01', forma: 'ryczalt', stawka_domyslna: 1200, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null }],
      ledger_manual_entries: [],
    };
    const wynik = await czytajEwidencje(memoryClient(tables) as unknown as SupabaseClient, 'firma-1', 2026, { kurs: vi.fn() });
    if (!wynik.ok) throw new Error(wynik.komunikat);
    expect(wynik.ewidencja.wiersze).toEqual([]);
    expect(wynik.ewidencja.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
  });
});

function jpkFaktura(o: Partial<JpkInvoice> = {}): JpkInvoice {
  return {
    invoiceNumber: 'FV/5/11/2026',
    invoiceType: 'regular',
    currency: 'PLN',
    issueDate: '2026-11-09',
    saleDate: '2026-10-15',
    buyerName: 'Klient Sp. z o.o.',
    buyerNip: '5252241585',
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    lines: [{ position: 1, name: 'Rower', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23' }],
    ...o,
  } as JpkInvoice;
}

const PARAGON_FA3 = { receipt: { receiptNumber: '000123', receiptDate: '2026-10-15', cashRegisterNumber: 'ABC1234567890' } };

describe('JPK i VAT miesiąca: FP z FaktWay ma to samo oznaczenie co FP z importu', () => {
  it('flagi treści dokumentu: paragon w fa3_data to oznaczenie FP', () => {
    expect(importedContentFlags('app', PARAGON_FA3).ksefMarkers).toEqual({ fp: true });
    expect(importedContentFlags('app', {}).ksefMarkers).toBeUndefined();
  });

  it('kwoty JPK_FA (bez oznaczenia FP w strukturze): odmowa z numerem faktury i oznaczeniem FP', () => {
    const inv = jpkFaktura(importedContentFlags('app', PARAGON_FA3));
    expect(() => amountsOf(inv)).toThrow(JpkDocumentNotSupportedError);
    expect(() => amountsOf(inv)).toThrow(/JPK wstrzymany:.*FV\/5\/11\/2026.*faktura do paragonu \(FP\)/);
  });

  it('VAT miesiąca w module księgowości: FP do paragonu z października w listopadzie bez podatku należnego', () => {
    // Krok 1.2, część 2 (świadoma zmiana testu): w części 1 był tu brak; teraz
    // FP to wiersz z typem FP poza deklaracją (art. 109 ust. 3d).
    const wynik = vatMiesiaca({ sprzedaz: [jpkFaktura(importedContentFlags('app', PARAGON_FA3))], koszty: [] }, 0);
    expect(wynik).toMatchObject({ ok: true, naleznyGr: 0, doZaplatyGr: 0, liczbaSprzedazy: 1 });
  });

  it('VAT miesiąca w module księgowości: FP do paragonu z tego samego miesiąca to brak (raport z kasy RO)', () => {
    const tenSam = jpkFaktura({ ...importedContentFlags('app', PARAGON_FA3), saleDate: '2026-11-02' });
    const wynik = vatMiesiaca({ sprzedaz: [tenSam], koszty: [] }, 0);
    expect(wynik).toEqual({ ok: false, brak: expect.stringMatching(/FV\/5\/11\/2026.*fakturą do paragonu.*\(RO\).*poza FaktWay/) });
  });
});

describe('gotowość paczki JPK (Co-Pilot): FP z FaktWay zatrzymuje JPK_FA z powodem', () => {
  let tables: MemoryTables;
  beforeEach(() => {
    vi.stubEnv('KSEF_ENV', 'test');
    tables = {
      tenants: [{ id: 'firma-a', nip: '5260001246' }],
      invoices: [{
        id: 'fp-app', tenant_id: 'firma-a', direction: 'outgoing', ksef_status: 'accepted', ksef_environment: 'test',
        issue_date: '2026-11-09', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
        internal_number: 'FV/5/11/2026', net_total: 1000, vat_total: 230, fa3_data: PARAGON_FA3,
      }],
      invoice_line_items: [{ id: 'l-1', invoice_id: 'fp-app', vat_rate: '23', net_amount: 1000, vat_amount: 230 }],
    };
  });
  afterEach(() => vi.unstubAllEnvs());

  it('powód z numerem faktury i FP', async () => {
    const powod = await jpkFaBlocker(memoryClient(tables) as never, {
      tenantId: 'firma-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', includeCorrections: true,
    });
    expect(powod).toMatch(/JPK wstrzymany:.*FV\/5\/11\/2026.*\(FP\)/);
  });
});
