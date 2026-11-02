/**
 * Minimal Slack incoming-webhook transport.
 * Critical alerts require a confirmed 2xx response; bugs and metrics keep
 * the existing fail-soft behavior so Slack downtime cannot break user flows.
 *
 * Critical alerts are mirrored to Telegram when it is configured
 * (`lib/alerts/telegram.ts`) — Slack alone does not wake anyone at night.
 */

import { escapeTelegramHtml, isTelegramConfigured, sendTelegramMessage } from './telegram';

export type SlackChannel = 'urgent' | 'bugs' | 'metrics';

function getWebhookUrl(channel: SlackChannel): string | null {
  const envKey =
    channel === 'urgent'
      ? 'SLACK_WEBHOOK_URGENT'
      : channel === 'bugs'
        ? 'SLACK_WEBHOOK_BUGS'
        : 'SLACK_WEBHOOK_METRICS';
  const url = process.env[envKey]?.trim();
  if (!url) return null;
  if (url.startsWith('xxx') || !url.startsWith('https://hooks.slack.com/')) {
    return null;
  }
  return url;
}

export interface SlackMessage {
  channel: SlackChannel;
  /** Plain text; Slack accepts mrkdwn. */
  text: string;
  context?: Record<string, string | number | boolean>;
}

/** `true` = Slack potwierdził przyjęcie (2xx); `false` = brak webhooka albo błąd bez wymogu dostarczenia. */
async function postSlackAlert(
  msg: SlackMessage,
  requireDelivery: boolean,
): Promise<boolean> {
  const url = getWebhookUrl(msg.channel);
  if (!url) {
    if (requireDelivery) {
      throw new Error('Critical Slack webhook is not configured');
    }
    // AUD-83: alert bez webhooka znikał bez śladu. Pierwsza linia wystarczy,
    // żeby w logu było widać, co przepadło.
    console.warn(`[slack] brak webhooka ${msg.channel} — alert pominięty: ${msg.text.split('\n')[0]!.slice(0, 120)}`);
    return false;
  }

  const payload: Record<string, unknown> = { text: msg.text };
  if (msg.context && Object.keys(msg.context).length > 0) {
    payload.attachments = [{
      color:
        msg.channel === 'urgent'
          ? '#dc2626'
          : msg.channel === 'bugs'
            ? '#f59e0b'
            : '#3b82f6',
      fields: Object.entries(msg.context).map(([title, value]) => ({
        title,
        value: String(value),
        short: String(value).length < 30,
      })),
    }];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Never include the webhook URL, response body, or provider error in
      // exceptions; each can contain sensitive material.
      throw new Error('Slack delivery HTTP ' + response.status);
    }
    return true;
  } catch {
    if (requireDelivery) {
      throw new Error('Critical Slack delivery was not confirmed');
    }
    console.error('[slack] webhook delivery was not confirmed');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fail-soft transport for support, bugs, backups and metrics.
 *
 * Wynik mówi, czy Slack potwierdził przyjęcie. Większość wywołań go ignoruje;
 * „Połącz z człowiekiem” dzięki niemu nie obiecuje klientowi maila, gdy alert
 * nigdzie nie dotarł.
 */
export async function sendSlackAlert(msg: SlackMessage): Promise<boolean> {
  if (msg.channel !== 'urgent' || !isTelegramConfigured()) {
    return postSlackAlert(msg, false);
  }
  // Pilne (dziś: kopie bazy) idą też na Telegram, jak alarmy krytyczne —
  // sam Slack nikogo nie budzi (AUD-83). Oba kanały fail-soft.
  const [slack] = await Promise.all([
    postSlackAlert(msg, false),
    sendTelegramMessage(formatUrgentForTelegram(msg)).catch(() => {
      console.error('[telegram] pilny alert niedostarczony');
    }),
  ]);
  return slack;
}

function formatUrgentForTelegram(msg: SlackMessage): string {
  const lines = [`🚨 ${escapeTelegramHtml(msg.text.replace(/\*/g, ''))}`];
  for (const [label, value] of Object.entries(msg.context ?? {})) {
    lines.push(`• ${escapeTelegramHtml(label)}: ${escapeTelegramHtml(String(value))}`);
  }
  return lines.join('\n');
}

export interface SlackAlertRichContext {
  fields: { label: string; value: string }[];
  link?: { label: string; url: string };
}

/** Strict transport for the critical-alerts monitor. */
export async function alertCritical(
  title: string,
  bodyMrkdwn: string,
  rich: SlackAlertRichContext,
): Promise<void> {
  const text = '*' + title + '*\n' + bodyMrkdwn;
  const context: Record<string, string | number | boolean> = {};
  for (const field of rich.fields) {
    context[field.label] = field.value;
  }
  if (rich.link) {
    context[rich.link.label] = rich.link.url;
  }

  if (!isTelegramConfigured()) {
    await postSlackAlert({ channel: 'urgent', text, context }, true);
    return;
  }

  // Dwa kanały: alarm jest dostarczony, jeśli potwierdził go choć jeden.
  // Deduplikacja w monitorze zapisuje się dopiero po tym potwierdzeniu.
  const [slack, telegram] = await Promise.allSettled([
    postSlackAlert({ channel: 'urgent', text, context }, true),
    sendTelegramMessage(formatCriticalForTelegram(title, bodyMrkdwn, rich), {
      requireDelivery: true,
    }),
  ]);
  if (slack.status === 'rejected' && telegram.status === 'rejected') {
    throw new Error('Critical alert delivery was not confirmed on any channel');
  }
}

/** Slack mrkdwn → zwykły tekst w HTML Telegrama (gwiazdki pogrubienia znikają). */
function formatCriticalForTelegram(
  title: string,
  bodyMrkdwn: string,
  rich: SlackAlertRichContext,
): string {
  const lines = [
    `🚨 <b>${escapeTelegramHtml(title)}</b>`,
    escapeTelegramHtml(bodyMrkdwn.replace(/\*/g, '')),
  ];
  for (const field of rich.fields) {
    lines.push(`• ${escapeTelegramHtml(field.label)}: ${escapeTelegramHtml(field.value)}`);
  }
  if (rich.link) {
    lines.push(`${escapeTelegramHtml(rich.link.label)}: ${escapeTelegramHtml(rich.link.url)}`);
  }
  return lines.join('\n');
}

export async function alertMetrics(
  title: string,
  bodyMrkdwn: string,
  rows: { label: string; value: string }[],
): Promise<void> {
  const text = '*' + title + '*\n' + bodyMrkdwn;
  const context: Record<string, string | number | boolean> = {};
  for (const row of rows) {
    context[row.label] = row.value;
  }
  await sendSlackAlert({ channel: 'metrics', text, context });
}
