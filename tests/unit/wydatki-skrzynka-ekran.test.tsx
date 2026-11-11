// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E6 (PLAN-FINORA §5 P8, P9, §2.2 `/expenses/[id]`): ekrany Wydatków
 * i Skrzynki KSeF w układzie Finora Transactions — kafle w jednej karcie
 * (każdy we własnej granicy błędu), tabela od `lg`, karty poniżej `lg`,
 * puste stany (Skrzynka: tekst z e2e 04, raz w znacznikach) i karta
 * szczegółów wydatku. Liczby liczy `lib/dashboard/expense-stats.ts`
 * (osobny test); tu sprawdzamy, co widzi człowiek.
 */

const stats = vi.hoisted(() => ({
  getExpenseMonthTotals: vi.fn(),
  getRecurringExpenseStats: vi.fn(),
  getInboxMonthCosts: vi.fn(),
  countExpensesToReview: vi.fn(),
  getLastInboxFetchAt: vi.fn(),
  getInboxScheduleSummary: vi.fn(),
  verified: vi.fn(),
  trybCtx: null as unknown,
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

const pageContext = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/dashboard/expense-stats', () => stats);
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: pageContext.get }));
// Kafel „Ostatnie pobranie” pyta o tryb danych firmy (weryfikacja KSeF) — jedna funkcja trybu.
vi.mock('@/lib/demo/tryb-danych', () => ({
  trybDanych: async (ctx: unknown) => {
    stats.trybCtx = ctx;
    return { tryb: (await stats.verified()) ? 'prawdziwe' : 'przyklad', stan: 'C', verifiedAt: null };
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
// Strona zleca przyspieszenie terminu po odpowiedzi; poza żądaniem `after` by rzucił.
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ksef/inbox-activity', () => ({ requestInboxPollOnVisit: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/app/actions/expenses', () => ({
  deleteExpenseAction: vi.fn(),
  reviewExpenseAction: vi.fn(),
  getOcrJobStatusAction: vi.fn(),
}));

import { ExpenseEditForm } from '@/components/expenses/expense-edit-form';
import { ExpenseDayCards, type ExpenseRow } from '@/components/expenses/expenses-list';
import { canDeleteExpense } from '@/components/expenses/finora/expense-row-actions';
import {
  ExpensesGrossCell,
  ExpensesRecurringCell,
  ExpensesToReviewCell,
  ExpensesVatCell,
  ExpenseStatsCards,
} from '@/components/expenses/finora/expense-stat-cells';
import { expenseColumns, ExpensesTable, searchExpenseText } from '@/components/expenses/finora/expenses-table';
import { plDate } from '@/components/expenses/finora/labels';
import { monthOptions } from '@/components/expenses/finora/month-selector';
import { StatCell, StatsCardsFrame } from '@/components/expenses/finora/stats-cards';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import type { PageContext } from '@/lib/supabase/page-context';
import { buildInboxRows, type InboxInvoiceRow } from '@/app/(dashboard)/(koszty)/inbox/_components/inbox-rows';
import {
  InboxLastFetchCell,
  InboxMonthCostsCell,
  InboxNewCell,
} from '@/app/(dashboard)/(koszty)/inbox/_components/inbox-stat-cells';
import { inboxAmount, inboxColumns, InboxTable } from '@/app/(dashboard)/(koszty)/inbox/_components/inbox-table';
import { RiArrowRightUpLine } from '@remixicon/react';
import ExpensesPage from '@/app/(dashboard)/(koszty)/expenses/page';
import InboxPage from '@/app/(dashboard)/(koszty)/inbox/page';

const supabase = {} as PageContext['supabase'];
const TENANT = 'firma-a';

function expense(id: string, fields: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id,
    tenant_id: TENANT,
    paid_at: null,
    payment_account: null,
    payment_due_date: null,
    payment_split: null,
    payment_terms: null,
    categorization_confidence: null,
    categorization_method: null,
    category_label: 'Telekomunikacja',
    created_at: '2026-10-01T10:00:00Z',
    created_by: null,
    document_number: 'FV/10/2026',
    document_type: 'invoice',
    gross_amount: 123,
    is_deductible: true,
    is_reviewed: true,
    issue_date: '2026-10-05',
    kpir_column: 'col_13',
    ksef_invoice_id: null,
    net_amount: 100,
    notes: null,
    ocr_extracted_data: null,
    ocr_job_id: null,
    seller_address: null,
    seller_name: 'Telekom spółka z ograniczoną odpowiedzialnością',
    seller_nip: '1234567890',
    source: 'manual',
    source_file_mime: null,
    source_file_path: null,
    updated_at: '2026-10-01T10:00:00Z',
    vat_amount: 23,
    vat_deductible_amount: 23,
    vat_rate: '23',
    ...fields,
  };
}

function invoice(id: string, fields: Partial<InboxInvoiceRow> = {}): InboxInvoiceRow {
  return {
    id,
    internal_number: 'FA/1/10/2026',
    ksef_number: '1234567890-20261005-ABCDEF-01',
    issue_date: '2026-10-05',
    seller_nip: '1234567890',
    seller_data: { name: 'Hosting S.A.', nip: '1234567890' },
    fa3_data: null,
    gross_total: '615.00',
    currency: 'PLN',
    ksef_accepted_at: '2026-10-05T10:00:00Z',
    origin: 'ksef_inbox',
    ...fields,
  };
}

const html = (node: ReactElement) => renderToStaticMarkup(node);

type QueryResult = { data: unknown; error: { message: string } | null };

/** Atrapa klienta: każdy łańcuch zapytań do tabeli kończy się podanym wynikiem. */
function supabaseReturning(results: Record<string, QueryResult>): PageContext['supabase'] {
  return {
    from(table: string) {
      const result = results[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'order', 'limit', 'range']) {
        chain[method] = () => chain;
      }
      chain.then = (resolve: (v: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    },
  } as unknown as PageContext['supabase'];
}

beforeEach(() => {
  vi.resetAllMocks();
  stats.verified.mockResolvedValue(true);
});

describe('kafle P8 — StatsCards Finory z komórkami w granicach błędu', () => {
  it('rama: jedna karta, grupy po dwie, separatory jak w Finorze', () => {
    const markup = html(
      <StatsCardsFrame
        cells={['a', 'b', 'c', 'd'].map((key) => (
          <StatCell key={key} label={`Kafel ${key}`} value="1" icon={RiArrowRightUpLine} />
        ))}
      />,
    );
    expect(markup.match(/data-slot="card"/g)).toHaveLength(1);
    expect(markup).toContain('max-xl:flex-col');
    expect(markup.match(/data-slot="separator"/g)?.length).toBeGreaterThanOrEqual(6);
    for (const key of ['a', 'b', 'c', 'd']) expect(markup).toContain(`Kafel ${key}`);
  });

  it('kafle z danymi: kwoty skrócone z pełną w title, liczba do opisania, stałe koszty', async () => {
    stats.getExpenseMonthTotals.mockResolvedValue({ month: '2026-10', gross: 45678.9, vatDeductible: 1234.56 });
    stats.getRecurringExpenseStats.mockResolvedValue({
      recurring: [{ sellerNip: '1', sellerName: 'Hosting', months: 3, averageAmount: 99.99, typicalDay: 5 }],
      recurringTotal: 99.99,
    });
    stats.countExpensesToReview.mockResolvedValue(3);
    const props = { supabase, tenantId: TENANT, month: '2026-10' };

    const gross = html((await ExpensesGrossCell(props)) as ReactElement);
    expect(gross).toContain('Wydatki w miesiącu');
    expect(gross).toContain('45,7 tys. zł');
    expect(gross).toContain('title="45 678,90 zł"');
    expect(gross).toContain('Tylko koszty w KPiR');

    const vat = html((await ExpensesVatCell(props)) as ReactElement);
    expect(vat).toContain('VAT do odliczenia');
    expect(vat).toContain('title="1234,56 zł"');

    const review = html((await ExpensesToReviewCell(props)) as ReactElement);
    expect(review).toContain('>3<');
    expect(review).toContain('3 wydatki czekają na sprawdzenie');

    const recurring = html((await ExpensesRecurringCell(props)) as ReactElement);
    expect(recurring).toContain('Stałe koszty');
    expect(recurring).toContain('100 zł');
    expect(recurring).toContain('1 dostawca');
    expect(stats.getExpenseMonthTotals).toHaveBeenCalledWith(supabase, TENANT, '2026-10');
    expect(stats.getRecurringExpenseStats).toHaveBeenCalledWith(supabase, TENANT, '2026-10');
  });

  it('stan pusty: zero wydatków i brak stałych kosztów — bez udawanej kwoty', async () => {
    stats.getExpenseMonthTotals.mockResolvedValue({ month: '2026-10', gross: 0, vatDeductible: 0 });
    stats.getRecurringExpenseStats.mockResolvedValue({ recurring: [], recurringTotal: 0 });
    stats.countExpensesToReview.mockResolvedValue(0);
    const props = { supabase, tenantId: TENANT, month: '2026-10' };

    expect(html((await ExpensesGrossCell(props)) as ReactElement)).toContain('0 zł');
    expect(html((await ExpensesToReviewCell(props)) as ReactElement)).toContain('Wszystko opisane');
    const recurring = html((await ExpensesRecurringCell(props)) as ReactElement);
    expect(recurring).toContain('—');
    expect(recurring).toContain('Pokażemy, gdy dostawca wróci w 3 z 4 miesięcy');
  });

  it('wyjątek strażnika zabiera jeden kafel z polską treścią, bez ogona PostgREST-a', async () => {
    stats.getExpenseMonthTotals.mockRejectedValue(new KsefExpenseCurrencyNotSupportedError());
    stats.countExpensesToReview.mockRejectedValue(new Error('Nie można policzyć wydatków do opisania: connection reset'));
    const props = { supabase, tenantId: TENANT, month: '2026-10' };

    const gross = html((await ExpensesGrossCell(props)) as ReactElement);
    expect(gross).toContain('role="status"');
    expect(gross).toContain(new KsefExpenseCurrencyNotSupportedError().message);

    const review = html((await ExpensesToReviewCell(props)) as ReactElement);
    expect(review).toContain('Nie można policzyć wydatków do opisania');
    expect(review).not.toContain('connection reset');
  });

  it('wyjątek z okna stałych kosztów (koszt sprzed miesiąca) zabiera tylko kafel „Stałe koszty”', async () => {
    stats.getExpenseMonthTotals.mockResolvedValue({ month: '2026-10', gross: 123, vatDeductible: 23 });
    stats.getRecurringExpenseStats.mockRejectedValue(new KsefExpenseCurrencyNotSupportedError());
    const props = { supabase, tenantId: TENANT, month: '2026-10' };

    const gross = html((await ExpensesGrossCell(props)) as ReactElement);
    expect(gross).toContain('title="123,00 zł"');
    expect(gross).not.toContain('role="status"');
    const vat = html((await ExpensesVatCell(props)) as ReactElement);
    expect(vat).toContain('title="23,00 zł"');
    expect(vat).not.toContain('role="status"');

    const recurring = html((await ExpensesRecurringCell(props)) as ReactElement);
    expect(recurring).toContain('role="status"');
    expect(recurring).toContain(new KsefExpenseCurrencyNotSupportedError().message);
  });

  it('karta kafli: cztery sloty w jednej karcie Finory', () => {
    const markup = html(<ExpenseStatsCards supabase={supabase} tenantId={TENANT} month="2026-10" />);
    expect(markup.match(/data-slot="card"/g)).toHaveLength(1);
    expect(markup.match(/aria-busy="true"/g)).toHaveLength(4);
  });
});

describe('tabela P8 — Finora Transactions na naszych wydatkach', () => {
  const rows = [
    expense('e-1'),
    expense('e-2', { source: 'ksef_inbox', is_reviewed: false, ksef_invoice_id: 'inv-1', gross_amount: 615, issue_date: '2026-10-04' }),
    expense('e-3', { source: 'ocr_photo', document_type: 'receipt', category_label: null, seller_nip: null, issue_date: '2026-10-04', gross_amount: 40.5 }),
  ];

  it('stan z danymi: kolumny wg P8, tabela od lg, karty poniżej lg, kwoty i daty po polsku', () => {
    const markup = html(<ExpensesTable expenses={rows} listVariant="month" />);
    for (const header of ['Data', 'Sprzedawca', 'Źródło', 'Kategoria', 'Kolumna KPiR', 'Dokument', 'Brutto', 'Status', 'Akcje']) {
      expect(markup).toContain(`>${header}<`);
    }
    expect(markup).toContain('hidden lg:block');
    expect(markup).toContain('border-t lg:hidden');
    expect(markup).toContain('Telekom sp. z o.o.');
    expect(markup).toContain('NIP 1234567890');
    expect(markup).toContain('bez NIP');
    expect(markup).toContain('05.10.2026');
    expect(markup).toContain('615,00 zł');
    expect(markup).toContain('Paragon');
    expect(markup).toContain('Bez kategorii');
    expect(markup).toContain('Wszystkie źródła');
    expect(markup).toContain('Wszystkie kategorie');
    expect(markup).toContain('Wszystkie statusy');
    expect(markup).toContain('+ Dodaj wydatek');
    expect(markup).toContain('Pozycje <span>1–3</span> z <span>3</span>');
    expect(markup).toContain('href="/expenses/e-2"');
    // Suma dnia w kartach: 4 października = 615 + 40,50.
    expect(markup).toContain('655,50 zł');
    expect(markup).not.toMatch(/\$[0-9]/);
  });

  it('nagłówek sortowalny: przycisk z aria-sort na <th> (WCAG 4.1.2), nie fokusowalny div', () => {
    const markup = html(<ExpensesTable expenses={rows} listVariant="month" />);
    expect(markup).not.toMatch(/<div[^>]*tabindex="0"/);
    expect(markup).toMatch(/<th[^>]*aria-sort="none"[^>]*>\s*<button type="button"[^>]*>Data/);
    // Kolumna bez sortowania (Akcje) nie ogłasza stanu sortowania.
    expect(markup).not.toMatch(/<th[^>]*aria-sort[^>]*>Akcje</);
  });

  it('błąd odczytu listy: „+ Dodaj wydatek” zostaje także na komputerze (od lg)', async () => {
    pageContext.get.mockResolvedValue({
      supabase: supabaseReturning({ expenses: { data: null, error: { message: 'connection reset' } } }),
      tenantId: TENANT,
    });
    const markup = html((await ExpensesPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(markup).toContain('Nie udało się pobrać wydatków');
    // Przycisk pływający (lg:hidden) i przycisk przy komunikacie (max-lg:hidden).
    expect(markup.match(/\+ Dodaj wydatek/g)).toHaveLength(2);
    expect(markup).toMatch(/max-lg:hidden[^"]*"[^>]*>(?:(?!<\/div>)[\s\S])*\+ Dodaj wydatek/);
  });

  it('stan pusty: nasz komunikat raz, bez tabeli', () => {
    const month = html(<ExpensesTable expenses={[]} listVariant="month" />);
    expect(month.match(/Brak wydatków w tym miesiącu/g)).toHaveLength(1);
    expect(month).not.toContain('<table');
    const unreviewed = html(<ExpensesTable expenses={[]} listVariant="unreviewed" />);
    expect(unreviewed.match(/Brak wydatków do opisania/g)).toHaveLength(1);
  });

  it('filtry z listą wartości porównują całą wartość („reviewed” ≠ „unreviewed”)', () => {
    for (const id of ['source', 'category', 'status']) {
      const column = expenseColumns.find((c) => c.id === id);
      expect(column?.filterFn).toBe('equalsString');
      expect(column?.meta?.filterVariant).toBe('select');
    }
  });

  it('wyszukiwarka: sprzedawca, NIP, numer, kategoria, notatka', () => {
    const text = searchExpenseText(expense('e-9', { notes: 'projekt X' }));
    for (const part of ['Telekom', '1234567890', 'FV/10/2026', 'Telekomunikacja', 'projekt X']) expect(text).toContain(part);
  });

  it('Usuń tylko dla wydatków spoza KSeF (jak w formularzu)', () => {
    expect(canDeleteExpense({ source: 'manual', ksef_invoice_id: null })).toBe(true);
    expect(canDeleteExpense({ source: 'ksef_inbox', ksef_invoice_id: null })).toBe(false);
    expect(canDeleteExpense({ source: 'manual', ksef_invoice_id: 'inv-1' })).toBe(false);
  });

  it('karty po dniu: suma dnia z przekazanych sum (wszystkie wiersze po filtrach)', () => {
    const markup = html(
      <ExpenseDayCards expenses={[rows[1]!]} dayTotals={new Map([['2026-10-04', 655.5]])} />,
    );
    expect(markup).toContain('655,50 zł');
    expect(markup).toContain('Do opisania');
    expect(markup).toContain('KSeF');
  });
});

describe('wyszukiwanie w tabeli (przeglądarka)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  it('wpisanie NIP-u zawęża wiersze i licznik pozycji', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ExpensesTable
          expenses={[expense('e-1'), expense('e-2', { seller_name: 'Inny', seller_nip: '5555555555' })]}
          listVariant="month"
        />,
      );
    });
    const input = host.querySelector<HTMLInputElement>('#expense-search')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '5555');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('Pozycje 1–1 z 1');
    expect(host.textContent).toContain('Inny');
    expect(host.textContent).not.toContain('Telekom sp. z o.o.');
  });
});

describe('Skrzynka KSeF P9', () => {
  it('wiersze: status z wydatku (Nowa / Opisana), bez wydatku „—”, błąd odczytu → bez statusu', () => {
    const invoices = [invoice('inv-1'), invoice('inv-2'), invoice('inv-3')];
    const links = [
      { id: 'e-1', ksef_invoice_id: 'inv-1', is_reviewed: false },
      { id: 'e-2', ksef_invoice_id: 'inv-2', is_reviewed: true },
    ];

    const rows = buildInboxRows(invoices, links);
    expect(rows.map((r) => [r.id, r.status, r.expenseId])).toEqual([
      ['inv-1', 'new', 'e-1'],
      ['inv-2', 'reviewed', 'e-2'],
      ['inv-3', null, null],
    ]);
    expect(buildInboxRows(invoices, null).every((r) => r.status === null && r.expenseId === null)).toBe(true);
  });

  // Decyzja Bartosza 22.10.2026: zakup z historii KSeF (`origin = 'ksef_import'`)
  // to archiwum bez kosztu — plakietka „Historia z KSeF” zamiast „—”.
  it('zakup z historii KSeF bez wydatku: plakietka „Historia z KSeF” w tabeli i w karcie', () => {
    const rows = buildInboxRows(
      [invoice('inv-1', { origin: 'ksef_import' }), invoice('inv-2'), invoice('inv-3', { origin: 'ksef_import' })],
      [{ id: 'e-3', ksef_invoice_id: 'inv-3', is_reviewed: true }],
    );
    expect(rows.map((r) => [r.id, r.fromKsefHistory, r.status])).toEqual([
      ['inv-1', true, null],
      ['inv-2', false, null],
      ['inv-3', true, 'reviewed'],
    ]);
    const markup = html(<InboxTable rows={rows} />);
    // Tylko inv-1 (bez wydatku): raz w tabeli, raz w karcie; inv-3 ma wydatek i status „Opisana”.
    expect(markup.match(/>Historia z KSeF</g)).toHaveLength(2);
    expect(markup).toContain('title="Faktura z historii KSeF — nie dodaliśmy jej do kosztów"');
    expect(markup).toContain('Opisana');
    // Bieżąca faktura bez wydatku dalej „jeszcze powstaje”.
    expect(markup).toContain('Wydatek z tej faktury jeszcze powstaje');
  });

  it('błąd odczytu wydatków: bez plakietki historii (nie wiemy, czy wydatek jest)', () => {
    const rows = buildInboxRows([invoice('inv-1', { origin: 'ksef_import' })], null);
    const markup = html(<InboxTable rows={rows} statusUnavailable />);
    expect(markup).not.toContain('>Historia z KSeF<');
  });

  it('sprzedawca z seller_data, potem z FA(3), potem z kolumny NIP', () => {
    const [a, b] = buildInboxRows([
      invoice('inv-1', { seller_data: null, fa3_data: { seller: { name: 'Z FA3', nip: '1111111111' } } }),
      invoice('inv-2', { seller_data: null, fa3_data: null, seller_nip: '2222222222' }),
    ], []);
    expect([a?.sellerName, a?.sellerNip]).toEqual(['Z FA3', '1111111111']);
    expect([b?.sellerName, b?.sellerNip]).toEqual(['—', '2222222222']);
  });

  it('stan z danymi: kolumny P9 bez „Termin płatności”, kwota w walucie faktury', () => {
    const rows = buildInboxRows(
      [invoice('inv-1'), invoice('inv-2', { currency: 'EUR', gross_total: 100 })],
      [{ id: 'e-1', ksef_invoice_id: 'inv-1', is_reviewed: false }],
    );
    const markup = html(<InboxTable rows={rows} />);
    for (const header of ['Data wystawienia', 'Sprzedawca', 'Numer', 'Numer KSeF', 'Brutto', 'Status', 'Akcje']) {
      expect(markup).toContain(`>${header}<`);
    }
    expect(markup).not.toContain('Termin płatności');
    expect(markup).toContain('615,00 zł');
    expect(markup).toContain('100,00 EUR');
    expect(markup).toContain('Nowa');
    expect(markup).toContain('href="/expenses/e-1"');
    expect(markup).toContain('1234567890-20261005-ABCDEF-01');
    expect(markup).toContain('05.10.2026');
    expect(inboxColumns.find((c) => c.id === 'status')?.filterFn).toBe('equalsString');
    expect(inboxAmount({ gross: 1, currency: 'PLN' })).toBe('1,00 zł');
  });

  it('data otrzymania z KSeF (z godziną, Europe/Warsaw) w kartach i w tabeli — po niej sortujemy', () => {
    const rows = buildInboxRows(
      [invoice('inv-1', { issue_date: '2026-09-01' }), invoice('inv-2', { ksef_accepted_at: null })],
      [],
    );
    const markup = html(<InboxTable rows={rows} />);
    // 10:00 UTC = 12:00 czasu polskiego; raz w tabeli, raz w karcie.
    expect(markup.match(/05\.10\.2026, 12:00/g)).toHaveLength(2);
    expect(markup).toContain('01.09.2026');
    expect(markup).toContain('Otrzymana');
  });

  it('błąd odczytu wydatków: kolumny „Status” i „Akcje” naprawdę ukryte, bez „jeszcze powstaje”', () => {
    const rows = buildInboxRows([invoice('inv-1')], null);
    const markup = html(<InboxTable rows={rows} statusUnavailable />);
    expect(markup).toContain('615,00 zł');
    expect(markup).not.toContain('>Status<');
    expect(markup).not.toContain('>Akcje<');
    expect(markup).not.toContain('Wszystkie statusy');
    expect(markup).not.toContain('jeszcze powstaje');
  });

  it('strona skrzynki: błąd odczytu wydatków → komunikat zgodny z ekranem (kolumna ukryta)', async () => {
    pageContext.get.mockResolvedValue({
      supabase: supabaseReturning({
        invoices: { data: [invoice('inv-1')], error: null },
        expenses: { data: null, error: { message: 'connection reset' } },
      }),
      tenantId: TENANT,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const markup = html((await InboxPage()) as ReactElement);
    error.mockRestore();
    expect(markup).toContain('Nie udało się sprawdzić statusu faktur');
    expect(markup).not.toContain('>Status<');
    expect(markup).not.toContain('jeszcze powstaje');
  });

  it('stan pusty: tekst z e2e 04 dokładnie raz (getByText w trybie ścisłym)', () => {
    const markup = html(<InboxTable rows={[]} />);
    expect(markup.match(/Brak faktur przychodzących/g)).toHaveLength(1);
    expect(markup).toContain('Otrzymane faktury pojawią się tutaj automatycznie po synchronizacji z KSeF');
  });

  it('kafle: nowe faktury, koszty skrzynki, ostatnie pobranie i puste stany', async () => {
    stats.countExpensesToReview.mockResolvedValue(2);
    stats.getInboxMonthCosts.mockResolvedValue({ month: '2026-10', gross: 1845, count: 3 });
    stats.getLastInboxFetchAt.mockResolvedValueOnce('2026-10-19T14:05:00Z').mockResolvedValue(null);
    const props = { supabase, tenantId: TENANT, user: { id: 'uzytkownik-1' } };

    const fresh = html((await InboxNewCell(props)) as ReactElement);
    expect(fresh).toContain('Nowe faktury');
    expect(stats.countExpensesToReview).toHaveBeenCalledWith(supabase, TENANT, { source: 'ksef_inbox' });

    const month = html((await InboxMonthCostsCell(props)) as ReactElement);
    expect(month).toContain('1,8 tys. zł');
    expect(month).toContain('3 faktury w KPiR');

    const last = html((await InboxLastFetchCell(props)) as ReactElement);
    expect(last).toContain('19.10.2026, 16:05');

    const none = html((await InboxLastFetchCell(props)) as ReactElement);
    expect(none).toContain('Jeszcze nie pobraliśmy żadnej faktury');
    // Poprawka 21.10.2026: podtytuł z „co 15 minut” zniknął — rytm jest w kaflu także przed pierwszym pobraniem.
    expect(none).toContain('sprawdzamy KSeF co 15 minut');

    // Tryb liczony dla firmy i użytkownika strony (PLAN-PRAWDZIWE-DANE §4 „Uwaga do F”).
    expect(stats.trybCtx).toEqual({ supabase, tenantId: TENANT, user: { id: 'uzytkownik-1' } });

    stats.verified.mockResolvedValue(false);
    const noKsef = html((await InboxLastFetchCell(props)) as ReactElement);
    expect(noKsef).toContain('Podłącz KSeF, a faktury kosztowe pobierzemy same');
    expect(noKsef).not.toContain('Sprawdź teraz');
  });

  it('kafel: „Sprawdź teraz” i ostatnie sprawdzenie, gdy firma ma harmonogram', async () => {
    stats.getLastInboxFetchAt.mockResolvedValue('2026-10-19T14:05:00Z');
    stats.getInboxScheduleSummary.mockResolvedValue({ lastCheckedAt: '2026-10-20T08:30:00Z' });
    const props = { supabase, tenantId: TENANT, user: { id: 'uzytkownik-1' } };

    const cell = html((await InboxLastFetchCell(props)) as ReactElement);
    expect(cell).toContain('Sprawdź teraz');
    expect(cell).toContain('19.10.2026, 16:05');
    expect(cell).toContain('Ostatnie sprawdzenie: 20.10.2026, 10:30');
    expect(cell).toContain('sprawdzamy KSeF co 15 minut');
    expect(cell).not.toMatch(/[—–]/);
  });

  it('kafel: przed pierwszą fakturą przycisk też jest, gdy firma ma KSeF', async () => {
    stats.getLastInboxFetchAt.mockResolvedValue(null);
    stats.getInboxScheduleSummary.mockResolvedValue({ lastCheckedAt: null });
    const props = { supabase, tenantId: TENANT, user: { id: 'uzytkownik-1' } };

    const cell = html((await InboxLastFetchCell(props)) as ReactElement);
    expect(cell).toContain('Jeszcze nie pobraliśmy żadnej faktury');
    expect(cell).toContain('Sprawdź teraz');
  });

  it('kafel: bez harmonogramu (firma bez KSeF albo baza przed 00160) bez przycisku, dotychczasowy tekst', async () => {
    stats.getLastInboxFetchAt.mockResolvedValue('2026-10-19T14:05:00Z');
    stats.getInboxScheduleSummary.mockResolvedValue(null);
    const props = { supabase, tenantId: TENANT, user: { id: 'uzytkownik-1' } };

    const cell = html((await InboxLastFetchCell(props)) as ReactElement);
    expect(cell).toContain('Sprawdzamy KSeF co 15 minut');
    expect(cell).not.toContain('Sprawdź teraz');
  });
});

describe('/expenses/[id] — karta szczegółów Finory, logika formularza bez zmian', () => {
  it('karta szczegółów: kwota, status, sprzedawca, źródło, dokument; przyciski jak dotąd', () => {
    const markup = html(
      <ExpenseEditForm expense={expense('e-1', { is_reviewed: false })} photoUrl={null} ksefCurrency={null} />,
    );
    expect(markup).toContain('Zaakceptuj wydatek');
    expect(markup).toContain('Szczegóły wydatku');
    expect(markup).toContain('123,00 zł');
    expect(markup).toContain('Do opisania');
    expect(markup).toContain('Telekom sp. z o.o.');
    expect(markup).toContain('Faktura · FV/10/2026');
    expect(markup).toContain('05.10.2026');
    expect(markup).toContain('Uwzględnij w KPiR');
    expect(markup).toContain('>Zaakceptuj<');
    expect(markup).toContain('Usuń');
    expect(markup).not.toMatch(/glass|backdrop-blur/);
  });

  it('koszt KSeF w EUR bez kursu: ostrzeżenie, „Zapisz poza KPiR” po odznaczeniu, bez „Usuń”', () => {
    const markup = html(
      <ExpenseEditForm
        expense={expense('e-1', { source: 'ksef_inbox', ksef_invoice_id: 'inv-1', is_deductible: false })}
        photoUrl={null}
        ksefCurrency="EUR"
      />,
    );
    expect(markup).toContain('Faktura w EUR wymaga ręcznego uzgodnienia.');
    expect(markup).toContain('Brak potwierdzonego kursu');
    expect(markup).toContain('Zapisz poza KPiR');
    expect(markup).not.toContain('>Usuń<');
  });

  it('kwota w karcie szczegółów: kod waluty bez kursu, „zł” z kursem, bez „zł” przy nieznanej walucie', () => {
    const ksef = { source: 'ksef_inbox' as const, ksef_invoice_id: 'inv-1', gross_amount: 1000 };
    const noRate = html(<ExpenseEditForm expense={expense('e-1', ksef)} photoUrl={null} ksefCurrency="EUR" />);
    expect(noRate).toContain('1000,00 EUR');
    expect(noRate).not.toContain('1000,00 zł');

    const fx = { currency: 'EUR', mid: 4.25, tableNo: '200/A/NBP/2026', effectiveDate: '2026-10-02', appliedFor: '2026-10-05' };
    const withRate = html(
      <ExpenseEditForm
        expense={expense('e-1', { ...ksef, gross_amount: 4250, ocr_extracted_data: { source: 'ksef_inbox', currency: 'EUR', fx } })}
        photoUrl={null}
        ksefCurrency="EUR"
      />,
    );
    expect(withRate).toContain('4250,00 zł');

    const unknown = html(<ExpenseEditForm expense={expense('e-1', ksef)} photoUrl={null} ksefCurrency={null} />);
    expect(unknown).not.toContain('1000,00 zł');
    expect(unknown).toContain('waluta do wyjaśnienia');

    const pln = html(<ExpenseEditForm expense={expense('e-1', ksef)} photoUrl={null} ksefCurrency="PLN" />);
    expect(pln).toContain('1000,00 zł');
  });

  it('zdjęcie paragonu w karcie Finory', () => {
    const markup = html(
      <ExpenseEditForm expense={expense('e-1', { source: 'ocr_photo' })} photoUrl="https://r2.example/p.jpg" ksefCurrency={null} />,
    );
    expect(markup).toContain('Zdjęcie paragonu');
    expect(markup).toContain('src="https://r2.example/p.jpg"');
  });
});

describe('pomocnicze', () => {
  it('data DD.MM.RRRR', () => {
    expect(plDate('2026-10-05')).toBe('05.10.2026');
    expect(plDate(null)).toBe('—');
  });

  it('wybór miesiąca: 24 wstecz od bieżącego, wybrany spoza listy dochodzi na koniec', () => {
    const options = monthOptions('2026-10', '2026-10');
    expect(options).toHaveLength(24);
    expect(options[0]).toEqual({ label: 'Październik 2026', value: '2026-10' });
    expect(options.at(-1)?.value).toBe('2024-11');
    expect(monthOptions('2026-10', '2020-01').at(-1)).toEqual({ label: 'Styczeń 2020', value: '2020-01' });
  });
});
