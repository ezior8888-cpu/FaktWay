/**
 * Paczka A (Etap 7.3): 14 cronów utrzymaniowych — rejestracje pg-boss.
 *
 * Runnery żyją w lib/jobs/runners/*. Kolejki cron.* planuje worker wg
 * CRON_JOBS z lib/jobs/queues.ts (harmonogramy przeniesione 1:1 z dawnych
 * triggerów Inngest; Inngest odpięty w etapie 10).
 *
 * Domyślnie 4 ponowne próby (jak dawniej w Inngest); wyjątek
 * nightly-validation-recheck (retries: 1 w konfiguracji joba).
 */

import { runArchiveOldInvoices } from '../runners/archive-old-invoices';
import { runCertExpiryAlert } from '../runners/cert-expiry-alert';
import { runCleanupAuditLogs } from '../runners/cleanup-audit-logs';
import { runCleanupOldBackups } from '../runners/cleanup-old-backups';
import { runDailyDbSnapshot } from '../runners/daily-db-snapshot';
import { runGdprProcessDeletions } from '../runners/gdpr-process-deletions';
import { runJobsWatchdog } from '../runners/jobs-watchdog';
import { runKsefHealthCheck } from '../runners/ksef-health-check';
import { runKsefLifecycleReconcile } from '../runners/ksef-lifecycle-reconcile';
import { runKsefLifecycleReport } from '../runners/ksef-lifecycle-report';
import { runNightlyValidationRecheck } from '../runners/nightly-validation-recheck';
import { runRetentionDelete } from '../runners/retention-delete';
import { runSupportChatRetention } from '../runners/support-chat-retention';
import { runVerifyBackup } from '../runners/verify-backup';
import { registerJob, type JobContext } from '../registry';

const DEFAULT_JOB_RETRIES = 4;

/** Cron bez payloadu — handler ignoruje dane, odpala runner z kontekstem. */
function cronJob(
  queue: string,
  runner: (ctx: JobContext) => Promise<unknown>,
  maxRetries: number = DEFAULT_JOB_RETRIES,
): void {
  registerJob<Record<string, never>>({
    queue,
    maxRetries,
    handler: (_data, ctx) => runner(ctx),
  });
}

cronJob('cron.archive-old-invoices', runArchiveOldInvoices);
cronJob('cron.cert-expiry-alert', runCertExpiryAlert);
// Sprzątanie dzienników paczkami (00157): ponowienie od zera powtarza cały
// 10-minutowy budżet, więc 1 retry (błąd przejściowy); resztę bierze następna noc.
cronJob('cron.cleanup-audit-logs', runCleanupAuditLogs, 1);
cronJob('cron.cleanup-old-backups', runCleanupOldBackups);
cronJob('cron.daily-db-snapshot', runDailyDbSnapshot);
cronJob('cron.gdpr-process-deletions', runGdprProcessDeletions);
cronJob('cron.jobs-watchdog', runJobsWatchdog);
cronJob('cron.ksef-health-check', runKsefHealthCheck);
// Cykl życia faktury (PR 4b): przebieg jest idempotentny (RPC + warunki w UPDATE),
// więc ponowienie po błędzie nie dubluje zleceń; 1 retry wystarczy.
cronJob('cron.ksef-lifecycle-reconcile', runKsefLifecycleReconcile, 1);
cronJob('cron.ksef-lifecycle-report', runKsefLifecycleReport, 1);
cronJob(
  'cron.nightly-validation-recheck',
  runNightlyValidationRecheck,
  1, // parytet: retries: 1 w konfiguracji Inngest tego joba
);
cronJob('cron.retention-delete', runRetentionDelete);
// Retencja czatu pomocy (polityka prywatności, 24 mies.): przebieg idempotentny.
cronJob('cron.support-chat-retention', runSupportChatRetention);
cronJob('cron.verify-backup', runVerifyBackup);
