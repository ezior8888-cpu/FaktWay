import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { alertCritical } from '@/lib/alerts/slack';
import {
  escapeTelegramHtml,
  isTelegramConfigured,
  sendTelegramMessage,
} from '@/lib/alerts/telegram';
import { buildTelegramReport } from '@/lib/jobs/runners/daily-summary-email';
import type { DailyMetrics } from '@/lib/observability/business-metrics';

const token = '123456:synthetic-telegram-secret';
const slackUrl = 'https://hooks.slack.com/services/T000/B000/synthetic-secret';
const rich = { fields: [{ label: 'Liczba', value: '1' }] };

function ok() {
  return { ok: true, status: 200 };
}
function fail(status = 500) {
  return { ok: false, status };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Telegram — konfiguracja', () => {
  it('bez tokenu albo bez czatów kanał jest wyłączony', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
    vi.stubEnv('TELEGRAM_ALERT_CHAT_IDS', '');
    expect(isTelegramConfigured()).toBe(false);

    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_ALERT_CHAT_IDS', '111');
    expect(isTelegramConfigured()).toBe(false);
  });

  it('odrzuca identyfikatory czatów, które nie są liczbami', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
    vi.stubEnv('TELEGRAM_ALERT_CHAT_IDS', '@kanal, abc');
    expect(isTelegramConfigured()).toBe(false);
  });

  it('bez konfiguracji nie wysyła nic i nie rzuca (fail-soft)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTelegramMessage('x')).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bez konfiguracji i z requireDelivery rzuca', async () => {
    await expect(sendTelegramMessage('x', { requireDelivery: true })).rejects.toThrow(
      'Telegram alert channel is not configured',
    );
  });
});

describe('Telegram — wysyłka', () => {
  beforeEach(() => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
    vi.stubEnv('TELEGRAM_ALERT_CHAT_IDS', '111, -222');
  });

  it('wysyła do każdego czatu z parse_mode HTML i liczy potwierdzenia', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail(403));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTelegramMessage('<b>x</b>', { silent: true })).resolves.toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      chat_id: '111',
      text: '<b>x</b>',
      parse_mode: 'HTML',
      disable_notification: true,
    });
    expect((JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body) as { chat_id: string }).chat_id).toBe('-222');
  });

  it('przy braku potwierdzenia z requireDelivery rzuca bez tokenu w treści błędu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`request to bot${token} failed`)),
    );

    let error: unknown;
    try {
      await sendTelegramMessage('x', { requireDelivery: true });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('Telegram delivery was not confirmed');
    expect(String(error)).not.toContain('synthetic-telegram-secret');
  });

  it('przycina zbyt długie wiadomości do limitu Bot API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegramMessage('a'.repeat(5000));

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as { text: string };
    expect(body.text.length).toBeLessThanOrEqual(4096);
  });
});

describe('escapeTelegramHtml', () => {
  it('escapuje &, < i >', () => {
    expect(escapeTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('alertCritical — Slack + Telegram', () => {
  beforeEach(() => {
    vi.stubEnv('SLACK_WEBHOOK_URGENT', slackUrl);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
    vi.stubEnv('TELEGRAM_ALERT_CHAT_IDS', '111');
  });

  function routedFetch(slack: object | Error, telegram: object | Error) {
    return vi.fn((url: string) => {
      const result = url.startsWith('https://hooks.slack.com/') ? slack : telegram;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    });
  }

  it('wysyła na oba kanały', async () => {
    const fetchMock = routedFetch(ok(), ok());
    vi.stubGlobal('fetch', fetchMock);

    await expect(alertCritical('KSeF niedostępny', '*5* min', rich)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('awaria Slacka nie gubi alarmu, gdy Telegram potwierdził', async () => {
    vi.stubGlobal('fetch', routedFetch(fail(500), ok()));

    await expect(alertCritical('Alarm', 'Opis', rich)).resolves.toBeUndefined();
  });

  it('awaria Telegrama nie gubi alarmu, gdy Slack potwierdził', async () => {
    vi.stubGlobal('fetch', routedFetch(ok(), new Error('network')));

    await expect(alertCritical('Alarm', 'Opis', rich)).resolves.toBeUndefined();
  });

  it('brak potwierdzenia na obu kanałach rzuca — deduplikacja się nie zapisze', async () => {
    vi.stubGlobal('fetch', routedFetch(fail(500), fail(502)));

    let error: unknown;
    try {
      await alertCritical('Alarm', 'Opis', rich);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('not confirmed on any channel');
    expect(String(error)).not.toContain('synthetic');
  });

  it('Telegram dostaje tekst bez gwiazdek Slacka i z escapowanym HTML', async () => {
    const fetchMock = routedFetch(ok(), ok());
    vi.stubGlobal('fetch', fetchMock);

    await alertCritical('Kolejka <offline>', 'Faktur: *12*', {
      fields: [{ label: 'Próg', value: '>= 50' }],
    });

    const telegramCall = fetchMock.mock.calls.find(([url]) => new URL(url).hostname === 'api.telegram.org');
    const text = (JSON.parse((telegramCall as unknown as [string, { body: string }])[1].body) as { text: string }).text;
    expect(text).toContain('<b>Kolejka &lt;offline&gt;</b>');
    expect(text).toContain('Faktur: 12');
    expect(text).toContain('Próg: &gt;= 50');
  });
});

describe('buildTelegramReport — raport dzienny', () => {
  const metrics: DailyMetrics = {
    period: { from: '2026-09-30T04:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
    signups: 3,
    newTenants: 2,
    onboardingCompletions: 1,
    firstInvoiceCount: 1,
    invoicesIssued: 12,
    invoicesAccepted: 11,
    invoicesFailed: 1,
    invoicesOfflineQueued: 0,
    ocrJobsCompleted: 4,
    ksefDowntimeMinutes: 7,
    ksefMaxConsecutiveFailures: 3,
    totalAuditErrors: 0,
    totalInngestFailures: 2,
    paymentsSucceeded: 2,
    paymentsFailed: 0,
    paymentsTotalGrossPln: 59.98,
  };

  it('zawiera same agregaty i pogrubiony nagłówek', () => {
    const report = buildTelegramReport(metrics);

    expect(report.startsWith('📊 <b>FaktWay — raport dzienny</b>')).toBe(true);
    expect(report).toContain('wystawione 12, przyjęte 11, nieudane 1, offline 0');
    expect(report).toContain('7 min niedostępności');
    expect(report).toContain('Błędy: audyt 0, joby 2');
  });

  it('jedyne znaczniki HTML to pogrubienie nagłówka', () => {
    const report = buildTelegramReport(metrics);
    const tags = report.match(/<[^>]+>/g) ?? [];
    expect(tags).toEqual(['<b>', '</b>']);
  });
});
