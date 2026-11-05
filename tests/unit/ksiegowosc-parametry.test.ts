import { describe, expect, it } from 'vitest';

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  brakNastepnegoRoku,
  brakujace,
  limitZwolnieniaVat,
  PARAMETRY,
  parametryNa,
  parametryRoku,
  rokSkladkowyZdrowotnej,
  SEKCJE,
  terminyNa,
  wszystkieLiczby,
  zdrowotnaNa,
  type ParametryRoku,
} from '@/lib/ksiegowosc/parametry';
import { TERMINY } from '@/lib/ksiegowosc/parametry/terminy';

/**
 * Parametry modułu księgowości (plan księgowości JDG, krok K1, D7):
 * każda liczba ma źródło i datę odczytu, brak roku i niesprawdzona sekcja
 * zatrzymują liczenie, a liczby 2026 odtwarzają co do grosza kwoty z tabel
 * ZUS (przeciwko pomyłce przy przepisywaniu stawek i podstaw).
 */

const LATA = Object.values(PARAMETRY);
const DATA = /^\d{4}-\d{2}-\d{2}$/;

/** Składka w groszach: podstawa w groszach × stopa w pb, zaokrąglenie do grosza. */
function skladka(podstawaGr: number, stopaPb: number): number {
  return Math.round((podstawaGr * stopaPb) / 10_000);
}

function wartosc(p: ParametryRoku, sekcja: keyof Omit<ParametryRoku, 'rok'>, klucz: string): number {
  const liczba = (p[sekcja].liczby as Record<string, { wartosc: number | null }>)[klucz];
  if (liczba?.wartosc == null) throw new Error(`brak ${sekcja}.${klucz} w ${p.rok}`);
  return liczba.wartosc;
}

describe('każda liczba ma źródło', () => {
  it.each(LATA.map((p) => [p.rok, p] as const))('rok %i: wartość ze źródłem i datą, brak z powodem', (_rok, p) => {
    for (const { sekcja, klucz, liczba } of wszystkieLiczby(p)) {
      const gdzie = `${p.rok} ${sekcja}.${klucz}`;
      expect(liczba.odczyt, gdzie).toMatch(DATA);
      expect(['gr', 'pb', 'mies', 'dzien'], gdzie).toContain(liczba.jednostka);
      if (liczba.wartosc === null) {
        expect(liczba.uwagi?.trim().length ?? 0, `${gdzie}: brak wartości bez powodu`).toBeGreaterThan(10);
      } else {
        expect(liczba.zrodlo.trim().length, `${gdzie}: liczba bez źródła`).toBeGreaterThan(10);
        expect(Number.isInteger(liczba.wartosc), `${gdzie}: jednostki są całkowite`).toBe(true);
        expect(liczba.wartosc, gdzie).toBeGreaterThan(0);
      }
    }
  });

  it('każdy rok ma wszystkie sekcje, a pole rok zgadza się z kluczem', () => {
    for (const [rok, p] of Object.entries(PARAMETRY)) {
      expect(p.rok).toBe(Number(rok));
      for (const sekcja of SEKCJE) expect(p[sekcja], `${rok} ${sekcja}`).toBeDefined();
    }
  });

  it('terminy mają źródła i są posortowane po dacie obowiązywania', () => {
    const daty = TERMINY.map((t) => t.od);
    expect([...daty].sort()).toEqual(daty);
    for (const t of TERMINY) {
      for (const [klucz, liczba] of Object.entries(t.liczby)) {
        expect(liczba.zrodlo.length, klucz).toBeGreaterThan(10);
        expect(liczba.jednostka).toBe('dzien');
      }
    }
  });

  it('żadna sekcja nie jest jeszcze potwierdzona przez księgową (B4)', () => {
    for (const p of LATA) {
      for (const sekcja of SEKCJE) expect(p[sekcja].sprawdzila, `${p.rok} ${sekcja}`).toBeNull();
    }
  });
});

describe('fail-closed', () => {
  it('rok bez pliku nie dostaje parametrów z innego roku', () => {
    expect(parametryNa('2028-01-01')).toBeNull();
    expect(parametryRoku(2025)).toBeNull();
    expect(limitZwolnieniaVat('2028-01-01')).toBeNull();
  });

  it('brak roku daje komunikat z nazwą braku i ścieżkę operatora', () => {
    const [brak] = brakujace(2028, ['zus']);
    expect(brak).toMatchObject({ sekcja: 'zus', powod: 'brak_roku' });
    expect(brak?.komunikat).toContain('2028');
    expect(brak?.operator).toContain('lib/ksiegowosc/parametry/2028.ts');
  });

  it('niesprawdzona sekcja zatrzymuje liczenie także wtedy, gdy liczby są pełne', () => {
    const braki = brakujace(2026, ['ryczalt']);
    expect(braki).toHaveLength(1);
    expect(braki[0]).toMatchObject({ sekcja: 'ryczalt', powod: 'niesprawdzone' });
    expect(braki[0]?.komunikat).toContain('księgow');
  });

  it('nieogłoszone kwoty 2027 są wymienione z nazwy', () => {
    const zdrowotna = brakujace(2027, ['zdrowotna']).find((b) => b.powod === 'brak_liczby');
    expect(zdrowotna?.liczby).toEqual(
      expect.arrayContaining(['przecietneWynagrodzenieIvKw', 'ryczaltDo60Tys', 'ryczaltDo300Tys', 'ryczaltPonad300Tys']),
    );
    const zus = brakujace(2027, ['zus']).find((b) => b.powod === 'brak_liczby');
    expect(zus?.liczby).toEqual(['prognozowanePrzecietneWynagrodzenie', 'stopaWypadkowaOdKwietnia']);
  });

  it('komunikaty dla klienta bez trybu rozkazującego i długich myślników (D8)', () => {
    const wszystkie = [...brakujace(2028, SEKCJE), ...brakujace(2027, SEKCJE)];
    for (const { komunikat } of wszystkie) {
      expect(komunikat).not.toMatch(/[—–]/);
      expect(komunikat).not.toMatch(/\b(zapłać|uzupełnij|sprawdź|dodaj)\b/i);
    }
  });
});

describe('rok składkowy zdrowotnej (luty do stycznia)', () => {
  it('styczeń należy do roku poprzedniego', () => {
    expect(rokSkladkowyZdrowotnej('2027-01')).toBe(2026);
    expect(rokSkladkowyZdrowotnej('2027-02')).toBe(2027);
    expect(rokSkladkowyZdrowotnej('2027-12')).toBe(2027);
  });

  it('minimalna składka za styczeń 2027 z roku 2026, od lutego nowa', () => {
    expect(zdrowotnaNa('2027-01')?.liczby.minimalna.wartosc).toBe(43_254);
    expect(zdrowotnaNa('2027-02')?.liczby.minimalna.wartosc).toBe(44_550);
    expect(zdrowotnaNa('2026-01')).toBeNull(); // rok składkowy 2025: brak pliku
  });
});

describe('terminy po dacie obowiązywania', () => {
  it('przed pierwszym wierszem nie zgadujemy', () => {
    expect(terminyNa('2025-12-31')).toBeNull();
  });

  it('dni miesiąca: 20 dla ryczałtu, zaliczki i ZUS, 25 dla JPK_V7M', () => {
    const t = terminyNa('2028-01-01');
    expect(t?.liczby.ryczalt.wartosc).toBe(20);
    expect(t?.liczby.zaliczkaPit.wartosc).toBe(20);
    expect(t?.liczby.zus.wartosc).toBe(20);
    expect(t?.liczby.vatJpk.wartosc).toBe(25);
  });
});

describe('liczby 2026 odtwarzają tabele ZUS co do grosza', () => {
  const p = PARAMETRY[2026]!;

  it('pełny ZUS: 1 926,76 zł, bez chorobowego 1 788,29 zł', () => {
    const podstawa = skladka(wartosc(p, 'zus', 'prognozowanePrzecietneWynagrodzenie'), wartosc(p, 'zus', 'podstawaPelnaProc'));
    expect(podstawa).toBe(565_200);
    const emerytalna = skladka(podstawa, wartosc(p, 'zus', 'stopaEmerytalna'));
    const rentowe = skladka(podstawa, wartosc(p, 'zus', 'stopaRentowa'));
    const wypadkowa = skladka(podstawa, wartosc(p, 'zus', 'stopaWypadkowaOdKwietnia'));
    const chorobowa = skladka(podstawa, wartosc(p, 'zus', 'stopaChorobowa'));
    const fp = skladka(podstawa, wartosc(p, 'zus', 'stopaFunduszPracy'));
    expect([emerytalna, rentowe, wypadkowa, chorobowa, fp]).toEqual([110_327, 45_216, 9_439, 13_847, 13_847]);
    expect(emerytalna + rentowe + wypadkowa + chorobowa + fp).toBe(192_676);
    expect(emerytalna + rentowe + wypadkowa + fp).toBe(178_829);
  });

  it('preferencyjny ZUS: 456,18 zł, bez chorobowego 420,86 zł (bez Funduszu Pracy)', () => {
    const podstawa = skladka(wartosc(p, 'zus', 'placaMinimalna'), wartosc(p, 'zus', 'podstawaPreferencyjnaProc'));
    expect(podstawa).toBe(144_180);
    const czesci = ['stopaEmerytalna', 'stopaRentowa', 'stopaWypadkowaOdKwietnia', 'stopaChorobowa'].map((k) =>
      skladka(podstawa, wartosc(p, 'zus', k)),
    );
    expect(czesci).toEqual([28_144, 11_534, 2_408, 3_532]);
    expect(czesci.reduce((a, b) => a + b, 0)).toBe(45_618);
    expect(czesci[0]! + czesci[1]! + czesci[2]!).toBe(42_086);
  });

  it('zdrowotna na ryczałcie: 9 % z 60, 100 i 180 % przeciętnego wynagrodzenia', () => {
    const przecietne = wartosc(p, 'zdrowotna', 'przecietneWynagrodzenieIvKw');
    const stawka = wartosc(p, 'zdrowotna', 'stawka');
    const kwota = (procentPb: number) => skladka(skladka(przecietne, procentPb), stawka);
    expect(kwota(6_000)).toBe(wartosc(p, 'zdrowotna', 'ryczaltDo60Tys'));
    expect(kwota(10_000)).toBe(wartosc(p, 'zdrowotna', 'ryczaltDo300Tys'));
    expect(kwota(18_000)).toBe(wartosc(p, 'zdrowotna', 'ryczaltPonad300Tys'));
  });

  it('minimalna zdrowotna to 9 % minimalnego wynagrodzenia (2026 i od lutego 2027)', () => {
    expect(skladka(wartosc(p, 'zus', 'placaMinimalna'), wartosc(p, 'zdrowotna', 'stawka'))).toBe(
      wartosc(p, 'zdrowotna', 'minimalna'),
    );
    const p27 = PARAMETRY[2027]!;
    expect(skladka(wartosc(p27, 'zus', 'placaMinimalna'), wartosc(p27, 'zdrowotna', 'stawka'))).toBe(
      wartosc(p27, 'zdrowotna', 'minimalna'),
    );
  });
});

describe('bezpiecznik roku', () => {
  it('PARAMETRY NA NASTĘPNY ROK ISTNIEJĄ OD 1 GRUDNIA — ten test ma popsuć build w grudniu bez nowego pliku', () => {
    // Gdy test pęknie: dodaj lib/ksiegowosc/parametry/<rok>.ts ze źródłami
    // (sekcja 5 planu) i wpisz go w PARAMETRY. Bez pliku 1 stycznia karta
    // limitu VAT na Pulpicie pokaże błąd, a silniki przestaną liczyć.
    expect(brakNastepnegoRoku(todayInWarsaw(new Date()))).toBeNull();
  });

  it('liczy od 1 grudnia, a nie wcześniej', () => {
    expect(brakNastepnegoRoku('2027-11-30')).toBeNull();
    expect(brakNastepnegoRoku('2027-12-01')).toBe(2028);
    expect(brakNastepnegoRoku('2026-12-01')).toBeNull();
  });
});
