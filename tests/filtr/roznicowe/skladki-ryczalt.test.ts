import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { ryczaltMiesiaca } from '@/lib/ksiegowosc/ryczalt';
import { zdrowotnaOdDochodu, zdrowotnaRyczaltu } from '@/lib/ksiegowosc/zdrowotna';
import { skladkiSpoleczne, type LiczbyZus } from '@/lib/ksiegowosc/zus';

import { grosze, groszeZeZnakiem, profil } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';
import { ryczaltWyrocznia } from '../wyrocznia/ryczalt';
import { zdrowotnaOdDochoduWyrocznia, zdrowotnaRyczaltuWyrocznia, type ParametryZdrowotnej } from '../wyrocznia/zdrowotna';
import { skladkiWyrocznia, type EtapZusWyrocznia, type ParametryZus } from '../wyrocznia/zus';

/**
 * Testy różnicowe (żelazny filtr F6, plan B4.4): silniki aplikacji
 * (`lib/ksiegowosc/{zus,zdrowotna,ryczalt}.ts`) i wyrocznie z czystego pokoju
 * (`tests/filtr/wyrocznia/`, osobna sesja i model, tylko z przepisów
 * w SPEC-skladki.md). Wyrocznia zdrowotnej liczy kwoty od podstaw (przeciętne
 * i minimalne wynagrodzenie razy procenty), więc test sprawdza też kwoty
 * wpisane w parametrach roku. Każda różnica to znalezisko (FZ).
 */
const P = parametryRoku(2026)!;
const w = (l: { wartosc: number | null }) => l.wartosc as number;
const ZUS = P.zus.liczby;
const parametryZus = (z: LiczbyZus): ParametryZus => ({
  prognozowanePrzecietneGr: w(z.prognozowanePrzecietneWynagrodzenie),
  placaMinimalnaGr: w(z.placaMinimalna),
  podstawaPelnaPb: w(z.podstawaPelnaProc),
  podstawaPreferencyjnaPb: w(z.podstawaPreferencyjnaProc),
  emerytalnaPb: w(z.stopaEmerytalna),
  rentowaPb: w(z.stopaRentowa),
  chorobowaPb: w(z.stopaChorobowa),
  wypadkowaDoMarcaPb: w(z.stopaWypadkowaDoMarca),
  wypadkowaOdKwietniaPb: w(z.stopaWypadkowaOdKwietnia),
  funduszPracyPb: w(z.stopaFunduszPracy),
});
const ZDR = P.zdrowotna.liczby;
const PARAMETRY_ZDROWOTNEJ: ParametryZdrowotnej = {
  stawkaPb: w(ZDR.stawka),
  stawkaLiniowyPb: w(ZDR.stawkaLiniowy),
  przecietneIvKwGr: w(ZDR.przecietneWynagrodzenieIvKw),
  placaMinimalnaGr: w(ZUS.placaMinimalna),
  progRyczaltu60Gr: w(ZDR.progRyczaltu60Tys),
  progRyczaltu300Gr: w(ZDR.progRyczaltu300Tys),
};

describe('wyrocznia ZUS: składki społeczne za pełny miesiąc', () => {
  const etap = fc.constantFrom('pelny', 'preferencyjny', 'ulga_na_start', 'etat_obok') as fc.Arbitrary<EtapZusWyrocznia>;
  const inneWypadkowe: LiczbyZus = { ...ZUS, stopaWypadkowaOdKwietnia: { ...ZUS.stopaWypadkowaOdKwietnia, wartosc: 193 } };

  it.each([
    ['parametry 2026', ZUS],
    ['inna stawka wypadkowa od kwietnia', inneWypadkowe],
  ])('%s: każda składka co do grosza', (_opis, liczby) => {
    fc.assert(
      fc.property(etap, fc.boolean(), fc.integer({ min: 1, max: 12 }), (e, chorobowe, m) => {
        // Ulga od 1.01.2026 trwa 6 pełnych miesięcy; preferencyjny od 1.01.2026 cały rok.
        const miesiac = e === 'ulga_na_start' ? ((m - 1) % 6) + 1 : m;
        const aplikacja = skladkiSpoleczne(`2026-${String(miesiac).padStart(2, '0')}`, profil({ zusEtap: e, zusOd: e === 'pelny' || e === 'etat_obok' ? null : '2026-01-01', chorobowe }), liczby);
        if (!aplikacja.ok) throw new Error(aplikacja.brak);
        expect(aplikacja.skladki).toEqual(skladkiWyrocznia(e, chorobowe, miesiac, parametryZus(liczby)));
      }),
      opcje(),
    );
  });
});

describe('wyrocznia składki zdrowotnej', () => {
  it('ryczałt: kwota według progu przychodu, liczona od przeciętnego wynagrodzenia (sprawdza też parametry 2026)', () => {
    fc.assert(
      fc.property(fc.oneof(grosze(600_000), fc.constantFrom(6_000_000, 6_000_001, 30_000_000, 30_000_001, 0)), (przychod) => {
        const aplikacja = zdrowotnaRyczaltu(przychod, ZDR);
        if (!aplikacja.ok) throw new Error(aplikacja.brak);
        expect(aplikacja.zdrowotna.skladkaGr).toBe(zdrowotnaRyczaltuWyrocznia(przychod, PARAMETRY_ZDROWOTNEJ));
      }),
      opcje(),
    );
  });

  it.each(['skala', 'liniowy'] as const)('%s: od dochodu, nie mniej niż 9 %% minimalnego wynagrodzenia', (forma) => {
    fc.assert(
      fc.property(groszeZeZnakiem(300_000), (dochod) => {
        const aplikacja = zdrowotnaOdDochodu(forma, dochod, ZDR);
        if (!aplikacja.ok) throw new Error(aplikacja.brak);
        expect(aplikacja.zdrowotna.skladkaGr).toBe(zdrowotnaOdDochoduWyrocznia(forma, dochod, PARAMETRY_ZDROWOTNEJ));
      }),
      opcje(),
    );
  });
});

describe('wyrocznia ryczałtu za miesiąc', () => {
  const STAWKI = [1700, 1500, 1400, 1250, 1200, 1000, 850, 550, 300];
  const stawki = fc.uniqueArray(fc.constantFrom(...STAWKI), { minLength: 0, maxLength: 4 });
  const wejscie = fc.record({
    przychod: stawki.chain((ss) => fc.tuple(...ss.map((s) => fc.tuple(fc.constant(s), groszeZeZnakiem(300_000).map((g) => (g % 7 === 0 ? -Math.abs(g) % 5_000_000 : Math.abs(g))))))),
    ujemne: stawki.chain((ss) => fc.tuple(...ss.map((s) => fc.tuple(fc.constant(s), fc.integer({ min: -2_000_000, max: -1 }))))),
    spoleczne: grosze(5_000),
    zdrowotna: grosze(3_000),
    nadwyzka: grosze(20_000),
  });

  it('remis reszt przy podziale odliczeń: grosz dostaje wyższa stawka (reguła programu, RP-RYCZ-STAWKI-02)', () => {
    // Dwie stawki po 1 000,50 zł i 1 gr odliczeń: stawka z groszem ma podstawę 1 000 zł, druga 1 001 zł.
    const przychod: Array<[number, number]> = [[1200, 100_050], [850, 100_050]];
    const aplikacja = ryczaltMiesiaca(
      { przychodWgStawekGr: new Map(przychod), spoleczneZaplaconeGr: 1, zdrowotnaZaplaconaGr: 0, nadwyzkaZPoprzednichGr: 0 },
      P.ryczalt.liczby,
    );
    if (!aplikacja.ok) throw new Error(aplikacja.brak);
    const wyrocznia = ryczaltWyrocznia({ przychodWgStawek: przychod, ujemneZPoprzednich: [], spoleczneZaplaconeGr: 1, zdrowotnaZaplaconaGr: 0, nadwyzkaZPoprzednichGr: 0, odliczenieZdrowotnejPb: 5000 });
    expect([...aplikacja.ryczalt.podstawaWgStawekGr.entries()].sort((a, b) => b[0] - a[0])).toEqual([[1200, 100_000], [850, 100_100]]);
    expect(wyrocznia.podstawaWgStawek).toEqual([[1200, 100_000], [850, 100_100]]);
  });

  it('ryczałt, odliczenia, podstawy i ujemne na kolejne miesiące', () => {
    fc.assert(
      fc.property(wejscie, (d) => {
        const aplikacja = ryczaltMiesiaca(
          {
            przychodWgStawekGr: new Map(d.przychod),
            ujemneZPoprzednichGr: new Map(d.ujemne),
            spoleczneZaplaconeGr: d.spoleczne,
            zdrowotnaZaplaconaGr: d.zdrowotna,
            nadwyzkaZPoprzednichGr: d.nadwyzka,
          },
          P.ryczalt.liczby,
        );
        if (!aplikacja.ok) throw new Error(aplikacja.brak);
        const wyrocznia = ryczaltWyrocznia({
          przychodWgStawek: d.przychod,
          ujemneZPoprzednich: d.ujemne,
          spoleczneZaplaconeGr: d.spoleczne,
          zdrowotnaZaplaconaGr: d.zdrowotna,
          nadwyzkaZPoprzednichGr: d.nadwyzka,
          odliczenieZdrowotnejPb: w(P.ryczalt.liczby.odliczenieZdrowotnej),
        });
        const r = aplikacja.ryczalt;
        const posortuj = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[0] - a[0]);
        expect({
          ryczalt: r.ryczaltGr,
          odliczono: r.odliczenia.odliczonoGr,
          nadwyzka: r.odliczenia.nadwyzkaNaKolejneGr,
          podstawy: posortuj(r.podstawaWgStawekGr),
          ujemne: posortuj(r.ujemneNaKolejneGr),
        }).toEqual({
          ryczalt: wyrocznia.ryczaltGr,
          odliczono: wyrocznia.odliczonoGr,
          nadwyzka: wyrocznia.nadwyzkaNaKolejneGr,
          podstawy: wyrocznia.podstawaWgStawek,
          ujemne: wyrocznia.ujemneNaKolejne,
        });
      }),
      opcje(),
    );
  });
});
