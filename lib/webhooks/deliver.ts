import { decryptWebhookSecret } from '@/lib/webhooks/secret-box';
import { EVENT_ID_HEADER, EVENT_TYPE_HEADER, SIGNATURE_HEADER, signatureHeader } from '@/lib/webhooks/signature';
import type { WebhookTransport } from '@/lib/webhooks/transport';
import { WEBHOOK_TIMEOUT_MS, type WebhookDeliveryError } from '@/lib/webhooks/types';
import { checkWebhookUrl, resolvePublicTarget, type Resolver } from '@/lib/webhooks/url-guard';

/**
 * Jedna próba dostawy webhooka (krok 7.1, część 3): sprawdzenie adresu,
 * odszyfrowanie sekretu, DNS z kontrolą WSZYSTKICH adresów, POST z podpisem.
 * Limit 10 s obejmuje DNS, połączenie i odpowiedź. Wynik (bez treści
 * odpowiedzi) zapisuje `webhook_record_attempt` (00187); harmonogram ponowień
 * i wyłączenie webhooka liczy baza.
 */

/** Wiersz z `webhook_claim_deliveries` (00187): dostawa przejęta na tę próbę. */
export interface ClaimedDelivery {
  delivery_id: string;
  tenant_id: string;
  webhook_id: string;
  url: string;
  secret_ciphertext: string;
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
  /** Numer tej próby (1-6), już zapisany w bazie przy przejęciu. */
  attempt: number;
}

export type AttemptOutcome =
  | { succeeded: true; statusCode: number; durationMs: number }
  | {
      succeeded: false;
      statusCode: number | null;
      error: WebhookDeliveryError;
      /** `false`: błąd po stronie FaktWay, nie odbiorcy; nie zbliża webhooka do wyłączenia. */
      countsTowardDisable: boolean;
      durationMs: number;
    };

export interface AttemptDeps {
  resolve: Resolver;
  transport: WebhookTransport;
  nowMs?: () => number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export const WEBHOOK_USER_AGENT = 'FaktWay-Webhooks/1.0 (+https://faktway.pl/api/docs)';

/** Treść żądania: zawsze ta sama dla tej samej dostawy (ponowienia wysyłają to samo). */
export function webhookBody(delivery: Pick<ClaimedDelivery, 'event_id' | 'event_type' | 'occurred_at' | 'data'>): string {
  return JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    created_at: new Date(delivery.occurred_at).toISOString(),
    data: delivery.data,
  });
}

const TIMED_OUT = Symbol('timeout');

/** Obietnica albo `TIMED_OUT`, gdy sygnał przerwie czekanie (atrapy też go nie zignorują). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(TIMED_OUT);
      return;
    }
    const onAbort = () => resolve(TIMED_OUT);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function transportError(error: unknown): WebhookDeliveryError {
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH|ALTNAME/i.test(code)) return 'tls';
  return 'connection';
}

export async function attemptDelivery(delivery: ClaimedDelivery, deps: AttemptDeps): Promise<AttemptOutcome> {
  const clock = deps.nowMs ?? Date.now;
  const startedAt = clock();
  const elapsed = () => Math.max(0, Math.round(clock() - startedAt));
  const failure = (error: WebhookDeliveryError, statusCode: number | null = null, countsTowardDisable = true): AttemptOutcome => ({
    succeeded: false,
    statusCode,
    error,
    countsTowardDisable,
    durationMs: elapsed(),
  });

  // 1. Adres jeszcze raz: zasady mogły się zmienić od zapisu.
  const url = checkWebhookUrl(delivery.url);
  if (!url.ok) return failure('invalid_url');

  // 2. Sekret do podpisu. Błąd tu (brak klucza, rotacja) to problem FaktWay, nie odbiorcy.
  let signingSecret: string;
  try {
    signingSecret = decryptWebhookSecret(
      delivery.secret_ciphertext,
      { tenantId: delivery.tenant_id, webhookId: delivery.webhook_id },
      deps.env,
    );
  } catch {
    return failure('signing_unavailable', null, false);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  try {
    // 3. DNS i kontrola wszystkich adresów, w tym samym limicie czasu.
    const target = await untilAborted(resolvePublicTarget(url.hostname, deps.resolve), controller.signal);
    if (target === TIMED_OUT) return failure('timeout');
    if (!target.ok) return failure(target.reason);

    // 4. Podpis z czasem tej próby i POST na sprawdzony adres.
    const body = webhookBody(delivery);
    const timestamp = Math.floor(clock() / 1000);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': WEBHOOK_USER_AGENT,
      [EVENT_ID_HEADER]: delivery.event_id,
      [EVENT_TYPE_HEADER]: delivery.event_type,
      [SIGNATURE_HEADER]: signatureHeader(signingSecret, timestamp, body),
    };
    let response;
    try {
      response = await untilAborted(
        deps.transport({ url: new URL(url.href), address: target.address, family: target.family, headers, body, signal: controller.signal }),
        controller.signal,
      );
    } catch (error) {
      return failure(controller.signal.aborted ? 'timeout' : transportError(error));
    }
    if (response === TIMED_OUT) return failure('timeout');

    const status = response.status;
    if (status >= 200 && status < 300) return { succeeded: true, statusCode: status, durationMs: elapsed() };
    const validStatus = status >= 100 && status <= 599 ? status : null;
    if (status >= 300 && status < 400) return failure('redirect', validStatus);
    return failure('http_status', validStatus);
  } finally {
    clearTimeout(timer);
  }
}
