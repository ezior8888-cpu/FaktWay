/**
 * Adres klienta z nagłówków żądania: jedna kolejność zaufania dla limitów prób
 * (`getClientIp`, AUD-62) i dla audytu (`logAudit`, krok 8.5).
 *
 * `X-Real-Ip` ustawia Traefik w Coolify (przy domyślnej konfiguracji nadpisuje
 * nagłówki przysłane przez klienta), potem OSTATNI wpis `X-Forwarded-For`,
 * dopisany przez nasze proxy. Pierwszy wpis może podać sam klient.
 * Moduł bez importów Nexta: wartość bez sprawdzania formatu, `null` przy braku.
 */
export function clientIpFromHeaders(headers: Pick<Headers, 'get'>): string | null {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  return forwarded.split(',').map((part) => part.trim()).filter(Boolean).pop() ?? null;
}
