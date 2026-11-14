import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  /** Zepsuty kursor: ignoruje `gt` — do testu bezpiecznika postępu. */
  ignoreGt: false,
}));

/** Atrapa PostgREST, która naprawdę filtruje, sortuje i tnie — jak baza. */
function query(rows: Row[]) {
  const preds: Array<(r: Row) => boolean> = [];
  let sort: { col: string; asc: boolean } | null = null;
  let limit = Infinity;
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q,
    eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
    neq: (c: string, v: unknown) => (preds.push((r) => r[c] !== null && r[c] !== v), q),
    in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
    lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), q),
    gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), q),
    gt: (c: string, v: string) => (db.ignoreGt || preds.push((r) => String(r[c]) > v), q),
    order: (col: string, o?: { ascending?: boolean }) => ((sort = { col, asc: o?.ascending !== false }), q),
    limit: (n: number) => ((limit = n), q),
    then: (ok: (v: { data: Row[]; error: null }) => unknown) => {
      let out = rows.filter((r) => preds.every((p) => p(r)));
      if (sort) {
        const { col, asc } = sort;
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      return Promise.resolve({ data: out.slice(0, limit), error: null }).then(ok);
    },
  });
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => query(db.rows) }),
}));

import { productionPaymentConfirmSources } from '@/lib/flo/functions/payment-confirm-producer';
import { findInvoicesRequiringReminders } from '@/lib/reminders/scheduler';

/**
 * Kogo ponaglamy. Do 27.09 cron brał każdą przyjętą, nieopłaconą fakturę po
 * terminie — także korektę (drugi „dług” za tę samą sprzedaż) i fakturę
 * z importu historii (nieopłaconą tylko dlatego, że import nie zna wpłat),
 * a do tego jeden `limit(500)` na całą platformę.
 */

const TENANT = 'ten-1';
const DAWNO = '2026-08-01';

function faktura(id: string, o: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    internal_number: `FV ${id}`,
    direction: 'outgoing',
    ksef_status: 'accepted',
    invoice_kind: 'regular',
    origin: 'app',
    payment_status: 'unpaid',
    payment_due_date: DAWNO,
    reminders_paused: false,
    gross_total: 1230,
    paid_amount: 0,
    buyer_data: { name: 'Klient' },
    buyer_nip: '5252241585',
    ...o,
  };
}

/** Kandydaci firmy TENANT, zebrani ze wszystkich stron. */
async function kandydaci(): Promise<string[]> {
  const ids: string[] = [];
  await findInvoicesRequiringReminders([TENANT], async (page) => {
    ids.push(...page.map((i) => i.id));
  });
  return ids;
}

beforeEach(() => {
  db.rows = [];
  db.ignoreGt = false;
});

describe('kandydaci do ponaglenia (cron)', () => {
  it('tylko zwykła, własna faktura po terminie — bez korekty i bez importu', async () => {
    db.rows = [
      faktura('a-zwykla'),
      faktura('b-korekta', { invoice_kind: 'correction', gross_total: 1000 }),
      faktura('c-import', { origin: 'ksef_import' }),
      faktura('d-zaliczka', { invoice_kind: 'advance' }),
      faktura('e-wstrzymana', { reminders_paused: true }),
      faktura('f-zaplacona', { payment_status: 'paid' }),
      faktura('g-przed-terminem', { payment_due_date: '2999-01-01' }),
      faktura('h-zakup', { direction: 'incoming' }),
      // C-16/00145: ROZ jest kandydatem jak każda inna ścigalna faktura —
      // CHASEABLE_INVOICE_KINDS już ją wpuszcza, bo dojrzałość amountDue
      // jest po stronie wyzwalacza i decideNextReminder, nie tego filtra.
      faktura('i-roz', { invoice_kind: 'final', invoice_type: 'ROZ' }),
    ];
    const ids = await kandydaci();
    expect(ids).toEqual(['a-zwykla', 'd-zaliczka', 'i-roz']);
  });

  it('ponad 500 zaległych na platformie — każda trafia do przebiegu', async () => {
    db.rows = Array.from({ length: 1203 }, (_, n) => faktura(`inv-${String(n).padStart(5, '0')}`));
    const ids = await kandydaci();
    expect(ids).toHaveLength(1203);
    expect(new Set(ids).size).toBe(1203);
  });

  it('kursor stoi w miejscu → błąd zamiast pętli bez końca', async () => {
    db.rows = Array.from({ length: 600 }, (_, n) => faktura(`inv-${String(n).padStart(5, '0')}`));
    db.ignoreGt = true;
    await expect(kandydaci()).rejects.toThrow(/identyfikatory nie rosną/);
  });
});

describe('K-01 „czy klient zapłacił” — ta sama definicja zaległości', () => {
  it('korekta nie jest osobnym długiem', async () => {
    const now = new Date('2026-09-27T10:00:00Z');
    db.rows = [
      faktura('a-zwykla', { payment_due_date: '2026-09-20' }),
      faktura('b-korekta', { invoice_kind: 'correction', payment_due_date: '2026-09-20' }),
    ];
    const found = await productionPaymentConfirmSources().readOverdueInvoices(TENANT, now);
    expect(found.map((i) => i.id)).toEqual(['a-zwykla']);
  });

  it('ROZ: amountDue z payment_data.amountDue, nie z gross_total (C-16, 00145)', async () => {
    const now = new Date('2026-09-27T10:00:00Z');
    db.rows = [
      faktura('roz-1', {
        invoice_kind: 'final', invoice_type: 'ROZ', payment_due_date: '2026-09-20',
        gross_total: 12300, payment_data: { amountDue: 9840 },
      }),
    ];
    const found = await productionPaymentConfirmSources().readOverdueInvoices(TENANT, now);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'roz-1', grossTotal: 12300, amountDue: 9840 });
  });
});
