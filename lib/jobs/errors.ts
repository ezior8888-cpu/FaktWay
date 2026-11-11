/**
 * Błędy sterujące retry w workerze pg-boss.
 *
 * Nazwy i konstruktory jak w dawnym SDK Inngest (etap 10: Inngest odpięty
 * 02.10.2026), żeby ciała jobów rzucały je bez zmian:
 *   - `NonRetriableError` — natychmiast kończy próby i woła `onExhausted`.
 *     Część jobów rozpoznaje go po `error.name === 'NonRetriableError'`
 *     (np. klasyfikacja odrzucenia w `onSubmitInvoiceExhausted`), więc nazwa
 *     jest częścią kontraktu.
 *   - `RetryAfterError` — retry z JAWNYM opóźnieniem (np. schedule KSeF
 *     30s→2m→5m→15m→1h) zamiast domyślnego. Opóźnienie: ms albo '30s'/'2m'.
 */

import { parseDurationMs } from './duration';

export class NonRetriableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetriableError';
  }
}

export class RetryAfterError extends Error {
  /** Opóźnienie kolejnej próby w ms. */
  readonly retryAfterMs: number;
  /**
   * Czy to ponowienie zużywa próbę z `maxRetries`. `false` = OCZEKIWANIE
   * (KSeF nadal przetwarza wcześniejszą wysyłkę, inna próba trzyma dzierżawę):
   * liczone osobnym licznikiem, żeby pięć odczekań nie kończyło faktury jako
   * `failed` (S22 z rewizji 03.10.2026). Domyślnie `true`.
   */
  readonly countsAsAttempt: boolean;
  /**
   * PAUZA po 429 z KSeF (L1a): firma czeka na koniec blokady MF. Nie zużywa
   * ani próby, ani budżetu odczekań (`__waits`); ma własny budżet czasu
   * łańcucha pauz (`MAX_PAUSE_CHAIN_MS` w `retry.ts`), po którym liczy się
   * jak zwykła próba — żeby trwała blokada MF miała wyjście (failed
   * `KSEF_RATE_LIMIT` → I6). Domyślnie `false`.
   */
  readonly pause: boolean;

  constructor(
    message: string,
    retryAfter: string | number,
    options?: { cause?: unknown; countsAsAttempt?: boolean; pause?: boolean },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RetryAfterError';
    this.retryAfterMs = parseDurationMs(retryAfter);
    this.countsAsAttempt = options?.countsAsAttempt ?? true;
    this.pause = options?.pause ?? false;
  }
}
