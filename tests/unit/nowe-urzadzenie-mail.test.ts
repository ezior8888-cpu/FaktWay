import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '@/lib/jobs/registry';

/**
 * Krok 8.5, część 2: mail o logowaniu z nowego urządzenia.
 *
 * Prawdziwe: runner joba i zlecenie zdarzenia. Atrapy tylko dla granic: baza
 * (audit_logs, konto GoTrue), kolejka (sendJobEvent) i dostawca poczty.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  rowsError: null as { message: string } | null,
  email: 'fixture@example.test' as string | null,
  send: vi.fn(),
  sendJob: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'audit_logs') throw new Error(`nieoczekiwana tabela: ${table}`);
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: async () => ({ data: h.rowsError ? null : h.rows, error: h.rowsError }),
      };
      return q;
    },
    auth: { admin: { getUserById: async () => ({ data: { user: h.email ? { email: h.email } : null }, error: null }) } },
  }),
}));
vi.mock('@/lib/email/send', () => ({ sendNewLoginEmail: h.send }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: h.sendJob }));

const { runNewLoginMail } = await import('@/lib/jobs/runners/new-login-mail');
const { requestNewLoginCheck } = await import('@/lib/auth/sessions/new-login-check');

const USER_ID = '0d5c6a1e-6a8b-4c55-9e0e-2f4b1a7c3d10';
const SESSION = '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e';
const OLD_SESSION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

function login(session: string, userAgent: string | null, ip: string | null, createdAt: string, action = 'auth.login') {
  return { action, user_agent: userAgent, ip_address: ip, created_at: createdAt, metadata: { session_id: session } };
}

const NEW_DEVICE_ROWS = () => [
  login(SESSION, IPHONE_SAFARI, '203.0.113.9', '2026-11-09T10:05:00Z'),
  login(OLD_SESSION, MAC_CHROME, '83.21.104.5', '2026-11-01T10:00:00Z'),
];

beforeEach(() => {
  vi.resetAllMocks();
  h.rows = [];
  h.rowsError = null;
  h.email = 'fixture@example.test';
  h.send.mockResolvedValue({ sent: true, messageId: 'msg-1' });
  h.sendJob.mockResolvedValue({ ids: ['job-1'] });
});

describe('zlecenie sprawdzenia logowania', () => {
  it('wysyła zdarzenie z kluczem równym identyfikatorowi sesji', async () => {
    await requestNewLoginCheck({ userId: USER_ID, sessionId: SESSION });
    expect(h.sendJob).toHaveBeenCalledExactlyOnceWith({
      name: 'auth/login.completed',
      data: { userId: USER_ID, sessionId: SESSION },
      singletonKey: `new-login/${SESSION}`,
    });
  });

  it('bez identyfikatora sesji nie zleca nic (nie ma czego sprawdzać)', async () => {
    await requestNewLoginCheck({ userId: USER_ID, sessionId: null });
    expect(h.sendJob).not.toHaveBeenCalled();
  });

  it('awaria kolejki nie przerywa logowania', async () => {
    h.sendJob.mockRejectedValue(new Error('kolejka niedostępna'));
    await expect(requestNewLoginCheck({ userId: USER_ID, sessionId: SESSION })).resolves.toBeUndefined();
  });
});

describe('runNewLoginMail', () => {
  const data = { userId: USER_ID, sessionId: SESSION };

  it('znane urządzenie (ta sama przeglądarka, system i sieć): bez maila', async () => {
    h.rows = [
      login(SESSION, MAC_CHROME, '83.21.104.77', '2026-11-09T10:00:00Z'),
      login(OLD_SESSION, MAC_CHROME, '83.21.104.5', '2026-11-01T10:00:00Z'),
    ];
    expect(await runNewLoginMail(data, context)).toEqual({ skipped: true, reason: 'known-device' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('inna sieć niż dotąd: mail', async () => {
    h.rows = [
      login(SESSION, MAC_CHROME, '203.0.113.9', '2026-11-09T10:00:00Z'),
      login(OLD_SESSION, MAC_CHROME, '83.21.104.5', '2026-11-01T10:00:00Z'),
    ];
    expect(await runNewLoginMail(data, context)).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      to: 'fixture@example.test', userId: USER_ID, device: 'Mac (Chrome)', ip: '203.0.113.x',
      idempotencyKey: `new-login/${SESSION}`,
    }));
  });

  it('inna przeglądarka lub system: mail', async () => {
    h.rows = NEW_DEVICE_ROWS();
    await runNewLoginMail(data, context);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ device: 'iPhone (Safari)' }));
  });

  it('pierwsze logowanie po rejestracji (brak wcześniejszych wpisów): bez maila', async () => {
    h.rows = [login(SESSION, MAC_CHROME, '83.21.104.77', '2026-11-09T10:00:00Z', 'auth.signup')];
    expect(await runNewLoginMail(data, context)).toEqual({ skipped: true, reason: 'first-login' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('wcześniejszy wpis rejestracji z tego samego urządzenia: bez maila', async () => {
    h.rows = [
      login(SESSION, MAC_CHROME, '83.21.104.77', '2026-11-09T10:00:00Z'),
      login(OLD_SESSION, MAC_CHROME, '83.21.104.5', '2026-11-01T10:00:00Z', 'auth.signup'),
    ];
    expect(await runNewLoginMail(data, context)).toEqual({ skipped: true, reason: 'known-device' });
  });

  it('późniejsze logowanie z innej sesji nie robi z tej „znanej”', async () => {
    h.rows = [
      login(OLD_SESSION, IPHONE_SAFARI, '203.0.113.9', '2026-11-10T10:00:00Z'),
      login(SESSION, IPHONE_SAFARI, '203.0.113.9', '2026-11-09T10:00:00Z'),
      login('11111111-1111-4111-8111-111111111111', MAC_CHROME, '83.21.104.5', '2026-11-01T10:00:00Z'),
    ];
    expect(await runNewLoginMail(data, context)).toEqual({ sent: true });
  });

  it('nieznany adres albo przeglądarka: mail (bezpieczniejsza wersja)', async () => {
    h.rows = [
      login(SESSION, null, null, '2026-11-09T10:00:00Z'),
      login(OLD_SESSION, null, null, '2026-11-01T10:00:00Z'),
    ];
    await runNewLoginMail(data, context);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ device: 'Nieznane urządzenie', ip: null }));
  });

  it('data i godzina w Europe/Warsaw', async () => {
    h.rows = NEW_DEVICE_ROWS();
    await runNewLoginMail(data, context);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: expect.stringContaining('11:05') }));
  });

  it('błąd odczytu bazy to ponowienie (rzut), nie cicha rezygnacja', async () => {
    h.rowsError = { message: 'połączenie zerwane' };
    await expect(runNewLoginMail(data, context)).rejects.toThrow('połączenie zerwane');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('brak wpisu logowania tej sesji (jeszcze niezapisany): ponowienie', async () => {
    h.rows = [login(OLD_SESSION, MAC_CHROME, '83.21.104.5', '2026-11-01T10:00:00Z')];
    await expect(runNewLoginMail(data, context)).rejects.toThrow(/wpisu logowania/);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('błąd dostawcy poczty to ponowienie z tym samym kluczem idempotencji', async () => {
    h.rows = NEW_DEVICE_ROWS();
    h.send.mockRejectedValueOnce(new Error('Resend error'));
    await expect(runNewLoginMail(data, context)).rejects.toThrow('Resend error');
    await runNewLoginMail(data, context);
    const keys = h.send.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([`new-login/${SESSION}`, `new-login/${SESSION}`]);
  });

  it('konto bez adresu e-mail: bez wysyłki', async () => {
    h.email = null;
    h.rows = NEW_DEVICE_ROWS();
    expect(await runNewLoginMail(data, context)).toEqual({ skipped: true, reason: 'no-email' });
  });
});
