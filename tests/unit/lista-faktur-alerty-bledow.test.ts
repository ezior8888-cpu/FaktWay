import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * Alerty strony /invoices (PLAN-FINORA §5 P3, ten sam defekt co kafle w #288):
 * strona pokazywała klientowi surowy `error.message` — angielski tekst
 * PostgREST-a w tytule alertu „Nie udało się pobrać faktur” oraz treść wyjątku
 * faktów płatności w alercie „Nie udało się policzyć płatności”. Testy idą
 * PRAWDZIWĄ ścieżką strony (`InvoicesPage` + `loadInvoiceListRowFacts` +
 * `readCompletePages`), klient bazy to atrapa zwracająca błąd z PostgREST-a.
 */

type Result = { data: unknown[] | null; count: number | null; error: { message: string } | null };

const state = vi.hoisted(() => ({
  list: null as unknown,
  children: null as unknown,
  envBroken: false,
}));

vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => {
    if (state.envBroken) throw new Error('KSeF environment is not safely configured');
    return 'production';
  },
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: fakeClient(), tenantId: 'ten-1' }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import InvoicesPage from '@/app/(dashboard)/(faktury)/invoices/page';

const POSTGREST_TAIL = 'permission denied for table invoices';

/**
 * Atrapa klienta: zapytanie o dzieci (korekty, rozliczenia zaliczek) poznaje po
 * `parent_invoice_id` / `overlaps`, każde inne to zapytanie listy.
 */
function fakeClient() {
  return {
    from() {
      let kind: 'list' | 'children' = 'list';
      const builder = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        gt: () => builder,
        gte: () => builder,
        lt: () => builder,
        lte: () => builder,
        or: () => builder,
        order: () => builder,
        range: () => builder,
        in: (column: string) => {
          if (column === 'parent_invoice_id') kind = 'children';
          return builder;
        },
        overlaps: () => {
          kind = 'children';
          return builder;
        },
        then<T, E = never>(
          resolve?: ((value: Result) => T | PromiseLike<T>) | null,
          reject?: ((reason: unknown) => E | PromiseLike<E>) | null,
        ) {
          const result = (kind === 'list' ? state.list : state.children) as Result;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const row = {
  id: 'inv-1',
  tenant_id: 'ten-1',
  internal_number: 'FV/1/10/2026',
  issue_date: '2026-09-15',
  buyer_data: { name: 'Nabywca 1' },
  created_at: '2026-09-15T10:00:00Z',
  xml_storage_path: null,
  last_error_code: null,
  ksef_number: 'KSEF-1',
  direction: 'outgoing',
  origin: 'app',
  ksef_status: 'accepted',
  ksef_environment: 'production',
  invoice_kind: 'regular',
  invoice_type: 'VAT',
  currency: 'PLN',
  gross_total: 1230,
  paid_amount: 0,
  payment_data: null,
  payment_due_date: '2026-10-01',
  payment_status: 'unpaid',
  parent_invoice_id: null,
  advance_invoice_ids: [],
};

const ok = (rows: unknown[]): Result => ({ data: rows, count: rows.length, error: null });
const failed: Result = { data: null, count: null, error: { message: POSTGREST_TAIL } };

/** Teksty z drzewa strony (bez renderowania komponentów) i liczba list faktur. */
function collect(tree: ReactNode): { text: string; lists: number } {
  const out = { text: '', lists: 0 };
  const walk = (node: ReactNode): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      out.text += `${node} `;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object' || !('props' in node)) return;
    const props = (node as ReactElement<Record<string, unknown>>).props;
    if (Array.isArray(props.initialInvoices)) out.lists += 1;
    walk(props.children as ReactNode);
  };
  walk(tree);
  return out;
}

async function renderPage() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
  try {
    return collect(await InvoicesPage({ searchParams: Promise.resolve({}) }));
  } finally {
    vi.useRealTimers();
  }
}

let consoleError: MockInstance<typeof console.error>;

/** Czy któryś wpis `console.error` niesie wyjątek o tej treści (pełna przyczyna dla operatora). */
const loggedError = (fragment: string) =>
  consoleError.mock.calls.flat().some((arg) => arg instanceof Error && arg.message.includes(fragment));

beforeEach(() => {
  state.list = ok([row]);
  state.children = ok([]);
  state.envBroken = false;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('alert „Nie udało się pobrać faktur”', () => {
  it('błąd zapytania listy: polski tytuł i wyjście, bez tekstu PostgREST-a, błąd w logu', async () => {
    state.list = failed;
    const { text, lists } = await renderPage();
    expect(text).toContain('Nie udało się pobrać faktur');
    expect(text).toContain('Odśwież stronę za chwilę');
    expect(text).toContain('zgłoś go w pomocy FaktWay');
    expect(text).not.toContain('permission denied');
    expect(text).not.toContain('invoices');
    expect(lists).toBe(0);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[invoices]'), failed.error);
  });
});

describe('alert „Nie udało się policzyć płatności”', () => {
  it('błąd odczytu korekt: polska część bez ogona PostgREST-a, lista zostaje, pełny błąd w logu', async () => {
    state.children = failed;
    const { text, lists } = await renderPage();
    expect(text).toContain('Nie udało się policzyć płatności');
    expect(text).toContain('Nie można odczytać korekt faktur na liście');
    expect(text).toContain('zgłoś go w pomocy FaktWay');
    expect(text).not.toContain('permission denied');
    expect(lists).toBe(1);
    expect(loggedError(POSTGREST_TAIL)).toBe(true);
  });

  it('brak środowiska KSeF (angielski wyjątek konfiguracji): bez jego treści, lista zostaje', async () => {
    state.envBroken = true;
    const { text, lists } = await renderPage();
    expect(text).toContain('Nie udało się policzyć płatności');
    expect(text).toContain('Odśwież stronę za chwilę');
    expect(text).toContain('zgłoś go w pomocy FaktWay');
    expect(text).not.toContain('safely configured');
    expect(text).not.toContain('KSeF environment');
    expect(lists).toBe(1);
    expect(loggedError('safely configured')).toBe(true);
  });

  it('bez błędów: żadnego alertu i lista pokazana', async () => {
    const { text, lists } = await renderPage();
    expect(text).not.toContain('Nie udało się');
    expect(lists).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
