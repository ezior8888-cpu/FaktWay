import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { rozdzielProporcjonalnie, ryczaltMiesiaca, type WejscieRyczaltu } from '@/lib/ksiegowosc/ryczalt';

import { grosze, stawkaRyczaltu } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * Niezmienniki ryczałtu (plan filtra B4.2, NZ-RYCZ i NZ-WSP; rejestr RP-RYCZ-*,
 * RP-KOR-02). Silnik czysty, parametry 2026 podane wprost.
 */
const LICZBY = parametryRoku(2026)!.ryczalt.liczby;

const przychody = fc
  .uniqueArray(fc.tuple(stawkaRyczaltu, grosze(400_000)), { selector: ([pb]) => pb, minLength: 0, maxLength: 4 })
  .map((pary) => new Map(pary));

const wejscie = fc.record({
  przychodWgStawekGr: przychody,
  spoleczneZaplaconeGr: grosze(5_000),
  zdrowotnaZaplaconaGr: grosze(3_000),
  nadwyzkaZPoprzednichGr: grosze(20_000),
});

function licz(w: WejscieRyczaltu) {
  const wynik = ryczaltMiesiaca(w, LICZBY);
  if (!wynik.ok) throw new Error(wynik.brak);
  return wynik.ryczalt;
}

describe('ryczałt: wspólne (NZ-WSP-01, NZ-WSP-04)', () => {
  it('te same wejścia dają ten sam wynik; kwoty to grosze całkowite', () => {
    fc.assert(
      fc.property(wejscie, (w) => {
        const a = licz(w);
        expect(licz(w)).toEqual(a);
        for (const kwota of [a.ryczaltGr, a.odliczenia.odliczonoGr, a.odliczenia.nadwyzkaNaKolejneGr, ...a.podstawaWgStawekGr.values()]) {
          expect(Number.isSafeInteger(kwota)).toBe(true);
        }
      }),
      opcje(),
    );
  });
});

describe('NZ-RYCZ-01: ryczałt nie jest ujemny, a zerowy przychód bez odliczeń daje zero', () => {
  it('ryczałt ≥ 0 i w pełnych złotych; podstawy w pełnych złotych', () => {
    fc.assert(
      fc.property(wejscie, (w) => {
        const r = licz(w);
        expect(r.ryczaltGr).toBeGreaterThanOrEqual(0);
        expect(r.ryczaltGr % 100).toBe(0);
        for (const podstawa of r.podstawaWgStawekGr.values()) expect(podstawa % 100).toBe(0);
      }),
      opcje(),
    );
    expect(licz({ przychodWgStawekGr: new Map(), spoleczneZaplaconeGr: 0, zdrowotnaZaplaconaGr: 0, nadwyzkaZPoprzednichGr: 0 }).ryczaltGr).toBe(0);
  });
});

describe('NZ-RYCZ-02: więcej przychodu nigdy nie daje mniej ryczałtu', () => {
  it('dopisanie przychodu w jednej stawce przy tych samych odliczeniach', () => {
    fc.assert(
      fc.property(wejscie, stawkaRyczaltu, grosze(100_000), (w, pb, dodatek) => {
        const wiecej = new Map(w.przychodWgStawekGr);
        wiecej.set(pb, (wiecej.get(pb) ?? 0) + dodatek);
        expect(licz({ ...w, przychodWgStawekGr: wiecej }).ryczaltGr).toBeGreaterThanOrEqual(licz(w).ryczaltGr);
      }),
      opcje(),
    );
  });
});

describe('NZ-RYCZ-03: więcej zapłaconych składek nigdy nie daje więcej ryczałtu', () => {
  it('składki społeczne, zdrowotna i nadwyżka z poprzednich miesięcy', () => {
    fc.assert(
      fc.property(wejscie, grosze(5_000), fc.constantFrom('spoleczneZaplaconeGr', 'zdrowotnaZaplaconaGr', 'nadwyzkaZPoprzednichGr'), (w, dodatek, pole) => {
        const wiecej = { ...w, [pole]: w[pole as keyof typeof w] as number + dodatek };
        expect(licz(wiecej).ryczaltGr).toBeLessThanOrEqual(licz(w).ryczaltGr);
      }),
      opcje(),
    );
  });
});

describe('NZ-RYCZ-05: odliczenia rozdzielone proporcjonalnie sumują się do całości bez zgubionego grosza', () => {
  it('rozdzielProporcjonalnie', () => {
    fc.assert(
      fc.property(grosze(100_000), przychody, (kwota, wagi) => {
        const sumaWag = [...wagi.values()].reduce((a, b) => a + b, 0);
        const czesci = rozdzielProporcjonalnie(kwota, wagi);
        const suma = [...czesci.values()].reduce((a, b) => a + b, 0);
        expect([...czesci.keys()].sort()).toEqual([...wagi.keys()].sort());
        expect(suma).toBe(sumaWag === 0 ? 0 : kwota);
        for (const [pb, czesc] of czesci) {
          expect(Number.isInteger(czesc) && czesc >= 0).toBe(true);
          // Każda część różni się od dokładnej proporcji mniej niż o grosz.
          if (sumaWag > 0) expect(Math.abs(czesc - (kwota * (wagi.get(pb) ?? 0)) / sumaWag)).toBeLessThan(1 + 1e-9);
        }
      }),
      opcje(),
    );
  });
});

describe('NZ-RYCZ-06: niewykorzystane odliczenie przechodzi na kolejne miesiące', () => {
  it('odliczono + nadwyżka = dostępne; odliczono nie przekracza przychodu', () => {
    fc.assert(
      fc.property(wejscie, (w) => {
        const r = licz(w);
        const przychod = [...r.przychodWgStawekGr.values()].reduce((a, b) => a + b, 0);
        const dostepne = w.nadwyzkaZPoprzednichGr + w.spoleczneZaplaconeGr + r.odliczenia.zdrowotna50ProcGr;
        expect(r.odliczenia.odliczonoGr + r.odliczenia.nadwyzkaNaKolejneGr).toBe(dostepne);
        expect(r.odliczenia.odliczonoGr).toBe(Math.min(dostepne, przychod));
        expect(r.odliczenia.nadwyzkaNaKolejneGr).toBeGreaterThanOrEqual(0);
      }),
      opcje(),
    );
  });
});

describe('NZ-RYCZ-09: korekta większa niż przychód przechodzi na kolejne miesiące tej samej stawki', () => {
  it('ujemny przychód stawki daje zero ryczałtu z tej stawki i trafia do ujemnych na kolejne', () => {
    fc.assert(
      fc.property(stawkaRyczaltu, fc.integer({ min: 1, max: 1_000_000 }), (pb, minus) => {
        const r = licz({ przychodWgStawekGr: new Map([[pb, -minus]]), spoleczneZaplaconeGr: 0, zdrowotnaZaplaconaGr: 0, nadwyzkaZPoprzednichGr: 0 });
        expect(r.ryczaltGr).toBe(0);
        expect(r.ujemneNaKolejneGr.get(pb)).toBe(-minus);
      }),
      opcje(),
    );
  });

  it('ujemne z poprzednich miesięcy zmniejszają przychód tej stawki, nie innej', () => {
    fc.assert(
      fc.property(grosze(100_000), grosze(100_000), (plus, minus) => {
        const r = licz({
          przychodWgStawekGr: new Map([[1200, plus], [850, 100_000]]),
          ujemneZPoprzednichGr: new Map([[1200, -minus]]),
          spoleczneZaplaconeGr: 0,
          zdrowotnaZaplaconaGr: 0,
          nadwyzkaZPoprzednichGr: 0,
        });
        expect(r.przychodWgStawekGr.get(850)).toBe(100_000);
        const reszta = plus - minus;
        if (reszta > 0) expect(r.przychodWgStawekGr.get(1200)).toBe(reszta);
        if (reszta < 0) expect(r.ujemneNaKolejneGr.get(1200)).toBe(reszta);
      }),
      opcje(),
    );
  });
});

describe('NZ-RYCZ-04 i NZ-RYCZ-08', () => {
  it.todo('NZ-RYCZ-04: koszty nie zmieniają ryczałtu (wejście silnika nie ma kosztów; test na ewidencji w F6)');
  it.todo('NZ-RYCZ-08: podział faktury na dwie o tej samej sumie i stawce nie zmienia ryczałtu (test na ewidencji w F6)');
});

describe('NZ-RYCZ-02: kontrprzykład z nocnego przebiegu (FZ-007, #649, ziarno 924139385)', () => {
  // Przychód w czterech stawkach, odliczenia mniejsze od przychodu. Dopisanie 0,17 zł
  // w nowej stawce 10 % przestawiało grosze z podziału odliczeń między stawkami,
  // a zaokrąglenie podstawy do złotych robiło z grosza 1 zł mniej ryczałtu.
  const w: WejscieRyczaltu = {
    przychodWgStawekGr: new Map([[1700, 4_760_460], [300, 38_104_683], [1200, 25_780_476], [850, 22_650_664]]),
    spoleczneZaplaconeGr: 175_576,
    zdrowotnaZaplaconaGr: 134_613,
    nadwyzkaZPoprzednichGr: 1_274_300,
  };

  it('0,17 zł przychodu w nowej stawce 10 % nie obniża ryczałtu', () => {
    const wiecej = new Map(w.przychodWgStawekGr).set(1000, 17);
    expect(licz({ ...w, przychodWgStawekGr: wiecej }).ryczaltGr).toBeGreaterThanOrEqual(licz(w).ryczaltGr);
  });

  it('żaden grosz od 1 do 200 w nowej albo istniejącej stawce nie obniża ryczałtu ani żadnej podstawy', () => {
    const przed = licz(w);
    const zle: string[] = [];
    for (const pb of [1700, 1500, 1400, 1200, 1000, 850, 550, 300]) {
      for (let dodatek = 1; dodatek <= 200 && zle.length < 10; dodatek++) {
        const wiecej = new Map(w.przychodWgStawekGr);
        wiecej.set(pb, (wiecej.get(pb) ?? 0) + dodatek);
        const po = licz({ ...w, przychodWgStawekGr: wiecej });
        if (po.ryczaltGr < przed.ryczaltGr) zle.push(`${pb} +${dodatek} gr: ryczałt ${po.ryczaltGr} < ${przed.ryczaltGr}`);
        for (const [stawka, podstawa] of przed.podstawaWgStawekGr) {
          if ((po.podstawaWgStawekGr.get(stawka) ?? 0) < podstawa) zle.push(`${pb} +${dodatek} gr: podstawa ${stawka} spada`);
        }
      }
    }
    expect(zle).toEqual([]);
  });
});
