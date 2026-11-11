import { z } from 'zod';

/**
 * Webhooki publicznego API (krok 7.1 planu kompletnej aplikacji, część 3, 00187).
 *
 * Moduł bez `node:*`, więc trafia także do przeglądarki (formularz
 * w Ustawieniach → API). Sprawdzanie adresu, podpis, szyfrowanie sekretu
 * i wysyłka są w pozostałych plikach `lib/webhooks/` (tylko serwer).
 */

/** Ta sama lista co CHECK `webhook_endpoints_events_check` (00187). Kolejność = kolejność zapisu. */
export const WEBHOOK_EVENT_TYPES = ['invoice.ksef_accepted', 'expense.ksef_received', 'payment.recorded'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  'invoice.ksef_accepted': 'Faktura przyjęta w KSeF',
  'expense.ksef_received': 'Nowa faktura kosztowa ze skrzynki KSeF',
  'payment.recorded': 'Wpłata zapisana',
};

/** Ten sam limit pilnuje wyzwalacz `guard_webhook_endpoint` (00187). */
export const MAX_WEBHOOKS = 5;

/** Limit czasu jednej próby: DNS, połączenie, TLS i odpowiedź razem. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Odstępy ponowień po kolejnych nieudanych próbach. Ten sam harmonogram ma
 * `webhook_record_attempt` (00187) i opis na `/api/docs`; zgodność pilnuje test.
 */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200, 43_200] as const;
/** Pierwsza próba i pięć ponowień; potem dostawa jest „nieudana”. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;
/** Tyle nieudanych dostaw z rzędu i webhook wyłącza się sam (00187). */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;

/** Stany dostawy z CHECK `webhook_deliveries_status_check`. */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Rodzaje błędu próby w dzienniku dostaw (`webhook_deliveries.last_error`).
 * `signing_unavailable` to błąd po stronie FaktWay (brak klucza szyfrowania),
 * więc nie liczy się do wyłączenia webhooka.
 */
export const WEBHOOK_DELIVERY_ERRORS = [
  'invalid_url',
  'dns',
  'blocked_address',
  'timeout',
  'connection',
  'tls',
  'redirect',
  'http_status',
  'signing_unavailable',
] as const;
export type WebhookDeliveryError = (typeof WEBHOOK_DELIVERY_ERRORS)[number];

/** Opis błędu w dzienniku dostaw dla klienta (Ustawienia → API). */
export const WEBHOOK_ERROR_LABELS: Record<string, string> = {
  invalid_url: 'adres niezgodny z zasadami (tylko https na porcie 443)',
  dns: 'nie znaleźliśmy adresu serwera w DNS',
  blocked_address: 'adres serwera jest prywatny albo zastrzeżony',
  timeout: 'brak odpowiedzi w 10 s',
  connection: 'nie udało się połączyć z serwerem',
  tls: 'błąd certyfikatu HTTPS serwera',
  redirect: 'serwer odpowiedział przekierowaniem (nie podążamy za nim)',
  http_status: 'serwer odpowiedział kodem spoza 2xx',
  signing_unavailable: 'chwilowy błąd po stronie FaktWay',
  interrupted: 'próba przerwana po stronie FaktWay',
  webhook_disabled: 'webhook wyłączony przed wysyłką',
};

export function canonicalEvents(events: readonly WebhookEventType[]): WebhookEventType[] {
  return WEBHOOK_EVENT_TYPES.filter((type) => events.includes(type));
}

/** Formularz „Nowy webhook”: ten sam schemat w przeglądarce i w akcji. */
export const webhookCreateSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'Podaj adres, na który FaktWay ma wysyłać zdarzenia.')
    .max(2048, 'Adres może mieć najwyżej 2048 znaków.'),
  events: z
    .array(z.enum(WEBHOOK_EVENT_TYPES, { error: 'Nieznany rodzaj zdarzenia.' }))
    .min(1, 'Zaznacz, o czym FaktWay ma powiadamiać.')
    .max(WEBHOOK_EVENT_TYPES.length),
});
