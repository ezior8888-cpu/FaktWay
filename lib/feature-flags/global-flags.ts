/**
 * Globalne feature flags w NASZYM Postgresie (Etap 8 migracji Hetzner).
 *
 * Zastąpiło `@vercel/edge-config` — ostatnią zależność aplikacji od Vercela.
 * Interfejs jest celowo identyczny (`getGlobalFlag`, `getAllGlobalFlags`),
 * więc `index.ts` nie wie, skąd pochodzą wartości.
 *
 * Czym to się różni od Edge Config:
 *   - odczyt z Postgresa (db-1) zamiast edge-KV, ale ZAWSZE przez Redis
 *     (TTL 60 s) — normalny ruch nie dokłada zapytań do bazy,
 *   - kill-switch propaguje się do minuty zamiast <1 s. Akceptowalne:
 *     to narzędzie incydentowe, a nie ścieżka gorąca. Kto potrzebuje
 *     natychmiast, czyści klucz w Redisie.
 *
 * Fail-soft (jak poprzednio): każdy błąd → `false`, czyli apka działa
 * normalnie. Utracony zostaje tylko kill-switch, nigdy dostępność.
 */

import * as Sentry from '@sentry/nextjs';

import { cached } from '@/lib/cache';
import { createAdminClient } from '@/lib/supabase/admin';

import type { GlobalFlag } from './types';

/** Wszystkie znane flagi globalne — używane też przez `getAllGlobalFlags`. */
export const GLOBAL_FLAGS: readonly GlobalFlag[] = [
  'killAllKsefSubmissions',
  'maintenanceMode',
  'disableSignups',
  'killFloAgent',
  'requireMfaForSensitive',
  'killKsiegowosc',
  'publicApiEnabled',
] as const;

/** Kill-switch musi reagować szybko, ale nie kosztem zapytania na każdy request. */
const TTL_SECONDS = 60;

const CACHE_KEY = 'flags:global';

interface GlobalFlagRow {
  flag: string;
  enabled: boolean;
}

/** Odczyt wszystkich flag jednym zapytaniem + cache (mniej round-tripów). */
async function readAllFlags(): Promise<Record<string, boolean>> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('global_feature_flags')
    .select('flag, enabled');

  if (error) throw new Error(error.message);

  const out: Record<string, boolean> = {};
  for (const row of (data ?? []) as GlobalFlagRow[]) {
    out[row.flag] = row.enabled === true;
  }
  return out;
}

async function loadFlags(): Promise<Record<string, boolean>> {
  try {
    const flags = await cached(CACHE_KEY, TTL_SECONDS, readAllFlags);
    return flags ?? {};
  } catch (err) {
    // Baza/Redis niedostępne — nie blokujemy aplikacji, ale chcemy wiedzieć.
    Sentry.addBreadcrumb({
      category: 'feature-flags.global',
      level: 'warning',
      message: 'Odczyt globalnych flag nieudany — traktuję jako wyłączone',
      data: { error: (err as Error).message },
    });
    return {};
  }
}

export async function getGlobalFlag(flag: GlobalFlag): Promise<boolean> {
  const flags = await loadFlags();
  return flags[flag] === true;
}

/**
 * Authoritative read before FLO side effects. An outage must not disable a kill
 * switch silently, and stale cache must not allow an already disabled action.
 * A successful lookup without a row keeps the existing default (flag=false).
 */
export async function getGlobalFlagForExecution(flag: GlobalFlag): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from('global_feature_flags')
    .select('enabled')
    .eq('flag', flag)
    .maybeSingle();
  if (error) throw new Error('Nie udało się sprawdzić wyłącznika funkcji');
  if (data === null) return false;
  if (!data || typeof data.enabled !== 'boolean') {
    throw new Error('Nieprawidłowy stan wyłącznika funkcji');
  }
  return data.enabled;
}

/**
 * Wszystkie flagi naraz — dla miejsc, które sprawdzają kilka w jednym
 * przebiegu (np. bramka trybu przerwy technicznej).
 */
export async function getAllGlobalFlags(): Promise<Record<GlobalFlag, boolean>> {
  const flags = await loadFlags();
  return Object.fromEntries(
    GLOBAL_FLAGS.map((f) => [f, flags[f] === true]),
  ) as Record<GlobalFlag, boolean>;
}

/**
 * Przestawia flagę (panel admina). Czyści cache, żeby zmiana zadziałała
 * natychmiast, a nie po wygaśnięciu TTL — przy incydencie to ma znaczenie.
 */
export async function setGlobalFlag(
  flag: GlobalFlag,
  enabled: boolean,
  updatedBy?: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('global_feature_flags')
    .upsert(
      {
        flag,
        enabled,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy ?? null,
      },
      { onConflict: 'flag' },
    );

  if (error) throw new Error(`Nie udało się zapisać flagi ${flag}: ${error.message}`);

  const { cacheDel } = await import('@/lib/cache');
  await cacheDel(CACHE_KEY);
}
