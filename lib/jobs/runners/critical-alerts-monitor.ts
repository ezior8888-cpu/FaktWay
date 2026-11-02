/**
 * Critical alerts monitor (Faza 27).
 *
 * Cron co 5 minut. Sprawdza kilka progów i strzela Slack #urgent gdy
 * coś przekroczone. Idempotency: claim w Redis per typ alertu — nie
 * spamujemy tym samym alertem co 5 min, tylko raz na 30 min.
 *
 * Sprawdzamy:
 *   1. **KSeF down** >= 5 min (z `ksef_health_log` — Faza 23+24)
 *   2. **Offline24 queue rośnie** — > 50 pending invoices
 *   3. **Inngest job failures** — > 10 failed runs w ostatnich 5 min
 *   4. **Payment failures** — > 5 failed Stripe payments w ostatniej godzinie
 *   5. **Refund reconciliation** — processing > 15 min lub reconciliation_required
 *   6. **Stale Stripe webhooks** — processing > 15 min lub failed
 *   7. **Stale dunning notifications** — sending starsze niż 15 min
 *   8. **Checkout claims** — creating > 15 min albo uncertain/held
 *   9. **Stale VAT enqueue** — faktura powiązana, ale brak potwierdzenia emisji > 15 min
 *  10. **KSeF reconciliation** — numer KSeF przy niezaakceptowanym statusie lub ROZ hold
 *  11. **Kopia bazy nieaktualna** — najnowsza udana kopia starsza niż 26 h (AUD-37)
 *  12. **Skrzynka KSeF zaległa** — firma bez przebiegu skrzynki > 6 h
 *  13. **Opłacone bez faktury VAT** — płatność Stripe > 60 min bez dokumentu (AUD-40)
 *  14. **KSeF sending bez wyniku** — faktura w `sending` > 15 min od przejęcia wysyłki (#71)
 *  15. **Historia KSeF stoi** — brak startu strumieni, przebieg bez sukcesu > 6 h,
 *      zaległość bez postępu > 24 h, podejrzane błędy poświadczeń (decyzja
 *      Bartosza 22.10.2026)
 *  16. **Historia KSeF: faktury do operatora** — pozycje zablokowane z powodem
 *      operatorskim i strumienie przy limicie (raz na dobę)
 *  17. **Historia KSeF: 429 u wielu firm** — globalny bezpiecznik fan-outu
 *
 * Wszystkie progi konserwatywne — wolimy false-positive niż przegapić
 * critical incident. Operator może zignorować, ale nie chcemy gubić alertów.
 */

import * as Sentry from '@sentry/nextjs';

import { OPERATOR_DUPLICATE_MESSAGES } from '@/lib/admin/ksef-operator-policy';
import { alertCritical } from '@/lib/alerts/slack';
import { backupAgeHours, isBackupStale, MAX_BACKUP_AGE_HOURS } from '@/lib/backup/freshness';
import { STALE_REFUND_OPERATION_MS } from '@/lib/billing/refund-operations';
import { reconcileExpiredOpenCheckoutAttempts } from '@/lib/stripe/checkout-reconcile';
import { cacheGet, cacheSet } from '@/lib/cache';
import { OFFLINE_QUEUE_OPEN_STATUSES } from '@/lib/ksef/offline-queue-status';
import { createAdminClient } from '@/lib/supabase/admin';
import { configuredKsefEnvironment, requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { GLOBAL_429_TENANTS } from '@/lib/ksef/history-sync/constants';

import type { JobContext } from '@/lib/jobs/registry';

const ALERT_DEDUP_TTL_SECONDS = 30 * 60; // 30 min
const ALERT_DEDUP_KEY_PREFIX = 'alerts:critical:lastsent';

/**
 * Znaczniki „wysłano” w pamięci procesu — bez Redisa (cała produkcja) cache
 * nic nie pamiętał i ten sam alarm szedł co 5 minut (N2). Monitor chodzi
 * w jednym, długo żyjącym procesie workera, więc pamięć procesu wystarcza;
 * restart workera najwyżej powtórzy alarm raz.
 */
const deliveredLocally = new Map<string, number>();

/**
 * Sprawdza czy ten typ alertu wysyłaliśmy w ciągu ostatnich 30 min.
 * Jeśli tak — pomiń. Nowy znacznik zapisujemy dopiero po potwierdzonym 2xx.
 */
export async function shouldSendAlert(alertKey: string): Promise<boolean> {
  const cacheKey = `${ALERT_DEDUP_KEY_PREFIX}:${alertKey}`;
  const until = deliveredLocally.get(cacheKey);
  if (until !== undefined && until > Date.now()) return false;
  const existing = await cacheGet<string>(cacheKey);
  return !existing;
}

/** Cache dedup only after the critical transport confirms a 2xx response. */
export async function markAlertDelivered(
  alertKey: string,
  ttlSeconds: number = ALERT_DEDUP_TTL_SECONDS,
): Promise<void> {
  const cacheKey = ALERT_DEDUP_KEY_PREFIX + ':' + alertKey;
  // Cache is fail-soft: a failed write can duplicate a later alert, but never
  // suppress a retry of an undelivered one.
  const stored = await cacheSet(cacheKey, new Date().toISOString(), ttlSeconds);
  // Cache niczego nie zapisał (brak Redisa albo jego awaria) — pamięć procesu (N2).
  if (stored === false) deliveredLocally.set(cacheKey, Date.now() + ttlSeconds * 1000);
}
interface AlertCheckResult {
  type: string;
  fired: boolean;
  reason?: string;
}

async function checkKsefDowntime(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min window
  const { data } = await supabase
    .from('ksef_health_log')
    .select('level, recorded_at')
    .gte('recorded_at', cutoffIso)
    .order('recorded_at', { ascending: true });

  const rows = (data ?? []) as Array<{ level: string; recorded_at: string }>;
  if (rows.length === 0) return { type: 'ksef_down', fired: false };

  // Policz minut spędzonych w `down`.
  let downtimeMs = 0;
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i]!;
    if (cur.level !== 'down') continue;
    const next = rows[i + 1];
    const endMs = next ? new Date(next.recorded_at).getTime() : Date.now();
    downtimeMs += endMs - new Date(cur.recorded_at).getTime();
  }
  const downtimeMin = Math.round(downtimeMs / 60000);

  if (downtimeMin < 5) return { type: 'ksef_down', fired: false };

  const shouldSend = await shouldSendAlert('ksef_down');
  if (!shouldSend) return { type: 'ksef_down', fired: false, reason: 'dedup' };

  await alertCritical(
    `KSeF API niedostępny: ${downtimeMin} min w ostatnich 10 minutach`,
    `Health monitor wykrył *${downtimeMin}* minut "down" status w ostatnim 10-min oknie. Wysyłki faktur są przerzucane do Offline24 queue.`,
    {
      fields: [
        { label: 'Downtime', value: `${downtimeMin} min` },
        { label: 'Window', value: '10 min' },
      ],
      link: {
        label: 'Otwórz /admin/system',
        url: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/admin/system`,
      },
    },
  );

  await markAlertDelivered('ksef_down');
  return { type: 'ksef_down', fired: true };
}

async function checkOfflineQueueBacklog(): Promise<AlertCheckResult> {
  const environment = requireConfiguredKsefEnvironment();
  const { count, error } = await createAdminClient()
    .from('ksef_offline_queue')
    .select('id', { count: 'exact', head: true })
    .in('status', [...OFFLINE_QUEUE_OPEN_STATUSES])
    .eq('ksef_environment', environment);
  // A failed count is not an empty queue. The monitor reports the check error
  // to Sentry instead of silently hiding invoices with statutory deadlines.
  if (error || typeof count !== 'number') {
    throw error ?? new Error('Offline24 queue count unavailable');
  }
  if (count < 50) return { type: 'offline_backlog', fired: false };

  const dedupKey = 'offline_backlog:' + environment;
  if (!(await shouldSendAlert(dedupKey))) {
    return { type: 'offline_backlog', fired: false, reason: 'dedup' };
  }
  await alertCritical(
    'Offline24 queue rośnie: ' + count + ' otwartych wpisów',
    'Faktur czekających lub w trakcie wysyłki Offline24: ' + count + '. Sprawdź dostępność KSeF i recovery cron.',
    {
      fields: [
        { label: 'Queued + sending', value: String(count) },
        { label: 'KSeF env', value: environment },
      ],
      link: {
        label: 'Otwórz /admin/system',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/system',
      },
    },
  );
  await markAlertDelivered(dedupKey);
  return { type: 'offline_backlog', fired: true };
}

/** Legacy or cross-environment queue items must never silently disappear. */
export async function checkBlockedKsefOfflineQueue(): Promise<AlertCheckResult> {
  const environment = requireConfiguredKsefEnvironment();
  const filter = 'ksef_environment.is.null,ksef_environment.neq.' + environment;
  const supabase = createAdminClient();
  const [blocked, nearest] = await Promise.all([
    supabase.from('ksef_offline_queue')
      .select('id', { count: 'exact', head: true })
      .in('status', [...OFFLINE_QUEUE_OPEN_STATUSES]).or(filter),
    supabase.from('ksef_offline_queue')
      .select('deadline')
      .in('status', [...OFFLINE_QUEUE_OPEN_STATUSES]).or(filter)
      .order('deadline', { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (blocked.error || nearest.error || blocked.count === null) {
    throw blocked.error ?? nearest.error ?? new Error('Blocked Offline24 queue count unavailable');
  }
  if (blocked.count === 0) return { type: 'offline_environment_blocked', fired: false };
  if (!nearest.data?.deadline) throw new Error('Blocked Offline24 deadline unavailable');

  const dedupKey = 'offline_environment_blocked:' + environment;
  if (!(await shouldSendAlert(dedupKey))) {
    return { type: 'offline_environment_blocked', fired: false, reason: 'dedup' };
  }
  await alertCritical(
    'Offline24 wymaga uzgodnienia środowiska',
    'Co najmniej jeden oczekujący lub rozpoczęty wpis Offline24 nie ma potwierdzonego środowiska lub dotyczy innego środowiska. Nie wznawiaj go automatycznie; uzgodnij z KSeF i kolejkami przed zmianą konfiguracji.',
    {
      fields: [
        { label: 'Zablokowane', value: String(blocked.count) },
        { label: 'Najbliższy deadline', value: nearest.data.deadline },
        { label: 'KSeF env', value: environment },
      ],
      link: {
        label: 'Otwórz /admin/system',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/system',
      },
    },
  );
  await markAlertDelivered(dedupKey);
  return { type: 'offline_environment_blocked', fired: true };
}
async function checkInngestFailures(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('inngest_run_log')
    .select('*', { count: 'exact', head: true })
    .in('status', ['error', 'failed'])
    .gte('created_at', cutoffIso);

  const failures = count ?? 0;
  if (failures < 10) return { type: 'inngest_failures', fired: false };

  const shouldSend = await shouldSendAlert('inngest_failures');
  if (!shouldSend) return { type: 'inngest_failures', fired: false, reason: 'dedup' };

  await alertCritical(
    `${failures} Inngest job failures w ostatnich 5 min`,
    `Burst failures w background jobs — sprawdź który job pada.`,
    {
      fields: [
        { label: 'Failures (5min)', value: String(failures) },
        { label: 'Threshold', value: '10' },
      ],
      link: {
        label: 'Otwórz /admin/system',
        url: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/admin/system`,
      },
    },
  );

  await markAlertDelivered('inngest_failures');
  return { type: 'inngest_failures', fired: true };
}

async function checkPaymentFailures(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('stripe_payments')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('created_at', cutoffIso);

  const failures = count ?? 0;
  if (failures < 5) return { type: 'payment_failures', fired: false };

  const shouldSend = await shouldSendAlert('payment_failures');
  if (!shouldSend) return { type: 'payment_failures', fired: false, reason: 'dedup' };

  await alertCritical(
    `${failures} Stripe payment failures w ostatniej godzinie`,
    `Może to wskazywać na problem z Stripe API, błędne karty, lub fraud attempt.`,
    {
      fields: [
        { label: 'Failures (1h)', value: String(failures) },
        { label: 'Threshold', value: '5' },
      ],
      link: {
        label: 'Otwórz /admin/support',
        url: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/admin/support`,
      },
    },
  );

  await markAlertDelivered('payment_failures');
  return { type: 'payment_failures', fired: true };
}

/** Unresolved or stalled refunds stay blocked until an operator reconciles Stripe. */
export async function checkStaleRefundOperations(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - STALE_REFUND_OPERATION_MS).toISOString();
  const [processingResult, reconciliationResult] = await Promise.all([
    supabase
      .from('stripe_refund_operations')
      .select('payment_id', { count: 'exact', head: true })
      .eq('status', 'processing')
      .lt('created_at', cutoffIso),
    supabase
      .from('stripe_refund_operations')
      .select('payment_id', { count: 'exact', head: true })
      .eq('status', 'reconciliation_required'),
  ]);

  if (processingResult.error || reconciliationResult.error ||
      processingResult.count === null || reconciliationResult.count === null) {
    throw processingResult.error ?? reconciliationResult.error ??
      new Error('Refund operation counts unavailable');
  }
  const staleProcessing = processingResult.count;
  const needsReconciliation = reconciliationResult.count;
  if (staleProcessing + needsReconciliation === 0) {
    return { type: 'stale_refund_operations', fired: false };
  }

  const shouldSend = await shouldSendAlert('stale_refund_operations');
  if (!shouldSend) return { type: 'stale_refund_operations', fired: false, reason: 'dedup' };

  await alertCritical(
    'Zwroty Stripe wymagają uzgodnienia',
    'Co najmniej jedna operacja zwrotu utknęła w processing ponad 15 minut lub ma status reconciliation_required. Sprawdź płatność i zwroty w Stripe przed jakąkolwiek kolejną próbą; nie odblokowuj automatycznie.',
    {
      fields: [
        { label: 'Processing > 15 min', value: String(staleProcessing) },
        { label: 'Wymaga uzgodnienia', value: String(needsReconciliation) },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );

  await markAlertDelivered('stale_refund_operations');
  return { type: 'stale_refund_operations', fired: true };
}

/** Review cases are independent of webhook receipts; processed means durably recorded. */
export async function checkOpenStripeFinancialCases(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const countCases = () => supabase
    .from('stripe_financial_cases')
    .select('stripe_object_id', { count: 'exact', head: true });
  const [quarantined, open, awaitingAdmin] = await Promise.all([
    countCases().eq('case_state', 'quarantined'),
    countCases().eq('case_state', 'open'),
    countCases().eq('case_state', 'awaiting_admin').lt('first_seen_at', cutoffIso),
  ]);

  if (quarantined.error || open.error || awaitingAdmin.error ||
      quarantined.count === null || open.count === null ||
      awaitingAdmin.count === null) {
    throw quarantined.error ?? open.error ?? awaitingAdmin.error ??
      new Error('Stripe financial case counts unavailable');
  }
  if (quarantined.count + open.count + awaitingAdmin.count === 0) {
    return { type: 'open_stripe_financial_cases', fired: false };
  }

  const shouldSend = await shouldSendAlert('open_stripe_financial_cases');
  if (!shouldSend) {
    return { type: 'open_stripe_financial_cases', fired: false, reason: 'dedup' };
  }

  await alertCritical(
    'Zwroty lub spory Stripe wymagają uzgodnienia',
    'Przejrzyj sprawy finansowe po pełnym ID w Stripe i bazie. Kwarantanna oznacza brak pewnego powiązania; nie zgaduj firmy, nie ponawiaj zwrotu i nie usuwaj blokady bez udokumentowanej decyzji.',
    {
      fields: [
        { label: 'Bez powiązania', value: String(quarantined.count) },
        { label: 'Powiązane, otwarte', value: String(open.count) },
        { label: 'Admin > 15 min', value: String(awaitingAdmin.count) },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );
  await markAlertDelivered('open_stripe_financial_cases');
  return { type: 'open_stripe_financial_cases', fired: true };
}
/** A Customer create can succeed at Stripe even when its response is lost. */
export async function checkStaleStripeCustomerAttempts(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const countAttempts = () => supabase
    .from('stripe_customer_attempts')
    .select('id', { count: 'exact', head: true });
  const [creating, uncertain] = await Promise.all([
    countAttempts().eq('status', 'creating').lt('created_at', cutoffIso),
    countAttempts().eq('status', 'uncertain'),
  ]);

  if (creating.error || uncertain.error ||
      creating.count === null || uncertain.count === null) {
    throw creating.error ?? uncertain.error ??
      new Error('Stripe Customer attempt counts unavailable');
  }
  if (creating.count + uncertain.count === 0) {
    return { type: 'stale_stripe_customer_attempts', fired: false };
  }

  const shouldSend = await shouldSendAlert('stale_stripe_customer_attempts');
  if (!shouldSend) {
    return { type: 'stale_stripe_customer_attempts', fired: false, reason: 'dedup' };
  }
  await alertCritical(
    'Stripe Customer wymaga uzgodnienia',
    'Tworzenie Customer utknęło albo wynik Stripe jest niepewny. Sprawdź dokładny Customer i przypisanie do firmy; nie zwalniaj claimu ani nie ponawiaj tworzenia na podstawie samego czasu.',
    {
      fields: [
        { label: 'Creating > 15 min', value: String(creating.count) },
        { label: 'Niepewne', value: String(uncertain.count) },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );
  await markAlertDelivered('stale_stripe_customer_attempts');
  return { type: 'stale_stripe_customer_attempts', fired: true };
}
/** A Checkout create can succeed at Stripe even when its response is lost. */
export async function checkStaleStripeCheckoutAttempts(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  try {
    await reconcileExpiredOpenCheckoutAttempts(cutoffIso);
  } catch (error) {
    // A failed check must leave the stale rows visible to the alert.
    Sentry.captureException(error, {
      tags: { area: 'billing.checkout.reconcile' },
    });
  }
  const countAttempts = () => supabase
    .from('stripe_checkout_attempts')
    .select('id', { count: 'exact', head: true });
  const [creating, uncertain, held, expiredOpen] = await Promise.all([
    countAttempts().eq('status', 'creating').lt('created_at', cutoffIso),
    countAttempts().eq('status', 'uncertain'),
    countAttempts().eq('status', 'held'),
    countAttempts().eq('status', 'open').lt('session_expires_at', cutoffIso),
  ]);

  if (creating.error || uncertain.error || held.error || expiredOpen.error ||
      creating.count === null || uncertain.count === null ||
      held.count === null || expiredOpen.count === null) {
    throw creating.error ?? uncertain.error ?? held.error ?? expiredOpen.error ??
      new Error('Stripe Checkout attempt counts unavailable');
  }
  if (creating.count + uncertain.count + held.count + expiredOpen.count === 0) {
    return { type: 'stale_stripe_checkout_attempts', fired: false };
  }

  const shouldSend = await shouldSendAlert('stale_stripe_checkout_attempts');
  if (!shouldSend) {
    return { type: 'stale_stripe_checkout_attempts', fired: false, reason: 'dedup' };
  }
  await alertCritical(
    'Checkout Stripe wymaga uzgodnienia',
    'Trwała próba Checkout utknęła, ma niepewny wynik lub minęła zapisana data wygaśnięcia. Świeży stan sesji potwierdź w Stripe. Nie usuwaj claimu ani nie ponawiaj utworzenia sesji bez dowodu.',
    {
      fields: [
        { label: 'Creating > 15 min', value: String(creating.count) },
        { label: 'Niepewne', value: String(uncertain.count) },
        { label: 'Wstrzymane', value: String(held.count) },
        { label: 'Open po terminie > 15 min', value: String(expiredOpen.count) },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );
  await markAlertDelivered('stale_stripe_checkout_attempts');
  return { type: 'stale_stripe_checkout_attempts', fired: true };
}
/** A stopped webhook may already have emitted jobs. Never reset it automatically. */
export async function checkStaleStripeWebhookEvents(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const [processingResult, failedResult, retryableResult] = await Promise.all([
    supabase
      .from('stripe_webhook_events')
      .select('id', { count: 'exact', head: true })
      .eq('processing_status', 'processing')
      .lt('received_at', cutoffIso),
    supabase
      .from('stripe_webhook_events')
      .select('id', { count: 'exact', head: true })
      .eq('processing_status', 'failed'),
    supabase
      .from('stripe_webhook_events')
      .select('id', { count: 'exact', head: true })
      .eq('processing_status', 'retryable')
      .lt('received_at', cutoffIso),
  ]);

  if (processingResult.error || failedResult.error || retryableResult.error ||
      processingResult.count === null || failedResult.count === null ||
      retryableResult.count === null) {
    throw processingResult.error ?? failedResult.error ?? retryableResult.error ??
      new Error('Stripe webhook receipt count unavailable');
  }
  const staleProcessing = processingResult.count;
  const failed = failedResult.count;
  const staleRetryable = retryableResult.count;
  if (staleProcessing + failed + staleRetryable === 0) {
    return { type: 'stale_stripe_webhooks', fired: false };
  }

  const shouldSend = await shouldSendAlert('stale_stripe_webhooks');
  if (!shouldSend) {
    return { type: 'stale_stripe_webhooks', fired: false, reason: 'dedup' };
  }

  await alertCritical(
    'Webhooki Stripe wymagają uzgodnienia',
    'Co najmniej jeden webhook Stripe utknął w processing/retryable ponad 15 minut lub ma status failed. Nie resetuj claimu i nie ponawiaj handlera bez sprawdzenia skutków w bazie, kolejce i Stripe.',
    {
      fields: [
        { label: 'Processing > 15 min', value: String(staleProcessing) },
        { label: 'Failed', value: String(failed) },
        { label: 'Retryable > 15 min', value: String(staleRetryable) },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );

  await markAlertDelivered('stale_stripe_webhooks');
  return { type: 'stale_stripe_webhooks', fired: true };
}

/**
 * AUD-40: płatność opłacona ponad godzinę temu, a faktury VAT brak — np.
 * `FAKTFLOW_OPERATOR_TENANT_ID` nieustawione (job kończy „skipped”) albo job
 * padł przed utworzeniem dokumentu. Klient zapłacił, sprzedaż bez faktury.
 */
export async function checkPaidWithoutVatInvoice(): Promise<AlertCheckResult> {
  const cutoffIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await createAdminClient()
    .from('stripe_payments')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'succeeded')
    .is('vat_invoice_id', null)
    .lt('paid_at', cutoffIso);

  if (error || count === null) {
    throw error ?? new Error('Paid-without-VAT count unavailable');
  }
  if (count === 0) return { type: 'paid_without_vat_invoice', fired: false };

  const shouldSend = await shouldSendAlert('paid_without_vat_invoice');
  if (!shouldSend) {
    return { type: 'paid_without_vat_invoice', fired: false, reason: 'dedup' };
  }

  await alertCritical(
    'Opłacone abonamenty bez faktury VAT',
    'Co najmniej jedna płatność Stripe jest opłacona ponad godzinę, a faktura VAT nie powstała. Sprawdź FAKTFLOW_OPERATOR_TENANT_ID i job self-invoice-payment; fakturę wystaw ręcznie, jeśli zadanie jej nie utworzy.',
    {
      fields: [
        { label: 'Płatności', value: String(count) },
        { label: 'Próg', value: '60 min' },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );

  await markAlertDelivered('paid_without_vat_invoice');
  return { type: 'paid_without_vat_invoice', fired: true };
}

/** A KSeF send may have succeeded despite a lost response; never retry it blindly. */
export async function checkStaleKsefSendingInvoices(): Promise<AlertCheckResult> {
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  // The send claim writes submitted_to_ksef_at together with `sending`.
  // Invoice updated_at can change later, so it cannot age this claim reliably.
  // Legacy rows with no claim timestamp violate that invariant and also need
  // reconciliation, regardless of invoice updated_at or creation time.
  const supabase = createAdminClient();
  const [staleResult, missingClaimResult] = await Promise.all([
    supabase.from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('ksef_status', 'sending')
      .lt('submitted_to_ksef_at', cutoffIso),
    supabase.from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('ksef_status', 'sending')
      .is('submitted_to_ksef_at', null),
  ]);

  if (staleResult.error || missingClaimResult.error ||
      typeof staleResult.count !== 'number' ||
      typeof missingClaimResult.count !== 'number') {
    throw staleResult.error ?? missingClaimResult.error ??
      new Error('Stale KSeF sending invoice counts unavailable');
  }
  if (staleResult.count + missingClaimResult.count === 0) {
    return { type: 'stale_ksef_sending_invoices', fired: false };
  }

  const dedupKey = 'stale_ksef_sending_invoices';
  if (!(await shouldSendAlert(dedupKey))) {
    return { type: dedupKey, fired: false, reason: 'dedup' };
  }

  await alertCritical(
    'Wysyłka faktur do KSeF wymaga uzgodnienia',
    'Co najmniej jedna faktura pozostaje w sending ponad 15 minut od przejęcia wysyłki lub nie ma znacznika przejęcia. Sprawdź stan w KSeF i bazie przed zmianą statusu; nie ponawiaj wysyłki automatycznie.',
    {
      fields: [
        { label: 'Faktury > 15 min', value: String(staleResult.count) },
        { label: 'Brak znacznika wysyłki', value: String(missingClaimResult.count) },
        { label: 'Próg', value: '15 min' },
      ],
      link: {
        label: 'Otwórz /admin/system',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/system',
      },
    },
  );
  await markAlertDelivered(dedupKey);
  return { type: dedupKey, fired: true };
}

/** A linked VAT draft without a confirmed enqueue must never be resent blindly. */
export async function checkStaleBillingVatEnqueues(): Promise<AlertCheckResult> {
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  // The invoice and payment link are created in one DB transaction. Invoice
  // created_at is stable; payment.updated_at can move on later webhooks.
  const { count, error } = await createAdminClient()
    .from('stripe_payments')
    .select(
      'id, invoices!stripe_payments_vat_invoice_id_fkey!inner(created_at)',
      { count: 'exact', head: true },
    )
    .not('vat_invoice_id', 'is', null)
    .is('vat_invoice_submitted_at', null)
    .lt('invoices.created_at', cutoffIso);

  if (error || count === null) {
    throw error ?? new Error('Stale billing VAT enqueue count unavailable');
  }
  if (count === 0) return { type: 'stale_billing_vat_enqueues', fired: false };

  const shouldSend = await shouldSendAlert('stale_billing_vat_enqueues');
  if (!shouldSend) {
    return { type: 'stale_billing_vat_enqueues', fired: false, reason: 'dedup' };
  }

  await alertCritical(
    'Faktury VAT Stripe wymagają uzgodnienia z KSeF',
    'Co najmniej jedna płatność ma powiązaną fakturę VAT starszą niż 15 minut bez potwierdzenia emisji zlecenia. Ręcznie uzgodnij stan kolejki i KSeF przed zmianą znacznika; nie wysyłaj zlecenia automatycznie ponownie.',
    {
      fields: [
        { label: 'Faktury > 15 min', value: String(count) },
        { label: 'Próg', value: '15 min' },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );

  await markAlertDelivered('stale_billing_vat_enqueues');
  return { type: 'stale_billing_vat_enqueues', fired: true };
}

/**
 * A KSeF number must not coexist with an unaccepted outgoing invoice. A ROZ
 * hold is an operator reconciliation state, not a rejection from KSeF. Count
 * both independently: one invoice can satisfy both predicates.
 */
export async function checkKsefReconciliationAnomalies(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const countOutgoing = () => supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outgoing');
  const [acceptedMismatch, rozHold] = await Promise.all([
    countOutgoing()
      .not('ksef_number', 'is', null)
      .or('ksef_status.is.null,ksef_status.neq.accepted'),
    countOutgoing()
      .eq('last_error_code', 'ROZ_HOLD_RECONCILE')
      .or('ksef_status.is.null,ksef_status.neq.accepted'),
  ]);

  if (acceptedMismatch.error || rozHold.error ||
      acceptedMismatch.count === null || rozHold.count === null) {
    throw acceptedMismatch.error ?? rozHold.error ??
      new Error('KSeF reconciliation counts unavailable');
  }
  if (acceptedMismatch.count === 0 && rozHold.count === 0) {
    return { type: 'ksef_reconciliation', fired: false };
  }

  // A newly appearing category must alert immediately even if the other one
  // was delivered within the 30-minute dedup window.
  const alertKey = `ksef_reconciliation:${acceptedMismatch.count > 0 ? 'number' : 'none'}:${rozHold.count > 0 ? 'roz' : 'none'}`;
  const shouldSend = await shouldSendAlert(alertKey);
  if (!shouldSend) {
    return { type: 'ksef_reconciliation', fired: false, reason: 'dedup' };
  }

  await alertCritical(
    'Faktury wymagają ręcznego uzgodnienia z KSeF',
    'Numer KSeF przy statusie innym niż accepted lub lokalna blokada ROZ wymaga sprawdzenia dokumentu i stanu w KSeF. Nie oznacza to odrzucenia przez KSeF. Nie ponawiaj wysyłki ani nie zmieniaj statusu przed ręcznym uzgodnieniem.',
    {
      fields: [
        { label: 'Numer KSeF, status niezaakceptowany', value: String(acceptedMismatch.count) },
        { label: 'ROZ wstrzymane', value: String(rozHold.count) },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );

  await markAlertDelivered(alertKey);
  return { type: 'ksef_reconciliation', fired: true };
}

/** Wiersz I5D (00148), którego oryginał sprawdzono w innym albo nieznanym środowisku KSeF. */
export const I5D_ENV_INVARIANT = 'I5D-env';

/** PR C (00156, 5.8): przegląd pliku z oznaczeniem FaktWay (I5R) czeka na operatora co najmniej tyle — alarm krytyczny `I5R-72h`. */
export const I5R_ALARM_INVARIANT = 'I5R-72h';
const I5R_ALARM_AFTER_MS = 72 * 60 * 60 * 1000;

/**
 * Inwariant do alarmu dla wiersza strażnika. I5D (00148, D-A4-1b-3 PR B,
 * decyzja 4) — faktura czeka na decyzję klienta: nie alarm, także gdy
 * powiadomienie nie doszło. E-mail „czeka na Twoją decyzję” idzie raz i nikt
 * go automatycznie nie ponawia; gdy nie doszedł — operator: „Przypomnij
 * klientowi” (raport dzienny, /admin/ksef z kolumną „Powiadomienie klienta”). Wyjątek: dane oryginału sprawdzono w innym środowisku KSeF niż
 * obecne (albo KSEF_ENV jest nieznane) — wtedy `I5D-env`, bo klient nie
 * zapisze decyzji (RPC ENV). `null` — wiersz nie alarmuje.
 *
 * PR C (00156, spec v3 5.8): `I3K` (K zapisana decyzją bez sesji UPO albo bez daty nadania) nie alarmuje
 * z monitora — to trwały sygnał w raporcie i KPI, a alarm Sentry idzie z akcji decyzji. `I5R`
 * (przegląd pliku przez operatora; klient usłyszał „damy znać”) alarmuje dopiero po 72 h od ostatniego
 * udanego sprawdzenia (`detail.checked_at`): młodsze `checked_at` → `null`; brak albo nieczytelna wartość →
 * `I5R-72h` od razu (fail-closed: nie wiemy, od kiedy klient czeka). Zegar liczy od ostatniego sprawdzenia:
 * „Tylko uzgodnij”, które pobierze plik, zapisuje nowe `checkedAt` i zaczyna 72 h od nowa (nowa ocena
 * = nowy przegląd).
 */
function alertingInvariant(row: { invariant: string; detail?: unknown }, environment: string | null, now: number): string | null {
  const detail = typeof row.detail === 'object' && row.detail !== null ? (row.detail as Record<string, unknown>) : null;
  switch (row.invariant) {
    case 'I5D':
      return environment !== null && detail?.env === environment ? null : I5D_ENV_INVARIANT;
    case 'I3K':
      return null;
    case 'I5R': {
      const checkedAt = typeof detail?.checked_at === 'string' ? Date.parse(detail.checked_at) : Number.NaN;
      return Number.isNaN(checkedAt) || now - checkedAt >= I5R_ALARM_AFTER_MS ? I5R_ALARM_INVARIANT : null;
    }
    default:
      return row.invariant;
  }
}

/**
 * W3 / cykl życia faktury (PR 4b): naruszenia strażnika `ksef_lifecycle_violations()`
 * (00131). I1 i klasa transient mają automat w `cron.ksef-lifecycle-reconcile`;
 * reszta (I2 sending ponad dzierżawę, I3 accepted bez UPO/XML, I4 failed bez
 * kodu, I5 stary wpis sent, I9 failed z numerem) to praca operatora w /admin/ksef.
 * I5D (00148) — faktura czeka na decyzję klienta: nie alarm (e-mail idzie raz
 * i nie jest ponawiany; gdy nie doszedł — operator: „Przypomnij klientowi” —
 * widzi fakturę w raporcie i w /admin/ksef); I5D-env — alarm, bo klient nie
 * zapisze decyzji. PR C (00156): I5R (przegląd pliku) — alarm `I5R-72h` po 72 h,
 * I3K — bez alarmu z monitora (patrz `alertingInvariant`).
 */
export async function checkKsefLifecycleViolations(): Promise<AlertCheckResult> {
  const { data, error } = await createAdminClient().rpc('ksef_lifecycle_violations');
  if (error) throw new Error(`ksef_lifecycle_violations: ${error.message}`);
  const environment = configuredKsefEnvironment();
  const now = Date.now();
  const alerting = ((data ?? []) as Array<{ invariant: string; detail?: unknown }>)
    .map((row) => alertingInvariant(row, environment, now))
    .filter((inv): inv is string => inv !== null);
  if (alerting.length === 0) {
    return { type: 'ksef_lifecycle_violations', fired: false };
  }
  const counts = new Map<string, number>();
  for (const inv of alerting) counts.set(inv, (counts.get(inv) ?? 0) + 1);
  const invariants = [...counts.keys()].sort();
  // Nowy inwariant ma alarmować od razu, nawet gdy inny poszedł w oknie dedup.
  const alertKey = `ksef_lifecycle_violations:${invariants.join('+')}`;
  if (!(await shouldSendAlert(alertKey))) {
    return { type: 'ksef_lifecycle_violations', fired: false, reason: 'dedup' };
  }
  await alertCritical(
    'Strażnik cyklu życia faktury: naruszenia',
    'Faktury w stanie sprzecznym z cyklem życia. I1 (queued bez zlecenia) i klasę transient naprawia cron ponowień; pozostałe wymagają operatora: I2 sending ponad dzierżawę, I3 accepted bez UPO/XML, I4 failed bez kodu z katalogu, I5 wpis sent starszy niż 48 h, I9 failed z numerem KSeF. ' +
      OPERATOR_DUPLICATE_MESSAGES.i5dEnv +
      (counts.has(I5R_ALARM_INVARIANT) ? ` ${OPERATOR_DUPLICATE_MESSAGES.i5r72h}` : ''),
    {
      fields: invariants.map((inv) => ({ label: inv, value: String(counts.get(inv)) })),
      link: {
        label: 'Otwórz /admin/ksef',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/ksef',
      },
    },
  );
  await markAlertDelivered(alertKey);
  return { type: 'ksef_lifecycle_violations', fired: true };
}

/** An uncertain email send must be reconciled before any new delivery. */
export async function checkStaleDunningNotifications(): Promise<AlertCheckResult> {
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count, error } = await createAdminClient()
    .from('billing_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'payment_failed')
    .eq('status', 'sending')
    .lt('sent_at', cutoffIso);

  if (error || count === null) {
    throw error ?? new Error('Stale dunning notification count unavailable');
  }
  if (count === 0) return { type: 'stale_dunning_notifications', fired: false };

  const shouldSend = await shouldSendAlert('stale_dunning_notifications');
  if (!shouldSend) {
    return { type: 'stale_dunning_notifications', fired: false, reason: 'dedup' };
  }

  await alertCritical(
    'Powiadomienia o nieudanej płatności wymagają uzgodnienia',
    'Co najmniej jedna próba wysyłki pozostaje w sending ponad 15 minut. Sprawdź aktualną płatność i wynik wysyłki w Resend przed zmianą statusu; nie ponawiaj wysyłki automatycznie.',
    {
      fields: [
        { label: 'Próby > 15 min', value: String(count) },
        { label: 'Próg', value: '15 min' },
      ],
      link: {
        label: 'Otwórz panel administratora',
        url: (process.env.NEXT_PUBLIC_APP_URL ?? '') + '/admin/support',
      },
    },
  );

  await markAlertDelivered('stale_dunning_notifications');
  return { type: 'stale_dunning_notifications', fired: true };
}

/** Nieaktualna kopia nie budzi w nocy co 30 min — przypomnienie raz na 6 h. */
const STALE_BACKUP_DEDUP_TTL_SECONDS = 6 * 60 * 60;

/**
 * Najnowsza udana kopia bazy starsza niż 26 h (AUD-37). Łapie też cron, który
 * przestał się uruchamiać — wtedy snapshot nie zgłasza żadnej porażki.
 */
export async function checkStaleBackup(): Promise<AlertCheckResult> {
  const { data, error } = await createAdminClient()
    .from('backup_log')
    .select('started_at')
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const newestAt = (data as { started_at: string } | null)?.started_at ?? null;
  if (!isBackupStale(newestAt)) return { type: 'stale_backup', fired: false };

  const shouldSend = await shouldSendAlert('stale_backup');
  if (!shouldSend) return { type: 'stale_backup', fired: false, reason: 'dedup' };

  const age = backupAgeHours(newestAt);
  await alertCritical(
    'Kopia bazy jest nieaktualna',
    'Nocny snapshot bazy nie powstał. Sprawdź workera (kolejka cron.daily-db-snapshot), wpisy w backup_log i Sentry. Do czasu naprawy zrób kopię ręcznie według docs/runbooks/backup-restore.md.',
    {
      fields: [
        {
          label: 'Najnowsza udana kopia',
          value: age === null ? 'brak' : `${Math.floor(age)} h temu`,
        },
        { label: 'Próg', value: `${MAX_BACKUP_AGE_HOURS} h` },
      ],
    },
  );

  await markAlertDelivered('stale_backup', STALE_BACKUP_DEDUP_TTL_SECONDS);
  return { type: 'stale_backup', fired: true };
}

/** Skrzynka KSeF bez pełnego przebiegu dłużej niż tyle godzin = alarm. */
export const INBOX_STALE_HOURS = 6;

/**
 * Zaległość skrzynki KSeF (AUD-18). Firma z poświadczeniami, której HWM
 * skrzynki (`ksef_inbox_cursor.window_to`) jest starszy niż próg, albo która
 * od podpięcia KSeF nie ma żadnego pełnego przebiegu. Łapie padające
 * przebiegi, zatrzymany cron i zaległość po stronie MF — wcześniej
 * niekompletne pobranie było tylko linijką w logu. W alarmie liczby, bez NIP.
 */
export async function checkStaleInboxSync(): Promise<AlertCheckResult> {
  const supabase = createAdminClient();
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, ksef_verified_at')
    .not('ksef_credentials_encrypted', 'is', null);
  if (error) throw error;
  const withKsef = (tenants ?? []) as { id: string; ksef_verified_at: string | null }[];
  if (withKsef.length === 0) return { type: 'stale_inbox_sync', fired: false };

  const { data: cursors, error: cursorError } = await supabase
    .from('ksef_inbox_cursor')
    .select('tenant_id, window_to');
  if (cursorError) throw cursorError;
  const hwmByTenant = new Map(
    ((cursors ?? []) as { tenant_id: string; window_to: string | null }[])
      .map((row) => [row.tenant_id, row.window_to] as const),
  );

  const threshold = Date.now() - INBOX_STALE_HOURS * 60 * 60 * 1000;
  let stale = 0;
  let neverPolled = 0;
  for (const tenant of withKsef) {
    const hwm = hwmByTenant.get(tenant.id);
    if (hwm) {
      if (Date.parse(hwm) < threshold) stale += 1;
    } else if (tenant.ksef_verified_at && Date.parse(tenant.ksef_verified_at) < threshold) {
      neverPolled += 1;
    }
  }
  if (stale + neverPolled === 0) return { type: 'stale_inbox_sync', fired: false };

  const shouldSend = await shouldSendAlert('stale_inbox_sync');
  if (!shouldSend) return { type: 'stale_inbox_sync', fired: false, reason: 'dedup' };

  await alertCritical(
    'Skrzynka KSeF nie pobiera faktur',
    'Faktury kosztowe z KSeF nie są pobierane. Sprawdź kolejkę inbox.poll.tenant i cron.inbox-polling w workerze, Sentry i logi workera. Po naprawie skrzynka sama nadrobi zaległość od ostatniego pełnego przebiegu.',
    {
      fields: [
        { label: 'Firmy z zaległością', value: String(stale) },
        { label: 'Firmy bez żadnego przebiegu', value: String(neverPolled) },
        { label: 'Próg', value: `${INBOX_STALE_HOURS} h` },
      ],
    },
  );

  await markAlertDelivered('stale_inbox_sync');
  return { type: 'stale_inbox_sync', fired: true };
}

// ═══════════════════════════════════════════════════════════════
// Synchronizacja historii KSeF (decyzja Bartosza 22.10.2026, 00155)
// ═══════════════════════════════════════════════════════════════

/** Przebieg historii bez sukcesu dłużej niż tyle godzin = alarm „stoi”. */
export const KSEF_HISTORY_STALE_HOURS = 6;
/** Zaległość bez postępu dłużej niż tyle godzin = alarm. */
export const KSEF_HISTORY_BACKFILL_STUCK_HOURS = 24;
/** Błędy poświadczeń naprawia klient — chyba że jest ich podejrzanie dużo. */
const KSEF_HISTORY_CLIENT_FIXABLE = new Set(['credentials', 'certificate_expired', 'permission']);
/** Powody zablokowania, które wymagają operatora (reszta ma ścieżkę klienta albo czeka na KSeF). */
export const KSEF_HISTORY_OPERATOR_REASONS = [
  'parse_failed', 'local_conflict', 'number_taken_local', 'file_import_mismatch', 'own_send_unresolved',
  'save_failed', 'repair_failed', 'download_failed', 'archive_conflict', 'metadata_mismatch',
] as const;
const KSEF_HISTORY_BLOCKED_TTL_SECONDS = 24 * 60 * 60;

interface HistoryStreamAlertRow {
  tenant_id: string;
  direction: 'outgoing' | 'incoming';
  created_at: string;
  backfill_completed_at: string | null;
  backfill_issue: string | null;
  backfill_progress_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  paused_until: string | null;
  rate_limit_hits: number;
  client_paused_at: string | null;
}

export interface KsefHistoryStaleClasses {
  noStartOutgoing: number;
  noStartIncoming: number;
  stalled: number;
  backfillStuck: number;
  credentialsSuspicious: number;
}

/** Klasy alarmu „historia stoi” (czysta funkcja — testy). W wyniku tylko liczby. */
export function ksefHistoryStaleClasses(input: {
  tenants: Array<{ id: string; ksef_verified_at: string | null }>;
  streams: HistoryStreamAlertRow[];
  cursors: Array<{ tenant_id: string; last_page_at: string | null }>;
  now: number;
}): KsefHistoryStaleClasses {
  const { tenants, streams, cursors, now } = input;
  const hour = 3_600_000;
  const out: KsefHistoryStaleClasses = { noStartOutgoing: 0, noStartIncoming: 0, stalled: 0, backfillStuck: 0, credentialsSuspicious: 0 };
  const lastPage = new Map(cursors.map((c) => [c.tenant_id, c.last_page_at] as const));
  const allOutgoing = streams.filter((s) => s.direction === 'outgoing');
  const credentialStreams = allOutgoing.filter((s) => s.last_error_code === 'credentials');
  let inboxWorksDespiteCredentials = 0;

  for (const tenant of tenants) {
    const outgoing = streams.find((s) => s.tenant_id === tenant.id && s.direction === 'outgoing');
    const incoming = streams.find((s) => s.tenant_id === tenant.id && s.direction === 'incoming');
    if (outgoing?.client_paused_at) continue;
    if (!outgoing) {
      if (tenant.ksef_verified_at && Date.parse(tenant.ksef_verified_at) < now - hour) out.noStartOutgoing += 1;
      continue;
    }
    if (!incoming && Date.parse(outgoing.created_at) < now - 2 * hour) out.noStartIncoming += 1;

    const lastOk = Date.parse(outgoing.last_success_at ?? outgoing.created_at);
    const clientFixable = outgoing.last_error_code !== null && KSEF_HISTORY_CLIENT_FIXABLE.has(outgoing.last_error_code);
    const rateLimited = outgoing.paused_until !== null && Date.parse(outgoing.paused_until) > now;
    const longRateLimit = rateLimited && (outgoing.rate_limit_hits >= 4
      || Date.parse(outgoing.paused_until!) > now + KSEF_HISTORY_STALE_HOURS * hour);
    if (lastOk < now - KSEF_HISTORY_STALE_HOURS * hour && !clientFixable && (!rateLimited || longRateLimit)) {
      out.stalled += 1;
    }
    for (const stream of [outgoing, incoming]) {
      if (!stream || stream.backfill_completed_at || stream.backfill_issue === 'capacity') continue;
      const progress = Date.parse(stream.backfill_progress_at ?? stream.created_at);
      if (progress < now - KSEF_HISTORY_BACKFILL_STUCK_HOURS * hour) out.backfillStuck += 1;
    }
    if (outgoing.last_error_code === 'credentials' && outgoing.last_error_at) {
      const page = lastPage.get(tenant.id);
      // Skrzynka tej firmy pobiera faktury tym samym certyfikatem — błąd jest po naszej stronie.
      if (page && Date.parse(page) > Date.parse(outgoing.last_error_at)) inboxWorksDespiteCredentials += 1;
    }
  }
  const manyCredentialErrors = credentialStreams.length >= 3
    && allOutgoing.length > 0 && credentialStreams.length / allOutgoing.length >= 0.2;
  out.credentialsSuspicious = manyCredentialErrors ? credentialStreams.length : inboxWorksDespiteCredentials;
  return out;
}

/**
 * Historia KSeF stoi (punkt 5 i 8 krytyki): strumienie nie wystartowały,
 * przebieg nie ma sukcesu od 6 h (poza błędami, które naprawia klient,
 * i krótką pauzą po 429), zaległość bez postępu od doby, podejrzane błędy
 * poświadczeń. Firmy wstrzymane przez klienta — pomijane.
 */
export async function checkStaleKsefHistorySync(): Promise<AlertCheckResult> {
  const type = 'stale_ksef_history_sync';
  const environment = configuredKsefEnvironment();
  if (!environment) return { type, fired: false };
  const supabase = createAdminClient();
  const [tenantsRes, streamsRes, cursorsRes] = await Promise.all([
    supabase.from('tenants').select('id, ksef_verified_at')
      .not('ksef_credentials_encrypted', 'is', null)
      .not('ksef_verified_at', 'is', null)
      .eq('ksef_verified_environment', environment)
      .is('deleted_at', null)
      .eq('is_active', true),
    supabase.from('ksef_history_sync')
      .select('tenant_id, direction, created_at, backfill_completed_at, backfill_issue, backfill_progress_at, last_success_at, last_error_code, last_error_at, paused_until, rate_limit_hits, client_paused_at')
      .eq('environment', environment),
    supabase.from('ksef_inbox_cursor').select('tenant_id, last_page_at'),
  ]);
  for (const r of [tenantsRes, streamsRes, cursorsRes]) if (r.error) throw r.error;
  const classes = ksefHistoryStaleClasses({
    tenants: (tenantsRes.data ?? []) as Array<{ id: string; ksef_verified_at: string | null }>,
    streams: (streamsRes.data ?? []) as HistoryStreamAlertRow[],
    cursors: (cursorsRes.data ?? []) as Array<{ tenant_id: string; last_page_at: string | null }>,
    now: Date.now(),
  });
  const total = Object.values(classes).reduce((a, b) => a + b, 0);
  if (total === 0) return { type, fired: false };

  if (!(await shouldSendAlert(type))) return { type, fired: false, reason: 'dedup' };
  await alertCritical(
    'Synchronizacja historii KSeF stoi',
    'Synchronizacja historii KSeF stoi. Sprawdź `scripts/ops/ksef-historia.sh stan`, kolejkę ksef.history-sync.tenant i cron.ksef-history-sync, Sentry. Po naprawie pobieranie wznowi się od zapisanego miejsca (docs/runbooks/synchronizacja-historii-ksef.md).',
    {
      fields: [
        { label: 'Bez startu sprzedaży (> 1 h od weryfikacji)', value: String(classes.noStartOutgoing) },
        { label: 'Bez startu zakupów (> 2 h; zwykle przyczynę pokazuje stale_inbox_sync)', value: String(classes.noStartIncoming) },
        { label: `Bez sukcesu > ${KSEF_HISTORY_STALE_HOURS} h`, value: String(classes.stalled) },
        { label: `Zaległość bez postępu > ${KSEF_HISTORY_BACKFILL_STUCK_HOURS} h`, value: String(classes.backfillStuck) },
        { label: 'Podejrzane błędy poświadczeń', value: String(classes.credentialsSuspicious) },
      ],
    },
  );
  await markAlertDelivered(type);
  return { type, fired: true };
}

/**
 * Faktury historii KSeF, których nie pobraliśmy z powodu wymagającego
 * operatora, i strumienie przy limicie dziennika — raz na dobę.
 */
export async function checkKsefHistoryBlocked(): Promise<AlertCheckResult> {
  const type = 'ksef_history_blocked';
  const environment = configuredKsefEnvironment();
  if (!environment) return { type, fired: false };
  const supabase = createAdminClient();
  const [countsRes, capacityRes] = await Promise.all([
    supabase.from('ksef_history_item_counts')
      .select('reason_code, item_count')
      .eq('environment', environment)
      .eq('status', 'blocked')
      .in('reason_code', [...KSEF_HISTORY_OPERATOR_REASONS]),
    supabase.from('ksef_history_sync')
      .select('id', { count: 'exact', head: true })
      .eq('environment', environment)
      .eq('backfill_issue', 'capacity'),
  ]);
  if (countsRes.error) throw countsRes.error;
  if (capacityRes.error || typeof capacityRes.count !== 'number') {
    throw capacityRes.error ?? new Error('ksef_history_sync capacity count unavailable');
  }
  const byReason = new Map<string, number>();
  for (const row of (countsRes.data ?? []) as Array<{ reason_code: string | null; item_count: number }>) {
    if (!row.reason_code) continue;
    byReason.set(row.reason_code, (byReason.get(row.reason_code) ?? 0) + (Number(row.item_count) || 0));
  }
  const blocked = [...byReason.values()].reduce((a, b) => a + b, 0);
  const capacity = capacityRes.count;
  if (blocked + capacity === 0) return { type, fired: false };

  if (!(await shouldSendAlert(type))) return { type, fired: false, reason: 'dedup' };
  await alertCritical(
    'Historia KSeF: faktury do sprawdzenia',
    'Synchronizacja historii KSeF odłożyła faktury, które wymagają operatora. Lista: `scripts/ops/ksef-historia.sh pozycje <firma>`; po wyjaśnieniu `odblokuj <firma> <powód> --tak` (docs/runbooks/synchronizacja-historii-ksef.md).',
    {
      fields: [
        ...[...byReason.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([reason, count]) => ({ label: reason, value: String(count) })),
        { label: 'Strumienie przy limicie 25 000', value: String(capacity) },
      ],
    },
  );
  await markAlertDelivered(type, KSEF_HISTORY_BLOCKED_TTL_SECONDS);
  return { type, fired: true };
}

/** Wiele firm z 429 w ostatniej godzinie — ten sam warunek co bezpiecznik fan-outu. */
export async function checkKsefHistoryRateLimited(): Promise<AlertCheckResult> {
  const type = 'ksef_history_rate_limited';
  const environment = configuredKsefEnvironment();
  if (!environment) return { type, fired: false };
  const { count, error } = await createAdminClient()
    .from('ksef_history_sync')
    .select('id', { count: 'exact', head: true })
    .eq('environment', environment)
    .eq('direction', 'outgoing')
    .gte('rate_limited_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());
  if (error || typeof count !== 'number') throw error ?? new Error('ksef_history_sync rate limit count unavailable');
  if (count < GLOBAL_429_TENANTS) return { type, fired: false };

  if (!(await shouldSendAlert(type))) return { type, fired: false, reason: 'dedup' };
  await alertCritical(
    'Historia KSeF: KSeF ogranicza tempo',
    'KSeF ogranicza tempo wielu firmom — pobieranie historii wstrzymane automatycznie, żeby nie ryzykować blokady adresu. Wysyłka i skrzynka działają. Sprawdź `ksef-historia.sh stan`; w razie potrzeby `wstrzymaj-wszystko`.',
    { fields: [{ label: 'Firmy z 429 w ostatniej godzinie', value: String(count) }] },
  );
  await markAlertDelivered(type);
  return { type, fired: true };
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runCriticalAlertsMonitor({ step }: JobContext) {
    const results = await Promise.all([
      step.run('check-ksef', () => checkKsefDowntime().catch(captureAndReturn('ksef_down'))),
      step.run('check-offline', () =>
        checkOfflineQueueBacklog().catch(captureAndReturn('offline_backlog')),
      ),
      step.run('check-offline-environment', () =>
        checkBlockedKsefOfflineQueue().catch(captureAndReturn('offline_environment_blocked')),
      ),
      step.run('check-inngest', () =>
        checkInngestFailures().catch(captureAndReturn('inngest_failures')),
      ),
      step.run('check-payments', () =>
        checkPaymentFailures().catch(captureAndReturn('payment_failures')),
      ),
      step.run('check-stale-refunds', () =>
        checkStaleRefundOperations().catch(captureAndReturn('stale_refund_operations')),
      ),
      step.run('check-stale-webhooks', () =>
        checkStaleStripeWebhookEvents().catch(captureAndReturn('stale_stripe_webhooks')),
      ),
      step.run('check-financial-cases', () =>
        checkOpenStripeFinancialCases().catch(captureAndReturn('open_stripe_financial_cases')),
      ),
      step.run('check-checkout-attempts', () =>
        checkStaleStripeCheckoutAttempts().catch(captureAndReturn('stale_stripe_checkout_attempts')),
      ),
      step.run('check-customer-attempts', () =>
        checkStaleStripeCustomerAttempts().catch(captureAndReturn('stale_stripe_customer_attempts')),
      ),
      step.run('check-stale-dunning-notifications', () =>
        checkStaleDunningNotifications().catch(captureAndReturn('stale_dunning_notifications')),
      ),
      step.run('check-stale-ksef-sending-invoices', () =>
        checkStaleKsefSendingInvoices().catch(captureAndReturn('stale_ksef_sending_invoices')),
      ),
      step.run('check-stale-billing-vat-enqueues', () =>
        checkStaleBillingVatEnqueues().catch(captureAndReturn('stale_billing_vat_enqueues')),
      ),
      step.run('check-paid-without-vat-invoice', () =>
        checkPaidWithoutVatInvoice().catch(captureAndReturn('paid_without_vat_invoice')),
      ),
      step.run('check-ksef-reconciliation', () =>
        checkKsefReconciliationAnomalies().catch(captureAndReturn('ksef_reconciliation')),
      ),
      step.run('check-ksef-lifecycle', () =>
        checkKsefLifecycleViolations().catch(captureAndReturn('ksef_lifecycle_violations')),
      ),
      step.run('check-stale-backup', () =>
        checkStaleBackup().catch(captureAndReturn('stale_backup')),
      ),
      step.run('check-stale-inbox-sync', () =>
        checkStaleInboxSync().catch(captureAndReturn('stale_inbox_sync')),
      ),
      // Synchronizacja historii KSeF (decyzja Bartosza 22.10.2026): 18 → 21.
      step.run('check-stale-ksef-history-sync', () =>
        checkStaleKsefHistorySync().catch(captureAndReturn('stale_ksef_history_sync')),
      ),
      step.run('check-ksef-history-blocked', () =>
        checkKsefHistoryBlocked().catch(captureAndReturn('ksef_history_blocked')),
      ),
      step.run('check-ksef-history-rate-limited', () =>
        checkKsefHistoryRateLimited().catch(captureAndReturn('ksef_history_rate_limited')),
      ),
    ]);

    return {
      checked: results.length,
      fired: results.filter((r) => r.fired).length,
      details: results,
    };
}

function captureAndReturn(type: string): (err: unknown) => AlertCheckResult {
  return (err) => {
    Sentry.captureException(err, {
      tags: { area: 'observability.critical-alerts', alertType: type },
    });
    return { type, fired: false, reason: 'check-error' };
  };
}
