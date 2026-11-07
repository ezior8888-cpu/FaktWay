import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Lokalne konto dev (`pnpm db:local`). Dane logowania czytamy ze
 * `scripts/dev/baza-lokalna.sh`, żeby nie powielać hasła w kolejnym pliku.
 */
export function devCredentials(): { email: string; password: string } {
  const source = readFileSync(resolve(process.cwd(), 'scripts/dev/baza-lokalna.sh'), 'utf8');
  const email = /^DEV_EMAIL="([^"]+)"/m.exec(source)?.[1];
  const password = /^DEV_PASSWORD="([^"]+)"/m.exec(source)?.[1];
  if (!email || !password) throw new Error('Brak DEV_EMAIL / DEV_PASSWORD w scripts/dev/baza-lokalna.sh');
  return { email, password };
}

/** Test na koncie dev ma sens tylko na lokalnym serwerze i lokalnej bazie. */
export function isLocalBaseUrl(baseURL: string | undefined): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseURL ?? '');
}

/** Konto dev istnieje tylko w lokalnym Supabase (`pnpm db:local`), nie na stagingu. */
export function isLocalDatabase(): boolean {
  return isLocalBaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/**
 * Lokalny Supabase odpowiada (`pnpm db:local` działa). Bez tego logowanie
 * czekałoby do limitu czasu i zatrzymało wszystkie testy wizualne.
 */
export async function isLocalDatabaseUp(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !isLocalDatabase()) return false;
  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Sesja konta dev zapisana przez `wizualne-logowanie.ts` (poza gitem). */
export const SESJA_KONTA_DEV = 'test-results/wizualne-sesja.json';
