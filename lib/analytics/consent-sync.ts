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

export async function syncAnalyticsConsentWithServer(): Promise<void> {
  const mine = ++generation;
  settleDeliveredTouch();
  const local = readAnalyticsConsentRecord();
  const choice = local.consent !== 'unset' && !local.synced ? local.consent : null;

  let result: Awaited<ReturnType<typeof syncAnalyticsConsentAction>>;
  try {
    result = await syncAnalyticsConsentAction({ consent: choice, chosenAt: choice ? local.chosenAt : null });
  } catch {
    // Bez sieci wybór zostaje niezsynchronizowany i poleci przy następnym wejściu.
    return;
  }
  if (mine !== generation || result.status !== 'ok') return;

  if (result.consent && result.consentAt) {
    adoptAnalyticsConsent(result.consent, result.consentAt);
  } else if (local.consent !== 'unset' && local.synced) {
    forgetAnalyticsConsent();
  }
}

/** Kliknięcie w banerze albo ustawieniach. Przeglądarka reaguje od razu, nie czeka na serwer. */
export function chooseAnalyticsConsent(granted: boolean): void {
  setAnalyticsConsent(granted);
  void syncAnalyticsConsentWithServer();
}
