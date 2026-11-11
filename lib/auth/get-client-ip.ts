import { headers } from 'next/headers';

import { clientIpFromHeaders } from './client-ip';

/**
 * IP klienta do limitów prób (AUD-62).
 *
 * Kolejność: `X-Real-Ip` (ustawia Traefik w Coolify — przy domyślnej
 * konfiguracji nadpisuje nagłówki przysłane przez klienta), potem OSTATNI
 * wpis `X-Forwarded-For` — dopisany przez nasze proxy. Pierwszy wpis może
 * podać sam klient, więc klucz limitu dałby się podmieniać przy każdym
 * żądaniu. Tę samą kolejność bierze audyt (`lib/auth/client-ip.ts`).
 *
 * Zwraca 'unknown' lokalnie — wtedy rate limiting per-IP staje się
 * globalny (wszyscy w dev mają wspólny bucket), co jest OK do testów.
 */
export async function getClientIp(): Promise<string> {
  return clientIpFromHeaders(await headers()) ?? 'unknown';
}
