import { describe, expect, it } from 'vitest';

import { calculateOfflineDeadline, isPolishBusinessDay } from '@/lib/ksef/idempotency';

import * as wyrocznia from '../wyrocznia/terminy';

/**
 * Test różnicowy terminu doesłania faktury z trybu offline do KSeF (żelazny
 * filtr F10, część 3). Kod (`lib/ksef/idempotency.ts`, AUD-15, decyzja P1):
 * następny dzień roboczy po dniu wystawienia, przy awarii MF 7 dni roboczych,
 * do końca dnia w czasie polskim; dzień roboczy to poniedziałek-piątek bez
 * dni ustawowo wolnych od pracy. Wyrocznia dni wolnych z czystego pokoju
 * (`tests/filtr/wyrocznia/terminy.ts`, F6 część 3): `czyDzienTerminu` (nie
 * sobota, nie niedziela, nie święto ustawowe, Wigilia od 2025).
 *
 * Porównanie pełne, jak w `terminy.test.ts`: każdy dzień 2011-2100 (dzień
 * roboczy) i każdy dzień wystawienia 2026-2060 w obu trybach (termin).
 * Definicja dnia roboczego w trybie offline jest w kodzie oznaczona „do
 * weryfikacji z prawnikiem”: test pilnuje zgodności kodu z tą definicją
 * i z kalendarzem świąt, nie rozstrzyga samej definicji.
 */

const DOBA = 86_400_000;
const nastepny = (dzien: string) => new Date(Date.parse(`${dzien}T12:00:00Z`) + DOBA).toISOString().slice(0, 10);

function* dni(od: string, doDnia: string): Generator<string> {
  for (let d = od; d <= doDnia; d = nastepny(d)) yield d;
}

function terminWyroczni(wystawienie: string, dniRobocze: number): string {
  let d = wystawienie;
  let policzone = 0;
  while (policzone < dniRobocze) {
    d = nastepny(d);
    if (wyrocznia.czyDzienTerminu(d)) policzone += 1;
  }
  return d;
}

/** Chwila w czasie polskim jako „RRRR-MM-DD GG:MM:SS.mmm” (niezależnie od strefy procesu). */
const wPolsce = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const chwilaWPolsce = (c: Date) => `${wPolsce.format(c)}.${String(c.getUTCMilliseconds()).padStart(3, '0')}`;

describe('KSeF offline: termin doesłania = wyrocznia dni wolnych (F10 część 3)', () => {
  it('dzień roboczy w latach 2011-2100', () => {
    const rozne: string[] = [];
    for (const d of dni('2011-01-01', '2100-12-31')) {
      if (isPolishBusinessDay(d) !== wyrocznia.czyDzienTerminu(d)) rozne.push(d);
    }
    expect(rozne).toEqual([]);
  });

  it.each([
    ['następny dzień roboczy', false, 1],
    ['awaria MF: 7 dni roboczych', true, 7],
  ] as const)('%s: każdy dzień wystawienia 2026-2060, koniec dnia w Polsce', (_opis, awaria, liczba) => {
    const rozne: string[] = [];
    for (const d of dni('2026-01-01', '2060-12-31')) {
      const jest = chwilaWPolsce(calculateOfflineDeadline(d, awaria));
      const oczekiwany = `${terminWyroczni(d, liczba)} 23:59:59.999`;
      if (jest !== oczekiwany) rozne.push(`${d}: ${jest} zamiast ${oczekiwany}`);
    }
    expect(rozne.slice(0, 10)).toEqual([]);
  });
});
