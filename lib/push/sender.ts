// lib/push/sender.ts
// Wysyłka push notifications (Web Push Protocol + VAPID)
import webPush from 'web-push';

import { createAdminClient } from '@/lib/supabase/admin';

import { isAllowedPushEndpoint } from './endpoint';

/** RFC 8292: subject musi być URI typu mailto: lub https: */
function normalizeVapidSubject(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('mailto:') || t.startsWith('https://')) return t;
  if (t.includes('@')) return `mailto:${t}`;
  return t;
}

let vapidConfigured = false;

function configureVapidIfNeeded(): boolean {
  if (vapidConfigured) return true;
  const rawSubject = process.env.VAPID_SUBJECT?.trim();
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!rawSubject || !pub || !priv) return false;

  webPush.setVapidDetails(normalizeVapidSubject(rawSubject), pub, priv);
  vapidConfigured = true;
  return true;
}

function webPushStatusCode(err: unknown): number | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number'
  ) {
    return (err as { statusCode: number }).statusCode;
  }
  return undefined;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
}

export type NotificationType =
  | 'invoice_accepted'
  | 'invoice_rejected'
  | 'payment_received'
  | 'cert_expiry'
  | 'inbox_new';

const NOTIFY_COLUMNS: Record<
  NotificationType,
  | 'notify_invoice_accepted'
  | 'notify_invoice_rejected'
  | 'notify_payment_received'
  | 'notify_cert_expiry'
  | 'notify_inbox_new'
> = {
  invoice_accepted: 'notify_invoice_accepted',
  invoice_rejected: 'notify_invoice_rejected',
  payment_received: 'notify_payment_received',
  cert_expiry: 'notify_cert_expiry',
  inbox_new: 'notify_inbox_new',
};

/**
 * Odczyt bazy (subskrypcje, członkowie firmy) nieudany — to NIE jest „brak
 * subskrypcji”. Dawniej zwracało `{ sent: 0 }`, zadanie kończyło się sukcesem
 * i push przepadał po cichu (A5). Wołający ponawia zadanie albo łapie błąd
 * jawnie, gdy push jest dodatkiem do kanału, który już wyszedł.
 */
export class PushReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushReadError';
  }
}

type PushResult = { sent: number; failed: number };
type SubscriptionRow = { id: string; endpoint: string; p256dh: string; auth: string };
type AdminClient = ReturnType<typeof createAdminClient>;

export async function sendPushToUser(
  userId: string,
  type: NotificationType,
  payload: PushPayload,
): Promise<PushResult> {
  if (!configureVapidIfNeeded()) {
    return { sent: 0, failed: 0 };
  }

  const supabase = createAdminClient();
  const notifyCol = NOTIFY_COLUMNS[type];

  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)
    .eq('is_active', true)
    .eq(notifyCol, true);

  if (error) throw new PushReadError(`Nie można odczytać subskrypcji push: ${error.message}`);
  return deliver(supabase, subscriptions ?? [], payload);
}

/**
 * Push do wszystkich aktywnych członków firmy. Subskrypcje całej firmy jednym
 * odczytem PRZED pierwszą wysyłką: błąd w połowie zostawiałby część wysłaną,
 * a ponowienie zadania dzwoniłoby jej odbiorcom drugi raz (`renotify`).
 */
export async function sendPushToTenant(
  tenantId: string,
  type: NotificationType,
  payload: PushPayload,
): Promise<PushResult> {
  if (!configureVapidIfNeeded()) {
    return { sent: 0, failed: 0 };
  }

  const supabase = createAdminClient();
  const { data: rows, error } = await supabase
    .from('memberships')
    .select('user_id')
    .eq('organization_id', tenantId)
    .eq('status', 'active');

  if (error) throw new PushReadError(`Nie można odczytać członków firmy do pusha: ${error.message}`);
  const ids = [...new Set((rows ?? []).map((r) => r.user_id))];
  if (ids.length === 0) return { sent: 0, failed: 0 };

  const { data: subscriptions, error: subscriptionsError } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', ids)
    .eq('is_active', true)
    .eq(NOTIFY_COLUMNS[type], true);

  if (subscriptionsError) {
    throw new PushReadError(`Nie można odczytać subskrypcji push firmy: ${subscriptionsError.message}`);
  }
  return deliver(supabase, subscriptions ?? [], payload);
}

async function deliver(
  supabase: AdminClient,
  subscriptions: SubscriptionRow[],
  payload: PushPayload,
): Promise<PushResult> {
  // AUD-61: wiersze sprzed walidacji w akcji — adres spoza usług push
  // przeglądarek nie dostaje żądania z serwera.
  const deliverable = subscriptions.filter((sub) => isAllowedPushEndpoint(sub.endpoint));

  const outcomes = await Promise.all(
    deliverable.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify(payload),
          {
            TTL: 24 * 60 * 60,
            urgency: 'normal',
          },
        );

        await supabase
          .from('push_subscriptions')
          .update({ last_used_at: new Date().toISOString(), failed_count: 0 })
          .eq('id', sub.id);

        return 'sent' as const;
      } catch (err: unknown) {
        const status = webPushStatusCode(err);

        if (status === 410 || status === 404) {
          await supabase
            .from('push_subscriptions')
            .update({ is_active: false })
            .eq('id', sub.id);
        } else {
          await supabase.rpc('increment_push_failed_count', {
            sub_id: sub.id,
          });
        }
        return 'failed' as const;
      }
    }),
  );

  const sent = outcomes.filter((o) => o === 'sent').length;
  const failed = outcomes.filter((o) => o === 'failed').length;
  return { sent, failed };
}
