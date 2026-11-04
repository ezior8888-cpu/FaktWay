import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * „Połącz z człowiekiem” na PRAWDZIWEJ akcji (mocki tylko dla bazy, Slacka
 * i poczty). Test widgetu mockuje akcję, więc nie widział tych ścieżek:
 *  - rozmowa, którą czat sam eskalował (`ai_uncertain`), kończyła się na
 *    `status === 'escalated'`: klient widział „Zgłoszono”, a zespół nie
 *    dostawał ani prośby, ani adresu klienta;
 *  - `updateConversation` porzucał `error`, więc nieudany zapis też dawał
 *    „Zgłoszono”;
 *  - przy braku Slacka obietnica „Odezwiemy się mailem” nie miała drogi.
 */

type Row = {
  id: string;
  user_id: string;
  tenant_id: string | null;
  status: string;
  category: string | null;
  subject: string | null;
  escalation_reason: string | null;
  created_at: string;
};

const m = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'klient@example.test' } as { id: string; email?: string | null } | null,
  row: null as Row | null,
  selected: '' as string,
  updates: [] as Array<Record<string, unknown>>,
  updateError: null as { message: string } | null,
  slack: vi.fn(),
  email: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireVerifiedUser: async () => ({ user: m.user }),
}));
vi.mock('@/lib/alerts/slack', () => ({ sendSlackAlert: m.slack }));
vi.mock('@/lib/email/send', () => ({ sendSupportEscalationEmail: m.email }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: (columns: string) => {
        m.selected = columns;
        return { eq: () => ({ maybeSingle: async () => ({ data: m.row, error: null }) }) };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          m.updates.push(patch);
          return { error: m.updateError };
        },
      }),
    }),
  }),
}));

import { escalateConversationAction, submitCsatAction } from '@/lib/support/support-actions';

const CONV = '11111111-1111-4111-8111-111111111111';

function rozmowa(patch: Partial<Row> = {}): Row {
  return {
    id: CONV,
    user_id: 'user-1',
    tenant_id: null,
    status: 'open',
    category: 'ksef',
    subject: 'Jak wgrać certyfikat?',
    escalation_reason: null,
    created_at: '2026-11-02T10:00:00.000Z',
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.user = { id: 'user-1', email: 'klient@example.test' };
  m.row = rozmowa();
  m.updates = [];
  m.updateError = null;
  m.slack.mockResolvedValue(true);
  m.email.mockResolvedValue({ sent: true });
});

describe('escalateConversationAction', () => {
  it('rozmowa eskalowana przez czat (ai_uncertain): prośba klienta dochodzi do zespołu, z adresem', async () => {
    m.row = rozmowa({ status: 'escalated', escalation_reason: 'ai_uncertain' });
    await expect(escalateConversationAction(CONV)).resolves.toEqual({ ok: true });
    expect(m.selected).toContain('escalation_reason');
    expect(m.updates[0]).toMatchObject({ status: 'escalated', escalation_reason: 'user_requested' });
    expect(m.slack).toHaveBeenCalledTimes(1);
    expect(m.slack.mock.calls[0]![0].context).toMatchObject({ user_email: 'klient@example.test' });
  });

  it('drugie kliknięcie po prośbie klienta nie dubluje alertu ani maila', async () => {
    m.row = rozmowa({ status: 'escalated', escalation_reason: 'user_requested' });
    await expect(escalateConversationAction(CONV)).resolves.toEqual({ ok: true });
    expect(m.updates).toEqual([]);
    expect(m.slack).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
  });

  it('nieudany zapis to odmowa, bez alertu i bez „Zgłoszono”', async () => {
    m.updateError = { message: 'upstream timeout' };
    await expect(escalateConversationAction(CONV)).resolves.toEqual({ ok: false });
    expect(m.slack).not.toHaveBeenCalled();
    expect(m.email).not.toHaveBeenCalled();
  });

  it('zgłoszenie idzie też mailem na adres pomocy, z adresem klienta do odpowiedzi', async () => {
    await expect(escalateConversationAction(CONV)).resolves.toEqual({ ok: true });
    expect(m.email).toHaveBeenCalledTimes(1);
    expect(m.email.mock.calls[0]![0]).toMatchObject({
      conversationId: CONV,
      userEmail: 'klient@example.test',
      subject: 'Jak wgrać certyfikat?',
    });
    expect(SUPPORT_EMAIL).toContain('@');
  });

  it.each([
    ['brak webhooka albo błąd Slacka', false, { sent: true }],
    ['poczta odmówiła, Slack przyjął', true, { sent: false, reason: 'not-configured' }],
  ])('%s: jedna droga wystarczy', async (_nazwa, slack, email) => {
    m.slack.mockResolvedValue(slack);
    m.email.mockResolvedValue(email);
    await expect(escalateConversationAction(CONV)).resolves.toEqual({ ok: true });
  });

  it('żadna droga nie zadziałała: klient nie dostaje obietnicy maila, ślad w bazie zostaje', async () => {
    m.slack.mockResolvedValue(false);
    m.email.mockRejectedValue(new Error('Resend error'));
    await expect(escalateConversationAction(CONV)).resolves.toEqual({ ok: false });
    expect(m.updates[0]).toMatchObject({ escalation_reason: 'user_requested' });
  });

  it('cudza rozmowa: odmowa bez zapisu', async () => {
    m.row = rozmowa({ user_id: 'inny' });
    await expect(escalateConversationAction(CONV)).resolves.toEqual({ ok: false });
    expect(m.updates).toEqual([]);
    expect(m.slack).not.toHaveBeenCalled();
  });
});

describe('submitCsatAction', () => {
  it('nieudany zapis oceny nie wywraca akcji', async () => {
    m.updateError = { message: 'upstream timeout' };
    await expect(submitCsatAction(CONV, true)).resolves.toEqual({ ok: false });
  });
});
