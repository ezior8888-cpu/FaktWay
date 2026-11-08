import { describe, expect, it } from 'vitest';

import type { FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { sumyKpir, wierszeKpirOkresu, zbudujKpir, type KosztKpir, type WejscieKpir } from '@/lib/ksiegowosc/kpir';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { tenMiesiac, type Platnosc } from '@/lib/ksiegowosc/ten-miesiac';

/**
 * KPiR według wzoru 2026 (plan księgowości JDG, K7): wiersze K_1-K_17
 * z faktur, kosztów i wpisów ręcznych na zasadach ewidencji z K3, oraz
 * „Ten miesiąc” przy skali z KPiR (zaliczka i zdrowotna od dochodu).
 */

const SKALA: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'skala',
  stawkaDomyslna: null,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

function faktura(dzien: string, gr: number, z: Partial<FakturaEwidencji> = {}): FakturaEwidencji {
  return {
    id: `f-${dzien}-${gr}`,
    numer: `FV/${dzien}`,
    dataWystawienia: dzien,
    dataSprzedazy: dzien,
    rodzaj: 'zwykla',
    nettoGr: gr,
    waluta: 'PLN',
    numerKsef: null,
    fp: false,
    kontrahent: { kraj: 'PL', identyfikator: '5252241585', nazwa: 'Klient Sp. z o.o.', adres: 'ul. Prosta 1, 00-001 Warszawa' },
    rozliczoneZaliczkiGr: 0,
    pozycje: null,
    ...z,
  };
}

function koszt(dzien: string, gr: number, z: Partial<KosztKpir> = {}): KosztKpir {
  return {
    id: `k-${dzien}-${gr}`,
    data: dzien,
    dowod: `FZ/${dzien}`,
    numerKsef: null,
    kontrahent: { nazwa: 'Dostawca', adres: null, kraj: 'PL', identyfikator: '5260001246' },
    opis: 'Usługi księgowe',
    kolumnaAplikacji: 'col_13',
    kwotaGr: gr,
    ...z,
  };
}

const wejscie = (z: Partial<WejscieKpir> = {}): WejscieKpir => ({ rok: 2026, faktury: [], koszty: [], wpisy: [], wersje: [SKALA], kursy: new Map(), ...z });

describe('KPiR 2026', () => {
  it('sprzedaż w K_7 z kontrahentem (K_4-K_5), koszt w kolumnie z kategorii; przychody przed kosztami w tym samym dniu', () => {
    const k = zbudujKpir(
      wejscie({
        faktury: [faktura('2026-03-10', 1_000_000, { numerKsef: '5260001246-20260310-0100001AF629-AF' })],
        koszty: [koszt('2026-03-10', 20_000), koszt('2026-03-05', 50_000, { kolumnaAplikacji: 'col_10' })],
      }),
    );
    expect(k.braki).toEqual([]);
    expect(k.wiersze.map((w) => [w.lp, w.data, w.zrodlo.typ])).toEqual([
      [1, '2026-03-05', 'koszt'],
      [2, '2026-03-10', 'faktura'],
      [3, '2026-03-10', 'koszt'],
    ]);
    expect(k.wiersze[1]).toMatchObject({
      dowod: 'FV/2026-03-10',
      numerKsef: '5260001246-20260310-0100001AF629-AF',
      krajKontrahenta: 'PL',
      idKontrahenta: '5252241585',
      nazwaKontrahenta: 'Klient Sp. z o.o.',
      adresKontrahenta: 'ul. Prosta 1, 00-001 Warszawa',
      opis: 'Sprzedaż towarów i usług',
      kwoty: { k7: 1_000_000, k8: 0, k10: 0, k11: 0, k12: 0, k13: 0 },
    });
    // Kontrahent bez adresu: pole obowiązkowe K_5B dostaje „BRAK”.
    expect(k.wiersze[0]).toMatchObject({ adresKontrahenta: 'BRAK', kwoty: { k10: 50_000 } });
    expect(sumyKpir(k.wiersze)).toMatchObject({ przychodGr: 1_000_000, kosztyGr: 70_000, liczbaWierszy: 3 });
  });

  it('korekta w dniu wystawienia, rozliczenie bez zaliczek, faktura do paragonu poza księgą', () => {
    const k = zbudujKpir(
      wejscie({
        faktury: [
          faktura('2026-04-15', -20_000, { rodzaj: 'korekta', dataSprzedazy: '2026-03-10', numer: 'KOR/1' }),
          faktura('2026-04-20', 300_000, { rodzaj: 'rozliczenie', rozliczoneZaliczkiGr: 100_000, numer: 'ROZ/1' }),
          faktura('2026-04-21', 50_000, { fp: true, numer: 'FP/1' }),
        ],
      }),
    );
    expect(k.wiersze.map((w) => [w.dowod, w.data, w.kwoty.k7, w.uwagi])).toEqual([
      ['KOR/1', '2026-04-15', -20_000, 'Korekta (różnica)'],
      ['ROZ/1', '2026-04-20', 200_000, 'Rozliczenie, pomniejszone o zaliczki 1000,00 PLN'],
    ]);
    expect(k.pominiete).toEqual([expect.objectContaining({ numer: 'FP/1' })]);
  });

  it('waluta po kursie NBP, bez kursu brak; dzień z ryczałtem poza KPiR bez braku, dzień bez profilu z brakiem', () => {
    const ryczaltOdMaja: WersjaProfilu = { ...SKALA, id: 'p2', validFrom: '2026-05-01', forma: 'ryczalt', stawkaDomyslna: 1200 };
    const k = zbudujKpir(
      wejscie({
        wersje: [{ ...SKALA, validFrom: '2026-02-01' }, ryczaltOdMaja],
        faktury: [
          faktura('2026-03-02', 10_000, { waluta: 'EUR', numer: 'EUR/1' }),
          faktura('2026-03-03', 10_000, { waluta: 'EUR', numer: 'EUR/2' }),
          faktura('2026-05-04', 10_000, { numer: 'RYCZ/1' }),
          faktura('2026-01-15', 10_000, { numer: 'STYCZEN/1' }),
        ],
        kursy: new Map([['EUR|2026-03-02', { znaleziony: true, mid: 4.2586, tabela: '041/A/NBP/2026', dataTabeli: '2026-02-27' }]]),
      }),
    );
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7])).toEqual([['EUR/1', 42_586]]);
    expect(k.braki.map((b) => b.dokument)).toEqual(['STYCZEN/1', 'EUR/2']);
    expect(k.braki[1].komunikat).toContain('brak kursu średniego NBP');
  });

  it('koszt B+R w K_13 i K_16; koszt bez kolumny albo z kolumną przychodu to brak z wyjściem', () => {
    const k = zbudujKpir(
      wejscie({
        koszty: [
          koszt('2026-06-01', 30_000, { kolumnaAplikacji: 'col_15', opis: 'Badania' }),
          koszt('2026-06-02', 10_000, { kolumnaAplikacji: null, dowod: 'BEZ/1' }),
          koszt('2026-06-03', 10_000, { kolumnaAplikacji: 'col_7', dowod: 'PRZ/1' }),
        ],
      }),
    );
    expect(k.wiersze).toHaveLength(1);
    expect(k.wiersze[0]).toMatchObject({ kwoty: { k13: 30_000 }, br: { opis: 'Badania', kwotaGr: 30_000 } });
    expect(k.braki.map((b) => [b.dokument, b.komunikat])).toEqual([
      ['BEZ/1', expect.stringContaining('nie ma kolumny KPiR')],
      ['PRZ/1', expect.stringContaining('ma kolumnę przychodu')],
    ]);
    expect(sumyKpir(k.wiersze)).toMatchObject({ kosztyGr: 30_000, brGr: 30_000 });
  });

  it('wpis ręczny w swojej kolumnie (raport kasy w K_7, inny przychód w K_8)', () => {
    const k = zbudujKpir(
      wejscie({
        wpisy: [
          { id: 'w1', data: '2026-07-31', dokument: 'RK/07', kolumna: 'k7', kwotaGr: 123_456, opis: 'Raport miesięczny' },
          { id: 'w2', data: '2026-07-15', dokument: 'NOTA/1', kolumna: 'k8', kwotaGr: 5_000, opis: null },
        ],
      }),
    );
    expect(k.wiersze.map((w) => [w.dowod, w.kwoty.k7, w.kwoty.k8, w.opis, w.nazwaKontrahenta])).toEqual([
      ['NOTA/1', 0, 5_000, 'Przychód', 'BRAK'],
      ['RK/07', 123_456, 0, 'Raport miesięczny', 'BRAK'],
    ]);
    expect(wierszeKpirOkresu(k, '2026-07-20', '2026-07-31').map((w) => [w.lp, w.dowod])).toEqual([[1, 'RK/07']]);
  });
});

describe('„Ten miesiąc” przy skali z KPiR', () => {
  const zaplata = (miesiac: string, rodzaj: Platnosc['rodzaj'], kwotaGr: number, zaplaconeO: string, spoleczneBezFpGr = 0): Platnosc => ({
    miesiac,
    rodzaj,
    wersja: 1,
    kwotaGr,
    spoleczneBezFpGr,
    zaplaconeO,
  });

  it('marzec: zaliczka narastająco od stycznia, zdrowotna 9 % dochodu z lutego po zapłaconych społecznych', () => {
    const miesiace = ['2026-01-31', '2026-02-28', '2026-03-31'];
    const kpir = zbudujKpir(
      wejscie({
        faktury: miesiace.map((d) => faktura(d, 2_000_000)),
        koszty: miesiace.map((d) => koszt(d, 500_000)),
      }),
    );
    const w = tenMiesiac({
      miesiac: '2026-03',
      kpir: { rok: kpir, poprzedni: null },
      wersje: [SKALA],
      // Składki za styczeń i luty zapłacone w lutym i marcu (społeczne bez FP 1 788,29 zł).
      platnosci: [zaplata('2026-01', 'zus_spoleczne', 192_676, '2026-02-16', 178_829), zaplata('2026-02', 'zus_spoleczne', 192_676, '2026-03-16', 178_829)],
      parametry: parametryRoku,
    });
    if (!w.ok) throw new Error(w.braki.join(' '));
    const pozycje = Object.fromEntries(w.wynik.pozycje.map((p) => [p.rodzaj, p.ok ? p.kwotaGr : p.brak]));
    // Dochód I-III: 45 000 zł, społeczne 3 576,58 zł → podstawa 41 423 zł → 12 % = 4 970,76 − 3 600 = 1 370,76 zł.
    // Styczeń: 15 000 → 1 800 − 3 600 < 0; luty: 30 000 − 1 788,29 = 28 212 → 3 385,44 − 3 600 < 0; marzec: 1 371 zł.
    expect(pozycje.pit).toBe(137_100);
    expect(w.wynik.pit).toMatchObject({ dochodNarastajacoGr: 4_500_000, spoleczneNarastajacoGr: 357_658, podstawaNarastajacoGr: 4_142_300 });
    // Zdrowotna za marzec: dochód lutego 15 000 − 1 788,29 = 13 211,71 zł → 9 % = 1 189,05 zł.
    expect(pozycje.zdrowotna).toBe(118_905);
    expect(w.wynik.zdrowotnaOdDochodu).toMatchObject({ dochodGr: 1_321_171, minimalna: false });
    expect(w.wynik).toMatchObject({ przychodGr: 2_000_000, kosztyGr: 500_000 });
    expect(w.wynik.pozycje.find((p) => p.rodzaj === 'pit')?.termin?.faktyczny).toBe('2026-04-20');
  });

  it('styczeń bierze dochód z grudnia z KPiR roku poprzedniego; bez niej brak zdrowotnej', () => {
    const grudzien = zbudujKpir(wejscie({ faktury: [faktura('2026-12-31', 300_000)] }));
    const styczen = zbudujKpir(wejscie({ rok: 2027, faktury: [faktura('2027-01-31', 300_000)] }));
    const w = tenMiesiac({ miesiac: '2027-01', kpir: { rok: styczen, poprzedni: grudzien }, wersje: [SKALA], platnosci: [], parametry: parametryRoku });
    if (!w.ok) throw new Error(w.braki.join(' '));
    // Styczeń 2027 należy do roku składkowego od lutego 2026 r.: grudniowe 3 000 zł × 9 % = 270 zł, więc minimalna 432,54 zł.
    expect(w.wynik.pozycje.find((p) => p.rodzaj === 'zdrowotna')).toMatchObject({ ok: true, kwotaGr: 43_254, wejscia: { dochodGr: 300_000, zMiesiaca: '2026-12' } });

    const bezGrudnia = tenMiesiac({ miesiac: '2027-01', kpir: { rok: styczen, poprzedni: null }, wersje: [SKALA], platnosci: [], parametry: parametryRoku });
    if (!bezGrudnia.ok) throw new Error(bezGrudnia.braki.join(' '));
    expect(bezGrudnia.wynik.pozycje.find((p) => p.rodzaj === 'zdrowotna')).toMatchObject({ ok: false, brak: expect.stringContaining('grudzień 2026') });
  });

  it('brak w KPiR od stycznia zabiera zaliczkę, a składki społeczne zostają', () => {
    const kpir = zbudujKpir(wejscie({ koszty: [koszt('2026-02-10', 10_000, { kolumnaAplikacji: null })], faktury: [faktura('2026-03-31', 100_000)] }));
    const w = tenMiesiac({ miesiac: '2026-03', kpir: { rok: kpir, poprzedni: null }, wersje: [SKALA], platnosci: [], parametry: parametryRoku });
    if (!w.ok) throw new Error(w.braki.join(' '));
    const pit = w.wynik.pozycje.find((p) => p.rodzaj === 'pit');
    expect(pit).toMatchObject({ ok: false, brak: expect.stringContaining('KPiR ma braki w miesiącach: luty 2026') });
    expect(w.wynik.pozycje.find((p) => p.rodzaj === 'zus_spoleczne')).toMatchObject({ ok: true });
  });
});
