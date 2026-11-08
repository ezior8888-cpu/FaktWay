import { liczba } from './liczba';
import type { Terminy } from './typy';
import { ZUS_TERMINY } from './zrodla';

/**
 * Dni miesiąca terminów, posortowane rosnąco po dacie obowiązywania.
 *
 * Termin przypada zawsze w miesiącu po okresie; przesunięcie z soboty,
 * niedzieli i święta robi `lib/ksiegowosc/kalendarz.ts`. Przed pierwszym
 * wierszem nie zgadujemy (`terminyNa` zwraca `null`).
 */
export const TERMINY: readonly Terminy[] = [
  {
    od: '2026-01-01',
    liczby: {
      ryczalt: liczba(20, 'dzien', 'art. 21 ust. 1 ustawy o zryczałtowanym podatku dochodowym', 'wysoka', {
        odczyt: '2026-11-04',
        uwagi: 'Do 20. dnia za poprzedni miesiąc, za grudzień do 20 stycznia (plan, sekcja 5).',
      }),
      zaliczkaPit: liczba(20, 'dzien', 'art. 44 ust. 6 ustawy o podatku dochodowym od osób fizycznych', 'wysoka', {
        odczyt: '2026-11-04',
      }),
      zus: liczba(20, 'dzien', ZUS_TERMINY, 'wysoka'),
      vatJpk: liczba(25, 'dzien', 'art. 99 ust. 1 ustawy o VAT (JPK_V7M i zapłata)', 'wysoka', {
        odczyt: '2026-11-04',
      }),
    },
    sprawdzila: null,
  },
];
