import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { doZlotych, zaliczkiPit, type FormaPit, type MiesiacPit } from '@/lib/ksiegowosc/pit';

import { grosze } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * Niezmienniki zaliczek PIT, skala i liniowy (plan filtra B4.2, NZ-PIT;
 * rejestr RP-SKALA-01, RP-ZALICZKA-PIT-01, RP-LIN-01). Art. 44 ust. 3f
 * ustawy o PIT: zaliczka to podatek od początku roku minus zaliczki
 * należne za wcześniejsze miesiące.
 */
const P = parametryRoku(2026)!;
const LICZBY = { skala: P.skala.liczby, liniowy: P.liniowy.liczby };
const forma = fc.constantFrom('skala', 'liniowy') as fc.Arbitrary<FormaPit>;

const miesiacPit = fc.record({
  przychodGr: grosze(80_000),
  kosztyGr: grosze(60_000),
  spoleczneZaplaconeGr: grosze(2_500),
  zdrowotnaZaplaconaGr: grosze(2_000),
});
const rok = fc
  .array(miesiacPit, { minLength: 1, maxLength: 12 })
  .map((ms) => ms.map((m, i) => ({ ...m, miesiac: `2026-${String(i + 1).padStart(2, '0')}` }) satisfies MiesiacPit));

function licz(f: FormaPit, ms: readonly MiesiacPit[]) {
  const w = zaliczkiPit(f, ms, LICZBY);
  if (!w.ok) throw new Error(w.brak);
  return w.miesiace;
}

describe('NZ-PIT-01: zaliczka nieujemna; suma zaliczek to najwyższy podatek od początku roku', () => {
  it('Σ zaliczek do miesiąca = max po wcześniejszych miesiącach z podatku narastająco w pełnych złotych', () => {
    fc.assert(
      fc.property(forma, rok, (f, ms) => {
        let suma = 0;
        let najwyzszy = 0;
        for (const m of licz(f, ms)) {
          expect(m.zaliczkaGr).toBeGreaterThanOrEqual(0);
          suma += m.zaliczkaGr;
          najwyzszy = Math.max(najwyzszy, doZlotych(m.podatekNarastajacoGr));
          expect(suma).toBe(najwyzszy);
        }
      }),
      opcje(),
    );
  });
});

describe('NZ-PIT-02: dodanie kosztu nigdy nie podnosi zaliczek do zapłaty od początku roku', () => {
  // Doprecyzowanie z F5: zaliczka jednego późniejszego miesiąca może po dodaniu
  // kosztu wzrosnąć (wcześniej zapłacono mniej), ale suma zaliczek do każdego
  // miesiąca nie rośnie. Tak brzmi niezmiennik w planie filtra (B4.2) po F5.
  it('suma zaliczek do każdego miesiąca nie rośnie', () => {
    fc.assert(
      fc.property(forma, rok, fc.nat(11), grosze(20_000), (f, ms, ktory, koszt) => {
        const i = ktory % ms.length;
        const zKosztem = ms.map((m, j) => (j === i ? { ...m, kosztyGr: m.kosztyGr + koszt } : m));
        const a = licz(f, ms);
        const b = licz(f, zKosztem);
        let sa = 0;
        let sb = 0;
        for (let j = 0; j < a.length; j++) {
          sa += a[j].zaliczkaGr;
          sb += b[j].zaliczkaGr;
          expect(sb).toBeLessThanOrEqual(sa);
        }
      }),
      opcje(),
    );
  });
});

describe('NZ-PIT-03: dodanie przychodu nigdy nie obniża podatku od początku roku', () => {
  it('podatek narastająco niemalejący od przychodu', () => {
    fc.assert(
      fc.property(forma, rok, fc.nat(11), grosze(20_000), (f, ms, ktory, dodatek) => {
        const i = ktory % ms.length;
        const wiecej = ms.map((m, j) => (j === i ? { ...m, przychodGr: m.przychodGr + dodatek } : m));
        const a = licz(f, ms);
        const b = licz(f, wiecej);
        for (let j = 0; j < a.length; j++) expect(b[j].podatekNarastajacoGr).toBeGreaterThanOrEqual(a[j].podatekNarastajacoGr);
      }),
      opcje(),
    );
  });
});

describe('NZ-PIT-04: skala, kwota wolna i ciągłość na progu 120 000 zł', () => {
  const jedenMiesiac = (dochodGr: number) =>
    licz('skala', [{ miesiac: '2026-01', przychodGr: dochodGr, kosztyGr: 0, spoleczneZaplaconeGr: 0, zdrowotnaZaplaconaGr: 0 }])[0];

  it('dochód do 30 000 zł daje zero podatku', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3_000_000 - 50 }), (gr) => {
        expect(jedenMiesiac(gr).podatekNarastajacoGr).toBe(0);
      }),
      opcje(),
    );
  });

  it('wokół progu 120 000 zł złotówka więcej dochodu to najwyżej 33 gr więcej podatku', () => {
    const prog = P.skala.liczby.prog.wartosc as number;
    fc.assert(
      fc.property(fc.integer({ min: prog - 50_000, max: prog + 50_000 }), (gr) => {
        const roznica = jedenMiesiac(gr + 100).podatekNarastajacoGr - jedenMiesiac(gr).podatekNarastajacoGr;
        expect(roznica).toBeGreaterThanOrEqual(0);
        expect(roznica).toBeLessThanOrEqual(33);
      }),
      opcje(),
    );
  });
});

describe('NZ-PIT-05: liniowy, odliczenie zdrowotnej nie przekracza limitu rocznego', () => {
  it('zdrowotna narastająco ≤ limit', () => {
    const limit = P.liniowy.liczby.limitOdliczeniaZdrowotnej.wartosc as number;
    fc.assert(
      fc.property(rok, (ms) => {
        for (const m of licz('liniowy', ms.map((x) => ({ ...x, zdrowotnaZaplaconaGr: x.zdrowotnaZaplaconaGr * 10 })))) {
          expect(m.zdrowotnaNarastajacoGr).toBeLessThanOrEqual(limit);
        }
      }),
      opcje(),
    );
  });
});

describe('NZ-PIT-06 i NZ-PIT-07: pełne złote i strata miesiąca', () => {
  it('podstawa i zaliczka w pełnych złotych; dochód od początku roku to przychód minus koszty', () => {
    fc.assert(
      fc.property(forma, rok, (f, ms) => {
        let przychod = 0;
        let koszty = 0;
        licz(f, ms).forEach((m, j) => {
          przychod += ms[j].przychodGr;
          koszty += ms[j].kosztyGr;
          expect(m.podstawaNarastajacoGr % 100).toBe(0);
          expect(m.zaliczkaGr % 100).toBe(0);
          expect(m.dochodNarastajacoGr).toBe(przychod - koszty);
          expect(m.spoleczneNarastajacoGr).toBeLessThanOrEqual(Math.max(0, m.dochodNarastajacoGr));
        });
      }),
      opcje(),
    );
  });
});

describe('NZ-WSP-03: brak parametru to brak, nie zero', () => {
  it('bez kwoty zmniejszającej skala nie liczy', () => {
    const bez = { ...LICZBY, skala: { ...LICZBY.skala, kwotaZmniejszajaca: { ...LICZBY.skala.kwotaZmniejszajaca, wartosc: null } } };
    expect(zaliczkiPit('skala', [{ miesiac: '2026-01', przychodGr: 100, kosztyGr: 0, spoleczneZaplaconeGr: 0, zdrowotnaZaplaconaGr: 0 }], bez).ok).toBe(false);
  });
});
