import { z } from 'zod';

import { listExpenses, EXPENSE_REVIEW_STATUSES, type ApiExpense } from '@/lib/api/v1/expenses';
import {
  INVOICE_DIRECTIONS,
  INVOICE_KSEF_STATUSES,
  listInvoices,
  readInvoice,
  type ApiInvoice,
  type ApiInvoiceDetail,
  type ApiInvoiceItem,
  type InvoiceListQuery,
} from '@/lib/api/v1/invoices';
import { decodeCursor, isCalendarDate, isUuid } from '@/lib/api/v1/pagination';
import type { ApiKeyScope } from '@/lib/api/v1/scopes';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Narzędzia łącza MCP (krok 7.2): wyłącznie odczyt, na tych samych zapytaniach
 * co `GET /api/v1/invoices`, `GET /api/v1/invoices/{id}` i `GET /api/v1/expenses`
 * (`lib/api/v1/invoices.ts`, `lib/api/v1/expenses.ts`). Nie ma tu żadnej własnej
 * ścieżki do danych: klient bazy to token klucza, więc RLS wpuszcza tylko firmę
 * i zakres klucza, a filtr `tenant_id` jest drugą warstwą.
 *
 * Kwoty wychodzą jako liczby z kodem waluty (`currency`) obok. Zaokrąglenie to
 * wyłącznie `roundToCents`; ilość i cena jednostkowa pozycji nie są kwotami
 * końcowymi, więc zostają bez zaokrąglenia do groszy.
 *
 * Żadne narzędzie nie zapisuje, nie wysyła i nie zmienia stanu: test
 * `tests/unit/mcp.test.ts` sprawdza listę nazw i to, że do bazy idą same odczyty.
 */

export const MCP_DEFAULT_LIMIT = 25;
export const MCP_MAX_LIMIT = 50;

/** Stany płatności faktury, które do dziś są należnością (jak widok `invoices_overdue`). */
export const RECEIVABLE_PAYMENT_STATUSES = ['unpaid', 'partial', 'overdue'] as const;
const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'overdue'] as const;

export interface McpToolContext {
  db: SupabaseClient;
  tenantId: string;
  /** Dzisiejsza data w Polsce (RRRR-MM-DD): od niej liczymy „po terminie”. */
  today: string;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** Zakres klucza potrzebny do narzędzia. */
  scope: ApiKeyScope;
  inputSchema: z.ZodType;
  run(context: McpToolContext, input: unknown): Promise<Record<string, unknown>>;
}

/** Wejście, które się nie zgadza ze schematem: komunikat dla asystenta i człowieka. */
export class McpInputError extends Error {}

// ─── Wejście ────────────────────────────────────────────────────────────

const dateField = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data ma format RRRR-MM-DD.')
    .refine(isCalendarDate, 'To nie jest prawdziwa data kalendarzowa.')
    .describe(description);

const limitField = z
  .number()
  .int()
  .min(1)
  .max(MCP_MAX_LIMIT)
  .default(MCP_DEFAULT_LIMIT)
  .describe(`Ile wyników zwrócić (od 1 do ${MCP_MAX_LIMIT}, domyślnie ${MCP_DEFAULT_LIMIT}).`);

const cursorField = z
  .string()
  .refine((value) => decodeCursor(value) !== null, 'Kursor jest nieprawidłowy. Użyj wartości next_cursor z poprzedniej odpowiedzi.')
  .describe('Kursor kolejnej strony: wartość next_cursor z poprzedniej odpowiedzi.');

const listInvoicesInput = z.strictObject({
  direction: z.enum(INVOICE_DIRECTIONS).optional()
    .describe('outgoing: faktury wystawione przez firmę (sprzedaż), incoming: faktury otrzymane z KSeF.'),
  ksef_status: z.enum(INVOICE_KSEF_STATUSES).optional().describe('Stan faktury w KSeF, np. accepted (przyjęta).'),
  payment_status: z.array(z.enum(PAYMENT_STATUSES)).min(1).max(PAYMENT_STATUSES.length).optional()
    .describe('Stan płatności: unpaid (niezapłacona), partial (zapłacona częściowo), paid (zapłacona), overdue (po terminie).'),
  issue_date_from: dateField('Faktury wystawione od tej daty włącznie.').optional(),
  issue_date_to: dateField('Faktury wystawione do tej daty włącznie.').optional(),
  limit: limitField,
  cursor: cursorField.optional(),
});

const getInvoiceInput = z.strictObject({
  id: z.string().refine((value) => isUuid(value.toLowerCase()), 'Identyfikator faktury to UUID.')
    .describe('Identyfikator faktury (pole id z listy faktur).'),
});

const listReceivablesInput = z.strictObject({
  only_overdue: z.boolean().default(false)
    .describe('true: tylko faktury po terminie płatności. Domyślnie wszystkie niezapłacone.'),
  limit: limitField,
  cursor: cursorField.optional(),
});

const listExpensesInput = z.strictObject({
  review_status: z.enum(EXPENSE_REVIEW_STATUSES).optional()
    .describe('unreviewed: koszty jeszcze nieprzejrzane, reviewed: przejrzane.'),
  issue_date_from: dateField('Koszty z datą dokumentu od tej daty włącznie.').optional(),
  issue_date_to: dateField('Koszty z datą dokumentu do tej daty włącznie.').optional(),
  limit: limitField,
  cursor: cursorField.optional(),
});

/** Opisy błędów schematu po polsku: bez tekstów Zoda, które asystent pokazałby klientowi po angielsku. */
function polishIssue(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'To pole jest wymagane.' : `Zły typ wartości (oczekiwano: ${String(issue.expected)}).`;
    case 'unrecognized_keys':
      return `Nieznane pole: ${issue.keys.join(', ')}.`;
    case 'invalid_value':
      return `Dozwolone wartości: ${issue.values.map((value) => JSON.stringify(value)).join(', ')}.`;
    case 'too_small':
      return issue.origin === 'array' ? 'Za mało elementów.' : `Wartość jest za mała (najmniej: ${String(issue.minimum)}).`;
    case 'too_big':
      return issue.origin === 'array' ? 'Za dużo elementów.' : `Wartość jest za duża (najwyżej: ${String(issue.maximum)}).`;
    default:
      return undefined;
  }
}

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = z.safeParse(schema, input ?? {}, { error: polishIssue });
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    const message = issue.code === 'unrecognized_keys' ? `Nieznane pole: ${issue.keys.join(', ')}.` : issue.message;
    return path ? `${path}: ${message}` : message;
  });
  throw new McpInputError(`Nieprawidłowe dane wejściowe. ${lines.join(' ')}`);
}

// ─── Wyjście: kwoty jako liczby ─────────────────────────────────────────

/** Kwota tekstowa z bazy jako liczba z zaokrągleniem do groszy; `null`, gdy brak albo nie liczba. */
function amount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundToCents(parsed) : null;
}

function plainNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function invoiceSummary(invoice: ApiInvoice) {
  return {
    id: invoice.id,
    direction: invoice.direction,
    number: invoice.number,
    kind: invoice.kind,
    issue_date: invoice.issue_date,
    sale_date: invoice.sale_date,
    payment_due_date: invoice.payment_due_date,
    currency: invoice.currency,
    net_total: amount(invoice.net_total),
    vat_total: amount(invoice.vat_total),
    gross_total: amount(invoice.gross_total),
    paid_amount: amount(invoice.paid_amount) ?? 0,
    payment_status: invoice.payment_status,
    seller: invoice.seller,
    buyer: invoice.buyer,
    ksef_status: invoice.ksef_status,
    ksef_number: invoice.ksef_number,
  };
}

function itemSummary(item: ApiInvoiceItem) {
  return {
    position: item.position,
    name: item.name,
    quantity: plainNumber(item.quantity),
    unit: item.unit,
    unit_price_net: plainNumber(item.unit_price_net),
    net_amount: amount(item.net_amount),
    vat_rate: item.vat_rate,
    vat_amount: amount(item.vat_amount),
    gross_amount: amount(item.gross_amount),
  };
}

function invoiceDetail(invoice: ApiInvoiceDetail) {
  return { ...invoiceSummary(invoice), items: invoice.items.map(itemSummary) };
}

function expenseSummary(expense: ApiExpense) {
  return {
    id: expense.id,
    document_number: expense.document_number,
    document_type: expense.document_type,
    issue_date: expense.issue_date,
    seller: expense.seller,
    /** Waluta kwot kosztu; `null`, gdy FaktWay nie zna jej na pewno (nie zgadujemy złotych). */
    currency: expense.currency,
    net_amount: amount(expense.net_amount) ?? 0,
    vat_amount: amount(expense.vat_amount) ?? 0,
    gross_amount: amount(expense.gross_amount) ?? 0,
    vat_deductible_amount: amount(expense.vat_deductible_amount) ?? 0,
    vat_rate: expense.vat_rate,
    deductible: expense.deductible,
    review_status: expense.review_status,
    category: expense.category,
    source: expense.source,
    invoice_id: expense.invoice_id,
  };
}

function wholeDaysBetween(from: string, to: string): number {
  const day = (value: string) => Date.parse(`${value}T00:00:00Z`);
  return Math.round((day(to) - day(from)) / 86_400_000);
}

// ─── Narzędzia ──────────────────────────────────────────────────────────

function baseQuery(input: { limit: number; cursor?: string }): Pick<InvoiceListQuery, 'limit' | 'cursor'> {
  return { limit: input.limit, cursor: input.cursor ? decodeCursor(input.cursor) : null };
}

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'list_invoices',
    title: 'Lista faktur',
    scope: 'invoices:read',
    description:
      'Lista faktur firmy, od najnowszej daty wystawienia: wystawionych (outgoing) i otrzymanych z KSeF (incoming). '
      + 'Można filtrować po okresie wystawienia, kierunku, stanie w KSeF i stanie płatności. Kwoty są liczbami w walucie z pola currency. '
      + `Wyników jest najwyżej ${MCP_MAX_LIMIT} naraz; kolejną stronę pobierzesz kursorem next_cursor. Tylko odczyt.`,
    inputSchema: listInvoicesInput,
    async run(context, raw) {
      const input = parseInput(listInvoicesInput, raw);
      const page = await listInvoices(context.db, context.tenantId, {
        ...baseQuery(input),
        direction: input.direction ?? null,
        ksefStatus: input.ksef_status ?? null,
        issueDateFrom: input.issue_date_from ?? null,
        issueDateTo: input.issue_date_to ?? null,
        paymentStatuses: input.payment_status,
      });
      return { invoices: page.data.map(invoiceSummary), next_cursor: page.next_cursor };
    },
  },
  {
    name: 'get_invoice',
    title: 'Jedna faktura',
    scope: 'invoices:read',
    description:
      'Jedna faktura firmy z pozycjami, numerem, stronami, terminem płatności, stanem płatności i stanem w KSeF. '
      + 'Identyfikator faktury (id) weź z listy faktur albo należności. Faktury innej firmy nie da się odczytać. Tylko odczyt.',
    inputSchema: getInvoiceInput,
    async run(context, raw) {
      const input = parseInput(getInvoiceInput, raw);
      const invoice = await readInvoice(context.db, context.tenantId, input.id.toLowerCase());
      if (!invoice) throw new McpInputError('Nie ma takiej faktury w firmie tego klucza API.');
      return { invoice: invoiceDetail(invoice) };
    },
  },
  {
    name: 'list_receivables',
    title: 'Należności',
    scope: 'invoices:read',
    description:
      'Należności firmy: wystawione faktury przyjęte w KSeF, które nie są jeszcze w pełni zapłacone, z kwotą do zapłaty (amount_due) '
      + 'i liczbą dni po terminie (days_overdue). Ustaw only_overdue na true, żeby zobaczyć tylko faktury po terminie. '
      + 'Sumy amount_due_by_currency są osobno dla każdej waluty i dotyczą zwróconej strony wyników. Tylko odczyt.',
    inputSchema: listReceivablesInput,
    async run(context, raw) {
      const input = parseInput(listReceivablesInput, raw);
      const page = await listInvoices(context.db, context.tenantId, {
        ...baseQuery(input),
        direction: 'outgoing',
        ksefStatus: 'accepted',
        issueDateFrom: null,
        issueDateTo: null,
        paymentStatuses: RECEIVABLE_PAYMENT_STATUSES,
        dueBefore: input.only_overdue ? context.today : undefined,
      });
      const totals: Record<string, number> = {};
      const receivables = page.data.map((invoice) => {
        const summary = invoiceSummary(invoice);
        const gross = summary.gross_total ?? 0;
        const due = roundToCents(gross - summary.paid_amount);
        const daysOverdue = invoice.payment_due_date && invoice.payment_due_date < context.today
          ? wholeDaysBetween(invoice.payment_due_date, context.today)
          : 0;
        totals[summary.currency] = roundToCents((totals[summary.currency] ?? 0) + due);
        return { ...summary, amount_due: due, overdue: daysOverdue > 0, days_overdue: daysOverdue };
      });
      return {
        as_of: context.today,
        receivables,
        amount_due_by_currency: Object.fromEntries(Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))),
        next_cursor: page.next_cursor,
      };
    },
  },
  {
    name: 'list_expenses',
    title: 'Lista kosztów',
    scope: 'expenses:read',
    description:
      'Lista kosztów firmy (faktury kosztowe i dokumenty), od najnowszej daty dokumentu, z kwotami netto, VAT i brutto, '
      + 'kwotą VAT do odliczenia, kategorią i stanem przeglądu. Można filtrować po okresie i stanie przeglądu. '
      + 'Kwoty są liczbami w walucie z pola currency (null: waluta nieznana). '
      + `Wyników jest najwyżej ${MCP_MAX_LIMIT} naraz; kolejną stronę pobierzesz kursorem next_cursor. Tylko odczyt.`,
    inputSchema: listExpensesInput,
    async run(context, raw) {
      const input = parseInput(listExpensesInput, raw);
      const page = await listExpenses(context.db, context.tenantId, {
        ...baseQuery(input),
        reviewStatus: input.review_status ?? null,
        issueDateFrom: input.issue_date_from ?? null,
        issueDateTo: input.issue_date_to ?? null,
      });
      return { expenses: page.data.map(expenseSummary), next_cursor: page.next_cursor };
    },
  },
];

/** Schemat wejścia narzędzia w formacie JSON Schema (to widzi asystent w `tools/list`). */
export function toolInputJsonSchema(tool: McpTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
