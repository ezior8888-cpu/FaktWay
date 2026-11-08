import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { doZlotych, procent } from '@/lib/ksiegowosc/pit';
import { doPelnychZlotych } from '@/lib/ksiegowosc/ryczalt';
import { procentGr } from '@/lib/ksiegowosc/zus';

import { grosze, groszeZeZnakiem } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * Niezmienniki zaokrągleń (plan filtra B4.2, NZ-ZAOKR; rejestr RP-ZAOKR-01, RP-ZAOKR-02).
 * Art. 63 § 1 Ordynacji podatkowej: końcówki poniżej 50 gr pomija się,
 * 50 gr i więcej podwyższa do pełnego złotego.
 */
describe('NZ-ZAOKR-01: podstawa i podatek w pełnych złotych, od 50 gr w górę', () => {
  it.each([
    ['doZlotych (pit.ts)', doZlotych],
    ['doPelnychZlotych (ryczalt.ts)', doPelnychZlotych],
  ])('%s', (_nazwa, zaokraglij) => {
    fc.assert(
      fc.property(grosze(), (gr) => {
        const wynik = zaokraglij(gr);
        expect(wynik % 100).toBe(0);
        const koncowka = gr % 100;
        expect(wynik).toBe(koncowka >= 50 ? gr - koncowka + 100 : gr - koncowka);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZAOKR-05: zaokrąglenie zaokrąglonej kwoty nic nie zmienia', () => {
  it('doZlotych i doPelnychZlotych są idempotentne', () => {
    fc.assert(
      fc.property(groszeZeZnakiem(), (gr) => {
        // `===`, bo doZlotych(-1) daje -0 (bez znaczenia dla kwot: zaliczka idzie przez Math.max(0, …)).
        expect(doZlotych(doZlotych(gr)) === doZlotych(gr)).toBe(true);
        expect(doPelnychZlotych(doPelnychZlotych(gr)) === doPelnychZlotych(gr)).toBe(true);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZAOKR-04: jedna reguła, ta sama kwota zaokrągla się tak samo w każdym silniku', () => {
  it('kwoty nieujemne: obie funkcje dają ten sam wynik', () => {
    fc.assert(
      fc.property(grosze(), (gr) => {
        expect(doPelnychZlotych(gr)).toBe(doZlotych(gr));
      }),
      opcje(),
    );
  });

  // FZ-001 (docs/filtr/USTALENIA.md): dla kwot ujemnych z końcówką dokładnie 50 gr
  // doPelnychZlotych zaokrągla w stronę plus nieskończoności (-1,50 zł → -1 zł),
  // a doZlotych od zera (-1,50 zł → -2 zł). Dziś ryczałt nie dostaje ujemnej podstawy, więc klient
  // tego nie widzi; test zostaje czerwony do jednej wspólnej funkcji.
  it('kwoty ujemne poza końcówką 50 gr: ten sam wynik', () => {
    fc.assert(
      fc.property(groszeZeZnakiem().filter((gr) => Math.abs(gr) % 100 !== 50), (gr) => {
        expect(doPelnychZlotych(gr) === doZlotych(gr)).toBe(true);
      }),
      opcje(),
    );
  });

  it.fails('FZ-001: kwoty ujemne z końcówką 50 gr zaokrąglają się tak samo', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }).map((n) => -(n * 100 + 50)), (gr) => {
        expect(doPelnychZlotych(gr) === doZlotych(gr)).toBe(true);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZAOKR-02: składki w groszach (procent od kwoty do grosza)', () => {
  const stawka = fc.integer({ min: 0, max: 10_000 });
  it('procentGr (zus.ts) i procent (pit.ts) dają grosze całkowite i ten sam wynik dla kwot nieujemnych', () => {
    fc.assert(
      fc.property(grosze(), stawka, (gr, pb) => {
        const a = procentGr(gr, pb);
        expect(Number.isInteger(a)).toBe(true);
        expect(a).toBe(procent(gr, pb));
        // Różnica od dokładnego iloczynu najwyżej pół grosza.
        expect(Math.abs(a * 10_000 - gr * pb)).toBeLessThanOrEqual(5_000);
      }),
      opcje(),
    );
  });
});
