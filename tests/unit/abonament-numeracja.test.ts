import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { paidDateInPoland } from '@/lib/billing/self-invoice';

/**
 * AUD-69 (I5): faktury za abonament miały numer z końcówki identyfikatora
 * Stripe (nie kolejny), datę w UTC (płatność 00:30 1 marca = luty)
 * i status „unpaid”, choć karta była obciążona.
 */

// 00152 (nazwa FaktWay) przepisuje tę samą funkcję — niezmienniki AUD-69
// muszą zostać w każdej definicji, także w ostatniej.
const DEFINITIONS = [
  'supabase/migrations/00110_billing_invoice_numbering.sql',
  'supabase/migrations/00152_billing_invoice_faktway_name.sql',
];

describe('faktury za abonament (AUD-69)', () => {
  it.each([
    ['2026-02-28T23:30:00Z', '2026-03-01'],
    ['2026-07-31T22:10:00Z', '2026-08-01'],
    ['2026-03-01T12:00:00Z', '2026-03-01'],
  ])('płatność %s → data %s (czas polski)', (paidAt, day) => {
    expect(paidDateInPoland(paidAt)).toBe(day);
  });

  it.each(DEFINITIONS)('baza (%s): kolejny numer w miesiącu z licznika, data Europe/Warsaw, status paid', (file) => {
    const sql = readFileSync(file, 'utf8');
    expect(sql).toContain("(v_payment.paid_at AT TIME ZONE 'Europe/Warsaw')::date");
    expect(sql).toContain('ON CONFLICT (operator_tenant_id, period)');
    expect(sql).toContain("pg_catalog.lpad(v_seq::text, 4, '0')");
    expect(sql).toContain("false, v_invoice, 'paid', v_gross");
    expect(sql).not.toContain("AT TIME ZONE 'UTC'");
  });

  it('zdarzenie wysyłki do KSeF niesie numer nadany przez bazę', () => {
    const job = readFileSync('lib/jobs/runners/self-invoice-payment.ts', 'utf8');
    expect(job).toContain('invoice: { ...draft.invoice, internalNumber: inserted.internalNumber }');
  });
});
