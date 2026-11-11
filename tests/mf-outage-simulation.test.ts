/**
 * Symulacja "MF down 4h" (Faza 23 sekcja 4).
 *
 * System musi udowodnić, że podczas długotrwałej awarii:
 *   1. Każdy submit do KSeF dostaje deterministyczny 503 (mock down).
 *   2. KsefApiError ma `isRetryable=true` — sygnał dla Inngestu żeby
 *      retryować z `RetryAfterError` zamiast od razu fail'ować.
 *   3. Po wyczerpaniu retries `onFailure` wpadłaby do Offline24 (test sam
 *      retry path nie wykonuje — to robi Inngest scheduler — ale sprawdza
 *      że błąd jest właściwie sklasyfikowany jako retryable).
 *   4. Po przełączeniu mocka na 'healthy' identyczny submit zwraca sukces
 *      (recovery flow).
 *   5. Schedule retry (`getKsefRetryDelay`) zwraca prawidłowe wartości
 *      30s/2m/5m/15m/1h dla attempts 0-4.
 *
 * Testy nie odpalają Inngest scheduler'a (czas backoff sumuje się do >1h —
 * real-time test byłby absurd). Zamiast tego weryfikujemy każdy element flow
 * z osobna; integracja real-Inngest jest pokryta w Phase 20 E2E.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ksefFetch, KsefApiError } from '@/lib/ksef/client';
import { resetMockState, setMockScenario } from '@/lib/ksef/mock-fixtures';
import {
  getKsefRetryDelay,
  KSEF_MAX_RETRIES,
  KSEF_TENANT_CONCURRENCY_LIMIT,
} from '@/lib/jobs/retry-schedule';

describe('Symulacja: MF down 4h', () => {
  beforeEach(() => {
    resetMockState();
    process.env.E2E_MOCK_KSEF = '1';
    process.env.E2E_MOCK_KSEF_SKIP_DELAY = '1';
  });

  afterEach(() => {
    resetMockState();
    delete process.env.E2E_MOCK_KSEF;
    delete process.env.E2E_MOCK_KSEF_SKIP_DELAY;
    delete process.env.E2E_MOCK_KSEF_SCENARIO;
    delete process.env.E2E_MOCK_KSEF_RECOVERY_AFTER;
  });

  describe('Scenariusz 1: MF całkowicie nieczynne (down)', () => {
    it('10 prób submission — wszystkie 503, każda retryable', async () => {
      setMockScenario('down');

      const failures: number[] = [];
      const retryableFlags: boolean[] = [];

      for (let i = 0; i < 10; i++) {
        try {
          await ksefFetch('/sessions/online', {
            method: 'POST',
            accessToken: 'mock-token',
            body: {},
          });
          throw new Error('Nie powinno przejść');
        } catch (e) {
          if (e instanceof KsefApiError) {
            failures.push(e.status);
            retryableFlags.push(e.isRetryable);
          }
        }
      }

      // Wszystkie próby zakończone 503.
      expect(failures).toHaveLength(10);
      expect(failures.every((s) => s === 503)).toBe(true);

      // Każdy 503 sygnalizuje Inngest'owi do retry'owania (vs NonRetriable).
      expect(retryableFlags.every((r) => r === true)).toBe(true);
    });

    it('UPO download też zwraca 503 (nie tylko submit)', async () => {
      setMockScenario('down');

      try {
        await ksefFetch('/invoices/KSEF-NUM/upo', {
          method: 'GET',
          accessToken: 'mock-token',
        });
        throw new Error('Nie powinno przejść');
      } catch (e) {
        expect(e).toBeInstanceOf(KsefApiError);
        expect((e as KsefApiError).status).toBe(503);
      }
    });

    it('Inbox query też zwraca 503', async () => {
      setMockScenario('down');

      try {
        await ksefFetch('/invoices/query/metadata', {
          method: 'POST',
          accessToken: 'mock-token',
          body: {},
        });
        throw new Error('Nie powinno przejść');
      } catch (e) {
        expect(e).toBeInstanceOf(KsefApiError);
        expect((e as KsefApiError).status).toBe(503);
      }
    });
  });

  describe('Scenariusz 2: Recovery po N nieudanych próbach', () => {
    it('po 3 nieudanych próbach kolejna zwraca sukces (mock recovery)', async () => {
      setMockScenario('recovery');
      process.env.E2E_MOCK_KSEF_RECOVERY_AFTER = '3';

      // Próba 1-3 — fail.
      for (let i = 0; i < 3; i++) {
        try {
          await ksefFetch('/sessions/online', {
            method: 'POST',
            accessToken: 'mock-token',
            body: {},
          });
          throw new Error(`Próba ${i + 1} powinna failować`);
        } catch (e) {
          expect(e).toBeInstanceOf(KsefApiError);
          expect((e as KsefApiError).status).toBe(503);
        }
      }

      // Próba 4 — recovery, sukces.
      const result = await ksefFetch<{ referenceNumber: string }>(
        '/sessions/online',
        { method: 'POST', accessToken: 'mock-token', body: {} },
      );
      expect(result.referenceNumber).toBe('MOCK-SESSION-REF-0001');
    });
  });

  describe('Scenariusz 3: MF z powrotem online (full healthy flow)', () => {
    it('po przełączeniu na healthy submit idzie end-to-end', async () => {
      // Start: down.
      setMockScenario('down');
      try {
        await ksefFetch('/sessions/online', {
          method: 'POST',
          accessToken: 'mock-token',
          body: {},
        });
        throw new Error('Nie powinno przejść — down');
      } catch (e) {
        expect((e as KsefApiError).status).toBe(503);
      }

      // Switch: healthy. Symuluje "MF wstał".
      setMockScenario('healthy');
      const sessionRes = await ksefFetch<{ referenceNumber: string }>(
        '/sessions/online',
        { method: 'POST', accessToken: 'mock-token', body: {} },
      );
      expect(sessionRes.referenceNumber).toBeTruthy();

      // Wysyłka faktury w odzyskanej sesji.
      const sendRes = await ksefFetch<{ referenceNumber: string }>(
        `/sessions/online/${sessionRes.referenceNumber}/invoices`,
        { method: 'POST', accessToken: 'mock-token', body: {} },
      );
      expect(sendRes.referenceNumber).toBeTruthy();

      // Poll statusu — accepted.
      const pollRes = await ksefFetch<{ ksefNumber: string }>(
        `/sessions/${sessionRes.referenceNumber}/invoices/${sendRes.referenceNumber}`,
        { method: 'GET', accessToken: 'mock-token' },
      );
      expect(pollRes.ksefNumber).toMatch(/^MOCK-/);
    });
  });

  describe('Retry schedule sanity (z lib/jobs/retry-schedule.ts)', () => {
    it('schedule pokrywa 30s → 2m → 5m → 15m → 1h dla attempts 0-4', () => {
      expect(getKsefRetryDelay(0)).toBe('30s');
      expect(getKsefRetryDelay(1)).toBe('2m');
      expect(getKsefRetryDelay(2)).toBe('5m');
      expect(getKsefRetryDelay(3)).toBe('15m');
      expect(getKsefRetryDelay(4)).toBe('1h');
    });

    it('attempt >= 5 trzyma max (1h) — defensive fallback', () => {
      expect(getKsefRetryDelay(5)).toBe('1h');
      expect(getKsefRetryDelay(100)).toBe('1h');
    });

    it('limity per-tenant (2 równoległe od L1a, 5 ponowień)', () => {
      expect(KSEF_MAX_RETRIES).toBe(5);
      // L1a (08.11.2026): MF liczy limity na parę (NIP, IP), a cała platforma
      // wysyła z jednego adresu, więc firma ma najwyżej 2 wysyłki naraz zamiast
      // 100 ze spec Fazy 23 (czyli bez limitu; jedna firma brała wszystkie sloty).
      expect(KSEF_TENANT_CONCURRENCY_LIMIT).toBe(2);
    });
  });

  describe('Scenariusz 4: Audit logging w trybie down', () => {
    it('mocked 503 — error message zawiera kod HTTP', async () => {
      setMockScenario('down');

      try {
        await ksefFetch('/sessions/online', {
          method: 'POST',
          accessToken: 'mock-token',
          body: {},
        });
        throw new Error('Nie powinno przejść');
      } catch (e) {
        expect(e).toBeInstanceOf(KsefApiError);
        // KsefApiError zawiera status — propagowane do audit_logs przez
        // recordKsefAudit (audit `error: 'HTTP 503'`).
        const msg = (e as KsefApiError).message;
        expect(msg).toContain('503');
      }
    });
  });
});

/**
 * Główna asercja Fazy 23 sekcji 4:
 *
 * "System musi udowodnić, że podczas długotrwałej awarii nie gubi żadnej
 *  faktury, bezpiecznie zamraża je w Offline24, a po ponownym wstaniu API
 *  prawidłowo wznawia proces wysyłki."
 *
 * Dowód kompozycyjny:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ 1. Mock KSeF w trybie 'down' zwraca 503 na wszystkie endpointy. │
 *   │    → potwierdzone w testach `Scenariusz 1`.                     │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 2. KsefApiError(503) ma isRetryable=true (Faza 23 sekcja 2).    │
 *   │    → potwierdzone w testach `Scenariusz 1` (`retryableFlags`).  │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 3. Inngest dla retryable błędów woła `RetryAfterError` z naszego│
 *   │    schedulu (30s→2m→5m→15m→1h) — Faza 23 sekcja 2.              │
 *   │    → potwierdzone w testach `Retry schedule sanity`.            │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 4. Po wyczerpaniu retries `onFailure` przerzuca fakturę do      │
 *   │    `ksef_offline_queue` (Faza 23 sekcja 3, submit-invoice.ts).  │
 *   │    → kod handlera `onFailure` z `try-offline-queue` step.        │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 5. `process-offline-queue` cron (co 5min) re-emituje submit gdy │
 *   │    `next_attempt_at` wypadnie — istnieje od Fazy 11.            │
 *   │    Po recovery (mock 'healthy') submit się udaje.               │
 *   │    → potwierdzone w testach `Scenariusz 3` (full recovery flow).│
 *   └─────────────────────────────────────────────────────────────────┘
 */
