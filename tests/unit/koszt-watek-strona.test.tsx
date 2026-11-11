import { Suspense, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ekran kosztu z wątkiem (plan kompletnej aplikacji, krok 6.2, część 3): strona
 * zmienia się o jedną linię (wątek to osobny komponent pod formularzem), a wątek
 * czyta dane firmy i użytkownika z sesji. Sekcja ma kotwicę `#komentarze`, do
 * której prowadzi link z dzwonka.
 */

const m = vi.hoisted(() => ({
  expense: null as null | Record<string, unknown>,
  context: vi.fn(),
  load: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        in: () => q,
        maybeSingle: async () => ({ data: m.expense, error: null }),
      });
      return q;
    },
  }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/lib/storage/expenses', () => ({ getExpensePhotoUrl: async () => null }));
vi.mock('@/components/expenses/expense-edit-form', () => ({
  ExpenseEditForm: ({ expense }: { expense: { id: string } }) => <div data-testid="formularz" data-id={expense.id} />,
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: m.context }));
vi.mock('@/lib/expenses/expense-thread-load', () => ({ loadExpenseThread: m.load }));
// Panel kliencki importuje akcje serwerowe; tu sprawdzamy tylko, co dostaje.
vi.mock('@/app/actions/expense-thread', () => ({ addExpenseCommentAction: vi.fn(), resolveDocumentRequestAction: vi.fn() }));

const EXPENSE = '11111111-1111-4111-8111-111111111111';
const TENANT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const THREAD = { ok: true, entries: [], truncated: false };

beforeEach(() => {
  vi.clearAllMocks();
  m.expense = { id: EXPENSE, tenant_id: TENANT, source: 'manual', ksef_invoice_id: null, source_file_path: null };
  m.context.mockResolvedValue({ supabase: { tag: 'sesja' }, tenantId: TENANT, user: { id: USER, email: null }, role: 'accountant' });
  m.load.mockResolvedValue(THREAD);
});

describe('strona kosztu', () => {
  it('pod formularzem wątek tego kosztu, jako osobny komponent', async () => {
    vi.resetModules();
    vi.doMock('@/app/(dashboard)/expenses/[id]/_components/expense-thread', () => ({
      ExpenseThread: ({ expenseId }: { expenseId: string }) => <section data-testid="watek" data-id={expenseId} />,
    }));
    const { default: ExpenseDetailPage } = await import('@/app/(dashboard)/expenses/[id]/page');

    const html = renderToStaticMarkup((await ExpenseDetailPage({ params: Promise.resolve({ id: EXPENSE }) })) as ReactElement);

    expect(html).toBe(`<div data-testid="formularz" data-id="${EXPENSE}"></div><section data-testid="watek" data-id="${EXPENSE}"></section>`);
    vi.doUnmock('@/app/(dashboard)/expenses/[id]/_components/expense-thread');
  });

  it('koszt spoza firmy albo nieistniejący: notFound, bez wątku', async () => {
    m.expense = null;
    vi.resetModules();
    const { default: ExpenseDetailPage } = await import('@/app/(dashboard)/expenses/[id]/page');

    await expect(ExpenseDetailPage({ params: Promise.resolve({ id: EXPENSE }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(m.load).not.toHaveBeenCalled();
  });
});

describe('wątek na stronie kosztu', () => {
  it('sekcja z kotwicą #komentarze, odstęp pod przyklejony pasek akcji i treść w granicy Suspense', async () => {
    const { ExpenseThread, ExpenseThreadContent } = await import('@/app/(dashboard)/expenses/[id]/_components/expense-thread');
    const section = ExpenseThread({ expenseId: EXPENSE }) as ReactElement<{ id: string; className: string; children: ReactElement }>;

    expect(section.type).toBe('section');
    expect(section.props.id).toBe('komentarze');
    expect(section.props.className).toContain('pb-32');
    const boundary = section.props.children as ReactElement<{ children: ReactElement<{ expenseId: string }> }>;
    expect(boundary.type).toBe(Suspense);
    expect(boundary.props.children.type).toBe(ExpenseThreadContent);
    expect(boundary.props.children.props.expenseId).toBe(EXPENSE);
  });

  it('treść: wątek firmy i użytkownika z sesji; pisze każda rola z dostępem do kosztów', async () => {
    const { ExpenseThreadContent } = await import('@/app/(dashboard)/expenses/[id]/_components/expense-thread');
    const { ExpenseThreadPanel } = await import('@/app/(dashboard)/expenses/[id]/_components/expense-thread-panel');

    for (const role of ['owner', 'admin', 'member', 'accountant']) {
      m.context.mockResolvedValueOnce({ supabase: { tag: 'sesja' }, tenantId: TENANT, user: { id: USER, email: null }, role });
      const el = (await ExpenseThreadContent({ expenseId: EXPENSE })) as ReactElement<Record<string, unknown>>;
      expect(el.type).toBe(ExpenseThreadPanel);
      expect(el.props).toEqual({ expenseId: EXPENSE, thread: THREAD, canWrite: true });
    }
    expect(m.load).toHaveBeenCalledWith({ tag: 'sesja' }, { tenantId: TENANT, expenseId: EXPENSE, userId: USER });

    // Rola spoza listy (gdyby kiedyś doszła): tylko wgląd.
    m.context.mockResolvedValueOnce({ supabase: { tag: 'sesja' }, tenantId: TENANT, user: { id: USER, email: null }, role: 'viewer' });
    const el = (await ExpenseThreadContent({ expenseId: EXPENSE })) as ReactElement<Record<string, unknown>>;
    expect(el.props.canWrite).toBe(false);
  });
});
