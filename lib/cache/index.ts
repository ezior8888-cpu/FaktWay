/**
 * Public API cache layer — wrapper nad Redisem (`lib/cache/redis.ts`;
 * gdzie stoi i czemu zmienne nazywają się UPSTASH_* — nagłówek tamtego pliku).
 *
 * Gwarancja "fail-soft" DOTYCZY TYLKO TEJ WARSTWY: każda operacja cache
 * przechwytuje błędy Redisa i zwraca null/false zamiast rzucać — przy cache
 * miss lub awarii Redisa spada na live query. Limitery MFA i hasła celowo
 * działają odwrotnie (fail-closed), więc awaria Redisa blokuje m.in. logowanie
 * z 2FA i operacje na haśle — pełna lista w nagłówku `lib/cache/redis.ts`.
 *
 * Monitorowanie: każdy miss/hit/error inkrementuje counter w Sentry
 * breadcrumbs. Dla pełnej observability docelowo wystawimy Prometheus
 * metrics (Faza 27), na razie breadcrumbs wystarczają do debugowania.
 *
 * Wzorzec użycia:
 *
 *   const result = await cached(
 *     cacheKeys.nipValidation('1234567890'),
 *     TTL_SECONDS.nipValidation,
 *     async () => checkNipInWhitelist('1234567890'),
 *   );
 *
 * Pierwszy call: leci do `checkNipInWhitelist`, zapisuje w Redisie, zwraca.
 * Kolejne calls (przez 24h): zwraca z Redisa bez hit'u na MF API.
 */

import * as Sentry from '@sentry/nextjs';

import { getRedis, isRedisConfigured } from './redis';

export { cacheKeys, cachePatterns, TTL_SECONDS } from './keys';

// ─── Niskopoziomowe operacje ────────────────────────────────────────────

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isRedisConfigured()) return null;
  try {
    const value = await getRedis().get<T>(key);
    return value ?? null;
  } catch (err) {
    Sentry.addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'cache GET failed',
      data: { key, error: (err as Error).message },
    });
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  try {
    await getRedis().set(key, value, { ex: ttlSeconds });
    return true;
  } catch (err) {
    Sentry.addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'cache SET failed',
      data: { key, ttlSeconds, error: (err as Error).message },
    });
    return false;
  }
}

export async function cacheDel(...keys: string[]): Promise<number> {
  if (!isRedisConfigured() || keys.length === 0) return 0;
  try {
    return await getRedis().del(...keys);
  } catch (err) {
    Sentry.addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'cache DEL failed',
      data: { keys, error: (err as Error).message },
    });
    return 0;
  }
}

/**
 * Invalidate przez pattern. UWAGA — KEYS pattern jest O(N) w Redisie.
 * Używaj tylko w cleanup'ach administracyjnych (account deletion, manual
 * cache flush), nigdy w hot path.
 */
export async function cacheDelPattern(pattern: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  try {
    const redis = getRedis();
    const keys = (await redis.keys(pattern)) ?? [];
    if (keys.length === 0) return 0;
    return await redis.del(...keys);
  } catch (err) {
    Sentry.addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'cache DEL pattern failed',
      data: { pattern, error: (err as Error).message },
    });
    return 0;
  }
}

// ─── High-level wrapper ─────────────────────────────────────────────────

/**
 * `cached(key, ttl, factory)` — zwraca z cache jeśli jest, inaczej woła
 * `factory()`, zapisuje wynik i zwraca. Pattern lookup-aside (cache-aside).
 *
 * `null` i `undefined` z factory NIE są cache'owane — chronimy przed
 * stuck negatives (jeśli API jest chwilowo down, nie chcemy zapisać
 * "brak danych" na 24h). Tylko poprawny rezultat trafia do Redisa.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  factory: () => Promise<T | null>,
): Promise<T | null> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const fresh = await factory();
  if (fresh !== null && fresh !== undefined) {
    await cacheSet(key, fresh, ttlSeconds);
  }
  return fresh;
}

/**
 * Stale-while-revalidate dla long-running queries. Zwraca natychmiast
 * starą wartość z cache (nawet po expiry przez kolejne `staleWindow`
 * sekund), w tle revaliduje. UI dostaje fast first paint, świeże dane
 * zobaczy na następnym requeście.
 *
 * Implementacja prosta: trzymamy w Redisie dwa klucze — `key` (TTL = freshSeconds + staleSeconds)
 * i `key:fresh` (TTL = freshSeconds). Pierwszy ekspiruje później,
 * drugi pierwszy. Jeśli `:fresh` nie istnieje ale główny tak — zwracamy
 * stary + odpalamy refresh.
 */
export async function cachedSWR<T>(
  key: string,
  freshSeconds: number,
  staleSeconds: number,
  factory: () => Promise<T | null>,
): Promise<T | null> {
  const freshKey = `${key}:fresh`;
  const staleValue = await cacheGet<T>(key);
  const isStillFresh = (await cacheGet<string>(freshKey)) !== null;

  if (staleValue !== null && isStillFresh) {
    return staleValue;
  }

  if (staleValue !== null && !isStillFresh) {
    // Mamy stale, odpalamy revalidate w tle, zwracamy stale natychmiast.
    void revalidateInBackground(key, freshKey, freshSeconds, staleSeconds, factory);
    return staleValue;
  }

  // Pierwszy raz lub cache całkiem expired — sync fetch.
  const fresh = await factory();
  if (fresh !== null && fresh !== undefined) {
    await Promise.all([
      cacheSet(key, fresh, freshSeconds + staleSeconds),
      cacheSet(freshKey, '1', freshSeconds),
    ]);
  }
  return fresh;
}

async function revalidateInBackground<T>(
  key: string,
  freshKey: string,
  freshSeconds: number,
  staleSeconds: number,
  factory: () => Promise<T | null>,
): Promise<void> {
  try {
    const fresh = await factory();
    if (fresh !== null && fresh !== undefined) {
      await Promise.all([
        cacheSet(key, fresh, freshSeconds + staleSeconds),
        cacheSet(freshKey, '1', freshSeconds),
      ]);
    }
  } catch (err) {
    Sentry.addBreadcrumb({
      category: 'cache',
      level: 'warning',
      message: 'SWR revalidate failed (using stale)',
      data: { key, error: (err as Error).message },
    });
  }
}
