/**
 * Zaślepka `server-only` dla testów (vitest).
 *
 * Prawdziwy pakiet celowo rzuca wyjątek, gdy nie działa pod warunkiem
 * eksportu `react-server` (ustawianym normalnie przez Next.js). Testy jobów
 * importują kod serwerowy (analytics w submit-invoice), a runtime workera
 * rozwiązuje to hakiem `lib/jobs/server-only-hook.mjs` (patrz Dockerfile).
 * W testach wystarczy pusty moduł. Start workera z prawdziwymi flagami
 * sprawdza tests/unit/worker-start-jak-dockerfile.test.ts.
 */
export {};
