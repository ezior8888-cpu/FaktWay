import { syncAnalyticsConsentAction } from '@/app/actions/analytics-consent';

import { settleDeliveredTouch } from './attribution';
import {
  adoptAnalyticsConsent,
  forgetAnalyticsConsent,
  readAnalyticsConsentRecord,
  setAnalyticsConsent,
} from './consent';

/**
 * Zgoda przeglądarka ↔ serwer. Baza zna zgodę, bo zdarzenia z serwera (webhook,
 * joby) nie mają przeglądarki. Ostatni wybór wygrywa, porównuje atomowo RPC
 * `sync_analytics_consent`. Wyjątek: wybór raz dostarczony na konto nie jest już
 * „nowy”. Bez tego druga osoba przy wspólnym komputerze (biuro księgowe) dostałaby
 * cudze „tak”, bo jej własna decyzja jest starsza.
 */

// Odpowiedź z chwili sprzed świeższego kliknięcia nie może go nadpisać.
let generation = 0;

/** Zgoda tej osoby według konta, z ostatniej odpowiedzi serwera w tej karcie. */
let accountConsent: 'granted' | 'denied' | null = null;
export const ANALYTICS_ACCOUNT_EVENT = 'ff:analytics-account';

/**
 * Czy konto potwierdziło zgodę. Dopiero wtedy wolno połączyć PostHoga z osobą i firmą:
 * zgoda w localStorage bywa nieaktualna (odwołana na innym urządzeniu) albo cudza.
 */
export function isAnalyticsConsentConfirmedByAccount(): boolean {
  return accountConsent === 'granted';
}

/** Koniec panelu (wylogowanie, inna osoba w tej samej karcie): następna sesja zaczyna bez potwierdzenia. */
export function clearAnalyticsAccountConfirmation(): void {
  accountConsent = null;
}

/**
 * `confirmed`: konto odpowiedziało i jego decyzja jest przyjęta. `anonymous`: nikt nie jest
 * zalogowany, wybór czeka w tej przeglądarce do logowania. `failed`: błąd sieci albo bazy,
 * wybór czeka do następnego wejścia do panelu. `superseded`: świeższe kliknięcie przejęło synchronizację.
 */
export type AnalyticsSyncOutcome = 'confirmed' | 'anonymous' | 'failed' | 'superseded';

export async function syncAnalyticsConsentWithServer(): Promise<AnalyticsSyncOutcome> {
  const mine = ++generation;
  settleDeliveredTouch();
  const local = readAnalyticsConsentRecord();
  const choice = local.consent !== 'unset' && !local.synced ? local.consent : null;

  let result: Awaited<ReturnType<typeof syncAnalyticsConsentAction>>;
  try {
    result = await syncAnalyticsConsentAction({ consent: choice, chosenAt: choice ? local.chosenAt : null });
  } catch {
    // Bez sieci wybór zostaje niezsynchronizowany i poleci przy następnym wejściu.
    return 'failed';
  }
  if (mine !== generation) return 'superseded';
  if (result.status === 'anonymous') return 'anonymous';
  if (result.status !== 'ok') return 'failed';

  accountConsent = result.consent;
  if (result.consent && result.consentAt) {
    adoptAnalyticsConsent(result.consent, result.consentAt);
  } else if (local.consent !== 'unset' && local.synced) {
    forgetAnalyticsConsent();
  }
  window.dispatchEvent(new Event(ANALYTICS_ACCOUNT_EVENT));
  return 'confirmed';
}

/** Kliknięcie w banerze albo ustawieniach. Przeglądarka reaguje od razu, nie czeka na serwer. */
export function chooseAnalyticsConsent(granted: boolean): Promise<AnalyticsSyncOutcome> {
  accountConsent = null;
  setAnalyticsConsent(granted);
  return syncAnalyticsConsentWithServer();
}
