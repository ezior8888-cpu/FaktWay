import PQueue from 'p-queue';

import { runWithKsefNip } from './rate-limit-pause';

/**
 * Kolejka per NIP dla zadań KSeF (wysyłka, uzgodnienie, skrzynka, historia,
 * sesja UPO).
 *
 * Co robi, a czego NIE (stan 08.11.2026, L1a):
 *   - liczy ZADANIA, nie żądania: `submitInvoice` to jedno zadanie z
 *     logowaniem (gdy trzeba), otwarciem sesji, wysyłką, do 30 zapytań
 *     o status i zamknięciem. Limity MF są na żądania i grupy endpointów
 *     (`ksef-docs/limity/limity-api.md`, np. otwarcie sesji 10/s, 30/min,
 *     120/h), więc ta kolejka ich nie pilnuje — budżet na żądanie to karta
 *     L1b planu „zero zgubionych faktur”;
 *   - ustawia NIP firmy w kontekście zadania (`runWithKsefNip`), dzięki czemu
 *     każde `ksefFetch` w środku przechodzi przez pauzę firmy po 429
 *     (`rate-limit-pause.ts`, L1a). Kontekst ustawiamy WEWNĄTRZ zadania
 *     kolejki: p-queue startuje zadanie z kontekstu poprzedniego zadania albo
 *     timera, gdy nie ma wolnego slotu;
 *   - żyje w pamięci procesu (reset przy restarcie). Worker pg-boss to jeden
 *     proces; aplikacja web tej kolejki nie używa.
 *
 * Konfiguracja: `intervalCap` 50 zadań na sekundę i 10 zadań naraz na NIP —
 * bezpiecznik na zapętlenie, nie limit MF.
 */
class PerTenantRateLimiter {
  private queues = new Map<string, PQueue>();

  /** Kolejka danego NIP-u; tworzy nową, jeśli nie istnieje. */
  private getQueue(tenantNip: string): PQueue {
    let queue = this.queues.get(tenantNip);
    if (!queue) {
      queue = new PQueue({
        interval: 1000,
        intervalCap: 50,
        concurrency: 10,
      });
      this.queues.set(tenantNip, queue);
    }
    return queue;
  }

  /**
   * Dodaje zadanie do kolejki NIP-u (czeka, gdy kolejka pełna). Zadanie
   * biegnie z NIP-em w kontekście pauzy po 429.
   */
  async enqueue<T>(tenantNip: string, fn: () => Promise<T>): Promise<T> {
    const queue = this.getQueue(tenantNip);
    const result = await queue.add(() => runWithKsefNip(tenantNip, fn));
    // PQueue.add() może zwrócić undefined jeśli task został cancelled
    if (result === undefined) {
      throw new Error(`Rate-limited task for NIP ${tenantNip} returned undefined`);
    }
    return result;
  }

  /**
   * Statystyki kolejki (do debuggingu/metryki).
   */
  stats(tenantNip: string) {
    const queue = this.queues.get(tenantNip);
    if (!queue) return { size: 0, pending: 0 };
    return { size: queue.size, pending: queue.pending };
  }
}

/**
 * Singleton - jeden limiter na proces.
 */
export const ksefRateLimiter = new PerTenantRateLimiter();
