/**
 * Czy GoTrue ma włączone logowanie Google (17.10.2026).
 *
 * Strony logowania i rejestracji pokazywały przycisk Google na sztywno, a
 * produkcyjny GoTrue ma dostawcę wyłączonego. `signInWithOAuth` nie pyta
 * GoTrue, tylko buduje adres — klient lądował na surowym JSON-ie
 * „Unsupported provider: provider is not enabled” z db.*.
 *
 * Źródło prawdy to GoTrue (`/auth/v1/settings`), nie zmienna env: włączenie
 * Google w serwisie Supabase samo pokazuje przycisk, bez wdrożenia aplikacji.
 * Wynik pamiętany w procesie przez `TTL_MS` (strona logowania nie pyta GoTrue
 * przy każdym wejściu).
 *
 * Błąd odczytu: ostatnia znana wartość, a bez niej `true` — przycisk zostaje
 * jak przed zmianą. Ukrycie go przy czkawce sieci odcięłoby konta założone
 * przez Google; `loginWithGoogle` i tak sprawdza dostawcę przed przekierowaniem.
 */

import * as Sentry from '@sentry/nextjs';

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 2_000;

let last: { value: boolean; at: number } | null = null;

export async function isGoogleLoginEnabled(): Promise<boolean> {
  const now = Date.now();
  if (last && now - last.at < TTL_MS) return last.value;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  try {
    if (!url || !key) throw new Error('brak NEXT_PUBLIC_SUPABASE_URL albo NEXT_PUBLIC_SUPABASE_ANON_KEY');
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GoTrue /settings: HTTP ${res.status}`);
    const body = (await res.json()) as { external?: { google?: unknown } };
    const value = body.external?.google === true;
    last = { value, at: now };
    return value;
  } catch (err) {
    // Porażkę też pamiętamy przez TTL — przy awarii GoTrue strona logowania
    // nie czeka na timeout przy każdym wejściu.
    last = { value: last?.value ?? true, at: now };
    Sentry.captureMessage('Odczyt dostawców logowania z GoTrue nieudany — ostatnia znana wartość', {
      level: 'warning',
      tags: { area: 'auth.oauth-providers' },
      extra: { error: (err as Error).message, google: last.value },
    });
    return last.value;
  }
}
