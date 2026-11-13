import type { SupabaseClient } from '@supabase/supabase-js';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables } from './helpers/baza-w-pamieci';

import { sumyOkresu, wierszeOkresu, zbudujEwidencje, type FakturaEwidencji, type WpisReczny } from '@/lib/ksiegowosc/ewidencja';
import { czytajEwidencje } from '@/lib/ksiegowosc/ewidencja-dane';
import { sumyKpir, wierszeKpirOkresu, zbudujKpir, type WpisKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { czytajWpisyKpir } from '@/lib/ksiegowosc/wpisy-reczne';

/**
 * Faktura do paragonu (FP) w ewidencji przychodów i KPiR modułu księgowości:
 * plan kompletnej aplikacji, krok 1.2, część 2; zasada 2 planu księgowości
 * (RP-FP-01): FP nie jest drugim przychodem, jeśli sprzedaż weszła już
 * z raportu kasy. Art. 14 ust. 1 ustawy o PIT: przychód ze sprzedaży powstaje
 * raz; sprzedaż z kasy wchodzi raportem kasy, a FP tylko ją dokumentuje
 * (art. 109 ust. 3d ustawy o VAT: FP nie zwiększa wartości sprzedaży).
 *
 * Reguła pokrycia (#509, „następny PR”: miesiąc i kwoty): FP jest poza
 * ewidencją i KPiR, gdy raporty kasy (wpis ręczny „Raport z kasy
 * rejestrującej”, w KPiR kolumna 7) z miesiąca paragonu są nie niższe niż
 * faktury do paragonów z tego miesiąca. Inaczej brak z wyjściem: FP nie znika
 * i nie wchodzi drugi raz. Wpis „Inny dowód” ani wpis bez rodzaju nie jest
 * raportem kasy (rodzaj ma w formularzu wartość domyślną, więc dochodzi
 * warunek kwot).
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
    numerKsef: '5260001246-20261109-0100001AF629-AF',
    fp: true,
    kontrahent: { kraj: 'PL', identyfikator: '1234567890', nazwa: 'Klient Sp. z o.o.', adres: 'ul. Klienta 10' },
    rozliczoneZaliczkiGr: 0,
    pozycje: null,
    ...z,
  };
}

const raportKasy = (dzien: string, kwotaGr: number, z: Partial<WpisReczny> = {}): WpisReczny => ({
  id: `rk-${dzien}-${kwotaGr}`, rodzaj: 'raport_kasy', dataPrzychodu: dzien, dataWpisu: dzien,
  dokument: `RK/${dzien}`, kwotaGr, stawkaPb: 300, opis: null, ...z,
});

const wpisKpir = (data: string, kwotaGr: number, z: Partial<WpisKpir> = {}): WpisKpir => ({
  id: `rk-${data}-${kwotaGr}`, rodzaj: 'raport_kasy', data, dokument: `RK/${data}`, kolumna: 'k7', kwotaGr, opis: null, ...z,
});

const ewidencja = (faktury: FakturaEwidencji[], wpisy: WpisReczny[]) =>
  zbudujEwidencje({ rok: 2026, faktury, wpisy, wersje: [RYCZALT], kursy: new Map() });
const kpir = (faktury: FakturaEwidencji[], wpisy: WpisKpir[]) =>
  zbudujKpir({ rok: 2026, faktury, koszty: [], wpisy, wersje: [SKALA], kursy: new Map() });

describe('ewidencja ryczałtu: FP poza przychodem, gdy raport kasy z miesiąca paragonu ją obejmuje', () => {
  it('raport kasy za październik obejmuje FP do paragonu z października: FP poza ewidencją z powodem, przychód tylko z raportu', () => {
    const e = ewidencja([fakturaFp()], [raportKasy('2026-10-31', 5_000_00)]);
    expect(e.braki).toEqual([]);
    expect(e.wiersze.map((w) => w.dowod)).toEqual(['RK/2026-10-31']);
    expect(e.pominiete).toEqual([
      { numer: 'FV/5/11/2026', dzien: '2026-10-15', powod: expect.stringMatching(/do paragonu.*nie jest drugim przychodem.*raportu kasy za październik 2026/) },
    ]);
    expect(sumyOkresu(wierszeOkresu(e, '2026-10-01', '2026-10-31')).razemGr).toBe(5_000_00);
    // Miesiąc wystawienia FP (listopad) nie dostaje ani przychodu, ani braku.
    expect(wierszeOkresu(e, '2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('bez raportu kasy za miesiąc paragonu: brak z nazwą faktury i wyjściem (raport we wpisach ręcznych albo Pomoc)', () => {
    const e = ewidencja([fakturaFp()], []);
    expect(e.wiersze).toEqual([]);
    expect(e.pominiete).toEqual([]);
    expect(e.braki).toEqual([{ dzien: '2026-10-15', dokument: 'FV/5/11/2026', komunikat: expect.any(String) }]);
    expect(e.braki[0]!.komunikat).toMatch(/FV\/5\/11\/2026.*do paragonu.*nie jest przychodem.*nie ma raportu kasy.*wpisach ręcznych.*Pomocy/);
  });

  it('raport kasy z innego miesiąca niż paragon nie obejmuje FP', () => {
    const e = ewidencja([fakturaFp()], [raportKasy('2026-11-30', 5_000_00)]);
    expect(e.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
    expect(e.pominiete).toEqual([]);
  });

  it('raporty kasy niższe niż FP z miesiąca: brak z obiema kwotami', () => {
    const e = ewidencja([fakturaFp()], [raportKasy('2026-10-31', 500_00)]);
    expect(e.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
    expect(e.braki[0]!.komunikat).toMatch(/500,00 zł.*1000,00 zł.*Pomocy/);
  });

  it('wpis „Inny dowód” nie jest raportem kasy', () => {
    const e = ewidencja([fakturaFp()], [raportKasy('2026-10-31', 5_000_00, { rodzaj: 'inny', dokument: 'DW/1' })]);
    expect(e.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
    expect(e.wiersze.map((w) => w.dowod)).toEqual(['DW/1']);
  });

  it('kilka FP w miesiącu: raporty kasy muszą objąć ich sumę', () => {
    const dwie = [fakturaFp({ id: 'a', numer: 'FV/A', nettoGr: 600_00 }), fakturaFp({ id: 'b', numer: 'FV/B', nettoGr: 600_00, dataSprzedazy: '2026-10-20' })];
    const zaMalo = ewidencja(dwie, [raportKasy('2026-10-31', 1_000_00)]);
    expect(zaMalo.braki.map((b) => b.dokument)).toEqual(['FV/A', 'FV/B']);
    expect(zaMalo.pominiete).toEqual([]);
    const dosc = ewidencja(dwie, [raportKasy('2026-10-10', 700_00), raportKasy('2026-10-31', 500_00)]);
    expect(dosc.braki).toEqual([]);
    expect(dosc.pominiete.map((p) => p.numer)).toEqual(['FV/A', 'FV/B']);
  });

  it('FP w walucie albo korekta z oznaczeniem FP: brak z wyjściem przez Pomoc (bez zestawiania z raportem kasy)', () => {
    for (const f of [fakturaFp({ waluta: 'EUR' }), fakturaFp({ rodzaj: 'korekta', nettoGr: -100_00, dataWystawienia: '2026-10-20', dataSprzedazy: '2026-10-15' })]) {
      const e = ewidencja([f], [raportKasy('2026-10-31', 5_000_00)]);
      expect(e.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
      expect(e.braki[0]!.komunikat).toMatch(/do paragonu.*Pomocy/);
      expect(e.pominiete).toEqual([]);
    }
  });

  it('niezmiennik: FP nigdy nie jest wierszem przychodu i nigdy nie znika; pominięta tylko przy raportach kasy z miesiąca nie niższych niż FP', () => {
    const miesiac = fc.constantFrom('09', '10');
    const dane = fc.record({
      fp: fc.array(fc.record({ miesiac, dzien: fc.integer({ min: 1, max: 28 }), gr: fc.integer({ min: 1, max: 5_000_000 }) }), { minLength: 1, maxLength: 5 }),
      wpisy: fc.array(
        fc.record({ miesiac, dzien: fc.integer({ min: 1, max: 28 }), gr: fc.integer({ min: -100_000, max: 8_000_000 }), inny: fc.boolean() }),
        { maxLength: 5 },
      ),
    });
    fc.assert(
      fc.property(dane, ({ fp, wpisy }) => {
        const dzien = (m: string, d: number) => `2026-${m}-${String(d).padStart(2, '0')}`;
        const faktury = fp.map((f, i) => fakturaFp({ id: `fp-${i}`, numer: `FP/${i}`, dataSprzedazy: dzien(f.miesiac, f.dzien), nettoGr: f.gr }));
        const zWpisow = wpisy
          .filter((w) => w.gr !== 0)
          .map((w, i) => raportKasy(dzien(w.miesiac, w.dzien), w.gr, { id: `w-${i}`, dokument: `W/${i}`, rodzaj: w.inny ? 'inny' : 'raport_kasy' }));
        const e = ewidencja(faktury, zWpisow);

        const idFp = new Set(faktury.map((f) => f.id));
        expect(e.wiersze.some((w) => idFp.has(w.zrodlo.id))).toBe(false);
        const rozpatrzone = [...e.pominiete.map((p) => p.numer), ...e.braki.map((b) => b.dokument)].sort();
        expect(rozpatrzone).toEqual(faktury.map((f) => f.numer).sort());
        for (const m of ['09', '10']) {
          const fpMiesiaca = faktury.filter((f) => f.dataSprzedazy!.slice(5, 7) === m);
          const raporty = zWpisow.filter((w) => w.rodzaj === 'raport_kasy' && w.dataPrzychodu.slice(5, 7) === m).reduce((s, w) => s + w.kwotaGr, 0);
          const pominiete = e.pominiete.filter((p) => p.dzien.slice(5, 7) === m);
          const pokryte = fpMiesiaca.reduce((s, f) => s + f.nettoGr, 0) <= raporty;
          expect(pominiete.length).toBe(pokryte ? fpMiesiaca.length : 0);
          // Miesiąc bez braku: przychód to tylko wpisy ręczne (FP nie wchodzi drugi raz).
          if (!e.braki.some((b) => b.dzien.slice(5, 7) === m)) {
            const przychod = sumyOkresu(wierszeOkresu(e, `2026-${m}-01`, `2026-${m}-31`)).razemGr;
            expect(przychod).toBe(zWpisow.filter((w) => w.dataPrzychodu.slice(5, 7) === m).reduce((s, w) => s + w.kwotaGr, 0));
          }
        }
      }),
      { numRuns: 200, seed: 1202 },
    );
  });
});

describe('KPiR: ta sama reguła pokrycia raportem kasy (kolumna 7)', () => {
  it('raport kasy w kolumnie 7 za miesiąc paragonu: FP poza księgą, przychód tylko z raportu', () => {
    const k = kpir([fakturaFp()], [wpisKpir('2026-10-31', 5_000_00)]);
    expect(k.braki).toEqual([]);
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7])).toEqual([['RK/2026-10-31', 5_000_00]]);
    expect(k.pominiete).toEqual([
      { numer: 'FV/5/11/2026', dzien: '2026-10-15', powod: expect.stringMatching(/do paragonu.*nie jest drugim przychodem.*raportu kasy za październik 2026/) },
    ]);
    expect(sumyKpir(wierszeKpirOkresu(k, '2026-10-01', '2026-10-31')).przychodGr).toBe(5_000_00);
  });

  it('wpis w kolumnie 8, wpis „Inny dowód” i wpis bez rodzaju nie obejmują FP: brak z wyjściem', () => {
    const bezRodzaju: WpisKpir = { id: 'x', data: '2026-10-31', dokument: 'RK/X', kolumna: 'k7', kwotaGr: 5_000_00, opis: null };
    for (const wpis of [wpisKpir('2026-10-31', 5_000_00, { kolumna: 'k8' }), wpisKpir('2026-10-31', 5_000_00, { rodzaj: 'inny' }), bezRodzaju]) {
      const k = kpir([fakturaFp()], [wpis]);
      expect(k.pominiete).toEqual([]);
      expect(k.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
      expect(k.braki[0]!.komunikat).toMatch(/do paragonu.*księgi.*nie ma raportu kasy.*kolumna 7.*Pomocy/);
    }
  });
});

describe('odczyt z bazy: rodzaj wpisu ręcznego i FP z fa3_data docierają do reguły', () => {
  const FIRMA = 'firma-1';
  const wpisBaza = (z: Record<string, unknown>) => ({
    id: 'rk-10', tenant_id: FIRMA, rodzaj: 'raport_kasy', data_przychodu: '2026-10-31', data_wpisu: '2026-11-02',
    dokument: 'RK/10/2026', kwota_gr: 500_000, stawka_pb: 300, kolumna: null, opis: null, ...z,
  });
  const tabele = (wpis: Record<string, unknown>): MemoryTables => ({
    invoices: [{
      id: 'fp-app', tenant_id: FIRMA, direction: 'outgoing', ksef_status: 'accepted', ksef_environment: process.env.KSEF_ENV,
      internal_number: 'FV/5/11/2026', issue_date: '2026-11-09', sale_date: '2026-10-15', net_total: 1000,
      invoice_kind: 'regular', invoice_type: 'VAT', advance_invoice_ids: null, currency: 'PLN', ksef_number: null,
      buyer_data: { nip: '1234567890', name: 'Klient' },
      fa3_data: { receipt: { receiptNumber: '000123', receiptDate: '2026-10-15', cashRegisterNumber: 'ABC1234567890' } },
    }],
    invoice_line_items: [],
    tax_profiles: [{ id: 'p1', tenant_id: FIRMA, valid_from: '2026-01-01', forma: 'ryczalt', stawka_domyslna: 1200, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null }],
    ledger_manual_entries: [wpis],
  });

  it('ewidencja: raport kasy z bazy obejmuje FP z FaktWay; „Inny dowód” z bazy nie', async () => {
    const pokryta = await czytajEwidencje(memoryClient(tabele(wpisBaza({}))) as unknown as SupabaseClient, FIRMA, 2026, { kurs: vi.fn() });
    if (!pokryta.ok) throw new Error(pokryta.komunikat);
    expect(pokryta.ewidencja.braki).toEqual([]);
    expect(pokryta.ewidencja.pominiete.map((p) => p.numer)).toEqual(['FV/5/11/2026']);

    const inny = await czytajEwidencje(memoryClient(tabele(wpisBaza({ rodzaj: 'inny' }))) as unknown as SupabaseClient, FIRMA, 2026, { kurs: vi.fn() });
    if (!inny.ok) throw new Error(inny.komunikat);
    expect(inny.ewidencja.braki.map((b) => b.dokument)).toEqual(['FV/5/11/2026']);
  });

  it('KPiR: wpis z bazy (kolumna 7, rodzaj z bazy) obejmuje FP', async () => {
    const wpisy = await czytajWpisyKpir(
      memoryClient({ ledger_manual_entries: [wpisBaza({ stawka_pb: null, kolumna: 'k7' })] }) as unknown as SupabaseClient,
      FIRMA, '2026-01-01', '2026-12-31',
    );
    expect(wpisy.map((w) => w.rodzaj)).toEqual(['raport_kasy']);
    const k = kpir([fakturaFp()], wpisy);
    expect(k.braki).toEqual([]);
    expect(k.pominiete.map((p) => p.numer)).toEqual(['FV/5/11/2026']);
  });
});
