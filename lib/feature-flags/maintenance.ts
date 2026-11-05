/**
 * Przerwa techniczna `maintenanceMode` (AUD-63) — „blokuje panel” (00060).
 *
 * Czyta ją proxy przy żądaniach zalogowanych do panelu, więc odczyt jest
 * pamiętany w procesie przez `TTL_MS` — bez tego każde żądanie byłoby
 * zapytaniem do bazy, a pamięć procesu nie dokłada proxy zależności od Redisa.
 * Włączenie dociera do panelu w najwyżej pół minuty.
 *
 * Błąd odczytu: ostatnia znana wartość, a bez niej panel działa (fail-open,
 * decyzja z 02.10.2026). Przerwa „zawsze przy błędzie” zamieniałaby każdą
 * czkawkę bazy w przerwę dla wszystkich, której nie da się zdjąć flagą.
 * Odwrotnie niż wyłączniki skutków ubocznych (KSeF, FLO, rejestracja):
 * tam błąd odczytu zatrzymuje działanie.
 */

import * as Sentry from '@sentry/nextjs';

import { getGlobalFlagForExecution } from './global-flags';

export const MAINTENANCE_PATH = '/przerwa-techniczna';

const TTL_MS = 30_000;

let last: { value: boolean; at: number } | null = null;

export async function isMaintenanceMode(): Promise<boolean> {
  const now = Date.now();
  if (last && now - last.at < TTL_MS) return last.value;
  try {
    const value = await getGlobalFlagForExecution('maintenanceMode');
    last = { value, at: now };
    return value;
  } catch (err) {
    // Zapamiętujemy też porażkę — w awarii bazy proxy nie ponawia odczytu
    // przy każdym żądaniu, tylko raz na TTL.
    last = { value: last?.value ?? false, at: now };
    Sentry.captureMessage('Odczyt maintenanceMode nieudany — ostatnia znana wartość', {
      level: 'warning',
      tags: { area: 'feature-flags.maintenance' },
      extra: { error: (err as Error).message, value: last.value },
    });
    return last.value;
  }
}
