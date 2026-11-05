import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Obietnica „Odezwiemy się mailem” ma mieć ścieżkę operatora także bez Slacka:
 * `/admin/support` pokazywało tylko temat, kategorię i status 25 najnowszych
 * rozmów, bez adresu klienta. Eskalowana rozmowa spoza tych 25 znikała.
 */

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  rows: [] as Row[],
  filters: [] as Array<[string, unknown]>,
  limit: 0,
  emails: {} as Record<string, string | null>,
  getUserById: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children: React.ReactNode }) => createElement('a', p, children),
}));
vi.mock('@/lib/auth/admin-guard', () => ({ requireAdmin: async () => ({}) }));
vi.mock('@/lib/auth/auth-users', () => ({ scanAuthUsers: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { getUserById: m.getUserById } },
    from: () => {
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          m.filters.push([k, v]);
          return q;
        },
        order: () => q,
        limit: async (n: number) => {
          m.limit = n;
          const rows = m.rows.filter((row) => m.filters.every(([k, v]) => row[k] === v));
          return { data: rows.slice(0, n), error: null };
        },
      };
      return q;
    },
  }),
}));

import { getEscalatedConversations, getSupportConversations } from '@/lib/admin/support';

function rozmowa(patch: Row): Row {
  return {
    id: 'c-1',
    user_id: 'u-1',
    status: 'open',
    category: 'ksef',
    subject: 'Pytanie',
    csat_positive: null,
    escalation_reason: null,
    escalated_at: null,
    created_at: '2026-11-02T10:00:00.000Z',
    ...patch,
  };
}

beforeEach(() => {
  m.filters = [];
  m.limit = 0;
  m.rows = [];
  m.emails = { 'u-1': 'klient@example.test', 'u-2': 'drugi@example.test' };
  m.getUserById.mockReset();
  m.getUserById.mockImplementation(async (id: string) => ({
    data: { user: id in m.emails ? { id, email: m.emails[id] } : null },
    error: null,
  }));
});

describe('rozmowy z prośbą o człowieka w /admin/support', () => {
  it('lista najnowszych rozmów ma adres klienta', async () => {
    m.rows = [rozmowa({})];
    const [wynik] = await getSupportConversations(25);
    expect(wynik).toMatchObject({ id: 'c-1', userEmail: 'klient@example.test' });
  });

  it('eskalowane mają osobną listę, niezależną od 25 najnowszych, a prośby klienta są na górze', async () => {
    m.rows = [
      rozmowa({ id: 'c-ai', status: 'escalated', escalation_reason: 'ai_uncertain', escalated_at: '2026-11-02T12:00:00.000Z' }),
      rozmowa({ id: 'c-czlowiek', user_id: 'u-2', status: 'escalated', escalation_reason: 'user_requested', escalated_at: '2026-11-01T12:00:00.000Z' }),
    ];
    const wynik = await getEscalatedConversations();
    expect(m.filters).toContainEqual(['status', 'escalated']);
    expect(m.limit).toBeGreaterThan(25);
    expect(wynik.map((c) => c.id)).toEqual(['c-czlowiek', 'c-ai']);
    expect(wynik[0]).toMatchObject({ userEmail: 'drugi@example.test', escalationReason: 'user_requested' });
  });

  it('o ten sam adres pytamy GoTrue raz, a błąd odczytu nie wywraca panelu', async () => {
    m.rows = [
      rozmowa({ id: 'c-1', status: 'escalated' }),
      rozmowa({ id: 'c-2', status: 'escalated' }),
      rozmowa({ id: 'c-3', user_id: 'u-3', status: 'escalated' }),
    ];
    m.getUserById.mockImplementation(async (id: string) => {
      if (id === 'u-3') throw new Error('GoTrue niedostępny');
      return { data: { user: { id, email: 'klient@example.test' } }, error: null };
    });
    const wynik = await getEscalatedConversations();
    expect(m.getUserById).toHaveBeenCalledTimes(2);
    expect(wynik.find((c) => c.id === 'c-3')).toMatchObject({ userEmail: null });
  });
});

describe('ekran /admin/support', () => {
  it('pokazuje adres klienta i powód eskalacji', async () => {
    m.rows = [
      rozmowa({ id: 'c-czlowiek', status: 'escalated', escalation_reason: 'user_requested', escalated_at: '2026-11-01T12:00:00.000Z' }),
    ];
    vi.doMock('@/lib/admin/support', async (importOriginal) => {
      const prawdziwe = await importOriginal<typeof import('@/lib/admin/support')>();
      return {
        ...prawdziwe,
        getRecentSignups: async () => [],
        getInactiveUsers: async () => [],
        getRecentlyFailedInvoices: async () => [],
        getPendingJoinRequests: async () => [],
      };
    });
    const { default: AdminSupportPage } = await import('@/app/admin/support/page');
    const html = renderToStaticMarkup(await AdminSupportPage());
    expect(html).toContain('klient@example.test');
    expect(html).toContain('Klient poprosił o człowieka');
  });
});
