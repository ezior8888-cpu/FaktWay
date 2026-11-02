import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { alertCritical, sendSlackAlert } from '@/lib/alerts/slack';

const webhookUrl = 'https://hooks.slack.com/services/T000/B000/synthetic-secret';
const rich = { fields: [{ label: 'Liczba', value: '1' }] };

beforeEach(() => {
  vi.stubEnv('SLACK_WEBHOOK_URGENT', webhookUrl);
  vi.stubEnv('SLACK_WEBHOOK_BUGS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('critical Slack delivery', () => {
  it('rejects absent configuration without calling fetch or exposing a secret', async () => {
    vi.stubEnv('SLACK_WEBHOOK_URGENT', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(alertCritical('Alarm', 'Opis', rich))
      .rejects.toThrow('Critical Slack webhook is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 429, 500])('rejects HTTP %i without including the webhook URL', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status });
    vi.stubGlobal('fetch', fetchMock);

    let error: unknown;
    try {
      await alertCritical('Alarm', 'Opis', rich);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('Critical Slack delivery was not confirmed');
    expect(String(error)).not.toContain(webhookUrl);
    expect(String(error)).not.toContain('synthetic-secret');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a network failure without leaking the original provider error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new Error('request to ' + webhookUrl + ' failed'),
    );
    vi.stubGlobal('fetch', fetchMock);

    let error: unknown;
    try {
      await alertCritical('Alarm', 'Opis', rich);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('Critical Slack delivery was not confirmed');
    expect(String(error)).not.toContain(webhookUrl);
  });

  it('rejects a request that exceeds the transport timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(new Error('aborted at ' + webhookUrl)));
      }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = alertCritical('Alarm', 'Opis', rich);
    const assertion = expect(pending)
      .rejects.toThrow('Critical Slack delivery was not confirmed');
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('accepts only a confirmed 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(alertCritical('Alarm', 'Opis', rich)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the noncritical transport fail-soft', async () => {
    vi.stubEnv('SLACK_WEBHOOK_BUGS', webhookUrl);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bez wyjątku, ale z informacją, że nie doszło („Połącz z człowiekiem” z niej korzysta).
    await expect(sendSlackAlert({ channel: 'bugs', text: 'synthetic' }))
      .resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(webhookUrl);
  });
});
