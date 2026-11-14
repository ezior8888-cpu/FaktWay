import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

/** Atrapa PostgREST, która naprawdę filtruje, sortuje i tnie (jak w reminders-kandydaci). */
function query(rows: Row[]) {
  const preds: Array<(r: Row) => boolean> = [];
  let limit = Infinity;
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q,
    eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
    in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
    lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), q),
    gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), q),
    gt: (c: string, v: string) => (preds.push((r) => String(r[c]) > v), q),
    order: () => q,
    limit: (n: number) => ((limit = n), q),
    then: (ok: (v: { data: Row[]; error: null }) => unknown) => {
      const out = rows.filter((r) => preds.every((p) => p(r)));
      return Promise.resolve({ data: out.slice(0, limit), error: null }).then(ok);
    },
  });
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => query(db.rows) }),
}));

import { productionPaymentConfirmSources } from '@/lib/flo/functions/payment-confirm-producer';
import { getReceivables, isReceivableBase } from '@/lib/dashboard/receivables';
import { isReminderInvoiceChaseable, reminderRefusalMessage } from '@/lib/reminders/delivery-schema';
import { findInvoicesRequiringReminders } from '@/lib/reminders/scheduler';
import type { PageContext } from '@/lib/supabase/page-context';

vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => 'production',
}));

/**
 * Krok 1.2, ustalenie 3 z #509: sprzedaż z paragonu jest zapłacona przy kasie,
 * a FP dostaje termin płatności z formularza. FP nie trafia na listę „po
 * terminie”, do przypomnień ani do ponagleń FLO. Status płatności bez zmian.
 */

const TENANT = 'ten-1';
const RECEIPT = { receiptNumber: '000123', receiptDate: '2026-08-01', cashRegisterNumber: 'ABC1234567890' };

function faktura(id: string, o: Row = {}): Row {
  return {
    id, tenant_id: TENANT, internal_number: `FV ${id}`, direction: 'outgoing', ksef_status: 'accepted',
    ksef_environment: 'production', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'app',
    payment_status: 'unpaid', payment_due_date: '2026-08-01', reminders_paused: false, gross_total: 1230,
    paid_amount: 0, currency: 'PLN', buyer_data: { name: 'Klient' }, buyer_nip: '5252241585', payment_data: null,
    ...o,
  };
}

beforeEach(() => { db.rows = []; });

describe('FP poza przypomnieniami i ponagleniami', () => {
  it('isReminderInvoiceChaseable: FP z FaktWay i z importu nie jest ścigalna, zwykła jest', () => {
    const baza = { origin: 'app', invoice_kind: 'regular', invoice_type: 'VAT' };
    expect(isReminderInvoiceChaseable(baza)).toBe(true);
    expect(isReminderInvoiceChaseable({ ...baza, receipt: RECEIPT })).toBe(false);
    expect(isReminderInvoiceChaseable({ ...baza, ksef_fp: 'true' })).toBe(false);
    expect(isReminderInvoiceChaseable({ ...baza, fa3_data: { receipt: RECEIPT } })).toBe(false);
  });

  it('komunikat odmowy dla FP: numer dokumentu i co zrobić', () => {
    const msg = reminderRefusalMessage({ internal_number: 'FV/9/2026', fa3_data: { receipt: RECEIPT } });
    expect(msg).toContain('FV/9/2026');
    expect(msg).toMatch(/faktura do paragonu/i);
    expect(msg).toMatch(/zapłacon\w+ przy kasie/);
    expect(msg).toMatch(/Pomoc/);
  });

  it('cron przypomnień: FP nie jest kandydatem', async () => {
    db.rows = [faktura('a-zwykla'), faktura('b-fp', { receipt: RECEIPT }), faktura('c-fp-import', { ksef_fp: 'true' })];
    const ids: string[] = [];
    await findInvoicesRequiringReminders([TENANT], async (page) => {
      ids.push(...page.map((i) => i.id));
    });
    expect(ids).toEqual(['a-zwykla']);
  });

  it('ponaglenia FLO (K-01): FP nie jest zaległą fakturą', async () => {
    db.rows = [faktura('a-zwykla'), faktura('b-fp', { receipt: RECEIPT })];
    const found = await productionPaymentConfirmSources().readOverdueInvoices(TENANT, new Date('2026-09-27T10:00:00Z'));
    expect(found.map((i) => i.id)).toEqual(['a-zwykla']);
  });

  it('lista „po terminie” (należności): FP nie wchodzi do sumy zaległych, status płatności bez zmian', async () => {
    const rows = [faktura('a-zwykla'), faktura('b-fp', { receipt: RECEIPT })].map((r) => ({ ...r }));
    const supabase = {
      from(table: string) {
        const q: Record<string, unknown> = {};
        const preds: Array<(r: Row) => boolean> = [];
        Object.assign(q, {
          select: () => q,
          eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
          in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
          gt: (c: string, v: number) => (preds.push((r) => Number(r[c]) > v), q),
          not: () => q,
          order: () => q,
          range: () => q,
          then: (ok: (v: unknown) => unknown) => {
            const m = table === 'invoices' ? rows.filter((r) => preds.every((p) => p(r))) : [];
            return Promise.resolve({ data: m, count: m.length, error: null }).then(ok);
          },
        });
        return q;
      },
    } as unknown as PageContext['supabase'];
    const r = await getReceivables(supabase, TENANT, new Date('2026-10-17T10:00:00Z'));
    expect(r.byInvoice.map((i) => i.id)).toEqual(['a-zwykla']);
    expect(rows[1]!.payment_status).toBe('unpaid');
  });

  it('isReceivableBase: FP bez należności (kolumna „Do zapłaty” pokazuje „—”)', () => {
    const ctx = { environment: 'production' as const, childIds: new Set<string>() };
    const row = faktura('x') as unknown as Parameters<typeof isReceivableBase>[0];
    expect(isReceivableBase(row, ctx)).toBe(true);
    expect(isReceivableBase({ ...row, receipt: RECEIPT } as typeof row, ctx)).toBe(false);
  });
});
