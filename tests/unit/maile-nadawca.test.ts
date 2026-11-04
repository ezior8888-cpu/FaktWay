import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({ Resend: class { emails = { send: s.send }; } }));
vi.mock('@/lib/email/preferences', () => ({ canSendTo: async () => ({ ok: true }) }));

/**
 * AUD-97: bez zmiennych RESEND_FROM_* nadawcą był `onboarding@resend.dev` —
 * domena dostawcy, nie FaktWay (i adres, którego Resend nie przyjmie poza
 * kontem testowym). Pusta zmienna też nie była traktowana jak brak.
 */

beforeEach(() => {
  s.send.mockReset().mockResolvedValue({ data: { id: 'm' }, error: null });
  vi.stubEnv('RESEND_API_KEY', 're_test_klucz');
  vi.stubEnv('RESEND_DEV_TO_OVERRIDE', '');
  vi.stubEnv('RESEND_FROM_EMAIL', '');
  vi.stubEnv('RESEND_FROM_TRANSACTIONAL', '');
  vi.stubEnv('RESEND_FROM_MARKETING', '');
});

describe('nadawca maili', () => {
  it('bez konfiguracji — domena FaktWay, nie resend.dev', async () => {
    const { sendEmail } = await import('@/lib/email/send');
    await sendEmail({ to: 'klient@example.test', subject: 'x', html: '<p>x</p>' });
    const from = String(s.send.mock.calls[0]![0].from);
    expect(from).toContain('<powiadomienia@faktway.pl>');
    expect(from).not.toContain('resend.dev');
  });

  it('ustawiona zmienna wygrywa', async () => {
    vi.stubEnv('RESEND_FROM_TRANSACTIONAL', 'FaktWay <faktury@faktflow.pl>');
    const { sendEmail } = await import('@/lib/email/send');
    await sendEmail({ to: 'klient@example.test', subject: 'x', html: '<p>x</p>' });
    expect(s.send.mock.calls[0]![0].from).toBe('FaktWay <faktury@faktflow.pl>');
  });
});
