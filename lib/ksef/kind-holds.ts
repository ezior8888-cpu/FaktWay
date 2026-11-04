/**
 * Które rodzaje dokumentów są wstrzymane w danym środowisku KSeF — CZYSTY
 * moduł (tylko typy), żeby builder ponowień, cron i polityki przycisków
 * (także w komponentach klienckich) nie ciągnęły `submission-holds`
 * (wyłącznik operatora czyta bazę kluczem serwisowym).
 *
 * Te same reguły co runner (`submission-holds`, `roz-submission-hold`)
 * i kolejkowanie (`ksef-submit-enqueue`): KOR tylko poza produkcją
 * (KOR_HOLD), ROZ we wszystkich środowiskach (ROZ_HOLD_RECONCILE) — C4
 * zmienia wszystkie miejsca razem. Nieznane środowisko (`KSEF_ENV` niepoprawne)
 * wstrzymuje każdy dokument specjalny (fail-closed); zwykłą fakturę zatrzyma
 * wtedy sama ścieżka wysyłki.
 */

import type { KsefEnvironment } from '@/types/ksef';

/** Korekty są wstrzymane tylko na KSeF produkcyjnym. */
export function isCorrectionHeldForEnv(env: KsefEnvironment): boolean {
  return env === 'production';
}

/** Rodzaj wstrzymany w środowisku: nieznane środowisko wstrzymuje dokumenty specjalne, nieznany rodzaj — zawsze. */
export function isKindHeldForEnv(kind: unknown, env: KsefEnvironment | null): boolean {
  switch (kind) {
    case 'regular':
      return false;
    case 'correction':
      return env === null || isCorrectionHeldForEnv(env);
    case 'advance':
      return env === null;
    case 'final':
      // ROZ we wszystkich środowiskach (runner, kolejkowanie, `submitInvoiceFullFlow`) — do C4.
      return true;
    default:
      return true;
  }
}

/** Dokumenty specjalne, które w tym środowisku wolno wysłać z kopii (cron I6/I7). */
export function sendableSpecialKinds(env: KsefEnvironment): Array<'correction' | 'advance'> {
  return (['correction', 'advance'] as const).filter((kind) => !isKindHeldForEnv(kind, env));
}
