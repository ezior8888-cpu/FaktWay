import { sendSlackAlert } from '@/lib/alerts/slack';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import type { JobContext } from '@/lib/jobs/registry';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Cron `cron.ksef-lifecycle-report` (07:30 Europe/Warsaw): dzienny raport
 * cyklu życia faktury dla operatora (PR 4b) — liczby per stan, naruszenia
 * strażnika per inwariant, akcje automatu i ludzi z ostatniej doby.
 * Kanał `metrics` (Slack; bez pilności — pilne idą z monitora alarmów).
 *
 * D-A4-1b-3 PR B (decyzja 4, 00148): I5D — faktury czekające na decyzję
 * klienta — osobnym wierszem, nigdy w „Naruszeniach strażnika”.
 */

export const LIFECYCLE_REPORT_STATUSES = ['draft', 'queued', 'sending', 'offline_queued', 'failed', 'rejected'] as const;

export const LIFECYCLE_REPORT_ACTIONS = [
  'invoice.send_enqueued',
  'invoice.send_requeued',
  'invoice.send_reset',
  'invoice.enqueue_released',
  'invoice.operator_requeue',
  'invoice.operator_reconcile',
  'invoice.operator_reset',
  // D-A4-1b-3 PR B: decyzja klienta przy 440 (RPC), zapis operatora i powiadomienie klienta.
  'invoice.ksef_duplicate_decided',
  'invoice.operator_duplicate_decision',
  'invoice.ksef_duplicate_decision_notified',
  // D-A4-1b-3 PR C (00156): zapis oryginału z KSeF decyzją, oddanie decyzji klientowi po przeglądzie pliku (RPC i operator)
  // i trwały znacznik „sprawdź ponownie”. I5R i I3K idą do „Naruszeń strażnika” (nie są I5D) bez zmian kodu raportu.
  'invoice.ksef_original_imported',
  'invoice.ksef_original_review_released',
  'invoice.operator_original_release',
  'invoice.ksef_original_recheck_flagged',
] as const;

/** I5D (00148): faktury czekające na decyzję klienta przy nierozstrzygniętym 440. */
export interface ClientDecisionPendingSummary {
  count: number;
  /** Oryginał sprawdzony w innym (albo nieznanym) środowisku KSeF niż obecne — klient nie zapisze decyzji (I5D-env). */
  otherEnv: number;
  /** Najstarszy znacznik 440 (`detail.attempted_at`). */
  oldestAttemptAt: string | null;
}

export interface LifecycleReportInput {
  statuses: Record<string, number>;
  accepted24h: number;
  violations: Record<string, number>;
  actions24h: Record<string, number>;
  /** Ponowienia bez aktora (cron) w ostatniej dobie. */
  autoRequeues24h: number;
  /** I5D osobno od naruszeń; brak pola — bez wiersza. */
  clientDecisionPending?: ClientDecisionPendingSummary;
}

/** `Czekają na decyzję klienta (I5D): {n}` [` · w innym środowisku KSeF: {m}`] [` · najdłużej od {data}`] (2.11.D). */
function clientPendingLine(p: ClientDecisionPendingSummary): string {
  return `Czekają na decyzję klienta (I5D): ${p.count}`
    + (p.otherEnv > 0 ? ` · w innym środowisku KSeF: ${p.otherEnv}` : '')
    + (p.oldestAttemptAt ? ` · najdłużej od ${formatWarsawDateTime(p.oldestAttemptAt)}` : '');
}

/** Treść raportu — czysta funkcja do testów. */
export function formatLifecycleReport(input: LifecycleReportInput): string {
  const statusLine = LIFECYCLE_REPORT_STATUSES
    .map((s) => `${s} ${input.statuses[s] ?? 0}`)
    .join(' · ');
  const violationEntries = Object.entries(input.violations).sort(([a], [b]) => a.localeCompare(b));
  const violationLine = violationEntries.length === 0
    ? 'brak'
    : violationEntries.map(([inv, n]) => `${inv} ${n}`).join(' · ');
  const actionEntries = Object.entries(input.actions24h).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b));
  const actionLine = actionEntries.length === 0
    ? 'brak'
    : actionEntries.map(([a, n]) => `${a.replace('invoice.', '')} ${n}`).join(' · ');
  return [
    '*KSeF — cykl życia faktury, raport dzienny*',
    `Stany (wychodzące): ${statusLine}`,
    `Przyjęte w 24 h: ${input.accepted24h}`,
    `Naruszenia strażnika: ${violationLine}`,
    ...(input.clientDecisionPending ? [clientPendingLine(input.clientDecisionPending)] : []),
    `Akcje w 24 h: ${actionLine}`,
    `Ponowienia automatu w 24 h: ${input.autoRequeues24h}`,
  ].join('\n');
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.ksef-lifecycle-report).
 */
export async function runKsefLifecycleReport({ step, logger }: JobContext): Promise<LifecycleReportInput> {
  const supabase = createAdminClient();
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const statuses = await step.run('count-statuses', async (): Promise<Record<string, number>> => {
    const results = await Promise.all(LIFECYCLE_REPORT_STATUSES.map((status) =>
      supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('direction', 'outgoing').eq('ksef_status', status)));
    const out: Record<string, number> = {};
    results.forEach((r, i) => {
      if (r.error) throw new Error(`Raport: nie można policzyć stanu ${LIFECYCLE_REPORT_STATUSES[i]}: ${r.error.message}`);
      out[LIFECYCLE_REPORT_STATUSES[i]!] = r.count ?? 0;
    });
    return out;
  });

  const accepted24h = await step.run('count-accepted-24h', async (): Promise<number> => {
    const { count, error } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      // 00155 (decyzja Bartosza 22.10.2026): tylko faktury, które powinny mieć
      // UPO — ten sam predykat co I3. Sprzedaż spoza FaktWay pobrana z KSeF
      // (`ksef_import`) to nie są nasze wysyłki.
      .filter('ksef_upo_expected', 'eq', 'true')
      .gte('ksef_accepted_at', sinceIso);
    if (error) throw new Error(`Raport: nie można policzyć przyjętych: ${error.message}`);
    return count ?? 0;
  });

  const { violations, clientDecisionPending } = await step.run('count-violations', async (): Promise<{
    violations: Record<string, number>;
    clientDecisionPending: ClientDecisionPendingSummary;
  }> => {
    const { data, error } = await supabase.rpc('ksef_lifecycle_violations');
    if (error) throw new Error(`ksef_lifecycle_violations: ${error.message}`);
    const environment = configuredKsefEnvironment();
    const out: Record<string, number> = {};
    const pending: ClientDecisionPendingSummary = { count: 0, otherEnv: 0, oldestAttemptAt: null };
    let oldestMs = Infinity;
    for (const row of (data ?? []) as Array<{ invariant: string; detail?: unknown }>) {
      if (row.invariant !== 'I5D') {
        out[row.invariant] = (out[row.invariant] ?? 0) + 1;
        continue;
      }
      const detail = typeof row.detail === 'object' && row.detail !== null ? (row.detail as { env?: unknown; attempted_at?: unknown }) : {};
      pending.count += 1;
      if (environment === null || detail.env !== environment) pending.otherEnv += 1;
      const at = typeof detail.attempted_at === 'string' ? detail.attempted_at : null;
      const ms = at ? Date.parse(at) : Number.NaN;
      if (at && !Number.isNaN(ms) && ms < oldestMs) {
        oldestMs = ms;
        pending.oldestAttemptAt = at;
      }
    }
    return { violations: out, clientDecisionPending: pending };
  });

  const { actions24h, autoRequeues24h } = await step.run('count-actions-24h', async () => {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('action, user_id')
      .in('action', [...LIFECYCLE_REPORT_ACTIONS])
      .gte('created_at', sinceIso)
      .limit(5000);
    if (error) throw new Error(`Raport: nie można odczytać akcji: ${error.message}`);
    const counts: Record<string, number> = {};
    let auto = 0;
    for (const row of (data ?? []) as Array<{ action: string; user_id: string | null }>) {
      counts[row.action] = (counts[row.action] ?? 0) + 1;
      if (row.action === 'invoice.send_requeued' && row.user_id === null) auto += 1;
    }
    return { actions24h: counts, autoRequeues24h: auto };
  });

  const input: LifecycleReportInput = { statuses, accepted24h, violations, actions24h, autoRequeues24h, clientDecisionPending };
  await step.run('send-report', () => sendSlackAlert({
    channel: 'metrics',
    text: formatLifecycleReport(input),
    context: {
      failed: statuses.failed ?? 0,
      rejected: statuses.rejected ?? 0,
      naruszenia: Object.values(violations).reduce((a, b) => a + b, 0),
      czekaNaKlienta: clientDecisionPending.count,
    },
  }));
  logger.info('Cykl życia: raport dzienny wysłany', { ...input });
  return input;
}
