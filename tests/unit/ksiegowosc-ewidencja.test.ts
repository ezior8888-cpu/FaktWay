import { describe, expect, it } from 'vitest';

import {
  brakiOkresu,
  dzienPrzychodu,
  kluczKursu,
  przeliczNaPln,
  sumyOkresu,
  wierszeOkresu,
  zbudujEwidencje,
  type FakturaEwidencji,
  type KursPrzychodu,
  type WejscieEwidencji,
  type WpisReczny,
} from '@/lib/ksiegowosc/ewidencja';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Ewidencja przychodów ryczałtu (plan księgowości JDG, K3): każda zasada
 * z sekcji 4 planu, która dotyczy ewidencji, ma tu swój przypadek.
 */

const RYCZALT_12: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: false,
  nrsZus: null,
  najem: false,
};

function faktura(z: Partial<FakturaEwidencji> = {}): FakturaEwidencji {
  return {
    id: 'f1',
    numer: 'FV/1/2026',
    dataWystawienia: '2026-03-10',
    dataSprzedazy: '2026-03-10',
    rodzaj: 'zwykla',
    nettoGr: 10_000_00,
    waluta: 'PLN',
    numerKsef: '1234567890-20260310-0A1B2C-3D4E5F-6A',
    fp: false,
    kontrahent: { kraj: 'PL', identyfikator: '1234567890' },
    rozliczoneZaliczkiGr: 0,
    pozycje: null,
    ...z,
  };
}

function wpis(z: Partial<WpisReczny> = {}): WpisReczny {
  return {
    id: 'w1',
    rodzaj: 'raport_kasy',
    dataPrzychodu: '2026-03-31',
    dataWpisu: '2026-04-02',
    dokument: 'RK/03/2026',
    kwotaGr: 2_500_00,
    stawkaPb: 300,
    opis: null,
    ...z,
  };
}

function ewidencja(z: Partial<WejscieEwidencji> = {}) {
  return zbudujEwidencje({ rok: 2026, faktury: [], wpisy: [], wersje: [RYCZALT_12], kursy: new Map(), ...z });
}

describe('pkt 1: przychód z faktur i wpisów ręcznych', () => {
  it('faktura wchodzi kwotą netto ze stawką z profilu, wpis z kasy swoją stawką', () => {
    const e = ewidencja({ faktury: [faktura()], wpisy: [wpis()] });
    expect(e.braki).toEqual([]);
    expect(e.wiersze.map((w) => [w.lp, w.dowod, w.kwotaGr, w.stawkaPb, w.dataWpisu, w.dataPrzychodu])).toEqual([
      [1, 'FV/1/2026', 10_000_00, 1200, '2026-03-10', '2026-03-10'],
      [2, 'RK/03/2026', 2_500_00, 300, '2026-04-02', '2026-03-31'],
    ]);
  });

  it('korekta wchodzi różnicą (także ujemną) w dniu swojego wystawienia, nie sprzedaży', () => {
    const kor = faktura({ id: 'k1', numer: 'KOR/1', rodzaj: 'korekta', dataWystawienia: '2026-05-04', dataSprzedazy: '2026-03-10', nettoGr: -1_000_00 });
    const [w] = ewidencja({ faktury: [kor] }).wiersze;
    expect([w.dataPrzychodu, w.kwotaGr, w.uwagi]).toEqual(['2026-05-04', -1_000_00, 'Korekta (różnica)']);
  });

  it('zaliczka się nie dubluje: rozliczenie pomniejszone o rozliczone zaliczki, jak w KPiR', () => {
    const zal = faktura({ id: 'z1', numer: 'ZAL/1', rodzaj: 'zaliczka', nettoGr: 3_000_00 });
    const roz = faktura({ id: 'r1', numer: 'ROZ/1', rodzaj: 'rozliczenie', nettoGr: 10_000_00, rozliczoneZaliczkiGr: 3_000_00, dataWystawienia: '2026-04-10', dataSprzedazy: '2026-04-10' });
    const e = ewidencja({ faktury: [zal, roz] });
    expect(e.wiersze.map((w) => [w.dowod, w.kwotaGr])).toEqual([['ZAL/1', 3_000_00], ['ROZ/1', 7_000_00]]);
    expect(sumyOkresu(e.wiersze).razemGr).toBe(10_000_00);
  });

  it('dzień przychodu: sprzedaż wcześniejsza niż wystawienie (kpirSaleEventDate), nigdy późniejsza', () => {
    expect(dzienPrzychodu(faktura({ dataSprzedazy: '2026-02-27', dataWystawienia: '2026-03-03' }))).toBe('2026-02-27');
    expect(dzienPrzychodu(faktura({ dataSprzedazy: '2026-03-20', dataWystawienia: '2026-03-03' }))).toBe('2026-03-03');
  });

  it('sprzedaż z grudnia zafakturowana w styczniu należy do roku sprzedaży', () => {
    const f = faktura({ dataSprzedazy: '2026-12-28', dataWystawienia: '2027-01-08' });
    expect(ewidencja({ faktury: [f] }).wiersze).toHaveLength(1);
    expect(zbudujEwidencje({ rok: 2027, faktury: [f], wpisy: [], wersje: [RYCZALT_12], kursy: new Map() }).wiersze).toEqual([]);
  });
});

describe('pkt 2: faktura do paragonu', () => {
  // Krok 1.2 planu kompletnej aplikacji (świadoma zmiana testu): FP dalej nie
  // jest drugim przychodem, ale do reguły, która sprawdzi pokrycie raportem kasy
  // (następny PR, G30), miesiąc z FP ma brak zamiast cichego pominięcia.
  it('FP nie jest drugim przychodem; miesiąc z FP ma brak z nazwą faktury i wyjściem', () => {
    const e = ewidencja({ faktury: [faktura({ fp: true })], wpisy: [wpis()] });
    expect(e.wiersze.map((w) => w.dowod)).toEqual(['RK/03/2026']);
    expect(e.pominiete).toEqual([]);
    expect(e.braki).toEqual([
      { dzien: '2026-03-10', dokument: 'FV/1/2026', komunikat: expect.stringMatching(/faktura do paragonu.*raportu kasy.*Pomocy/) },
    ]);
  });
});

describe('pkt 3: waluty po kursie NBP sprzed dnia przychodu', () => {
  const kursy = new Map<string, KursPrzychodu>([
    [kluczKursu('EUR', '2026-03-10'), { znaleziony: true, mid: 4.2586, tabela: '048/A/NBP/2026', dataTabeli: '2026-03-09' }],
  ]);

  it('kwota w EUR przeliczona do grosza, z kursem i tabelą w uwagach', () => {
    const [w] = ewidencja({ faktury: [faktura({ waluta: 'EUR', nettoGr: 1_000_00 })], kursy }).wiersze;
    expect(w.kwotaGr).toBe(4_258_60);
    expect(w.uwagi).toBe('1000,00 EUR po kursie 4,2586 (tabela 048/A/NBP/2026 z 2026-03-09)');
  });

  it('bez kursu: brak z nazwą faktury, bez przeliczenia „mniej więcej”', () => {
    const e = ewidencja({ faktury: [faktura({ waluta: 'USD' })], kursy });
    expect(e.wiersze).toEqual([]);
    expect(e.braki[0].komunikat).toMatch(/Faktura FV\/1\/2026 w USD: brak kursu średniego NBP sprzed 10\.03\.2026/);
  });

  it('przeliczenie zaokrągla połówkę od zera i nie gubi groszy na dużych kwotach', () => {
    expect(przeliczNaPln(1, 4.5)).toBe(5);
    expect(przeliczNaPln(-1, 4.5)).toBe(-5);
    // 999 999 999,99 EUR × 4,2586 = 4 258 599 999,957414 zł → 425 859 999 996 gr.
    expect(przeliczNaPln(999_999_999_99, 4.2586)).toBe(425_859_999_996);
  });
});

describe('pkt 5 i 6: miesiąc według dat kalendarzowych, kwoty do grosza', () => {
  it('wiersze i sumy miesiąca liczą się po dniu przychodu, a numeracja okresu zaczyna się od 1', () => {
    const e = ewidencja({
      faktury: [
        faktura({ id: 'a', numer: 'FV/A', dataWystawienia: '2026-03-31', dataSprzedazy: '2026-03-31', nettoGr: 1 }),
        faktura({ id: 'b', numer: 'FV/B', dataWystawienia: '2026-04-01', dataSprzedazy: '2026-04-01', nettoGr: 2 }),
      ],
    });
    expect(wierszeOkresu(e, '2026-04-01', '2026-04-30').map((w) => [w.lp, w.dowod])).toEqual([[1, 'FV/B']]);
    const sumy = sumyOkresu(wierszeOkresu(e, '2026-03-01', '2026-03-31'));
    expect([sumy.razemGr, sumy.liczbaWierszy, [...sumy.stawki]]).toEqual([1, 1, [[1200, 1]]]);
  });
});

describe('pkt 8: fail-closed z wyjściem', () => {
  it('dzień bez profilu: brak z nazwą dokumentu i drogą do ustawień', () => {
    const e = ewidencja({ wersje: [{ ...RYCZALT_12, validFrom: '2026-06-01' }], faktury: [faktura()] });
    expect(e.wiersze).toEqual([]);
    expect(e.braki).toEqual([
      { dzien: '2026-03-10', dokument: 'FV/1/2026', komunikat: expect.stringContaining('zakładce „Ustawienia podatkowe”') },
    ]);
    expect(brakiOkresu(e, '2026-03-01', '2026-03-31')).toHaveLength(1);
    expect(brakiOkresu(e, '2026-04-01', '2026-04-30')).toEqual([]);
  });

  it('dzień ze skalą: faktura nie należy do ewidencji (to KPiR), a wpis ręczny to brak z wyjściem', () => {
    const skala: WersjaProfilu = { ...RYCZALT_12, id: 'p2', validFrom: '2027-01-01', forma: 'skala', stawkaDomyslna: null };
    const e = zbudujEwidencje({
      rok: 2027,
      faktury: [faktura({ dataWystawienia: '2027-02-01', dataSprzedazy: '2027-02-01' })],
      wpisy: [wpis({ dataPrzychodu: '2027-02-28' })],
      wersje: [RYCZALT_12, skala],
      kursy: new Map(),
    });
    expect(e.wiersze).toEqual([]);
    expect(e.braki.map((b) => b.komunikat)).toEqual([expect.stringMatching(/forma opodatkowania to skala podatkowa.*Wpis usuwa się/)]);
    expect(e.ryczaltWRoku).toBe(false);
  });
});

describe('stawki z pozycji faktury (D4)', () => {
  it('pozycje z różnymi stawkami dzielą zwykłą fakturę na wiersze; bez własnej stawki obowiązuje domyślna', () => {
    const f = faktura({
      nettoGr: 3_000_00,
      pozycje: [
        { nettoGr: 1_000_00, stawkaRyczaltu: '8.50' },
        { nettoGr: 2_000_00, stawkaRyczaltu: null },
      ],
    });
    expect(ewidencja({ faktury: [f] }).wiersze.map((w) => [w.stawkaPb, w.kwotaGr])).toEqual([[850, 1_000_00], [1200, 2_000_00]]);
  });

  it('korekta z różnymi stawkami, suma pozycji inna niż netto i stawka spoza słownika to braki', () => {
    const e = ewidencja({
      faktury: [
        faktura({ id: 'k', numer: 'KOR/2', rodzaj: 'korekta', pozycje: [{ nettoGr: 1, stawkaRyczaltu: 3 }, { nettoGr: 1, stawkaRyczaltu: 12 }] }),
        faktura({ id: 's', numer: 'FV/S', nettoGr: 5_00, pozycje: [{ nettoGr: 1_00, stawkaRyczaltu: 3 }, { nettoGr: 1_00, stawkaRyczaltu: 12 }] }),
        faktura({ id: 'x', numer: 'FV/X', pozycje: [{ nettoGr: 10_000_00, stawkaRyczaltu: 20 }] }),
      ],
    });
    expect(e.wiersze).toEqual([]);
    expect(e.braki.map((b) => b.komunikat)).toEqual([
      expect.stringMatching(/^Faktura FV\/S: suma pozycji \(2,00\) nie zgadza się z kwotą netto \(5,00\)/),
      expect.stringMatching(/^Faktura FV\/X ma stawkę 20 %, której nie ma w ewidencji ryczałtu/),
      expect.stringMatching(/^Faktura KOR\/2 \(korekta\) ma pozycje z różnymi stawkami ryczałtu/),
    ]);
  });
});

describe('kolejność i rok', () => {
  it('Lp. rośnie po dniu przychodu, potem dniu wpisu i dowodzie; wpisy spoza roku pomija', () => {
    const e = ewidencja({
      faktury: [faktura({ id: 'b', numer: 'FV/2', dataWystawienia: '2026-01-05', dataSprzedazy: '2026-01-05' })],
      wpisy: [wpis({ id: 'w0', dokument: 'RK/01', dataPrzychodu: '2026-01-05', dataWpisu: '2026-01-04' }), wpis({ id: 'w9', dataPrzychodu: '2027-01-02' })],
    });
    expect(e.wiersze.map((w) => [w.lp, w.dowod])).toEqual([[1, 'RK/01'], [2, 'FV/2']]);
    expect(e.ryczaltWRoku).toBe(true);
  });
});

describe('próg najmu (K4): 8,5 % ponad 100 000 zł w roku to 12,5 %', () => {
  const NAJEM: WersjaProfilu = { ...RYCZALT_12, stawkaDomyslna: 850, najem: true };
  const PROG = { progGr: 10_000_000, stawkaNajmuPb: 850, stawkaPonadProgPb: 1250 };
  const f = (id: string, dzien: string, gr: number) => faktura({ id, numer: `FV/${id}`, dataWystawienia: dzien, dataSprzedazy: dzien, nettoGr: gr });
  const kor = (id: string, dzien: string, gr: number) => faktura({ id, numer: `KOR/${id}`, rodzaj: 'korekta', dataWystawienia: dzien, nettoGr: gr });
  const wiersze = (e: ReturnType<typeof ewidencja>) => e.wiersze.map((w) => [w.dowod, w.stawkaPb, w.kwotaGr]);

  it('wiersz przekraczający próg dzieli się, a kolejne idą z 12,5 %; JPK dostaje obie stawki', () => {
    const e = ewidencja({
      wersje: [NAJEM],
      najem: PROG,
      faktury: [f('a', '2026-02-01', 6_000_000), f('b', '2026-03-01', 5_000_000), f('c', '2026-04-01', 500_000)],
    });
    expect(e.braki).toEqual([]);
    expect(wiersze(e)).toEqual([
      ['FV/a', 850, 6_000_000],
      ['FV/b', 850, 4_000_000],
      ['FV/b', 1250, 1_000_000],
      ['FV/c', 1250, 500_000],
    ]);
    expect(e.wiersze[2].uwagi?.replace(/\u00a0/g, ' ')).toContain('Najem ponad 100 000 zł w roku: 12,5 %');
  });

  it('próg, stawki i tekst uwagi biorą się z parametrów roku, nie z kodu', () => {
    const e = ewidencja({ wersje: [NAJEM], najem: { ...PROG, progGr: 5_000_000, stawkaPonadProgPb: 1300 }, faktury: [f('a', '2026-02-01', 6_000_000)] });
    expect(wiersze(e)).toEqual([
      ['FV/a', 850, 5_000_000],
      ['FV/a', 1300, 1_000_000],
    ]);
    expect(e.wiersze[1].uwagi?.replace(/\u00a0/g, ' ')).toContain('Najem ponad 50 000 zł w roku: 13 %');
  });

  it('bez znacznika najmu 8,5 % zostaje 8,5 %; parametry niepotwierdzone przez księgową (D7) to brak z ich komunikatem', () => {
    expect(ewidencja({ wersje: [{ ...NAJEM, najem: false }], najem: { brak: 'x' }, faktury: [f('a', '2026-02-01', 100)] }).wiersze[0].stawkaPb).toBe(850);
    const bezProgu = ewidencja({ wersje: [NAJEM], najem: { brak: 'Stawki na 2026 r. (ryczałt) czekają na sprawdzenie przez księgową.' }, faktury: [f('a', '2026-02-01', 100)] });
    expect([bezProgu.wiersze, bezProgu.braki[0]?.komunikat]).toEqual([[], expect.stringContaining('czekają na sprawdzenie przez księgową')]);
  });

  it('korekta in minus po przekroczeniu progu najpierw zmniejsza nadwyżkę 12,5 %, resztę z 8,5 %', () => {
    const e = ewidencja({ wersje: [NAJEM], najem: PROG, faktury: [f('a', '2026-02-01', 11_000_000), kor('k1', '2026-05-01', -400_000), kor('k2', '2026-06-01', -1_000_000)] });
    expect(e.braki).toEqual([]);
    expect(wiersze(e)).toEqual([
      ['FV/a', 850, 10_000_000],
      ['FV/a', 1250, 1_000_000],
      ['KOR/k1', 1250, -400_000],
      ['KOR/k2', 850, -400_000],
      ['KOR/k2', 1250, -600_000],
    ]);
  });

  it('w odczycie próg najmu z sekcji ryczałtu niepotwierdzonej przez księgową to brak (D7)', async () => {
    const { progNajmuZParametrow } = await import('@/lib/ksiegowosc/ewidencja-dane');
    expect(progNajmuZParametrow(2026)).toEqual({ brak: expect.stringContaining('(ryczałt) czekają na sprawdzenie przez księgową') });
    expect(progNajmuZParametrow(2031)).toEqual({ brak: expect.stringContaining('2031') });
  });

  it('brak wcześniej w roku: kolejne wiersze najmu to brak, bo próg zależy od przychodu od początku roku', () => {
    const euro = faktura({ id: 'e', numer: 'FV/e', dataWystawienia: '2026-02-10', dataSprzedazy: '2026-02-10', nettoGr: 100_000, waluta: 'EUR' });
    const e = ewidencja({ wersje: [NAJEM], najem: PROG, faktury: [f('a', '2026-01-10', 1_000_000), euro, f('b', '2026-03-01', 500_000)] });
    expect(wiersze(e)).toEqual([['FV/a', 850, 1_000_000]]);
    expect(e.braki.map((b) => b.dokument)).toEqual(['FV/e', 'FV/b']);
    expect(e.braki[1].komunikat).toContain('10.02.2026');
  });
});
