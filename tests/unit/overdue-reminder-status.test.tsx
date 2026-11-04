import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Query = { table: string; selection: string; exactCount: boolean; head?: boolean; filters: Array<[string, unknown]> };
const mocks = vi.hoisted(() => ({ client: vi.fn(), activeOrg: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }));
vi.mock('@/lib/dashboard-shell-data', () => ({ getDashboardOrgSwitcherProps: mocks.activeOrg }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => 'production' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock('@/components/reminders/reminder-consent-dialog', () => ({ ReminderConsentDialog: () => null }));
vi.mock('@/app/actions/reminders', () => ({ toggleInvoiceRemindersAction: vi.fn() }));
vi.mock('@/app/actions/invoice-payments', () => ({ markInvoicePaidAction: vi.fn(), undoInvoicePaidAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import OverduePage from '@/app/(dashboard)/(faktury)/payments/overdue/page';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVOICE = '11111111-1111-4111-8111-111111111111';
let rows: Record<string, Row[]>;
let queries: Query[];
let failReminderRead: boolean;
let missingCount: boolean;
let failRelatedRead: boolean;
let missingRelatedCount: boolean;
let failAdvanceRead: boolean;
let missingAdvanceCount: boolean;
let serverCap: number;
let injectUnexpectedReminder: boolean;
function invoice(id: string, tenantId: string): Row & { id: string; tenant_id: string } {
  return { id, tenant_id: tenantId, internal_number: id === INVOICE ? 'VISIBLE-1' : 'FOREIGN-1',
    payment_due_date: '2026-09-01', gross_total: 100, paid_amount: 0, amount_due: 100,
    days_overdue: 22, buyer_name: 'Buyer', buyer_nip: null, buyer_email: 'buyer@example.test',
    reminders_paused: false, reminders_sent_count: 0 };
}
function reminder(invoiceId: string, tenantId: string, scheduledFor: string): Row {
  return { invoice_id: invoiceId, tenant_id: tenantId, scheduled_for: scheduledFor, status: 'pending' };
}
function client() {
  return { from(table: string) {
    const query: Query = { table, selection: '*', exactCount: false, filters: [] };
    queries.push(query);
    const filters: Array<(row: Row) => boolean> = [];
    let minimum = 0;
    let maximum = Infinity;
    const execute = () => {
      if (table === 'payment_reminders' && failReminderRead) {
        return { data: null, error: { message: 'PRIVATE ERROR' } };
      }
      if (table === 'invoices' && query.selection === 'id, tenant_id, parent_invoice_id' && failRelatedRead) {
        return { data: null, error: { message: 'PRIVATE ERROR' }, count: null };
      }
      if (table === 'invoices' && query.selection === 'id' && failAdvanceRead) {
        return { data: null, error: { message: 'PRIVATE ERROR' }, count: null };
      }
      const source: Row[] = table === 'invoices' && !rows.invoices
        ? (rows.invoices_overdue ?? []).map((row) => ({
            id: row.id, tenant_id: row.tenant_id, ksef_environment: 'production',
            origin: 'app', invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN',
          }))
        : (rows[table] ?? []);
      const matching = source.filter((row) => filters.every((test) => test(row)));
      if (table === 'payment_reminders' && injectUnexpectedReminder) {
        matching.push(reminder('unexpected-invoice', TENANT, '2026-09-23T11:00:00.000Z'));
      }
      const data = matching.slice(minimum, minimum + Math.min(maximum, serverCap)).map((row) => structuredClone(row));
      return { data: query.head ? null : data, error: null, count: query.exactCount
        ? ((table === 'payment_reminders' && missingCount) ||
          (table === 'invoices' && query.selection === 'id, tenant_id, parent_invoice_id' && missingRelatedCount) ||
          (table === 'invoices' && query.selection === 'id' && missingAdvanceCount)
          ? null : matching.length) : null };
    };
    const builder = {
      select: (selection: string, options?: { count?: 'exact'; head?: boolean }) => {
        query.selection = selection; query.exactCount = options?.count === 'exact'; query.head = options?.head;
        return builder;
      },
      eq: (key: string, expected: unknown) => { query.filters.push([key, expected]); filters.push((row) => row[key] === expected); return builder; },
      in: (key: string, expected: string[]) => { query.filters.push([key, expected]); filters.push((row) => expected.includes(String(row[key]))); return builder; },
      contains: (key: string, expected: string[]) => {
        query.filters.push([key, expected]);
        filters.push((row) => Array.isArray(row[key]) && expected.every((id) => (row[key] as string[]).includes(id)));
        return builder;
      },
      order: () => builder,
      limit: (count: number) => { maximum = count; return builder; },
      range: (start: number, end: number) => { minimum = start; maximum = end - start + 1; return builder; },
      then: <T = ReturnType<typeof execute>, E = never>(
        resolve?: ((value: ReturnType<typeof execute>) => T | PromiseLike<T>) | null,
        reject?: ((reason: unknown) => E | PromiseLike<E>) | null,
      ) => Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  } };
}
async function markup() { return renderToStaticMarkup(await OverduePage()); }
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
  queries = []; failReminderRead = false; missingCount = false; failRelatedRead = false;
  missingRelatedCount = false; failAdvanceRead = false; missingAdvanceCount = false; serverCap = Infinity;
  injectUnexpectedReminder = false;
  rows = { invoices_overdue: [invoice(INVOICE, TENANT)], payment_reminders: [] };
  mocks.client.mockResolvedValue(client());
  mocks.activeOrg.mockResolvedValue({ activeOrgId: TENANT });
});
afterEach(() => vi.useRealTimers());

describe('overdue reminder status', () => {
  it('shows only app invoices without linked corrections in the displayed sum', async () => {
    const importedId = '22222222-2222-4222-8222-222222222222';
    const correctionId = '33333333-3333-4333-8333-333333333333';
    const correctedId = '44444444-4444-4444-8444-444444444444';
    rows.invoices_overdue = [invoice(INVOICE, TENANT),
      { ...invoice(importedId, TENANT), internal_number: 'IMPORTED' },
      { ...invoice(correctionId, TENANT), internal_number: 'CORRECTION' },
      { ...invoice(correctedId, TENANT), internal_number: 'CORRECTED-ORIGINAL' }];
    rows.invoices = [
      { id: INVOICE, tenant_id: TENANT, ksef_environment: 'production', origin: 'app',
        invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' },
      { id: importedId, tenant_id: TENANT, ksef_environment: 'production', origin: 'ksef_import',
        invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' },
      { id: correctionId, tenant_id: TENANT, ksef_environment: 'production', origin: 'app',
        invoice_kind: 'correction', invoice_type: 'KOR', currency: 'PLN' },
      { id: correctedId, tenant_id: TENANT, ksef_environment: 'production', origin: 'app',
        invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' },
      { id: 'child', tenant_id: TENANT, parent_invoice_id: correctedId,
        invoice_kind: 'correction', invoice_type: 'KOR', ksef_status: 'accepted', gross_total: 110.70 },
    ];
    const page = await OverduePage();
    const props = page.props as { overdueInvoices: Array<{ id: string }>; stats: { totalAmount: number } };
    expect(props.overdueInvoices.map((item) => item.id)).toEqual([INVOICE]);
    expect(props.stats.totalAmount).toBe(100);
    const html = renderToStaticMarkup(page);
    // Poprawka Bartosza 21.10.2026: stała nota nad kaflami zniknęła. Zakres sumy
    // (bez importów i korekt) mówi podpis kafla „Po terminie” (RECEIVABLES_NOTE).
    expect(html).not.toContain('role="note"');
    expect(html).not.toContain('Importy i dokumenty wymagające uzgodnienia nie wchodzą do tej sumy');
    expect(html).toContain('Suma pokazanych pozycji<br/>Bez importów i faktur skorygowanych');
    expect(html).not.toContain('Suma do odzyskania');
    expect(html).not.toContain('IMPORTED');
    expect(html).not.toContain('CORRECTED-ORIGINAL');
    const related = queries.find((query) => query.selection === 'id, tenant_id, parent_invoice_id');
    expect(related?.exactCount).toBe(true);
    expect(related?.filters).toEqual([['tenant_id', TENANT], ['parent_invoice_id', [INVOICE, correctedId]]]);
  });

  it('excludes an accepted ZAL settled by ROZ with no parent_invoice_id from the displayed sum', async () => {
    const advanceId = '22222222-2222-4222-8222-222222222222';
    rows.invoices_overdue = [invoice(INVOICE, TENANT),
      { ...invoice(advanceId, TENANT), internal_number: 'ADVANCE-123', gross_total: 123, amount_due: 123 }];
    rows.invoices = [
      { id: INVOICE, tenant_id: TENANT, ksef_environment: 'production', origin: 'app',
        invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' },
      { id: advanceId, tenant_id: TENANT, ksef_environment: 'production', origin: 'app',
        invoice_kind: 'advance', invoice_type: 'ZAL', currency: 'PLN', ksef_status: 'accepted' },
      { id: 'final', tenant_id: TENANT, parent_invoice_id: null, advance_invoice_ids: [advanceId],
        invoice_kind: 'final', invoice_type: 'ROZ', ksef_status: 'accepted' },
    ];
    const page = await OverduePage();
    const props = page.props as { overdueInvoices: Array<{ id: string }>; stats: { totalAmount: number } };
    expect(props.overdueInvoices.map((item) => item.id)).toEqual([INVOICE]);
    expect(props.stats.totalAmount).toBe(100);
    expect(renderToStaticMarkup(page)).not.toContain('ADVANCE-123');
    expect(queries.find((query) => query.selection === 'id' && query.filters.some(([key]) => key === 'advance_invoice_ids')))
      .toMatchObject({ table: 'invoices', exactCount: true, head: true,
        filters: [['tenant_id', TENANT], ['advance_invoice_ids', [advanceId]]] });
  });

  it('fails closed if the final-invoice settlement count is missing or its read fails', async () => {
    rows.invoices = [{ id: INVOICE, tenant_id: TENANT, ksef_environment: 'production', origin: 'app',
      invoice_kind: 'advance', invoice_type: 'ZAL', currency: 'PLN' }];
    missingAdvanceCount = true;
    expect(await markup()).toContain('Nie można potwierdzić faktur rozliczających zaliczki');
    expect(queries.some((query) => query.table === 'payment_reminders')).toBe(false);
    missingAdvanceCount = false; failAdvanceRead = true; queries = [];
    expect(await markup()).toContain('Nie można potwierdzić faktur rozliczających zaliczki');
    expect(queries.some((query) => query.table === 'payment_reminders')).toBe(false);
  });

  it('fails closed when linked children are truncated or their exact count is unavailable', async () => {
    rows.invoices = [
      { id: INVOICE, tenant_id: TENANT, ksef_environment: 'production', origin: 'app',
        invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' },
      { id: 'child-1', tenant_id: TENANT, parent_invoice_id: INVOICE },
      { id: 'child-2', tenant_id: TENANT, parent_invoice_id: INVOICE },
    ];
    serverCap = 1;
    expect(await markup()).toContain('Nie można potwierdzić faktur powiązanych z korektami');
    expect(queries.some((query) => query.table === 'payment_reminders')).toBe(false);
    serverCap = Infinity; missingRelatedCount = true; queries = [];
    expect(await markup()).toContain('Nie można potwierdzić faktur powiązanych z korektami');
    expect(queries.some((query) => query.table === 'payment_reminders')).toBe(false);
    missingRelatedCount = false; failRelatedRead = true; queries = [];
    expect(await markup()).toContain('Nie można potwierdzić faktur powiązanych z korektami');
  });

  it('excludes inconsistent app classification and foreign currency before showing a PLN sum', async () => {
    const malformedId = '22222222-2222-4222-8222-222222222222';
    const euroId = '33333333-3333-4333-8333-333333333333';
    rows.invoices_overdue = [invoice(INVOICE, TENANT), invoice(malformedId, TENANT), invoice(euroId, TENANT)];
    rows.invoices = [
      { id: INVOICE, tenant_id: TENANT, ksef_environment: 'production', origin: 'app', invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' },
      { id: malformedId, tenant_id: TENANT, ksef_environment: 'production', origin: 'app', invoice_kind: 'regular', invoice_type: 'ZAL', currency: 'PLN' },
      { id: euroId, tenant_id: TENANT, ksef_environment: 'production', origin: 'app', invoice_kind: 'regular', invoice_type: 'VAT', currency: 'EUR' },
    ];
    const page = await OverduePage();
    const props = page.props as { overdueInvoices: Array<{ id: string }>; stats: { totalAmount: number } };
    expect(props.overdueInvoices.map((item) => item.id)).toEqual([INVOICE]);
    expect(props.stats.totalAmount).toBe(100);
  });

  it('keeps 100 production debts after older TEST and DEMO invoices are excluded', async () => {
    const testRows = Array.from({ length: 110 }, (_, index) => ({
      ...invoice('test-' + index, TENANT), internal_number: 'TEST-' + index,
    }));
    const productionRows = Array.from({ length: 100 }, (_, index) => ({
      ...invoice('prod-' + index, TENANT), internal_number: 'PROD-' + index,
    }));
    rows.invoices_overdue = [...testRows, ...productionRows];
    rows.invoices = [
      ...testRows.map((row, index) => ({ id: row.id, tenant_id: TENANT,
        ksef_environment: index % 2 === 0 ? 'test' : 'demo',
        origin: 'app', invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' })),
      ...productionRows.map((row) => ({ id: row.id, tenant_id: TENANT,
        ksef_environment: 'production', origin: 'app', invoice_kind: 'regular',
        invoice_type: 'VAT', currency: 'PLN' })),
    ];

    const page = await OverduePage();
    const props = page.props as {
      overdueInvoices: Array<{ id: string }>;
      stats: { totalAmount: number };
    };
    expect(props.overdueInvoices).toHaveLength(100);
    expect(props.overdueInvoices.every((row) => row.id.startsWith('prod-'))).toBe(true);
    expect(props.stats.totalAmount).toBe(10_000);
    // Dokładnie 100 po przejrzeniu całego widoku: lista jest pełna, bez noty o limicie.
    expect((page.props as { limitReached: boolean }).limitReached).toBe(false);
    expect(queries.filter((query) => query.table === 'invoices_overdue')).toHaveLength(3);
    expect(queries.filter((query) => query.table === 'invoices' && query.selection.includes('ksef_environment'))
      .every((query) => query.selection === 'id, ksef_environment, origin, invoice_kind, invoice_type, currency, payment_data' && query.exactCount)).toBe(true);
  });

  it('notes the 100-invoice cap only when more overdue invoices may exist (poprawka Bartosza 21.10.2026)', async () => {
    const productionRows = (count: number) => Array.from({ length: count }, (_, index) => ({
      ...invoice('prod-' + index, TENANT), internal_number: 'PROD-' + index,
    }));
    // Od 25.10.2026 liczby „Po terminie” stoją w pasku nad tabelą (`PanelStats`:
    // etykieta, liczba, podpis), nie w osobnych kaflach zakładki.
    const CAP_NOTE = /Faktur po terminie<\/dt><dd[^>]*>100<\/dd><dd[^>]*>średnio 22 dni po terminie<br\/>Pokazujemy pierwsze 100, od najdłużej zaległych<\/dd>/;

    // Jedna faktura: bez noty.
    let page = await OverduePage();
    expect((page.props as { limitReached: boolean }).limitReached).toBe(false);
    expect(renderToStaticMarkup(page)).not.toContain('Pokazujemy pierwsze');

    // Dokładnie 100 na jednej stronie widoku: lista pełna, bez noty.
    rows.invoices_overdue = productionRows(100);
    page = await OverduePage();
    expect((page.props as { limitReached: boolean }).limitReached).toBe(false);
    expect(renderToStaticMarkup(page)).not.toContain('Pokazujemy pierwsze');

    // 101 kandydatów: pętla staje po 100 bezpiecznych, 101. nie jest sprawdzana —
    // dalszych pozycji nie wykluczymy, więc nota mówi „pierwsze 100”.
    rows.invoices_overdue = productionRows(101);
    page = await OverduePage();
    expect((page.props as { overdueInvoices: unknown[] }).overdueInvoices).toHaveLength(100);
    expect((page.props as { limitReached: boolean }).limitReached).toBe(true);
    expect(renderToStaticMarkup(page)).toMatch(CAP_NOTE);

    // Cały widok przejrzany, bezpiecznych ponad 100 (99 + 100 z dwóch stron): ucięte na pewno.
    const testRow = { ...invoice('test-0', TENANT), internal_number: 'TEST-0' };
    rows.invoices_overdue = [testRow, ...productionRows(199)];
    rows.invoices = rows.invoices_overdue.map((row) => ({ id: row.id, tenant_id: TENANT,
      ksef_environment: row.id === 'test-0' ? 'test' : 'production', origin: 'app',
      invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN' }));
    page = await OverduePage();
    expect((page.props as { overdueInvoices: unknown[] }).overdueInvoices).toHaveLength(100);
    expect((page.props as { limitReached: boolean }).limitReached).toBe(true);
    expect(renderToStaticMarkup(page)).toMatch(CAP_NOTE);
  });

  it('shows reconciliation error for an overdue accepted invoice with unknown environment', async () => {
    rows.invoices = [{ id: INVOICE, tenant_id: TENANT, ksef_environment: null }];
    const html = await markup();
    expect(html).toContain('wymagają uzgodnienia środowiska KSeF');
    expect(html).not.toContain('Brak zaległych płatności');
    expect(queries.some((query) => query.table === 'payment_reminders')).toBe(false);
  });

  it('shows pending only for a visible invoice of the validated active tenant', async () => {
    rows.invoices_overdue.push(invoice('22222222-2222-4222-8222-222222222222', FOREIGN));
    rows.payment_reminders.push(reminder(INVOICE, TENANT, '2026-09-23T11:40:00.000Z'));
    rows.payment_reminders.push(reminder('22222222-2222-4222-8222-222222222222', FOREIGN, '2026-09-23T11:00:00.000Z'));
    const html = await markup();
    expect(html).toContain('Oczekuje na wysyłkę');
    // Poprawka Bartosza 21.10.2026: zastrzeżenie przeszło z noty nad kaflami
    // do podpisu kafla „Przypomnień wysłanych w miesiącu” (ten atrapowy klient nie
    // zna `.gte`, więc licznik kafla jest tu nieodczytany — zdanie stoi pod tą linią).
    expect(html).toMatch(/Przypomnień wysłanych w miesiącu<\/dt><dd[^>]*>—<\/dd><dd[^>]*>Nie udało się odczytać — odśwież za chwilę<br\/>Stan przypomnień jest orientacyjny<\/dd>/);
    expect(html).not.toContain('Stan przypomnień jest orientacyjny.');
    expect(html).not.toContain('FOREIGN-1');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Przypomnienie już zlecone"/);
    const view = queries.find((q) => q.table === 'invoices_overdue')!;
    const pending = queries.find((q) => q.table === 'payment_reminders')!;
    expect(view.filters).toContainEqual(['tenant_id', TENANT]);
    expect(pending.filters).toEqual(expect.arrayContaining([
      ['tenant_id', TENANT], ['invoice_id', [INVOICE]], ['status', 'pending'],
    ]));
    expect(pending.selection).toBe('invoice_id, scheduled_for');
    expect(pending.exactCount).toBe(true);
  });

  it('shows manual review after more than 30 minutes and no repeat-prepare action', async () => {
    rows.payment_reminders = [reminder(INVOICE, TENANT, '2026-09-23T11:29:59.000Z')];
    const html = await markup();
    expect(html).toContain('Wymaga weryfikacji wysyłki');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Wysyłka wymaga weryfikacji"/);
    expect(html).not.toContain('aria-label="Przygotuj przypomnienie"');
  });

  it('does not turn a failed status read into a claim that nothing is pending', async () => {
    failReminderRead = true;
    const html = await markup();
    expect(html).toContain('Stan wysyłki niedostępny');
    expect(html).not.toContain('aria-label="Przygotuj przypomnienie"');
    expect(html).not.toContain('PRIVATE ERROR');
  });

  it('shows unavailable when PostgREST truncates a full 100-invoice result', async () => {
    rows.invoices_overdue = Array.from({ length: 100 }, (_, index) =>
      invoice(index === 0 ? INVOICE : 'invoice-' + index, TENANT));
    rows.payment_reminders = rows.invoices_overdue.flatMap((item) =>
      Array.from({ length: 4 }, (_, stage) => reminder(String(item.id), TENANT,
        stage === 0 ? '2026-09-23T11:20:00.000Z' : '2026-09-23T11:40:00.000Z')));
    serverCap = 100;
    const page = await OverduePage();
    const statuses = (page.props as { overdueInvoices: Array<{ reminder_status: string }> }).overdueInvoices;
    expect(statuses).toHaveLength(100);
    expect(statuses.every((item) => item.reminder_status === 'unavailable')).toBe(true);
    expect(queries.find((q) => q.table === 'payment_reminders')?.exactCount).toBe(true);
  });

  it('fails closed if an inconsistent result includes an invoice outside the visible set', async () => {
    injectUnexpectedReminder = true;
    const html = await markup();
    expect(html).toContain('Stan wysyłki niedostępny');
    expect(html).not.toContain('aria-label="Przygotuj przypomnienie"');
  });

  it('shows unavailable when PostgREST omits the exact count, including an empty response', async () => {
    missingCount = true;
    const html = await markup();
    expect(html).toContain('Stan wysyłki niedostępny');
    expect(html).not.toContain('aria-label="Przygotuj przypomnienie"');
  });

  it('shows the latest reminder entry (any status) after the pending read, scoped to the tenant', async () => {
    rows.payment_reminders = [
      { ...reminder(INVOICE, TENANT, '2026-09-10T08:00:00.000Z'), stage: 'stage_1', status: 'sent' },
      { ...reminder(INVOICE, TENANT, '2026-09-17T08:00:00.000Z'), stage: 'stage_2', status: 'failed' },
    ];
    const page = await OverduePage();
    const [first] = (page.props as { overdueInvoices: Array<{ latest_reminder: unknown }> }).overdueInvoices;
    expect(first?.latest_reminder).toEqual({ stage: 2, status: 'failed', scheduledFor: '2026-09-17T08:00:00.000Z' });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('17.09.2026');
    expect(html).toContain('Etap 2');
    expect(html).toContain('Nieudane');
    const reads = queries.filter((q) => q.table === 'payment_reminders' && !q.head);
    expect(reads[0]?.selection).toBe('invoice_id, scheduled_for');
    expect(reads[1]).toMatchObject({ selection: 'invoice_id, stage, status, scheduled_for', exactCount: true });
    expect(reads[1]?.filters).toEqual([['tenant_id', TENANT], ['invoice_id', [INVOICE]]]);
  });

  it('shows the settings link only to the owner of the active organization', async () => {
    expect(await markup()).not.toContain('href="/settings/reminders"');
    mocks.activeOrg.mockResolvedValue({ activeOrgId: TENANT, memberships: [{ organizationId: TENANT, role: 'owner', isActive: true }] });
    expect(await markup()).toContain('href="/settings/reminders"');
    mocks.activeOrg.mockResolvedValue({ activeOrgId: TENANT, memberships: [{ organizationId: TENANT, role: 'member', isActive: true }] });
    expect(await markup()).not.toContain('href="/settings/reminders"');
  });

  // „Zapłacone” (00158): ta sama lista ról co w `mark_invoice_paid`. Księgowa widzi
  // należność, ale nie oznacza, więc przycisk, który RPC i tak by odrzuciło, nie powstaje.
  it.each([
    ['owner', true],
    ['admin', true],
    ['member', true],
    ['accountant', false],
  ])('role %s: the "Zapłacone" button present = %s', async (role, expected) => {
    mocks.activeOrg.mockResolvedValue({ activeOrgId: TENANT, memberships: [{ organizationId: TENANT, role, isActive: true }] });
    const html = await markup();
    expect(html.includes('aria-label="Zapłacone: oznacz fakturę VISIBLE-1"')).toBe(expected);
    // Etykieta zaczyna się od widocznego tekstu (WCAG 2.5.3), a pole dotyku ma 44 px.
    if (expected) expect(html).toMatch(/max-lg:min-h-\[44px\][^"]*max-lg:min-w-\[44px\]/);
  });

  it('marks nothing without a membership in the active organization', async () => {
    mocks.activeOrg.mockResolvedValue({ activeOrgId: TENANT, memberships: [{ organizationId: FOREIGN, role: 'owner', isActive: false }] });
    expect(await markup()).not.toContain('Zapłacone: oznacz fakturę');
  });

  it('leaves fresh preparation available only when the status read succeeds and finds no pending row', async () => {
    const html = await markup();
    expect(html).toContain('aria-label="Przygotuj przypomnienie"');
    expect(html).not.toContain('Wymaga weryfikacji wysyłki');
  });
});
