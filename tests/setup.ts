// Domyślny zestaw: wyłącznie lokalne testy i atrapy usług.
// Nie ładujemy .env.local ani innych plików ze środowiskiem aplikacji.
// Testy RLS mają osobny config, setup i jawne zmienne RLS_TEST_SUPABASE_*.
import { beforeEach } from 'vitest';

/**
 * L1a: pauza firmy po 429 (`lib/ksef/rate-limit-pause.ts`) żyje w pamięci
 * procesu. Bez czyszczenia 429 z jednego testu zostawiałby pauzę dla
 * fikcyjnego NIP-u `1234567890` w następnych testach tego pliku. Przez symbol,
 * bez importu modułu: import tutaj ładowałby prawdziwe moduły przed atrapami
 * `vi.mock` z plików testów.
 */
beforeEach(() => {
  const reset = (globalThis as Record<symbol, unknown>)[Symbol.for('faktway.ksefRateLimitPause.reset')];
  if (typeof reset === 'function') reset();
});
