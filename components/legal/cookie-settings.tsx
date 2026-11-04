'use client';

import { useState, useSyncExternalStore } from 'react';

import {
  ANALYTICS_CONSENT_EVENT,
  CONSENT_KEY,
  getAnalyticsConsent,
  isAnalyticsConfigured,
  type ConsentState,
} from '@/lib/analytics/consent';
import {
  chooseAnalyticsConsent,
  syncAnalyticsConsentWithServer,
  type AnalyticsSyncOutcome,
} from '@/lib/analytics/consent-sync';

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONSENT_KEY || event.key === null) onChange();
  };
  window.addEventListener(ANALYTICS_CONSENT_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ANALYTICS_CONSENT_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

const LABELS: Record<ConsentState, string> = {
  granted: 'Analityka jest włączona: wyraziłeś zgodę.',
  denied: 'Analityka jest wyłączona: nie wyraziłeś zgody albo ją wycofałeś.',
  unset: 'Nie podjąłeś jeszcze decyzji, więc analityka jest wyłączona.',
};

/**
 * Wycofanie zgody musi być tak samo łatwe jak jej udzielenie (art. 7 ust. 3
 * RODO). Do 15.10.2026 baner znikał po pierwszym kliknięciu i decyzji nie
 * dało się zmienić bez czyszczenia danych przeglądarki.
 */
export function CookieSettings() {
  const state = useSyncExternalStore<ConsentState | 'server'>(
    subscribe,
    () => getAnalyticsConsent(),
    () => 'server',
  );
  // Wynik zapisu na koncie: przeglądarka reaguje od razu, ale konto bywa nieosiągalne.
  const [note, setNote] = useState<{ outcome: 'anonymous' | 'failed'; granted: boolean } | null>(null);

  const report = (outcome: AnalyticsSyncOutcome, granted: boolean) => {
    setNote(outcome === 'anonymous' || outcome === 'failed' ? { outcome, granted } : null);
  };
  const choose = async (granted: boolean) => {
    setNote(null);
    report(await chooseAnalyticsConsent(granted), granted);
  };
  const retry = async () => {
    const granted = getAnalyticsConsent() === 'granted';
    setNote(null);
    report(await syncAnalyticsConsentWithServer(), granted);
  };

  if (!isAnalyticsConfigured()) {
    return (
      <p className="text-sm text-muted-foreground">
        W tej wersji serwisu analityka jest wyłączona: nie zapisujemy niczego poza cookies niezbędnymi.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {state === 'server' ? 'Sprawdzam ustawienia…' : LABELS[state]}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void choose(true)}
          disabled={state === 'granted'}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          Włącz analitykę
        </button>
        <button
          type="button"
          onClick={() => void choose(false)}
          disabled={state === 'denied'}
          className="rounded-full px-5 py-2.5 text-sm font-semibold text-foreground ring-1 ring-border transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          Wyłącz analitykę (tylko niezbędne)
        </button>
      </div>
      {note?.outcome === 'anonymous' && (
        <p className="text-sm text-muted-foreground" role="status">
          {note.granted ? 'Włączono' : 'Wyłączono'} w tej przeglądarce. Nie jesteś zalogowany, więc
          zapiszemy to na koncie po zalogowaniu w tej przeglądarce.
          {note.granted ? '' : ' Do tego czasu zdarzenia z naszego serwera (np. płatności) mogą jeszcze wychodzić, jeśli zgodę masz zapisaną na koncie.'}
        </p>
      )}
      {note?.outcome === 'failed' && (
        <p className="text-sm text-muted-foreground" role="status">
          Nie udało się zapisać wyboru na koncie. W tej przeglądarce działa od razu, a na koncie
          spróbujemy ponownie przy następnym wejściu do panelu.{' '}
          <button
            type="button"
            onClick={() => void retry()}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Spróbuj ponownie
          </button>
        </p>
      )}
    </div>
  );
}
