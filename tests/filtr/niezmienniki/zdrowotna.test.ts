import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { zdrowotnaOdDochodu, zdrowotnaRyczaltu } from '@/lib/ksiegowosc/zdrowotna';

import { grosze, groszeZeZnakiem } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/** Niezmienniki składki zdrowotnej (plan filtra B4.2, NZ-ZDR; rejestr RP-ZDR-*). */
const ZDR = parametryRoku(2026)!.zdrowotna.liczby;

/** Składka zdrowotna ryczałtu w groszach dla przychodu od początku roku. */
function kwota(przychodGr: number): number {
  const w = zdrowotnaRyczaltu(przychodGr, ZDR);
  if (!w.ok) throw new Error(w.brak);
  return w.zdrowotna.skladkaGr;
}

describe('NZ-ZDR-02: ryczałt, więcej przychodu narastająco nigdy nie daje niższej składki', () => {
  it('monotoniczność', () => {
    fc.assert(
      fc.property(grosze(600_000), grosze(600_000), (a, b) => {
        expect(kwota(Math.max(a, b))).toBeGreaterThanOrEqual(kwota(Math.min(a, b)));
      }),
      opcje(),
    );
  });
});

describe('NZ-ZDR-01: progi 60 i 300 tys. zł włącznie', () => {
  it('na progu niższa kwota, grosz ponad progiem wyższa', () => {
    const p60 = ZDR.progRyczaltu60Tys.wartosc as number;
    const p300 = ZDR.progRyczaltu300Tys.wartosc as number;
    expect(kwota(p60)).toBe(ZDR.ryczaltDo60Tys.wartosc);
    expect(kwota(p60 + 1)).toBe(ZDR.ryczaltDo300Tys.wartosc);
    expect(kwota(p300)).toBe(ZDR.ryczaltDo300Tys.wartosc);
    expect(kwota(p300 + 1)).toBe(ZDR.ryczaltPonad300Tys.wartosc);
  });
});

describe('NZ-ZDR-03: skala i liniowy, nigdy mniej niż minimum roku składkowego; strata daje minimum', () => {
  it.each(['skala', 'liniowy'] as const)('%s', (forma) => {
    fc.assert(
      fc.property(groszeZeZnakiem(200_000), (dochod) => {
        const w = zdrowotnaOdDochodu(forma, dochod, ZDR);
        if (!w.ok) throw new Error(w.brak);
        expect(w.zdrowotna.skladkaGr).toBeGreaterThanOrEqual(ZDR.minimalna.wartosc as number);
        expect(Number.isSafeInteger(w.zdrowotna.skladkaGr)).toBe(true);
        if (dochod <= 0) expect(w.zdrowotna.skladkaGr).toBe(ZDR.minimalna.wartosc);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZDR-05: dodanie kosztu w poprzednim miesiącu nigdy nie podnosi składki', () => {
  it.each(['skala', 'liniowy'] as const)('%s: składka niemalejąca od dochodu', (forma) => {
    fc.assert(
      fc.property(groszeZeZnakiem(200_000), grosze(50_000), (dochod, koszt) => {
        const a = zdrowotnaOdDochodu(forma, dochod, ZDR);
        const b = zdrowotnaOdDochodu(forma, dochod - koszt, ZDR);
        if (!a.ok || !b.ok) throw new Error('oczekiwana składka');
        expect(b.zdrowotna.skladkaGr).toBeLessThanOrEqual(a.zdrowotna.skladkaGr);
      }),
      opcje(),
    );
  });
});

describe('NZ-WSP-03: brak to nie zero', () => {
  it('bez minimalnej na rok składkowy: brak z treścią', () => {
    const bez = { ...ZDR, minimalna: { ...ZDR.minimalna, wartosc: null } };
    fc.assert(
      fc.property(groszeZeZnakiem(), (dochod) => {
        const w = zdrowotnaOdDochodu('skala', dochod, bez);
        expect(w.ok).toBe(false);
        if (!w.ok) expect(w.brak).toMatch(/nie są jeszcze ogłoszone/);
      }),
      opcje(),
    );
  });
});
