import { notFound } from 'next/navigation';

import { ApiKeysList, type ApiKeyPublicRow } from '@/components/settings/api-keys-list';
import { WebhooksList, type WebhookDeliveryRow, type WebhookPublicRow } from '@/components/settings/webhooks-list';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { isPublicApiEnabled } from '@/lib/api/v1/availability';
import { getPageContextWithRole } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/** Ostatnie dostawy pod każdym webhookiem (dziennik w bazie ma wszystkie). */
const DELIVERIES_PER_WEBHOOK = 5;

function toPublicKeys(rows: Record<string, unknown>[] | null): ApiKeyPublicRow[] {
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    key_prefix: String(r.key_prefix ?? ''),
    scopes: Array.isArray(r.scopes) ? r.scopes.map(String) : [],
    created_at: String(r.created_at ?? ''),
    last_used_at: r.last_used_at != null ? String(r.last_used_at) : null,
    revoked_at: r.revoked_at != null ? String(r.revoked_at) : null,
  }));
}

const textOrNull = (value: unknown): string | null => (value != null ? String(value) : null);

function toPublicWebhooks(
  rows: Record<string, unknown>[] | null,
  deliveryRows: Record<string, unknown>[] | null,
): WebhookPublicRow[] {
  const byWebhook = new Map<string, WebhookDeliveryRow[]>();
  for (const d of deliveryRows ?? []) {
    const list = byWebhook.get(String(d.webhook_id)) ?? [];
    if (list.length >= DELIVERIES_PER_WEBHOOK) continue;
    list.push({
      id: String(d.id),
      event_type: String(d.event_type ?? ''),
      status: String(d.status ?? ''),
      attempts: Number(d.attempts ?? 0),
      last_status_code: d.last_status_code != null ? Number(d.last_status_code) : null,
      last_error: textOrNull(d.last_error),
      last_attempt_at: textOrNull(d.last_attempt_at),
      next_attempt_at: textOrNull(d.next_attempt_at),
      created_at: String(d.created_at ?? ''),
    });
    byWebhook.set(String(d.webhook_id), list);
  }
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    url: String(r.url ?? ''),
    events: Array.isArray(r.events) ? r.events.map(String) : [],
    created_at: String(r.created_at ?? ''),
    disabled_at: textOrNull(r.disabled_at),
    disabled_reason: textOrNull(r.disabled_reason),
    consecutive_failures: Number(r.consecutive_failures ?? 0),
    last_success_at: textOrNull(r.last_success_at),
    deliveries: byWebhook.get(String(r.id)) ?? [],
  }));
}

/**
 * Zakładka „API” (krok 7.1 planu kompletnej aplikacji): klucze API firmy
 * i webhooki (część 3). Tylko właściciel i administrator; przed udostępnieniem
 * API (flaga `publicApiEnabled`) strony nie ma. Listy klientem z sesji: RLS
 * z 00181 i 00187 pokazuje je tylko właścicielowi i administratorowi, bez
 * skrótu klucza, szyfrogramu sekretu i treści zdarzeń.
 */
export default async function ApiKeysPage() {
  if (!(await isPublicApiEnabled())) notFound();
  const { supabase, tenantId } = await getPageContextWithRole(['owner', 'admin'], '/settings');

  const [keys, webhooks, deliveries] = await Promise.all([
    supabase
      .from('api_keys')
      .select('id, name, key_prefix, scopes, created_at, last_used_at, revoked_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('webhook_endpoints')
      .select('id, url, events, created_at, disabled_at, disabled_reason, consecutive_failures, last_success_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }),
    supabase
      .from('webhook_deliveries')
      .select('id, webhook_id, event_type, status, attempts, last_status_code, last_error, last_attempt_at, next_attempt_at, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  return (
    <FieldGroup>
      <div>
        <FieldLabel>Klucze API</FieldLabel>
        <FieldDescription>
          Klucz pozwala Twojemu programowi czytać faktury albo koszty tej firmy przez API FaktWay. Opis API:{' '}
          <a href="/api/docs" className="underline">faktway.pl/api/docs</a>.
        </FieldDescription>
      </div>

      {keys.error ? (
        <Alert variant="destructive">
          <AlertDescription>Nie udało się wczytać kluczy API. Odśwież stronę za chwilę.</AlertDescription>
        </Alert>
      ) : (
        <ApiKeysList keys={toPublicKeys(keys.data as Record<string, unknown>[] | null)} />
      )}

      <div>
        <FieldLabel>Webhooki</FieldLabel>
        <FieldDescription>
          Webhook to adres Twojego serwera, na który FaktWay wysyła zdarzenia: faktura przyjęta w KSeF, nowa faktura
          kosztowa ze skrzynki KSeF i zapisana wpłata. Każde zdarzenie jest podpisane nagłówkiem FaktWay-Signature. Opis:{' '}
          <a href="/api/docs#webhooki" className="underline">faktway.pl/api/docs</a>.
        </FieldDescription>
      </div>

      {webhooks.error || deliveries.error ? (
        <Alert variant="destructive">
          <AlertDescription>Nie udało się wczytać webhooków. Odśwież stronę za chwilę.</AlertDescription>
        </Alert>
      ) : (
        <WebhooksList
          webhooks={toPublicWebhooks(
            webhooks.data as Record<string, unknown>[] | null,
            deliveries.data as Record<string, unknown>[] | null,
          )}
        />
      )}
    </FieldGroup>
  );
}
