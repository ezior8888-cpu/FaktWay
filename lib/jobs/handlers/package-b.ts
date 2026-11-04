/**
 * Paczka B (Etap 7.4): 17 jobów e-mail / billing / przypomnienia.
 *
 * Runnery żyją w lib/jobs/runners/*.
 *
 * Konfiguracja przeniesiona 1:1 z dawnych funkcji Inngest (etap 7):
 *   - retries: notify 2, sekwencja e-mail 2, dunning 3, send-reminder 3,
 *     reszta domyślnie 4,
 *   - dunning: concurrency per tenant → grupa pg-boss `groupConcurrency: 1`
 *     (natywny odpowiednik `concurrency: { key: 'event.data.tenantId' }`).
 *
 * Sekwencja e-maili: odstępy dniowe realizuje `step.scheduleAfter`, czyli
 * `startAfter` pg-boss (job czeka w tabeli, przeżywa restart workera).
 */

import { runCancelRemindersOnPayment } from '../runners/cancel-reminders-on-payment';
import { runCriticalAlertsMonitor } from '../runners/critical-alerts-monitor';
import { runDailyAnalyticsDigest } from '../runners/daily-analytics-digest';
import { runDailySummaryEmail } from '../runners/daily-summary-email';
import { runDunningPaymentFailed } from '../runners/dunning-payment-failed';
import {
  runEmailDay1,
  runEmailDay12,
  runEmailDay14,
  runEmailDay4,
  runEmailDay8,
  runEmailWelcome,
} from '../runners/email-sequence';
import {
  notifyRetryDelayMs,
  onNotifyExhausted,
  runNotifyFailure,
  runNotifySuccess,
} from '../runners/notify-user';
import { runReminderScheduler } from '../runners/reminder-scheduler';
import { runSendReminder } from '../runners/send-reminder';
import { runTrialCountdownEmails } from '../runners/trial-countdown-emails';
import { runWeeklyBusinessReview } from '../runners/weekly-business-review';
import { registerJob, type JobContext } from '../registry';

const DEFAULT_JOB_RETRIES = 4;

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

function eventJob<TData>(
  queue: string,
  runner: (data: TData, ctx: JobContext) => Promise<unknown>,
  opts: {
    maxRetries?: number;
    groupConcurrency?: number;
    getDelayMs?: (attempt: number) => number;
    onExhausted?: (error: Error, data: TData, ctx: JobContext) => Promise<unknown>;
  } = {},
): void {
  registerJob<TData>({
    queue,
    maxRetries: opts.maxRetries ?? DEFAULT_JOB_RETRIES,
    ...(opts.groupConcurrency !== undefined
      ? { groupConcurrency: opts.groupConcurrency }
      : {}),
    ...(opts.getDelayMs ? { getDelayMs: opts.getDelayMs } : {}),
    ...(opts.onExhausted ? { onExhausted: opts.onExhausted } : {}),
    handler: (data, ctx) => runner(data, ctx),
  });
}

// ── Crony ──
cronJob('cron.critical-alerts-monitor', runCriticalAlertsMonitor);
cronJob('cron.daily-analytics-digest', runDailyAnalyticsDigest);
cronJob('cron.daily-summary-email', runDailySummaryEmail);
cronJob('cron.reminder-scheduler', runReminderScheduler);
cronJob('cron.trial-countdown-emails', runTrialCountdownEmails);
cronJob('cron.weekly-business-review', runWeeklyBusinessReview);

// ── Powiadomienia o wyniku wysyłki faktury (retries 2 — lepiej nie wysłać
//    niż wysłać 4×; parytet z konfiguracją Inngest). Odstępy 5 i 30 min
//    zamiast 10 s / 30 s; po wyczerpaniu prób log i Sentry z numerem
//    faktury (A5 #3) ──
eventJob('invoice.submit.succeeded.notify', runNotifySuccess, {
  maxRetries: 2,
  getDelayMs: notifyRetryDelayMs,
  onExhausted: onNotifyExhausted('invoice.submit.succeeded.notify'),
});
eventJob('invoice.submit.failed.notify', runNotifyFailure, {
  maxRetries: 2,
  getDelayMs: notifyRetryDelayMs,
  onExhausted: onNotifyExhausted('invoice.submit.failed.notify'),
});

// ── Billing + przypomnienia ──
eventJob('billing.payment.failed', runDunningPaymentFailed, {
  maxRetries: 3,
  groupConcurrency: 1, // odpowiednik concurrency per tenantId
});
eventJob('reminders.send.requested', runSendReminder, { maxRetries: 3 });
eventJob('invoice.payment.received', runCancelRemindersOnPayment);

// ── Sekwencja onboardingowa (14 dni, łańcuch przez scheduleAfter) ──
eventJob('user.registered', runEmailWelcome, { maxRetries: 2 });
eventJob('email.trial-day-1', runEmailDay1, { maxRetries: 2 });
eventJob('email.trial-day-4', runEmailDay4, { maxRetries: 2 });
eventJob('email.trial-day-8', runEmailDay8, { maxRetries: 2 });
eventJob('email.trial-day-12', runEmailDay12, { maxRetries: 2 });
eventJob('email.trial-day-14', runEmailDay14, { maxRetries: 2 });
