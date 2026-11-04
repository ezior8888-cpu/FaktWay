/**
 * Daily summary email (Faza 27).
 *
 * Codziennie 06:00 PL wysyła operatorowi (ADMIN_EMAILS) raport dzienny:
 * signups, faktury (issued/accepted/failed), KSeF uptime, payments, errors.
 *
 * Dlaczego email zamiast Slack: szczegółowe metryki w mailu są bardziej
 * skanowalne niż wall of text w Slack. Slack #metrics dostaje tylko
 * critical KPI summary (przez Krok 6 = weekly review).
 *
 * Idempotency: cron leci raz dziennie, brak retry-loop risk. Inngest
 * gwarantuje at-most-once dla crontab triggers.
 */

import * as Sentry from '@sentry/nextjs';

import { escapeTelegramHtml, isTelegramConfigured, sendTelegramMessage } from '@/lib/alerts/telegram';
import { sendEmail } from '@/lib/email/send';
import { getDailyMetrics, type DailyMetrics } from '@/lib/observability/business-metrics';

import type { JobContext } from '@/lib/jobs/registry';

function parseAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));
}

function fmtNum(n: number): string {
  return n.toLocaleString('pl-PL');
}

function fmtPln(n: number): string {
  return n.toLocaleString('pl-PL', { style: 'currency', currency: 'PLN' });
}

function buildHtml(metrics: DailyMetrics): string {
  const periodLabel = `${new Date(metrics.period.from).toLocaleDateString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
  })} → ${new Date(metrics.period.to).toLocaleDateString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
  })}`;

  const ksefStatus =
    metrics.ksefDowntimeMinutes > 30
      ? `<span style="color:#dc2626;font-weight:600">${metrics.ksefDowntimeMinutes} min downtime</span>`
      : metrics.ksefDowntimeMinutes > 0
        ? `<span style="color:#f59e0b">${metrics.ksefDowntimeMinutes} min downtime</span>`
        : '<span style="color:#10b981">100% uptime</span>';

  const acceptanceRate =
    metrics.invoicesIssued > 0
      ? Math.round((metrics.invoicesAccepted / metrics.invoicesIssued) * 100)
      : 100;

  return `
<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f6f6f6; margin: 0; padding: 20px; }
    .container { max-width: 640px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 12px; }
    h1 { color: #111; font-size: 22px; margin: 0 0 4px; }
    .period { color: #6b7280; font-size: 14px; margin: 0 0 24px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 16px 0; }
    .stat { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
    .stat-label { color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0; }
    .stat-value { color: #111; font-size: 20px; font-weight: 600; margin: 4px 0 0; }
    h2 { color: #374151; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; margin: 24px 0 8px; }
    .warning { background: #fef3c7; border: 1px solid #fde68a; padding: 12px; border-radius: 8px; margin: 16px 0; color: #92400e; font-size: 14px; }
    .footer { color: #9ca3af; font-size: 11px; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Daily summary — FaktWay</h1>
    <p class="period">${periodLabel}</p>

    <h2>Acquisition</h2>
    <div class="grid">
      <div class="stat"><p class="stat-label">Nowi userzy</p><p class="stat-value">${fmtNum(metrics.signups)}</p></div>
      <div class="stat"><p class="stat-label">Nowe organizacje</p><p class="stat-value">${fmtNum(metrics.newTenants)}</p></div>
    </div>

    <h2>Operations</h2>
    <div class="grid">
      <div class="stat"><p class="stat-label">Faktury wystawione</p><p class="stat-value">${fmtNum(metrics.invoicesIssued)}</p></div>
      <div class="stat"><p class="stat-label">Zaakceptowane przez KSeF</p><p class="stat-value">${fmtNum(metrics.invoicesAccepted)} (${acceptanceRate}%)</p></div>
      <div class="stat"><p class="stat-label">Faktury z błędem</p><p class="stat-value" style="color:${metrics.invoicesFailed > 0 ? '#dc2626' : '#111'}">${fmtNum(metrics.invoicesFailed)}</p></div>
      <div class="stat"><p class="stat-label">Offline24 queue</p><p class="stat-value" style="color:${metrics.invoicesOfflineQueued > 0 ? '#f59e0b' : '#111'}">${fmtNum(metrics.invoicesOfflineQueued)}</p></div>
      <div class="stat"><p class="stat-label">OCR jobs</p><p class="stat-value">${fmtNum(metrics.ocrJobsCompleted)}</p></div>
      <div class="stat"><p class="stat-label">KSeF status</p><p class="stat-value" style="font-size:14px">${ksefStatus}</p></div>
    </div>

    <h2>Billing</h2>
    <div class="grid">
      <div class="stat"><p class="stat-label">Płatności OK</p><p class="stat-value">${fmtNum(metrics.paymentsSucceeded)}</p></div>
      <div class="stat"><p class="stat-label">Suma brutto</p><p class="stat-value">${fmtPln(metrics.paymentsTotalGrossPln)}</p></div>
      ${
        metrics.paymentsFailed > 0
          ? `<div class="stat" style="grid-column: span 2; border-color: #fde68a; background: #fef3c7"><p class="stat-label" style="color:#92400e">Płatności nieudane (⚠️)</p><p class="stat-value" style="color:#dc2626">${fmtNum(metrics.paymentsFailed)}</p></div>`
          : ''
      }
    </div>

    <h2>Errors</h2>
    <div class="grid">
      <div class="stat"><p class="stat-label">Inngest job failures</p><p class="stat-value" style="color:${metrics.totalInngestFailures > 10 ? '#dc2626' : '#111'}">${fmtNum(metrics.totalInngestFailures)}</p></div>
      <div class="stat"><p class="stat-label">Max consecutive KSeF fails</p><p class="stat-value" style="color:${metrics.ksefMaxConsecutiveFailures > 3 ? '#dc2626' : '#111'}">${fmtNum(metrics.ksefMaxConsecutiveFailures)}</p></div>
    </div>

    ${
      metrics.invoicesOfflineQueued > 5 || metrics.paymentsFailed > 5
        ? `<div class="warning">⚠️ Coś wymaga uwagi — sprawdź /admin/system + /admin/support w panelu.</div>`
        : ''
    }

    <p class="footer">FaktWay operations dashboard · Generowany ${new Date().toLocaleString('pl-PL')}</p>
  </div>
</body>
</html>`;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runDailySummaryEmail({ step, logger }: JobContext) {
    const recipients = parseAdminEmails();
    const telegram = isTelegramConfigured();
    if (recipients.length === 0 && !telegram) {
      logger.warn('ADMIN_EMAILS pusty i brak Telegrama — daily summary skipped');
      return { skipped: true, reason: 'no-recipients' };
    }

    const metrics = await step.run('aggregate', () => getDailyMetrics(24));

    // Telegram: te same liczby co w mailu, bez dźwięku — to raport, nie alarm.
    // Fail-soft: brak dostarczenia nie blokuje maila.
    const telegramDelivered = telegram
      ? await step.run('send-telegram', () =>
          sendTelegramMessage(buildTelegramReport(metrics), { silent: true }),
        )
      : 0;

    if (recipients.length === 0) {
      return { recipients: 0, sent: 0, failed: 0, telegramDelivered };
    }

    const html = buildHtml(metrics);
    const subject = `📊 FaktWay daily: ${metrics.invoicesIssued} faktur, ${metrics.paymentsSucceeded} płatności`;

    const results = await step.run('send-emails', async () => {
      const sent: Array<{ email: string; ok: boolean }> = [];
      for (const email of recipients) {
        try {
          const result = await sendEmail({
            to: email,
            subject,
            html,
            category: 'transactional',
          });
          sent.push({ email, ok: result.sent });
        } catch (e) {
          Sentry.captureException(e, {
            tags: { area: 'observability.daily-summary' },
            extra: { recipient: email },
          });
          sent.push({ email, ok: false });
        }
      }
      return sent;
    });

    return {
      recipients: recipients.length,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      telegramDelivered,
    };
}

/**
 * Raport dzienny dla Telegrama — wyłącznie agregaty (bez nazw firm, e-maili,
 * NIP-ów), bo wiadomość trafia na serwery Telegrama.
 */
export function buildTelegramReport(metrics: DailyMetrics): string {
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
  const ksef =
    metrics.ksefDowntimeMinutes > 0
      ? `⚠️ ${fmtNum(metrics.ksefDowntimeMinutes)} min niedostępności (maks. ${fmtNum(metrics.ksefMaxConsecutiveFailures)} nieudanych prób z rzędu)`
      : '✅ dostępny przez całą dobę';
  const header = `📊 <b>FaktWay — raport dzienny</b> (${day(metrics.period.from)} → ${day(metrics.period.to)})`;
  const body = [
    `Rejestracje: ${fmtNum(metrics.signups)} · nowe firmy: ${fmtNum(metrics.newTenants)} · pierwsza faktura: ${fmtNum(metrics.firstInvoiceCount)}`,
    `Faktury: wystawione ${fmtNum(metrics.invoicesIssued)}, przyjęte ${fmtNum(metrics.invoicesAccepted)}, nieudane ${fmtNum(metrics.invoicesFailed)}, offline ${fmtNum(metrics.invoicesOfflineQueued)}`,
    `KSeF: ${ksef}`,
    `Płatności: udane ${fmtNum(metrics.paymentsSucceeded)} (${fmtPln(metrics.paymentsTotalGrossPln)}), nieudane ${fmtNum(metrics.paymentsFailed)}`,
    `Błędy: audyt ${fmtNum(metrics.totalAuditErrors)}, joby ${fmtNum(metrics.totalInngestFailures)}`,
  ];
  // Nagłówek składamy z liczb i dat, więc nie ma w nim treści do escapowania.
  return [header, '', ...body.map(escapeTelegramHtml)].join('\n');
}

