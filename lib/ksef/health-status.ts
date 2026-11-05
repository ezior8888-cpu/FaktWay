/**
 * KSeF health status — Redis-backed snapshot pisany przez cron
 * `ksef-health-check` co 30s, czytany przez UI banner.
 *
 * Decyzja: nie używamy `validation_cache` ani innej tabeli DB. Status musi
 * być natychmiastowy do odczytu (banner renderuje się na każdym żądaniu
 * dashboard), a 30s update granularity nie zasługuje na write w DB —
 * audit log + WAL by puchły bez sensu.
 *
 * Stan kompresujemy do trzech kategorii:
 *   - `operational` — KSeF odpowiada < 2s, status 2xx
 *   - `degraded`   — pojedyncze failure'y (1-2) LUB response time > 2s
 *   - `down`       — 3+ kolejne failure'y LUB HTTP 503 (MF outage banner)
 *
 * Eskalacja `degraded` → `down` opiera się na liczniku consecutive failures
 * w Redis. Pojedynczy timeout (chwilowa sieć) nie podnosi alarmu, ale 3 z rzędu
 * (≈90s) już tak.
 */

import { cacheGet, cacheKeys, cacheSet, TTL_SECONDS } from '@/lib/cache';
import { getRedis, isRedisConfigured } from '@/lib/cache/redis';
import { createAdminClient } from '@/lib/supabase/admin';
import type { KsefEnvironment } from '@/types/ksef';

export type KsefHealthLevel = 'operational' | 'degraded' | 'down';

export interface KsefHealthSnapshot {
  level: KsefHealthLevel;
  /** ISO timestamp ostatniego pinga (zarówno udanego jak i nie). */
  lastCheckedAt: string;
  /** Czas odpowiedzi w ms ostatniego pingu — null jeśli timeout / brak odpowiedzi. */
  responseTimeMs: number | null;
  /** Counter kolejnych failure'ów (0 gdy ostatni ping ok). */
  consecutiveFailures: number;
  /** HTTP 503 = MF zgłasza globalną awarię — banner pokazuje "MF Outage". */
  isMfOutage: boolean;
  /** Czytelny komunikat o błędzie dla operatora (Sentry breadcrumb). */
  error: string | null;
  /** Env którego dotyczy snapshot — `test` vs `production`. */
  env: KsefEnvironment;
}

const DEGRADED_RESPONSE_THRESHOLD_MS = 2000;
const DOWN_FAILURE_THRESHOLD = 3;

function defaultSnapshot(env: KsefEnvironment): KsefHealthSnapshot {
  return {
    level: 'operational',
    lastCheckedAt: new Date().toISOString(),
    responseTimeMs: null,
    consecutiveFailures: 0,
    isMfOutage: false,
    error: null,
    env,
  };
}

/**
 * Aktualizuje snapshot w Redis na podstawie wyniku pingu. Wywołuje go cron
 * `ksef-health-check` raz na 30s. Counter consecutive failures rośnie przy
 * każdym fail'u i resetuje się przy pierwszym OK — atomowo przez INCR/DEL.
 */
export async function recordKsefPing(
  env: KsefEnvironment,
  ping: {
    available: boolean;
    responseTimeMs: number | null;
    isMfOutage: boolean;
    error: string | null;
  },
): Promise<KsefHealthSnapshot> {
  if (!isRedisConfigured()) {
    // Bez Redisa nie ma jak przekazać statusu między crononem a UI;
    // banner po prostu się nie pokaże. To OK dla lokalnego dev'u.
    return {
      ...defaultSnapshot(env),
      level: ping.available ? 'operational' : 'down',
      responseTimeMs: ping.responseTimeMs,
      isMfOutage: ping.isMfOutage,
      error: ping.error,
    };
  }

  const redis = getRedis();
  const failuresKey = cacheKeys.ksefHealthFailures(env);

  let consecutiveFailures = 0;
  if (ping.available) {
    // Pierwszy sukces po awarii — wyczyść counter.
    await redis.del(failuresKey);
  } else {
    consecutiveFailures = await redis.incr(failuresKey);
    // TTL counter resetuje się po godzinie idle — chroni przed stuck-stale
    // wartością gdyby cron padł i nigdy nie zrobił `del()`.
    await redis.expire(failuresKey, 3600);
  }

  let level: KsefHealthLevel;
  if (ping.available && (ping.responseTimeMs ?? 0) < DEGRADED_RESPONSE_THRESHOLD_MS) {
    level = 'operational';
  } else if (ping.isMfOutage || consecutiveFailures >= DOWN_FAILURE_THRESHOLD) {
    level = 'down';
  } else {
    level = 'degraded';
  }

  const snapshot: KsefHealthSnapshot = {
    level,
    lastCheckedAt: new Date().toISOString(),
    responseTimeMs: ping.responseTimeMs,
    consecutiveFailures,
    isMfOutage: ping.isMfOutage,
    error: ping.error,
    env,
  };

  await cacheSet(cacheKeys.ksefHealthStatus(env), snapshot, TTL_SECONDS.ksefHealth);

  // Faza 24 Krok 3: persystencja do `ksef_health_log` dla wykresu 24h w
  // admin panelu. Zapisujemy tylko gdy level się zmienił LUB co 5min heartbeat —
  // bez tego dziennie wpadłoby 2880 wierszy/env, niepotrzebnie.
  await persistHealthLogIfRelevant(env, snapshot);

  return snapshot;
}

const HEARTBEAT_KEY_PREFIX = 'ksef:health-log:last';
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5min

async function persistHealthLogIfRelevant(
  env: KsefEnvironment,
  snapshot: KsefHealthSnapshot,
): Promise<void> {
  if (!isRedisConfigured()) {
    // Bez Redisa nie znamy ostatniego stanu — zapis na każdy ping byłby
    // za drogi. Skip, akceptujemy że wykres 24h będzie pusty w tym scenariuszu.
    return;
  }
  const redis = getRedis();
  const lastKey = `${HEARTBEAT_KEY_PREFIX}:${env}`;

  try {
    const last = await redis.get<{ level: string; recordedAt: number }>(lastKey);
    const now = Date.now();
    const levelChanged = !last || last.level !== snapshot.level;
    const heartbeatDue =
      !last || now - last.recordedAt >= HEARTBEAT_INTERVAL_MS;

    if (!levelChanged && !heartbeatDue) {
      return;
    }

    const supabase = createAdminClient();
    await supabase.from('ksef_health_log').insert({
      env,
      level: snapshot.level,
      response_time_ms: snapshot.responseTimeMs,
      consecutive_failures: snapshot.consecutiveFailures,
      is_mf_outage: snapshot.isMfOutage,
      error_short: snapshot.error?.slice(0, 200) ?? null,
    });

    // Trzymamy ostatnio-zapisany stan w Redisie żeby decyzja "skip vs persist"
    // była szybka (bez SELECT z DB co 30s).
    await redis.set(lastKey, { level: snapshot.level, recordedAt: now }, {
      ex: 24 * 60 * 60,
    });
  } catch {
    // Nie chcemy żeby telemetria padła krytyczna ścieżkę cron'a. Best-effort.
  }
}

/**
 * Odczyt snapshotu dla UI. Brak danych (Redis padł, cron jeszcze nie pingnął)
 * → zwracamy `null` — UI nie pokazuje banera, "no news is good news".
 */
export async function getKsefHealthSnapshot(
  env: KsefEnvironment,
): Promise<KsefHealthSnapshot | null> {
  return cacheGet<KsefHealthSnapshot>(cacheKeys.ksefHealthStatus(env));
}

/**
 * Snapshot bez `error` — to, co wolno pokazać w przeglądarce. `error` to tekst
 * dla operatora (komunikaty sieci, adresy). Lista pól jawna, żeby nowe pole
 * snapshotu nie trafiło do przeglądarki samo.
 */
export type KsefHealthPublic = Pick<
  KsefHealthSnapshot,
  'level' | 'lastCheckedAt' | 'responseTimeMs' | 'consecutiveFailures' | 'isMfOutage' | 'env'
>;

export function toPublicKsefHealth(snapshot: KsefHealthSnapshot): KsefHealthPublic {
  return {
    level: snapshot.level,
    lastCheckedAt: snapshot.lastCheckedAt,
    responseTimeMs: snapshot.responseTimeMs,
    consecutiveFailures: snapshot.consecutiveFailures,
    isMfOutage: snapshot.isMfOutage,
    env: snapshot.env,
  };
}

const PUBLIC_MEMO_TTL_MS = 15_000;

let publicMemo: {
  env: KsefEnvironment;
  at: number;
  value: Promise<KsefHealthPublic | null>;
} | null = null;

/**
 * Odczyt dla `/api/ksef/health`, trasy bez sesji (proxy jej nie sprawdza).
 * Wynik pamiętany w procesie przez 15 s, razem z `null` przy awarii Redisa:
 * inaczej każde anonimowe żądanie byłoby odczytem Redisa przez HTTP. Cron
 * pisze snapshot co 30 s, więc 15 s nie opóźnia baneru o nic istotnego.
 * Pamiętamy obietnicę, więc równoczesne żądania czekają na jeden odczyt.
 */
export function getPublicKsefHealth(env: KsefEnvironment): Promise<KsefHealthPublic | null> {
  const now = Date.now();
  if (publicMemo && publicMemo.env === env && now - publicMemo.at < PUBLIC_MEMO_TTL_MS) {
    return publicMemo.value;
  }
  const value = getKsefHealthSnapshot(env).then((s) => (s ? toPublicKsefHealth(s) : null));
  publicMemo = { env, at: now, value };
  return value;
}

/**
 * Helper dla submit-invoice job — szybkie sprawdzenie "czy w ogóle warto
 * próbować wysłać". Gdy `down`, lepiej od razu rzucić do offline queue niż
 * tracić retry-budget na zapowiedzianą porażkę.
 */
export async function isKsefHealthy(env: KsefEnvironment): Promise<boolean> {
  const snapshot = await getKsefHealthSnapshot(env);
  // Brak danych traktujemy optymistycznie — nie blokujemy submission'ów
  // gdy nie jesteśmy pewni że MF nie żyje.
  if (!snapshot) return true;
  return snapshot.level !== 'down';
}
