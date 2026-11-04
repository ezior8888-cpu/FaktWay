/**
 * Harmonogram skrzynki po stronie bazy (00160). Liczby i rachunki są w
 * `inbox-schedule.ts`; tu tylko RPC i rozsyłka w transakcji z pg-boss.
 *
 * Typy RPC są lokalne: `types/database.ts` generuje się z produkcji po wgraniu
 * migracji (AGENTS.md), więc do tego czasu nie zna tych funkcji.
 */

import { inboxPollTenant } from '@/lib/jobs/events';
import { withJobsTransaction, type JobsTransaction } from '@/lib/jobs/enqueue';
import { queuesForEvent } from '@/lib/jobs/queues';
import { createAdminClient } from '@/lib/supabase/admin';
import type { KsefEnvironment } from '@/types/ksef';

import {
  INBOX_ACTIVE_SUBSCRIPTION_STATUSES,
  INBOX_ACTIVITY_PULL_SECONDS,
  INBOX_ALARM_FAILING_MARGIN_MS,
  INBOX_ALARM_HWM_MARGIN_MS,
  INBOX_ALARM_OVERDUE_MS,
  INBOX_BRAKE_WINDOW_SECONDS,
  INBOX_DISPATCH_CHUNK,
  INBOX_LEASE_SECONDS,
  INBOX_NUDGE_MIN_SECONDS,
  inboxExpectedGapSeconds,
  type InboxActivityTier,
  type InboxPollErrorClass,
} from './inbox-schedule';

interface RpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

function client(): RpcClient {
  return createAdminClient() as unknown as RpcClient;
}

function firstRow<T>(data: unknown): T | null {
  return Array.isArray(data) ? ((data[0] as T | undefined) ?? null) : null;
}

export interface InboxPollBacklog {
  due: number;
  inFlight: number;
  oldestDueAt: string | null;
  polledRecent: number;
  rateLimitedRecent: number;
}

/** Liczby jednego taktu. Błąd rzuca: bez nich nie wiadomo, ile wolno wysłać. */
export async function readInboxPollBacklog(environment: KsefEnvironment): Promise<InboxPollBacklog> {
  const { data, error } = await client().rpc('ksef_inbox_poll_backlog', {
    p_environment: environment,
    p_recent_seconds: INBOX_BRAKE_WINDOW_SECONDS,
  });
  if (error) throw new Error(`Skrzynka: odczyt zaległości harmonogramu: ${error.message}`);
  const row = firstRow<{
    due: number | string;
    in_flight: number | string;
    oldest_due_at: string | null;
    polled_recent: number | string;
    rate_limited_recent: number | string;
  }>(data);
  return {
    due: Number(row?.due ?? 0),
    inFlight: Number(row?.in_flight ?? 0),
    oldestDueAt: row?.oldest_due_at ?? null,
    polledRecent: Number(row?.polled_recent ?? 0),
    rateLimitedRecent: Number(row?.rate_limited_recent ?? 0),
  };
}

/**
 * Należne firmy → zlecenia, paczkami. Wybór z dzierżawą i zapis zleceń idą
 * w jednej transakcji: bez dzierżawy bez zlecenia i odwrotnie. Gdy zapis padnie,
 * firma zostaje należna i bierze ją następny takt.
 *
 * `groupId` = NIP: bez tego limit „jeden przebieg na NIP” w pg-boss nie działa,
 * a dwa równoległe przebiegi tej samej firmy dublują powiadomienia (AUD-91).
 *
 * `options.queue` tylko dla testu na bazie (kolejka, której nie ma = błąd zapisu).
 */
export async function dispatchDueInboxPolls(
  environment: KsefEnvironment,
  limit: number,
  options: { queue?: string } = {},
): Promise<number> {
  const queue = options.queue ?? queuesForEvent(inboxPollTenant.name)[0]!;
  let sent = 0;
  while (sent < limit) {
    const chunk = Math.min(INBOX_DISPATCH_CHUNK, limit - sent);
    const claimed = await withJobsTransaction(async (tx: JobsTransaction, boss) => {
      const { rows } = await tx.executeSql(
        'SELECT tenant_id, nip, due_at FROM public.claim_ksef_inbox_polls($1, $2, $3)',
        [environment, chunk, INBOX_LEASE_SECONDS],
      );
      const firms = rows as Array<{ tenant_id: string; nip: string; due_at: string | Date }>;
      if (firms.length === 0) return 0;
      await boss.insert(
        queue,
        firms.map((firm) => ({
          data: inboxPollTenant.create({
            tenantId: firm.tenant_id,
            nip: firm.nip,
            environment,
            dueAt: new Date(firm.due_at).toISOString(),
          }).data,
          group: { id: firm.nip },
        })),
        { db: tx },
      );
      return firms.length;
    });
    sent += claimed;
    if (claimed < chunk) break;
  }
  return sent;
}

export interface InboxPollState {
  next_poll_at: string;
  poll_lease_until: string | null;
  consecutive_errors: number;
  last_invoice_at: string | null;
  last_activity_at: string | null;
  subscription_active: boolean;
}

/** Stan firmy na starcie przebiegu; `null` = brak wiersza (zlecenie sprzed wdrożenia). */
export async function readInboxPollState(tenantId: string): Promise<InboxPollState | null> {
  const { data, error } = await client().rpc('ksef_inbox_poll_state', {
    p_tenant_id: tenantId,
    p_active_statuses: INBOX_ACTIVE_SUBSCRIPTION_STATUSES,
  });
  if (error) throw new Error(`Skrzynka: odczyt harmonogramu firmy: ${error.message}`);
  return firstRow<InboxPollState>(data);
}

export async function finishInboxPoll(input: {
  tenantId: string;
  startedAt: Date;
  nextPollAt: Date;
  tier: InboxActivityTier;
  newInvoices: number;
  errorClass: InboxPollErrorClass | null;
}): Promise<void> {
  const { error } = await client().rpc('finish_ksef_inbox_poll', {
    p_tenant_id: input.tenantId,
    p_started_at: input.startedAt.toISOString(),
    p_next_poll_at: input.nextPollAt.toISOString(),
    p_activity_tier: input.tier,
    p_new_invoices: input.newInvoices,
    p_error_class: input.errorClass,
  });
  if (error) throw new Error(`Skrzynka: zapis harmonogramu firmy: ${error.message}`);
}

export type InboxActivityStatus = 'accepted' | 'in_flight' | 'too_soon';

export interface InboxActivityResult {
  status: InboxActivityStatus;
  retryAfterSeconds: number;
}

/**
 * Aktywność klienta. `requestPoll` = wejście do Skrzynki albo „Sprawdź teraz”.
 * `null` = firma bez KSeF. Wołający sprawdza członkostwo PRZED wywołaniem:
 * RPC jest tylko dla serwera.
 */
export async function noteInboxActivity(
  tenantId: string,
  options: { requestPoll: boolean },
): Promise<InboxActivityResult | null> {
  const { data, error } = await client().rpc('note_ksef_inbox_activity', {
    p_tenant_id: tenantId,
    p_request_poll: options.requestPoll,
    p_min_gap_seconds: INBOX_NUDGE_MIN_SECONDS,
    p_pull_seconds: INBOX_ACTIVITY_PULL_SECONDS,
  });
  if (error) throw new Error(`Skrzynka: zapis aktywności: ${error.message}`);
  const row = firstRow<{ status: InboxActivityStatus; retry_after_seconds: number }>(data);
  return row ? { status: row.status, retryAfterSeconds: Number(row.retry_after_seconds) || 0 } : null;
}

export interface InboxAlarmCounts {
  live: number;
  overdue: number;
  failing: number;
  hwmBehind: number;
  credentials: number;
  rateLimited: number;
  unscheduled: number;
}

/** Liczby alarmu: opóźnienie względem harmonogramu, liczone w bazie, bez list firm. */
export async function readInboxAlarmCounts(environment: KsefEnvironment): Promise<InboxAlarmCounts> {
  const { data, error } = await client().rpc('ksef_inbox_alarm_counts', {
    p_environment: environment,
    p_overdue_seconds: INBOX_ALARM_OVERDUE_MS / 1000,
    p_failing_margin_seconds: INBOX_ALARM_FAILING_MARGIN_MS / 1000,
    p_hwm_margin_seconds: INBOX_ALARM_HWM_MARGIN_MS / 1000,
    p_expected_gap_seconds: inboxExpectedGapSeconds(),
  });
  if (error) throw error;
  const row = firstRow<Record<string, number | string>>(data);
  return {
    live: Number(row?.live ?? 0),
    overdue: Number(row?.overdue ?? 0),
    failing: Number(row?.failing ?? 0),
    hwmBehind: Number(row?.hwm_behind ?? 0),
    credentials: Number(row?.credentials ?? 0),
    rateLimited: Number(row?.rate_limited ?? 0),
    unscheduled: Number(row?.unscheduled ?? 0),
  };
}
