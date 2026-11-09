import { describe, expect, it } from 'vitest';

import { MAX_PUBLICATION_GAP_DAYS, rateBefore, type NbpRate } from '@/lib/flo/nbp';

import * as kalendarz from '../wyrocznia/terminy';

/**
 * NZ-KURS-01 (żelazny filtr F10, waluty): kurs do przeliczenia to tabela
 * z ostatniego dnia roboczego PRZED dniem zdarzenia (art. 11a ust. 1 i 2
 * ustawy o PIT, art. 31a ust. 1 ustawy o VAT); weekend i święto cofają dalej.
 *
 * Aplikacja wybiera tabelę z danych NBP (`rateBefore`), a kalendarz decyduje
 * tylko o progu „zapas nieaktualny” (`MAX_PUBLICATION_GAP_DAYS`). Test
 * symuluje NBP, który publikuje tabelę A w każdy dzień roboczy według
 * niezależnej wyroczni dni wolnych (`tests/filtr/wyrocznia/terminy.ts`,
 * czysty pokój), i podaje `rateBefore` to samo okno co klient
 * (`lib/nbp/client.ts`: 10 dni przed datą). Dla każdego dnia 2026-2060 kurs
 * musi się znaleźć i być z ostatniego dnia roboczego przed zdarzeniem.
 * Najdłuższa prawdziwa luka to 6 dni (Wigilia w poniedziałek, od 2025 dzień
 * wolny), więc próg 7 dni nie może zablokować kursu po świętach.
 */
const DOBA = 86_400_000;
const OKNO_KLIENTA = 10;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

describe('NZ-KURS-01: dzień kursu NBP (F10)', () => {
  it('każdy dzień 2026-2060: kurs z ostatniego dnia roboczego przed zdarzeniem, nigdy „zapas nieaktualny”', () => {
    const od = Date.UTC(2026, 0, 1);
    const doDnia = Date.UTC(2060, 11, 31);
    let najdluzszaLuka = 0;
    let dni = 0;
    for (let t = od; t <= doDnia; t += DOBA) {
      const dzien = iso(t);
      const tabele: NbpRate[] = [];
      for (let k = OKNO_KLIENTA; k >= 1; k--) {
        const d = iso(t - k * DOBA);
        if (kalendarz.czyDzienTerminu(d)) tabele.push({ currency: 'EUR', mid: 4.25, tableNo: `${d}/A/NBP`, effectiveDate: d });
      }
      let oczekiwany = t - DOBA;
      while (!kalendarz.czyDzienTerminu(iso(oczekiwany))) oczekiwany -= DOBA;

      const wynik = rateBefore(tabele, 'EUR', dzien);
      expect(wynik, dzien).toMatchObject({ found: true, rate: { effectiveDate: iso(oczekiwany) } });
      if (wynik.found) najdluzszaLuka = Math.max(najdluzszaLuka, wynik.gapDays);
      dni++;
    }
    expect(dni).toBe(Math.round((doDnia - od) / DOBA) + 1);
    // Luka z Wigilią w poniedziałek: piątek 21.12 -> czwartek 27.12.
    expect(najdluzszaLuka).toBe(6);
    expect(najdluzszaLuka).toBeLessThanOrEqual(MAX_PUBLICATION_GAP_DAYS);
  });
});
