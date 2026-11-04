import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/reminders/reminder-consent-dialog', () => ({ ReminderConsentDialog: () => null }));
vi.mock('@/app/actions/reminders', () => ({ toggleInvoiceRemindersAction: vi.fn() }));

import { OverdueDashboard, OverdueDashboardError, type OverdueInvoice } from '@/components/reminders/overdue-dashboard';
import {
  countRemindersSentThisMonth,
  pickLatestReminders,
  readLatestReminders,
  warsawMidnightIso,
} from '@/lib/overdue/reminder-overview';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * P7 (PLAN-FINORA §5): `/payments/overdue` w układzie Invoice Reminders
 * Finory — kafle, kolumny „Przypomnienie” i „Status” z ostatniego wpisu
 * `payment_reminders`, link „Ustawienia przypomnień” tylko dla właściciela.
 */

const INVOICE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function row(invoiceId: string, stage: string, status: string, scheduledFor: string) {
  return { invoice_id: invoiceId, stage, status, scheduled_for: scheduledFor };
}

function overdue(overrides: Partial<OverdueInvoice> = {}): OverdueInvoice {
  return {
    id: INVOICE, internal_number: 'FV/9/2026', payment_due_date: '2026-09-01', gross_total: 1230,
    amount_due: 1230, days_overdue: 22, buyer_name: 'Klient spółka z ograniczoną odpowiedzialnością',
    buyer_nip: '1234567890', buyer_email: 'k@example.test', reminders_paused: false,
    reminders_sent_count: 1, reminder_status: 'none', latest_reminder: null, ...overrides,
  };
}

const stats = { totalCount: 1, totalAmount: 1230, avgDaysOverdue: 22, pausedCount: 0, sentThisMonth: 3 };

describe('pickLatestReminders — ostatni wpis faktury', () => {
  it('bierze najpóźniejszy termin, przy remisie wyższy etap', () => {
    const latest = pickLatestReminders([
      row(INVOICE, 'stage_1', 'sent', '2026-09-05T08:00:00Z'),
      row(INVOICE, 'stage_2', 'pending', '2026-09-12T08:00:00Z'),
      row(OTHER, 'stage_1', 'failed', '2026-09-10T08:00:00Z'),
      row(OTHER, 'stage_2', 'cancelled', '2026-09-10T08:00:00Z'),
    ], [INVOICE, OTHER]);
    expect(latest?.get(INVOICE)).toEqual({ stage: 2, status: 'pending', scheduledFor: '2026-09-12T08:00:00Z' });
    expect(latest?.get(OTHER)).toEqual({ stage: 2, status: 'cancelled', scheduledFor: '2026-09-10T08:00:00Z' });
  });

  it.each([
    ['faktura spoza widocznych', [row('obca', 'stage_1', 'sent', '2026-09-05T08:00:00Z')]],
    ['nieznany etap', [row(INVOICE, 'stage_9', 'sent', '2026-09-05T08:00:00Z')]],
    ['nieznany status', [row(INVOICE, 'stage_1', 'queued', '2026-09-05T08:00:00Z')]],
    ['zła data', [row(INVOICE, 'stage_1', 'sent', 'wczoraj')]],
    ['zdublowany etap', [row(INVOICE, 'stage_1', 'sent', '2026-09-05T08:00:00Z'), row(INVOICE, 'stage_1', 'sent', '2026-09-06T08:00:00Z')]],
  ])('niespójny odczyt (%s) → null, nie „brak”', (_opis, rows) => {
    expect(pickLatestReminders(rows, [INVOICE])).toBeNull();
  });
});

type Captured = { table: string; selection: string; options?: unknown; filters: Array<[string, string, unknown]>; limit?: number };

function fakeClient(result: { data: unknown; count: number | null; error: unknown }, captured: Captured[]) {
  return {
    from(table: string) {
      const query: Captured = { table, selection: '', filters: [] };
      captured.push(query);
      const builder = {
        select(selection: string, options?: unknown) { query.selection = selection; query.options = options; return builder; },
        eq(key: string, value: unknown) { query.filters.push(['eq', key, value]); return builder; },
        in(key: string, value: unknown) { query.filters.push(['in', key, value]); return builder; },
        gte(key: string, value: unknown) { query.filters.push(['gte', key, value]); return builder; },
        lt(key: string, value: unknown) { query.filters.push(['lt', key, value]); return builder; },
        limit(n: number) { query.limit = n; return builder; },
        then(resolve: (v: unknown) => unknown) { return Promise.resolve(result).then(resolve); },
      };
      return builder;
    },
  } as unknown as PageContext['supabase'];
}

describe('readLatestReminders — odczyt z sesji, ograniczony i policzony', () => {
  it('filtruje po firmie i widocznych fakturach, najwyżej 4 wiersze na fakturę', async () => {
    const captured: Captured[] = [];
    const data = [row(INVOICE, 'stage_1', 'sent', '2026-09-05T08:00:00Z')];
    const latest = await readLatestReminders(fakeClient({ data, count: 1, error: null }, captured), 'firma', [INVOICE, OTHER]);
    expect(latest?.get(INVOICE)?.status).toBe('sent');
    expect(latest?.has(OTHER)).toBe(false);
    expect(captured[0]).toMatchObject({
      table: 'payment_reminders', selection: 'invoice_id, stage, status, scheduled_for',
      options: { count: 'exact' }, limit: 8,
      filters: [['eq', 'tenant_id', 'firma'], ['in', 'invoice_id', [INVOICE, OTHER]]],
    });
  });

  it.each([
    ['błąd', { data: null, count: null, error: { message: 'x' } }],
    ['brak licznika', { data: [], count: null, error: null }],
    ['obcięta strona', { data: [row(INVOICE, 'stage_1', 'sent', '2026-09-05T08:00:00Z')], count: 2, error: null }],
  ])('%s → null (kolumna „Niedostępne”)', async (_opis, result) => {
    expect(await readLatestReminders(fakeClient(result, []), 'firma', [INVOICE])).toBeNull();
  });
});

describe('countRemindersSentThisMonth — miesiąc w Europe/Warsaw', () => {
  it('północ w Polsce: CEST (UTC+2) i CET (UTC+1)', () => {
    expect(warsawMidnightIso('2026-10-01')).toBe('2026-09-30T22:00:00.000Z');
    expect(warsawMidnightIso('2026-11-01')).toBe('2026-10-31T23:00:00.000Z');
    expect(warsawMidnightIso('2027-01-01')).toBe('2026-12-31T23:00:00.000Z');
  });

  it('1 października o 00:30 czasu polskiego liczy październik, wysłane i z tej firmy', async () => {
    const captured: Captured[] = [];
    const count = await countRemindersSentThisMonth(
      fakeClient({ data: null, count: 4, error: null }, captured), 'firma', new Date('2026-09-30T22:30:00Z'));
    expect(count).toBe(4);
    expect(captured[0]?.filters).toEqual([
      ['eq', 'tenant_id', 'firma'], ['eq', 'status', 'sent'],
      ['gte', 'sent_at', '2026-09-30T22:00:00.000Z'], ['lt', 'sent_at', '2026-10-31T23:00:00.000Z'],
    ]);
  });

  it('błąd albo brak licznika rzuca — kafel nie pokaże „0”', async () => {
    await expect(countRemindersSentThisMonth(fakeClient({ data: null, count: null, error: null }, []), 'firma'))
      .rejects.toThrow('wysłanych przypomnień');
  });
});

describe('OverdueDashboard — układ Finory', () => {
  it('kafle, kolumny i status ostatniego przypomnienia', () => {
    const html = renderToStaticMarkup(
      <OverdueDashboard
        overdueInvoices={[overdue({ latest_reminder: { stage: 2, status: 'pending', scheduledFor: '2026-09-12T08:00:00Z' } })]}
        stats={stats}
      />,
    );
    for (const text of ['Po terminie', 'Faktur po terminie', 'Przypomnień wysłanych w miesiącu', 'Wstrzymanych',
      'Faktura', 'Kontrahent', 'Termin płatności', 'Przypomnienie', 'Status', 'Akcje']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('Bez importów i faktur skorygowanych');
    expect(html).toContain('1230,00 zł');
    expect(html).toContain('12.09.2026');
    expect(html).toContain('Etap 2');
    expect(html).toContain('Zaplanowane');
    expect(html).toContain('01.09.2026');
    expect(html).toContain('22 dni po terminie');
    expect(html).toContain('Klient sp. z o.o.');
    expect(html).toContain('aria-label="Przygotuj przypomnienie"');
    expect(html).toContain('aria-label="Wstrzymaj przypomnienia"');
    expect(html).toContain('Pozycje');
    expect(html).not.toContain('Ustawienia przypomnień');
    expect(html).not.toMatch(/\$[0-9]/);
    expect(html).not.toContain('ff-glass-pane');
  });

  it('„Ustawienia przypomnień” tylko dla właściciela', () => {
    const html = renderToStaticMarkup(<OverdueDashboard overdueInvoices={[overdue()]} stats={stats} canManageSettings />);
    expect(html).toContain('href="/settings/reminders"');
    expect(html).toContain('Ustawienia przypomnień');
  });

  it('odczyt niepewny: „Niedostępne” i „—” zamiast „brak” i „0”', () => {
    const html = renderToStaticMarkup(
      <OverdueDashboard overdueInvoices={[overdue({ latest_reminder: 'unavailable' })]} stats={{ ...stats, sentThisMonth: null }} />,
    );
    expect(html).toContain('Niedostępne');
    expect(html).toContain('Stan niedostępny');
    expect(html).toContain('Nie udało się odczytać');
  });

  it('wstrzymana faktura: „Wznów” i brak przygotowania', () => {
    const html = renderToStaticMarkup(
      <OverdueDashboard overdueInvoices={[overdue({ reminders_paused: true })]} stats={{ ...stats, pausedCount: 1 }} />,
    );
    expect(html).toContain('aria-label="Wznów przypomnienia"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Przygotuj przypomnienie"/);
  });

  it('stan pusty i błąd listy', () => {
    const empty = renderToStaticMarkup(
      <OverdueDashboard overdueInvoices={[]} stats={{ ...stats, totalCount: 0, totalAmount: 0, sentThisMonth: 0 }} canManageSettings />,
    );
    expect(empty).toContain('Brak pozycji gotowych do przypomnienia');
    expect(empty).toContain('href="/settings/reminders"');
    expect(empty).not.toContain('Pozycje 1');
    const error = renderToStaticMarkup(<OverdueDashboardError message="Zaległe faktury wymagają uzgodnienia kwot" />);
    expect(error).toContain('Nie udało się pobrać listy: Zaległe faktury wymagają uzgodnienia kwot');
  });
});
