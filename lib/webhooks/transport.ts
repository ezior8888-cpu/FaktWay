import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';

/**
 * Transport HTTPS jednej próby dostawy webhooka.
 *
 * - Łączy się WYŁĄCZNIE z adresem sprawdzonym wcześniej (`lookup` przypięty do
 *   wyniku `resolvePublicTarget`), więc zmiana DNS między sprawdzeniem
 *   a połączeniem (rebinding) nie przekieruje żądania do sieci wewnętrznej.
 *   Certyfikat i SNI dalej sprawdzamy dla nazwy z adresu.
 * - `agent: false`: każde żądanie to nowe połączenie (bez puli, która mogłaby
 *   użyć gniazda otwartego do innego adresu).
 * - `node:https` nie śledzi przekierowań: 3xx wraca jako kod odpowiedzi.
 * - Treści odpowiedzi nie czytamy ani nie zapisujemy: tylko kod, potem
 *   zamknięcie połączenia. Limit czasu: sygnał przerwania od wołającego (10 s).
 */

export interface WebhookRequest {
  url: URL;
  /** Adres IP sprawdzony przez `resolvePublicTarget`. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface WebhookResponse {
  status: number;
}

export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookResponse>;

type RequestFn = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

/** `lookup`, który zawsze zwraca sprawdzony adres (także w trybie `all`, Node 20+). */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  const lookup = (_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
  return lookup as unknown as LookupFunction;
}

export function createHttpsTransport(requestFn: RequestFn = httpsRequest): WebhookTransport {
  return (request) =>
    new Promise<WebhookResponse>((resolve, reject) => {
      const hostname = request.url.hostname;
      const req = requestFn(
        {
          protocol: 'https:',
          hostname,
          port: 443,
          method: 'POST',
          path: `${request.url.pathname}${request.url.search}`,
          headers: { ...request.headers, 'Content-Length': String(Buffer.byteLength(request.body, 'utf8')) },
          agent: false,
          servername: hostname,
          lookup: pinnedLookup(request.address, request.family),
          signal: request.signal,
        },
        (response) => {
          resolve({ status: response.statusCode ?? 0 });
          response.destroy();
        },
      );
      req.on('error', reject);
      req.end(request.body);
    });
}
