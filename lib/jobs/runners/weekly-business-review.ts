/**
 * Weekly business review (Faza 27).
 *
 * Poniedziałek 09:00 PL — wysyła operatorowi mail z biznes KPI poprzedniego
 * tygodnia (MRR, churn, ARPU, signups) + posyła krótkie podsumowanie do
 * Slack #metrics.
 *
 * Idempotency: cron weekly, niski risk duplikatów.
 */

import * as Sentry from '@sentry/nextjs';

import { alertMetrics } from '@/lib/alerts/slack';
import { sendEmail } from '@/lib/email/send';
import {
  getWeeklyMetrics,
  type WeeklyMetrics,
} from '@/lib/observability/business-metrics';

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

function buildHtml(m: WeeklyMetrics): string {
  const churnPct =
    m.activeSubscriptions + m.churnedSubscriptions > 0
      ? Math.round(
          (m.churnedSubscriptions /
            (m.activeSubscriptions + m.churnedSubscriptions)) *
            100,
        )
      : 0;

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
    .hero { background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px; }
    .hero-value { color: #10b981; font-size: 36px; font-weight: 700; margin: 0; }
    .hero-label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin: 4px 0 0; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 16px 0; }
    .stat { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
    .stat-label { color: #6b7280; font-size: 11px; text-transform: uppercase; margin: 0; }
    .stat-value { color: #111; font-size: 22px; font-weight: 600; margin: 4px 0 0; }
    h2 { color: #374151; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; margin: 32px 0 8px; }
    .footer { color: #9ca3af; font-size: 11px; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📈 Weekly business review — FaktWay</h1>
    <p class="period">Tydzień ${new Date(m.period.from).toLocaleDateString('pl-PL', { day: '2-digit', month: 'long' })} → ${new Date(m.period.to).toLocaleDateString('pl-PL', { day: '2-digit', month: 'long' })}</p>

    <div class="hero">
      <p class="hero-value">${fmtPln(m.mrrPln)}</p>
      <p class="hero-label">MRR (Monthly Recurring Revenue)</p>
    </div>

    <h2>Subscriptions</h2>
    <div class="grid">
      <div class="stat"><p class="stat-label">Aktywne</p><p class="stat-value">${fmtNum(m.activeSubscriptions)}</p></div>
      <div class="stat"><p class="stat-label">W trialu</p><p class="stat-value">${fmtNum(m.trialingSubscriptions)}</p></div>
      <div class="stat"><p class="stat-label">Churned (7d)</p><p class="stat-value" style="color:${m.churnedSubscriptions > 5 ? '#dc2626' : '#111'}">${fmtNum(m.churnedSubscriptions)} (${churnPct}%)</p></div>
      <div class="stat"><p class="stat-label">ARPU</p><p class="stat-value">${fmtPln(m.arpu)}</p></div>
    </div>

    <h2>Acquisition (7d)</h2>
    <div class="grid">
      <div class="stat"><p class="stat-label">Signups</p><p class="stat-value">${fmtNum(m.signups)}</p></div>
      <div class="stat"><p class="stat-label">Onboarding ukończony</p><p class="stat-value">${fmtNum(m.onboardingCompletions)}</p></div>
    </div>

    <h2>Operations (7d)</h2>
    <div class="grid">
      <div class="stat"><p class="stat-label">Faktur wystawionych</p><p class="stat-value">${fmtNum(m.invoicesIssued)}</p></div>
      <div class="stat"><p class="stat-label">Płatności OK</p><p class="stat-value">${fmtNum(m.paymentsSucceeded)}</p></div>
      <div class="stat"><p class="stat-label">KSeF downtime</p><p class="stat-value" style="color:${m.ksefDowntimeMinutes > 60 ? '#dc2626' : '#111'}">${fmtNum(m.ksefDowntimeMinutes)} min</p></div>
      <div class="stat"><p class="stat-label">Job failures</p><p class="stat-value" style="color:${m.totalInngestFailures > 50 ? '#dc2626' : '#111'}">${fmtNum(m.totalInngestFailures)}</p></div>
    </div>

    <p class="footer">FaktWay weekly review · Generowany ${new Date().toLocaleString('pl-PL')}</p>
  </div>
</body>
</html>`;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runWeeklyBusinessReview({ step, logger }: JobContext) {
    const recipients = parseAdminEmails();
    if (recipients.length === 0) {
      logger.warn('ADMIN_EMAILS pusty — weekly review skipped');
      return { skipped: true };
    }

    const metrics = await step.run('aggregate-weekly', () => getWeeklyMetrics());
    const html = buildHtml(metrics);
    const subject = `📈 FaktWay weekly: MRR ${metrics.mrrPln} zł, ${metrics.signups} nowych`;

    // Email do każdego admina.
    await step.run('send-emails', async () => {
      for (const email of recipients) {
        try {
          await sendEmail({
            to: email,
            subject,
            html,
            category: 'transactional',
          });
        } catch (e) {
          Sentry.captureException(e, {
            tags: { area: 'observability.weekly-review' },
            extra: { recipient: email },
          });
        }
      }
    });

    // Slack #metrics — krótki summary (ludzie czytają Slack częściej niż mail).
    await step.run('post-slack', async () => {
      await alertMetrics(
        '📈 Weekly review',
        `Tydzień zamknięty — *${metrics.signups}* signups, *${metrics.invoicesIssued}* faktur, churn *${metrics.churnedSubscriptions}*`,
        [
          { label: 'MRR', value: `${metrics.mrrPln} zł` },
          { label: 'Active', value: String(metrics.activeSubscriptions) },
          { label: 'Trial', value: String(metrics.trialingSubscriptions) },
          { label: 'ARPU', value: `${metrics.arpu} zł` },
          {
            label: 'KSeF downtime',
            value: `${metrics.ksefDowntimeMinutes} min`,
          },
          { label: 'Inngest fails', value: String(metrics.totalInngestFailures) },
        ],
      );
    });

    return {
      recipients: recipients.length,
      mrr: metrics.mrrPln,
      signups: metrics.signups,
    };
}

