'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiAddLine, RiCloseLine, RiFileCopyLine, RiLoader4Line, RiWebhookLine } from '@remixicon/react';
import { toast } from 'sonner';

import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { createWebhookAction, deleteWebhookAction, enableWebhookAction } from '@/components/settings/webhooks-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  MAX_WEBHOOKS,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_ERROR_LABELS,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENT_TYPES,
  webhookCreateSchema,
  type WebhookEventType,
} from '@/lib/webhooks/types';

/**
 * Webhooki firmy (krok 7.1, część 3). Wygląd i układ jak lista kluczy API
 * obok (`api-keys-list.tsx`): nagłówek z przyciskiem, formularz w ramce,
 * karta z sekretem pokazanym raz, wiersze z odznaką stanu i akcjami po
 * prawej, pod wierszem ostatnie dostawy (D1: istniejące komponenty).
 */

export interface WebhookDeliveryRow {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
}

export interface WebhookPublicRow {
  id: string;
  url: string;
  events: string[];
  created_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  deliveries: WebhookDeliveryRow[];
}

const BADGE_OK = 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400';
const BADGE_ERROR = 'bg-red-600/10 text-red-600 dark:bg-red-400/10 dark:text-red-400';
const BADGE_WAIT = 'bg-amber-600/10 text-amber-800 dark:bg-amber-400/10 dark:text-amber-400';

const PL_DATE_TIME = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : PL_DATE_TIME.format(date);
}

function eventLabel(type: string): string {
  return WEBHOOK_EVENT_LABELS[type as WebhookEventType] ?? type;
}

export function WebhooksList({ webhooks }: { webhooks: WebhookPublicRow[] }) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between gap-2 max-sm:flex-col sm:items-center">
        <div>
          <p className="text-sm font-medium">Webhooki tej firmy</p>
          <p className="text-muted-foreground text-xs">
            Webhooki: <span className="text-foreground font-medium">{webhooks.length}</span> z {MAX_WEBHOOKS}
          </p>
        </div>
        <Button
          onClick={() => {
            setShowForm(true);
            setCreatedSecret(null);
          }}
          disabled={webhooks.length >= MAX_WEBHOOKS}
        >
          <RiAddLine aria-hidden />
          Nowy webhook
        </Button>
      </div>

      {createdSecret && <CreatedSecretCard signingSecret={createdSecret} onClose={() => setCreatedSecret(null)} />}

      {showForm && !createdSecret && (
        <CreateWebhookForm
          onSuccess={(signingSecret) => {
            setCreatedSecret(signingSecret);
            setShowForm(false);
            router.refresh();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {webhooks.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiWebhookLine />
            </EmptyMedia>
            <EmptyTitle>Brak webhooków</EmptyTitle>
            <EmptyDescription>
              Dodaj adres swojego serwera, a FaktWay powiadomi go, gdy faktura zostanie przyjęta w KSeF, przyjdzie
              faktura kosztowa albo zapiszesz wpłatę.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {webhooks.map((webhook) => (
            <WebhookRow key={webhook.id} webhook={webhook} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateWebhookForm({ onSuccess, onCancel }: { onSuccess: (signingSecret: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([...WEBHOOK_EVENT_TYPES]);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const toggleEvent = (type: WebhookEventType, checked: boolean) => {
    setEvents((current) => (checked ? [...new Set([...current, type])] : current.filter((t) => t !== type)));
  };

  const handleSubmit = () => {
    const parsed = webhookCreateSchema.safeParse({ url, events });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Niepoprawne dane webhooka.');
      return;
    }
    setStepUp(null);
    startCreating(async () => {
      const result = await createWebhookAction(parsed.data);
      if (result.success) {
        toast.success('Webhook dodany');
        onSuccess(result.signingSecret);
      } else if (result.mfaStepUp) {
        setStepUp(result.error);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4 border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Nowy webhook</p>
          <p className="text-muted-foreground text-xs">
            Adres musi zaczynać się od https:// i być dostępny z internetu. Sekret podpisu pokażemy tylko raz.
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onCancel} aria-label="Zamknij">
          <RiCloseLine aria-hidden />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="webhook-url">Adres serwera</FieldLabel>
          <Input
            id="webhook-url"
            type="url"
            inputMode="url"
            value={url}
            maxLength={2048}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://twoj-serwer.pl/faktway"
          />
        </Field>
        <Field>
          <FieldLabel>O czym powiadamiać</FieldLabel>
          <div className="flex flex-col gap-2">
            {WEBHOOK_EVENT_TYPES.map((type) => (
              <label key={type} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={events.includes(type)} onCheckedChange={(checked) => toggleEvent(type, checked === true)} />
                {WEBHOOK_EVENT_LABELS[type]}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {stepUp ? (
        <MfaStepUpNotice returnTo="/settings/api">
          {stepUp} Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      ) : null}

      <div className="flex gap-3 sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={isCreating}>
          Anuluj
        </Button>
        <Button onClick={handleSubmit} disabled={isCreating}>
          {isCreating && <RiLoader4Line className="animate-spin" aria-hidden />}
          Dodaj webhook
        </Button>
      </div>
    </div>
  );
}

function CreatedSecretCard({ signingSecret, onClose }: { signingSecret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(signingSecret);
    setCopied(true);
    toast.success('Sekret skopiowany do schowka');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Alert role="status" className="border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
      <AlertTitle>Webhook dodany</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 text-green-800 dark:text-green-400/80">
        <div className="flex items-start justify-between gap-3">
          <span>Skopiuj sekret podpisu i zapisz go na swoim serwerze, np. w zmiennej FAKTWAY_WEBHOOK_SECRET.</span>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Zamknij">
            <RiCloseLine aria-hidden />
          </Button>
        </div>
        <div className="flex gap-2">
          <Input
            readOnly
            value={signingSecret}
            aria-label="Sekret podpisu"
            className="text-foreground font-mono text-xs"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button onClick={handleCopy} className="shrink-0">
            <RiFileCopyLine aria-hidden />
            {copied ? 'Skopiowano!' : 'Kopiuj'}
          </Button>
        </div>
        <span>
          Sekret widać tylko teraz. Twój serwer sprawdza nim nagłówek FaktWay-Signature każdego zdarzenia (opis na{' '}
          <a href="/api/docs#webhooki" className="underline">faktway.pl/api/docs</a>). Zgubiony sekret: usuń webhook i dodaj go
          ponownie.
        </span>
      </AlertDescription>
    </Alert>
  );
}

function deliveryBadge(delivery: WebhookDeliveryRow) {
  if (delivery.status === 'succeeded') return <Badge className={BADGE_OK}>Dostarczona</Badge>;
  if (delivery.status === 'failed') return <Badge className={BADGE_ERROR}>Nieudana</Badge>;
  if (delivery.status === 'cancelled') return <Badge variant="outline">Anulowana</Badge>;
  return <Badge className={BADGE_WAIT}>{delivery.attempts > 0 ? 'Ponawiana' : 'Czeka'}</Badge>;
}

function deliveryDetails(delivery: WebhookDeliveryRow): string {
  const parts: string[] = [];
  if (delivery.last_status_code !== null) parts.push(`kod ${delivery.last_status_code}`);
  if (delivery.last_error && delivery.status !== 'succeeded') parts.push(WEBHOOK_ERROR_LABELS[delivery.last_error] ?? delivery.last_error);
  parts.push(`próby: ${delivery.attempts}`);
  if (delivery.status === 'pending' && delivery.attempts > 0 && delivery.next_attempt_at) {
    parts.push(`następna próba ${formatDateTime(delivery.next_attempt_at)}`);
  }
  return parts.join(' · ');
}

function WebhookRow({ webhook }: { webhook: WebhookPublicRow }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isDisabled = Boolean(webhook.disabled_at);

  const handleDelete = () => {
    if (!confirm(`Usunąć webhook ${webhook.url}? FaktWay przestanie wysyłać na ten adres zdarzenia, a dziennik dostaw zniknie.`)) return;
    startTransition(async () => {
      const result = await deleteWebhookAction(webhook.id);
      if (result.success) {
        toast.success('Webhook usunięty');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleEnable = () => {
    startTransition(async () => {
      const result = await enableWebhookAction(webhook.id);
      if (result.success) {
        toast.success('Webhook włączony');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-3 border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-10 items-center justify-center">
            <AvatarFallback className="bg-transparent">
              <RiWebhookLine className="text-foreground size-5" />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-mono text-sm font-medium" title={webhook.url}>
                {webhook.url}
              </p>
              {isDisabled ? <Badge className={BADGE_ERROR}>Wyłączony</Badge> : <Badge className={BADGE_OK}>Aktywny</Badge>}
              {webhook.events.map((type) => (
                <Badge key={type} variant="outline">
                  {eventLabel(type)}
                </Badge>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Dodany {formatSettingsDate(webhook.created_at)}
              {' · '}
              {webhook.last_success_at
                ? `ostatnia udana dostawa ${formatDateTime(webhook.last_success_at)}`
                : 'jeszcze bez udanej dostawy'}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {isDisabled && (
            <Button variant="outline" onClick={handleEnable} disabled={isPending}>
              Włącz ponownie
            </Button>
          )}
          <Button variant="ghost" onClick={handleDelete} disabled={isPending}>
            {isPending ? <RiLoader4Line className="animate-spin" aria-hidden /> : 'Usuń'}
          </Button>
        </div>
      </div>

      {isDisabled && (
        <Alert variant="destructive">
          <AlertTitle>Webhook wyłączony {formatDateTime(webhook.disabled_at)}</AlertTitle>
          <AlertDescription>
            {webhook.disabled_reason === 'consecutive_failures'
              ? `FaktWay wyłączył ten webhook po ${WEBHOOK_DISABLE_AFTER_FAILURES} nieudanych dostawach z rzędu. `
              : 'Ten webhook jest wyłączony. '}
            Sprawdź, czy serwer pod tym adresem działa i odpowiada kodem 2xx w ciągu 10 sekund, a potem włącz webhook
            ponownie. Zdarzeń z czasu wyłączenia nie wyślemy: pobierz je przez API.
          </AlertDescription>
        </Alert>
      )}

      {webhook.deliveries.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs font-medium">Ostatnie dostawy</p>
          {webhook.deliveries.map((delivery) => (
            <div key={delivery.id} className="flex flex-wrap items-center gap-2 text-xs">
              {deliveryBadge(delivery)}
              <span className="text-foreground">{eventLabel(delivery.event_type)}</span>
              <span className="text-muted-foreground">{formatDateTime(delivery.last_attempt_at ?? delivery.created_at)}</span>
              <span className="text-muted-foreground">{deliveryDetails(delivery)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
