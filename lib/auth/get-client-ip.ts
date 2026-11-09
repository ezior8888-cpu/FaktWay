import { headers } from 'next/headers';

/**
 * IP klienta do limitów prób (AUD-62).
 *
 * Kolejność: `X-Real-Ip` (ustawia Traefik w Coolify — przy domyślnej
 * konfiguracji nadpisuje nagłówki przysłane przez klienta), potem OSTATNI
 * wpis `X-Forwarded-For` — dopisany przez nasze proxy. Pierwszy wpis może
 * podać sam klient, więc klucz limitu dałby się podmieniać przy każdym
 * żądaniu.
 *
 * Zwraca 'unknown' lokalnie — wtedy rate limiting per-IP staje się
 * globalny (wszyscy w dev mają wspólny bucket), co jest OK do testów.
 */
export async function getClientIp(): Promise<string> {
  return clientIpFromHeaders(await headers());
}

/** To samo z nagłówków żądania, gdy trasa ma je pod ręką (`/api/v1`). */
export function clientIpFromHeaders(headersList: Pick<Headers, 'get'>): string {
  const realIp = headersList.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = headersList.get('x-forwarded-for');
  if (forwarded) {
    const last = forwarded.split(',').map((p) => p.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return 'unknown';
}
