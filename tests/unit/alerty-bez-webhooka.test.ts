import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AUD-83: alert bez skonfigurowanego webhooka Slack znikał bez śladu, a pilne
// alerty kopii bazy (`sendSlackAlert('urgent')`) nie szły na Telegram, choć
// alarmy krytyczne idą tam od #120. Teraz pilny alert idzie też na Telegram,
// a pominięty — zostawia ślad w logu.

const mocks = vi.hoisted(() => ({ telegram: vi.fn(), configured: true }));
vi.mock('@/lib/alerts/telegram', () => ({
  isTelegramConfigured: () => mocks.configured,
  sendTelegramMessage: mocks.telegram,
  escapeTelegramHtml: (s: string) => s,
}));

import { sendSlackAlert } from '@/lib/alerts/slack';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured = true;
  mocks.telegram.mockResolvedValue({ delivered: 1 });
  vi.stubEnv('SLACK_WEBHOOK_URGENT', '');
  vi.stubEnv('SLACK_WEBHOOK_BUGS', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('sendSlackAlert', () => {
  it('pilny alert idzie na Telegram także bez webhooka Slack', async () => {
    await sendSlackAlert({ channel: 'urgent', text: '❌ DB snapshot FAILED', context: { kind: 'daily' } });
    expect(mocks.telegram).toHaveBeenCalledOnce();
    expect(String(mocks.telegram.mock.calls[0]![0])).toContain('DB snapshot FAILED');
  });

  it('bez Slacka i Telegrama — ślad w logu zamiast ciszy', async () => {
    mocks.configured = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendSlackAlert({ channel: 'bugs', text: 'Coś się zepsuło' });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.join(' ')).toContain('bugs');
  });

  it('niepilny alert nie idzie na Telegram', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendSlackAlert({ channel: 'metrics', text: 'raport' });
    expect(mocks.telegram).not.toHaveBeenCalled();
  });

  it('błąd Telegrama nie wywraca nadawcy (fail-soft jak Slack)', async () => {
    mocks.telegram.mockRejectedValue(new Error('fixture'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sendSlackAlert({ channel: 'urgent', text: 'x' })).resolves.toBe(false);
  });
});
