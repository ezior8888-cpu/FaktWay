import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { zaliczkiPit, type FormaPit, type MiesiacPit } from '@/lib/ksiegowosc/pit';

import { grosze } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';
import { zaliczkiWyrocznia, type ParametryPit } from '../wyrocznia/pit';

/**
 * Test różnicowy (żelazny filtr F6, plan B4.4): silnik aplikacji
 * (`lib/ksiegowosc/pit.ts`) i wyrocznia napisana w „czystym pokoju”
 * (`tests/filtr/wyrocznia/pit.ts`: inna sesja i inny model, tylko z przepisów,
 * BigInt w groszach, bez wglądu w kod aplikacji) muszą dać te same zaliczki,
 * podstawy i podatek dla każdego roku. Każda różnica to znalezisko (FZ).
 */
const P = parametryRoku(2026)!;
const wartosc = (l: { wartosc: number | null }) => l.wartosc as number;
const PARAMETRY: ParametryPit = {
  skalaStawka1Pb: wartosc(P.skala.liczby.stawkaDoProgu),
  skalaStawka2Pb: wartosc(P.skala.liczby.stawkaPonadProg),
  skalaProgGr: wartosc(P.skala.liczby.prog),
  kwotaZmniejszajacaGr: wartosc(P.skala.liczby.kwotaZmniejszajaca),
  liniowyStawkaPb: wartosc(P.liniowy.liczby.stawka),
  limitZdrowotnejGr: wartosc(P.liniowy.liczby.limitOdliczeniaZdrowotnej),
};

const miesiac = fc.record({
  przychodGr: grosze(120_000),
  kosztyGr: grosze(90_000),
  spoleczneZaplaconeGr: grosze(3_000),
  zdrowotnaZaplaconaGr: grosze(4_000),
});
const rok = fc
  .array(miesiac, { minLength: 1, maxLength: 12 })
  .map((ms) => ms.map((m, i) => ({ ...m, miesiac: `2026-${String(i + 1).padStart(2, '0')}` }) satisfies MiesiacPit));
const forma = fc.constantFrom('skala', 'liniowy') as fc.Arbitrary<FormaPit>;

describe('wyrocznia PIT: aplikacja i czysty pokój dają te same zaliczki', () => {
  it('parametry 2026 są ogłoszone (wyrocznia dostaje te same liczby)', () => {
    for (const v of Object.values(PARAMETRY)) expect(Number.isInteger(v)).toBe(true);
  });

  it('każdy miesiąc roku: zaliczka, podstawa i podatek od początku roku', () => {
    fc.assert(
      fc.property(forma, rok, (f, ms) => {
        const aplikacja = zaliczkiPit(f, ms, { skala: P.skala.liczby, liniowy: P.liniowy.liczby });
        if (!aplikacja.ok) throw new Error(aplikacja.brak);
        const wyrocznia = zaliczkiWyrocznia(f, ms, PARAMETRY);
        expect(wyrocznia).toHaveLength(ms.length);
        aplikacja.miesiace.forEach((m, i) => {
          const w = wyrocznia[i];
          expect({ miesiac: m.miesiac, podstawa: m.podstawaNarastajacoGr, podatek: m.podatekNarastajacoGr, zaliczka: m.zaliczkaGr }).toEqual({
            miesiac: m.miesiac,
            podstawa: w.podstawaNarastajacoGr,
            podatek: w.podatekNarastajacoGr,
            zaliczka: w.zaliczkaGr,
          });
        });
      }),
      opcje(),
    );
  });
});
