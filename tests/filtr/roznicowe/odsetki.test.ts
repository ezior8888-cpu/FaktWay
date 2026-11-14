import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { calculateInterest, INTEREST_RATES, RATES_VERIFIED, type InterestKind } from '@/lib/flo/interest';
import { recoveryCompensationEur } from '@/lib/reminders/pdf-demand-letter';

import { opcje } from '../generatory/ustawienia';
import * as wyrocznia from '../wyrocznia/odsetki';

/**
 * Test różnicowy odsetek za opóźnienie i rekompensaty (żelazny filtr F10,
 * część 4). Wyrocznia `tests/filtr/wyrocznia/odsetki.ts` powstała w czystym
 * pokoju: podagent Claude Sonnet w katalogu bez repozytorium, tylko
 * z `SPEC-odsetki.md` (art. 481 § 2 KC; ustawa o przeciwdziałaniu nadmiernym
 * opóźnieniom w transakcjach handlowych, art. 4 pkt 3 lit. a, art. 7, art. 10 ust. 1).
 *
 * - Rekompensata (wezwania do zapłaty, `lib/reminders/pdf-demand-letter.ts`):
 *   granice 5 000 i 50 000 zł i losowe kwoty.
 * - Odsetki (`lib/flo/interest.ts`, FLO, niewdrożony; `RATES_VERIFIED`):
 *   mechanika podokresów i dni kontra suma dzienna wyroczni na tej samej
 *   tabeli stawek; tolerancja 0,5 gr na podokres (kod zaokrągla podokresy).
 * - Straże tabeli stawek: „sprawdzone” tylko ze źródłem przy każdej pozycji;
 *   każda sprawdzona pozycja z 1.01 albo 1.07 spełnia niezmiennik z SPEC
 *   (handlowe − ustawowe = 4,5 pp). Stawki są dziś placeholderami bez źródeł
 *   i niezmiennika nie spełniają (4,0 pp), co jest stanem znanym i zablokowanym.
 */

const NA_GROSZE = 100;
const tabela = (rodzaj: InterestKind) =>
  INTEREST_RATES.map((s) => ({ od: s.validFrom, stawka: rodzaj === 'commercial' ? s.commercial : s.statutoryLate }));
const PIERWSZA = INTEREST_RATES[0]!.validFrom;
const DOBA = 86_400_000;
const dzien = (n: number) => new Date(n * DOBA).toISOString().slice(0, 10);
const numer = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DOBA);

describe('Rekompensata za koszty odzyskiwania należności = wyrocznia (art. 10 ust. 1)', () => {
  it.each([1, 499_999, 500_000, 500_001, 4_999_999, 5_000_000, 5_000_001, 100_000_000])('granica: %i gr', (gr) => {
    expect(recoveryCompensationEur(gr / NA_GROSZE)).toBe(wyrocznia.rekompensataEur(gr));
  });

  it('losowe kwoty do 10 mln zł', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (gr) => {
        expect(recoveryCompensationEur(gr / NA_GROSZE)).toBe(wyrocznia.rekompensataEur(gr));
      }),
      opcje(),
    );
  });
});

describe('Odsetki: mechanika = wyrocznia na tej samej tabeli stawek', () => {
  const zakres = { min: numer(PIERWSZA), max: numer('2028-12-31') };

  it('losowe kwoty i okresy od pierwszej pozycji tabeli, oba rodzaje odsetek', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer(zakres),
        fc.integer({ min: 0, max: 1500 }),
        fc.constantFrom<InterestKind>('statutory_late', 'commercial'),
        (gr, start, dlugosc, rodzaj) => {
          const od = dzien(start);
          const doDnia = dzien(start + dlugosc);
          const kod = calculateInterest({ principal: gr / NA_GROSZE, from: od, to: doDnia, kind: rodzaj });
          const wzor = wyrocznia.odsetkiDokladne(gr, od, doDnia, tabela(rodzaj));
          expect(kod.periods.reduce((s, p) => s + p.days, 0)).toBe(wzor.dni);
          const tolerancjaGr = 0.5 * Math.max(1, kod.periods.length) + 1e-6;
          expect(Math.abs(kod.total * NA_GROSZE - wzor.groszeDokladne)).toBeLessThanOrEqual(tolerancjaGr);
        },
      ),
      opcje(),
    );
  });

  it.fails('FZ-004: przed pierwszą pozycją tabeli stawek nie ma odsetek (kod bierze pierwszą stawkę)', () => {
    const od = dzien(numer(PIERWSZA) - 30);
    const kod = calculateInterest({ principal: 1000, from: od, to: PIERWSZA, kind: 'statutory_late' });
    const wzor = wyrocznia.odsetkiDokladne(100_000, od, PIERWSZA, tabela('statutory_late'));
    expect(kod.total * NA_GROSZE).toBeCloseTo(wzor.groszeDokladne, 6);
  });
});

describe('Tabela stawek: straże przed włączeniem odsetek', () => {
  it('„sprawdzone” tylko ze źródłem przy każdej pozycji', () => {
    if (RATES_VERIFIED) expect(INTEREST_RATES.filter((s) => !s.source.trim()).map((s) => s.validFrom)).toEqual([]);
  });

  it('sprawdzona pozycja z 1.01 albo 1.07: handlowe − ustawowe = 4,5 pp (niezmiennik z SPEC)', () => {
    const zle = INTEREST_RATES.filter((s) => s.source.trim() && /-(01|07)-01$/.test(s.validFrom))
      .filter((s) => Math.round((s.commercial - s.statutoryLate) * 10_000) !== Math.round(wyrocznia.ROZNICA_HANDLOWA_USTAWOWA * 10_000))
      .map((s) => s.validFrom);
    expect(zle).toEqual([]);
  });
});
