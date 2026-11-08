import PQueue from 'p-queue';

/**
 * Rate limiter per NIP/tenant.
 * Trzyma osobną kolejkę dla każdego tenanta, żeby jeden tenant
 * nie blokował innych.
 *
 * UWAGA: To in-memory rate limiter - reset przy każdym redeploy.
 * Dla produkcji z wieloma instancjami - przenieś licznik do Redisa (`lib/cache`).
 */
class PerTenantRateLimiter {
  private queues = new Map<string, PQueue>();

  /**
   * Zwraca kolejkę dla danego tenanta. Tworzy nową jeśli nie istnieje.
   *
   * Konfiguracja:
   * - intervalCap: max 50 żądań / sekundę (bezpiecznie poniżej limitu 100/s)
   * - concurrency: max 10 równoległych żądań per tenant
   */
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
   * Dodaje zadanie do kolejki tenanta.
   * Jeśli kolejka jest pełna, czeka.
   */
  async enqueue<T>(tenantNip: string, fn: () => Promise<T>): Promise<T> {
    const queue = this.getQueue(tenantNip);
    const result = await queue.add(fn);
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
