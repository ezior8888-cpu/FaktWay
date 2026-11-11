/**
 * Alarmy strażników w działającej aplikacji (żelazny filtr F13, plan B4.10).
 * Każdy alarm ma kod `FILTR-RT-<id>` i trafia do Sentry jako błąd. Odcisk
 * (kod, rodzaj, miesiąc) skleja ten sam błąd wszystkich firm i wszystkich
 * odczytów w jedno zgłoszenie; firma jest w tagu. W treści i w tagach nie ma
 * kwot ani danych osobowych: operator odtwarza przypadek z firmy, miesiąca
 * i rodzaju. Ścieżka operatora: `docs/runbooks/filtr.md`, „Alarmy FILTR-RT”.
 *
 * Alarm nie zabiera klientowi strony: strażnik zamienił już pozycję na brak,
 * a błąd samego zgłoszenia trafia tylko do logu.
 */

import * as Sentry from '@sentry/nextjs';

export interface AlarmFiltra {
  /** `FILTR-RT-<id>`, np. `FILTR-RT-TM-02`. */
  kod: string;
  /** Rodzaj pozycji albo dokumentu, np. `vat`. */
  rodzaj: string;
  /** Okres RRRR-MM. */
  miesiac: string;
  /** Co się nie zgadza: zdanie bez kwot i bez danych osobowych. */
  opis: string;
}

export interface KontekstAlarmu {
  tenantId: string;
  /** Który strażnik zgłasza, np. `ten-miesiac`. */
  straznik: string;
}

export function zglosAlarmy(alarmy: readonly AlarmFiltra[], kontekst: KontekstAlarmu): void {
  for (const alarm of alarmy) {
    try {
      Sentry.captureMessage(`${alarm.kod} (${kontekst.straznik}, ${alarm.rodzaj}): ${alarm.opis}`, {
        level: 'error',
        tags: {
          area: 'filtr.bezpieczniki',
          straznik: kontekst.straznik,
          kod: alarm.kod,
          rodzaj: alarm.rodzaj,
          miesiac: alarm.miesiac,
          tenantId: kontekst.tenantId,
        },
        fingerprint: [alarm.kod, alarm.rodzaj, alarm.miesiac],
      });
    } catch (e) {
      console.error('[FILTR-RT] alarm nie trafił do Sentry', alarm.kod, alarm.rodzaj, alarm.miesiac, e instanceof Error ? e.message : String(e));
    }
  }
}
