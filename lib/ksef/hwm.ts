/**
 * Okno zapytań `/invoices/query/metadata` po dacie `PermanentStorage` — czysty
 * moduł (bez bazy, KSeF i zegara), wspólny dla Skrzynki KSeF
 * (`lib/jobs/runners/inbox-polling.ts`, który go re-eksportuje) i synchronizacji
 * historii (`lib/ksef/history-sync/windows.ts`, decyzja Bartosza 22.10.2026).
 *
 * Przeniesione 1:1 z `inbox-polling.ts`, żeby historia nie importowała runnera
 * skrzynki (a z nim kart FLO i powiadomień). Strażnik czystości:
 * tests/unit/ksef-historia-stale-czyste.test.ts.
 */

/** API przyjmuje do 100 dni na zapytanie — zostawiamy zapas. */
export const INBOX_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Początek następnego okna po pełnym przebiegu (F-039). Dokumentacja MF
 * (pobieranie przyrostowe): kolejne okno zaczyna się w „momencie zakończenia”
 * poprzedniego, czyli w `dateRange.to`, gdy było podane. `permanentStorageHwmDate`
 * jest globalny i przy nadrabianiu zaległości bywa późniejszy niż `to` —
 * start od niego przeskakiwał faktury z przedziału (to, HWM]. Wynik nigdy nie
 * cofa się przed początek okna i nie wychodzi poza jego koniec.
 */
export function nextInboxHwm(hwm: string, window: { from: string; to: string }): string {
  const hwmMs = Date.parse(hwm);
  if (!(hwmMs > Date.parse(window.from))) return window.from;
  if (hwmMs > Date.parse(window.to)) return window.to;
  return hwm;
}
