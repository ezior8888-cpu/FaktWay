/**
 * Cache key conventions + TTL strategy (Faza 22).
 *
 * Reguła kluczy:
 *   `ff:<domain>:<scope>:<id>` (`ff` = namespace aplikacji — skrót po dawnej
 *   nazwie, zostaje po zmianie marki na FaktWay, żeby nie unieważniać kluczy
 *   w cache; izoluje od innych apek na tej samej instancji Redisa). `<scope>` opisuje typ danych.
 *
 * Reguła TTL:
 *   - Dane praktycznie niezmienne (NIP company, NIP whitelist) → 24h
 *   - Dashboard KPI (refresh job co godzinę) → 5 min (overlap z MV refresh)
 *   - Lista kontrahentów / produktów (per tenant, RW dużo) → 60s
 *   - Rate limit window (per-NIP/per-IP) → 60-300s
 *
 * Klucze są zawsze stringami; encoder zapewnia że tenant_id (UUID) i NIP
 * są w predictable shape — nie wstrzykujesz user input bezpośrednio.
 */

export const TTL_SECONDS = {
  /** NIP whitelist (Biała Lista) / VIES — NIP nie zmienia statusu z minuty na minutę. */
  nipValidation: 24 * 60 * 60,
  /** GUS company lookup — dane firmowe statyczne. */
  gusLookup: 24 * 60 * 60,
  /** Dashboard KPI snapshot. Materialized view refresh co godzinę, więc 5min daje fresh feel. */
  dashboardSummary: 5 * 60,
  /** Monthly stats (chart) — agregaty miesięczne, 15min wystarczy. */
  monthlyStats: 15 * 60,
  /** Lista kontrahentów per tenant — mutacja po każdym INSERT/UPDATE/DELETE, więc krótko. */
  contractorsList: 60,
  /** Lista produktów per tenant. */
  productsList: 60,
  /** Feature flags per tenant. */
  featureFlags: 10 * 60,
  /** Rate-limit window — per-NIP submission rate. */
  rateLimit: 60,
  /** KSeF health status — cron pinguje co 30s, TTL 90s żeby przy braku
   *  pinga (cron padł) UI pokazał stale-status zamiast wieczornego "OK". */
  ksefHealth: 90,
} as const;

export function k(parts: string[]): string {
  return `ff:${parts.join(':')}`;
}

// ─── Standardowe klucze ─────────────────────────────────────────────────

export const cacheKeys = {
  /** NIP validation result (Whitelist or VIES). */
  nipValidation: (nip: string, countryCode = 'PL'): string =>
    k(['valid', countryCode.toUpperCase(), nip]),

  /** GUS company lookup po NIP. */
  gusLookup: (nip: string): string => k(['gus', nip]),

  /** Dashboard KPI per tenant. */
  dashboardSummary: (tenantId: string): string => k(['dash', 'sum', tenantId]),

  /** Monthly stats (6mc chart) per tenant + direction. */
  monthlyStats: (tenantId: string, direction: string, months = 6): string =>
    k(['dash', 'monthly', tenantId, direction, String(months)]),

  /** Lista kontrahentów per tenant. */
  contractorsList: (tenantId: string): string =>
    k(['list', 'contractors', tenantId]),

  /** Feature flags per tenant. */
  featureFlags: (tenantId: string): string => k(['ff', 'flags', tenantId]),

  /** Rate-limit window — `ff:rl:submit:<nip>:<minute>`. Minute granularity. */
  submitRateLimit: (nip: string, minuteBucket: number): string =>
    k(['rl', 'submit', nip, String(minuteBucket)]),

  /** Snapshot zdrowia KSeF API. Aktualizowany przez cron co 30s. */
  ksefHealthStatus: (env: string): string => k(['ksef', 'health', env]),

  /** Counter kolejnych failure'ów KSeF — eskalacja: 1+ = degraded, 3+ = down. */
  ksefHealthFailures: (env: string): string => k(['ksef', 'health-failures', env]),
} as const;

/**
 * Wzorce do `KEYS` pattern (cache invalidation). Używaj OSTROŻNIE — KEYS
 * jest O(N) w Redisie. Dla często-invalidowanych domen lepiej trzymać
 * jawną listę kluczy w sub-namespace.
 */
export const cachePatterns = {
  /** Wszystkie cache dla danego tenanta — przy account deletion. */
  allTenant: (tenantId: string): string => `ff:*:*${tenantId}*`,
  /** Wszystkie agregaty dashboardu danego tenanta. */
  dashboardAll: (tenantId: string): string => `ff:dash:*:${tenantId}*`,
} as const;
