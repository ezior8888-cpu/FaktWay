import fc from 'fast-check';

import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/** Generatory danych księgowości JDG (plan filtra B4.5). Kwoty w groszach, liczby całkowite. */

/** Kwota w groszach od 0 do `maxZl` złotych. */
export const grosze = (maxZl = 2_000_000) => fc.integer({ min: 0, max: maxZl * 100 });

/** Kwota w groszach, także ujemna (korekty). */
export const groszeZeZnakiem = (maxZl = 2_000_000) => fc.integer({ min: -maxZl * 100, max: maxZl * 100 });

/** Stawki ryczałtu w punktach bazowych (bez 12,5 %, która jest tylko po progu najmu). */
export const stawkaRyczaltu: fc.Arbitrary<number> = fc.constantFrom(1700, 1500, 1400, 1200, 1000, 850, 550, 300);

/** Miesiąc RRRR-MM w latach z parametrami. */
export const miesiac = (lata: readonly number[] = [2026]) =>
  fc.tuple(fc.constantFrom(...lata), fc.integer({ min: 1, max: 12 })).map(([r, m]) => `${r}-${String(m).padStart(2, '0')}`);

/** Dzień RRRR-MM-DD w danym roku. */
export const dzien = (rok = 2026) =>
  fc.integer({ min: 0, max: 364 }).map((d) => new Date(Date.UTC(rok, 0, 1) + d * 86_400_000).toISOString().slice(0, 10));

/** Poprawny NIP (suma kontrolna wagami 6,5,7,2,3,4,5,6,7 mod 11, bez wyniku 10). */
export const nip = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 9 })
  .map((cyfry) => {
    const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const suma = cyfry.reduce((s, c, i) => s + c * wagi[i], 0) % 11;
    return { cyfry, suma };
  })
  .filter(({ cyfry, suma }) => suma !== 10 && cyfry[0] !== 0)
  .map(({ cyfry, suma }) => `${cyfry.join('')}${suma}`);

export function profil(z: Partial<WersjaProfilu> = {}): WersjaProfilu {
  return {
    id: 'p1',
    validFrom: '2026-01-01',
    forma: 'ryczalt',
    stawkaDomyslna: 1200,
    zusEtap: 'pelny',
    zusOd: null,
    chorobowe: true,
    nrsZus: null,
    najem: false,
    ...z,
  };
}
