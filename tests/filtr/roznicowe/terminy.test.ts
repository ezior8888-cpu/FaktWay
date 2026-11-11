import { describe, expect, it } from 'vitest';

import {
  czyDzienRoboczy,
  dniWolne,
  najblizszyDzienRoboczy,
  terminDla,
  wielkanoc,
  type RodzajTerminu,
} from '@/lib/ksiegowosc/kalendarz';

import * as wyrocznia from '../wyrocznia/terminy';

/**
 * Test różnicowy terminów i dni wolnych (żelazny filtr F6, plan B4.7).
 * Wyrocznia `tests/filtr/wyrocznia/terminy.ts` powstała w czystym pokoju:
 * osobny podagent (model Claude Sonnet) w katalogu bez repozytorium, tylko
 * z `SPEC-terminy.md` (ustawa o dniach wolnych od pracy, art. 12 § 5
 * Ordynacji podatkowej, art. 44 ust. 6 ustawy o PIT, art. 21 ust. 1 ustawy
 * o ryczałcie, art. 47 ust. 1 pkt 1 ustawy o systemie ubezpieczeń
 * społecznych, art. 99 ust. 1 i art. 109 ust. 3b ustawy o VAT).
 *
 * Porównanie jest pełne, nie losowe: każdy rok, każdy dzień i każdy okres
 * w zakresie (RP-TERM-01, RP-TERM-02; NZ-TERM-01).
 */
const RODZAJE: readonly RodzajTerminu[] = ['ryczalt', 'zaliczkaPit', 'zus', 'vatJpk'];
const DOBA = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('Terminy i dni wolne: aplikacja = wyrocznia z przepisów (F6)', () => {
  it('niedziela wielkanocna w latach 1990-2100', () => {
    for (let rok = 1990; rok <= 2100; rok++) {
      expect(iso(wielkanoc(rok)), String(rok)).toBe(wyrocznia.wielkanoc(rok));
    }
  });

  // Od 2011, bo 6 stycznia jest dniem wolnym dopiero od 2011 r., a ani SPEC, ani
  // aplikacja nie znają tej granicy (wątpliwość wyroczni; dla terminów od 2026
  // bez znaczenia). Porównanie wcześniejszych lat potwierdzałoby wspólny błąd.
  it('święta ustawowe w latach 2011-2100 (Wigilia od 2025)', () => {
    for (let rok = 2011; rok <= 2100; rok++) {
      expect([...dniWolne(rok)].sort(), String(rok)).toEqual(wyrocznia.swietaUstawowe(rok));
    }
  });

  it('każdy dzień 2011-2060: czy może upłynąć termin i dokąd się przesuwa', () => {
    const od = Date.UTC(2011, 0, 1);
    const doDnia = Date.UTC(2060, 11, 31);
    let dni = 0;
    for (let t = od; t <= doDnia; t += DOBA) {
      const data = new Date(t);
      const dzien = iso(data);
      expect(czyDzienRoboczy(data), dzien).toBe(wyrocznia.czyDzienTerminu(dzien));
      expect(iso(najblizszyDzienRoboczy(data)), dzien).toBe(wyrocznia.przesunTermin(dzien));
      dni++;
    }
    expect(dni).toBe(Math.round((doDnia - od) / DOBA) + 1);
  });

  it('terminy za każdy miesiąc 2026-2060, wszystkie rodzaje: nominalny, faktyczny i znacznik przesunięcia', () => {
    let porownane = 0;
    for (let rok = 2025; rok <= 2060; rok++) {
      for (let miesiac = 1; miesiac <= 12; miesiac++) {
        for (const rodzaj of RODZAJE) {
          const aplikacja = terminDla({ rodzaj, rok, miesiac });
          if (!aplikacja) continue;
          const wzorzec = wyrocznia.termin(rodzaj, rok, miesiac);
          const opis = `${rodzaj} ${rok}-${miesiac}`;
          expect({ nominalny: aplikacja.nominalny, faktyczny: aplikacja.faktyczny }, opis).toEqual(wzorzec);
          expect(aplikacja.przesuniety, opis).toBe(wzorzec.nominalny !== wzorzec.faktyczny);
          porownane++;
        }
      }
    }
    // Parametry terminów obowiązują od 2026-01-01, więc porównanie obejmuje
    // co najmniej wszystkie okresy 2026-2060 (i grudzień 2025).
    expect(porownane).toBeGreaterThanOrEqual(35 * 12 * RODZAJE.length);
  });
});
