import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Dzwonek przy wpłacie do faktury (plan kompletnej aplikacji, krok 8.1,
 * część 3, 00197): kolejny odbiorca zdarzenia `invoice/payment.received`
 * (kolejka `invoice.payment.received.bell`, wzór kolejek dzwonka z 00188).
 *
 * Prawdziwy runner, prawdziwy zapis (`writeAppNotification`) i prawdziwe
 * treści; atrapa tylko dla bazy (odczyt `payments` i `invoices`, RPC
 * `app_notification_publish`). UNIQUE i CHECK sprawdza baza
 * (`tests/rls-dzwonek-wplaty.test.ts` w jobie „RLS isolation”).
 *
 * Granice: wpłata cofnięta albo usunięta nic nie pisze, wpłata innej faktury
 * i faktura spoza firmy wpłaty to błąd bez ponowień i bez wpisu, ponowienie
 * wysyła ten sam klucz (wpłata), a „Otrzymana płatność” jest tylko wtedy, gdy
 * faktura jest opłacona w całości PO tej wpłacie.
 */

type Row = Record<string, unknown>;
type Read = { table: string; filters: Array<[string, unknown]> };

const db = vi.hoisted(() => ({
  payments: [] as Row[],
  invoices: [] as Row[],
  errors: new Set<string>(),
  reads: [] as Read[],
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: 2, error: null } as { data: unknown; error: null | { message: string } },
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      return db.rpcResult;
    },
    from: (table: string) => {
      const rows = table === 'payments' ? db.payments : table === 'invoices' ? db.invoices : null;
      if (!rows) throw new Error(`nieoczekiwana tabela ${table}`);
      const filters: Array<[string, unknown]> = [];
      const run = () => {
        db.reads.push({ table, filters: [...filters] });
        if (db.errors.has(table)) return { data: null, error: { message: `${table}: connection reset` } };
        return { data: rows.filter((row) => filters.every(([k, v]) => row[k] === v)), error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return q;
        },
        order: () => q,
        maybeSingle: async () => {
          const r = run();
          return r.error ? r : { data: r.data[0] ?? null, error: null };
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
      };
      return q;
    },
  }),
}));

const { runAppNotificationPaymentReceived } = await import('@/lib/jobs/runners/app-notifications');
const { NonRetriableError } = await import('@/lib/jobs/errors');
const { APP_NOTIFICATION_KINDS } = await import('@/lib/app-notifications/types');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const OTHER_INVOICE = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333331';
const P2 = '33333333-3333-4333-8333-333333333332';
const P3 = '33333333-3333-4333-8333-333333333333';
const NBSP = /[  ]/g;
const plain = (t: unknown) => String(t).replace(NBSP, ' ');

const ctx = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n: string, fn: () => unknown) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
} as unknown as JobContext;

/** Wpłata zapisana przez RPC (00176) albo „Zapłacone” (00158): liczona, potwierdzona. */
function wplata(id: string, amount: number, minute: number, extra: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    invoice_id: INVOICE,
    amount,
    voided_at: null,
    is_auto_matched: false,
    is_confirmed: true,
    created_at: `2026-11-11T10:${String(minute).padStart(2, '0')}:00.123456+00:00`,
    ...extra,
  };
}

/** Faktura sprzedaży w PLN: 1230 zł do zapłaty. */
function faktura(extra: Row = {}): Row {
  return {
    id: INVOICE,
    tenant_id: TENANT,
    internal_number: 'FV/1/2026',
    invoice_kind: 'regular',
    gross_total: 1230,
    payment_data: null,
    buyer_data: { name: 'Acme Sp. z o.o.' },
    currency: 'PLN',
    ...extra,
  };
}

const run = (paymentId: string = P1, invoiceId = INVOICE) => runAppNotificationPaymentReceived({ invoiceId, paymentId }, ctx);

const wpis = (i = 0) => db.rpcCalls[i]!.args;

beforeEach(() => {
  db.payments = [];
  db.invoices = [faktura()];
  db.errors = new Set();
  db.reads = [];
  db.rpcCalls = [];
  db.rpcResult = { data: 2, error: null };
  sentry.captureException.mockClear();
});

describe('kolejka dzwonka: wpłata do faktury (krok 8.1, część 3)', () => {
  it('wpłata częściowa: „Wpłata częściowa” z kwotą i pozostałą sumą, link do faktury, klucz = wpłata', async () => {
    db.payments = [wplata(P1, 300, 1)];
    await expect(run()).resolves.toEqual({ created: 2 });
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]!.fn).toBe('app_notification_publish');
    expect({ ...wpis(), p_body: plain(wpis().p_body) }).toEqual({
      p_tenant_id: TENANT,
      p_kind: 'payment_received',
      p_object_key: P1,
      p_title: 'Wpłata częściowa',
      p_body: '300,00 zł za FV/1/2026 od Acme Sp. z o.o., pozostało do zapłaty 930,00 zł',
      p_link: `/invoices/${INVOICE}`,
    });
  });

  it('firma z wiersza wpłaty: faktura czytana z identyfikatorem ze zdarzenia i firmą wpłaty', async () => {
    db.payments = [wplata(P1, 300, 1)];
    await run();
    const invoiceReads = db.reads.filter((r) => r.table === 'invoices');
    expect(invoiceReads.length).toBeGreaterThan(0);
    for (const r of invoiceReads) expect(r.filters).toEqual(expect.arrayContaining([['id', INVOICE], ['tenant_id', TENANT]]));
    const paymentReads = db.reads.filter((r) => r.table === 'payments');
    expect(paymentReads.length).toBeGreaterThan(0);
    // Lista wpłat faktury tylko w firmie wpłaty.
    for (const r of paymentReads.filter((x) => !x.filters.some(([k]) => k === 'id'))) {
      expect(r.filters).toEqual(expect.arrayContaining([['tenant_id', TENANT], ['invoice_id', INVOICE]]));
    }
  });

  it('wpłata zamykająca fakturę: „Otrzymana płatność” z kwotą, numerem i nabywcą', async () => {
    db.payments = [wplata(P1, 1000, 1), wplata(P2, 230, 2)];
    await run(P2);
    expect(wpis()).toMatchObject({ p_kind: 'payment_received', p_object_key: P2, p_title: 'Otrzymana płatność', p_link: `/invoices/${INVOICE}` });
    expect(plain(wpis().p_body)).toBe('230,00 zł za FV/1/2026 od Acme Sp. z o.o., faktura opłacona w całości');
  });

  it('„Zapłacone” jedną wpłatą na całość: „Otrzymana płatność”', async () => {
    db.payments = [wplata(P1, 1230, 1, { match_method: 'manual' })];
    await run(P1);
    expect(wpis().p_title).toBe('Otrzymana płatność');
    expect(plain(wpis().p_body)).toBe('1230,00 zł za FV/1/2026 od Acme Sp. z o.o., faktura opłacona w całości');
  });

  it('stan PO tej wpłacie: późniejsza wpłata, która zamknęła fakturę, nie zmienia wpisu o wcześniejszej', async () => {
    // Zadanie pierwszej wpłaty ruszyło dopiero po drugiej (np. worker wstawał po wdrożeniu).
    db.invoices = [faktura({ paid_amount: 1230, payment_status: 'paid' })];
    db.payments = [wplata(P2, 230, 2), wplata(P1, 1000, 1)];
    await run(P1);
    expect(wpis().p_title).toBe('Wpłata częściowa');
    expect(plain(wpis().p_body)).toBe('1000,00 zł za FV/1/2026 od Acme Sp. z o.o., pozostało do zapłaty 230,00 zł');
    await run(P2);
    expect(wpis(1).p_title).toBe('Otrzymana płatność');
  });

  it('wpłaty cofnięte i niepotwierdzone dopasowania z banku nie liczą się do sumy (jak wyzwalacz 00176)', async () => {
    db.payments = [
      wplata(P1, 1000, 1, { voided_at: '2026-11-11T10:05:00+00:00' }),
      wplata(P3, 500, 2, { is_auto_matched: true, is_confirmed: false }),
      wplata(P2, 230, 3),
    ];
    await run(P2);
    expect(wpis().p_title).toBe('Wpłata częściowa');
    expect(plain(wpis().p_body)).toBe('230,00 zł za FV/1/2026 od Acme Sp. z o.o., pozostało do zapłaty 1000,00 zł');
  });

  it('ponowienie od zera: ten sam klucz i ta sama treść, baza nic nie dodaje', async () => {
    db.payments = [wplata(P1, 300, 1)];
    await expect(run()).resolves.toEqual({ created: 2 });
    db.rpcResult = { data: 0, error: null };
    await expect(run()).resolves.toEqual({ created: 0 });
    expect(db.rpcCalls).toHaveLength(2);
    expect(wpis(1)).toEqual(wpis(0));
  });

  it('wpłata cofnięta, zanim zadanie ruszyło: bez wpisu', async () => {
    db.payments = [wplata(P1, 300, 1, { voided_at: '2026-11-11T10:05:00+00:00' })];
    await expect(run()).resolves.toEqual({ skipped: 'payment-voided' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('niepotwierdzone dopasowanie z banku (nie liczy się do zapłaty): bez wpisu', async () => {
    db.payments = [wplata(P1, 1230, 1, { is_auto_matched: true, is_confirmed: false })];
    await expect(run()).resolves.toEqual({ skipped: 'payment-unconfirmed' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('wpłata usunięta (cofnięte „Zapłacone” kasuje wiersz): bez wpisu', async () => {
    db.payments = [];
    await expect(run()).resolves.toEqual({ skipped: 'payment-not-found' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('wpłata innej faktury (np. faktura obcej firmy w zdarzeniu): błąd bez ponowień, bez wpisu', async () => {
    db.payments = [wplata(P1, 300, 1)];
    db.invoices = [faktura(), faktura({ id: OTHER_INVOICE, tenant_id: OTHER_TENANT, internal_number: 'FV/9/2026' })];
    await expect(run(P1, OTHER_INVOICE)).rejects.toBeInstanceOf(NonRetriableError);
    expect(db.rpcCalls).toEqual([]);
  });

  it('wpłata innej faktury tej samej firmy: błąd bez ponowień, bez wpisu przy cudzej fakturze', async () => {
    db.payments = [wplata(P1, 300, 1)];
    db.invoices = [faktura(), faktura({ id: OTHER_INVOICE, internal_number: 'FV/9/2026' })];
    await expect(run(P1, OTHER_INVOICE)).rejects.toBeInstanceOf(NonRetriableError);
    expect(db.rpcCalls).toEqual([]);
  });

  it('faktura spoza firmy wpłaty: błąd bez ponowień, bez wpisu', async () => {
    db.payments = [wplata(P1, 300, 1)];
    db.invoices = [faktura({ tenant_id: OTHER_TENANT })];
    await expect(run()).rejects.toBeInstanceOf(NonRetriableError);
    expect(db.rpcCalls).toEqual([]);
  });

  it('zdarzenie sprzed kroku 8.1 (bez paymentId): bez odczytu i bez wpisu', async () => {
    db.payments = [wplata(P1, 300, 1)];
    await expect(runAppNotificationPaymentReceived({ invoiceId: INVOICE }, ctx)).resolves.toEqual({ skipped: 'no-payment-id' });
    expect(db.reads).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
  });

  it.each([['payments'], ['invoices']])('błąd odczytu %s: zadanie rzuca (ponowienie), bez wpisu', async (table) => {
    db.payments = [wplata(P1, 300, 1)];
    db.errors.add(table);
    await expect(run()).rejects.toThrow(/connection reset/);
    expect(db.rpcCalls).toEqual([]);
  });

  it('błąd zapisu: zadanie rzuca, pg-boss ponawia (UNIQUE chroni przed dublem)', async () => {
    db.payments = [wplata(P1, 300, 1)];
    db.rpcResult = { data: null, error: { message: 'new row violates check constraint "app_notifications_kind_check"' } };
    await expect(run()).rejects.toThrow(/app_notifications_kind_check/);
  });

  it('faktura walutowa („Zapłacone” z 00158 oznacza też walutę): kwota w walucie faktury, bez „zł”', async () => {
    db.invoices = [faktura({ currency: 'EUR', gross_total: 100, internal_number: 'INV/7/2026', buyer_data: { name: 'Kunde GmbH' } })];
    db.payments = [wplata(P1, 40, 1), wplata(P2, 60, 2)];
    await run(P1);
    expect(plain(wpis().p_body)).toBe('40,00 EUR za INV/7/2026 od Kunde GmbH, pozostało do zapłaty 60,00 EUR');
    await run(P2);
    expect(plain(wpis(1).p_body)).toBe('60,00 EUR za INV/7/2026 od Kunde GmbH, faktura opłacona w całości');
  });

  it('faktura rozliczeniowa (ROZ): do zapłaty to reszta po zaliczkach z payment_data.amountDue', async () => {
    db.invoices = [faktura({ invoice_kind: 'final', gross_total: 10000, payment_data: { amountDue: 2000 } })];
    db.payments = [wplata(P1, 500, 1), wplata(P2, 1500, 2)];
    await run(P1);
    expect(plain(wpis().p_body)).toBe('500,00 zł za FV/1/2026 od Acme Sp. z o.o., pozostało do zapłaty 1500,00 zł');
    await run(P2);
    expect(wpis(1).p_title).toBe('Otrzymana płatność');
  });

  it('grosze: 0,10 i 0,70 zł przy 0,80 zł do zapłaty to pełna zapłata (roundToCents, nie „pozostało 0,00 zł”)', async () => {
    db.invoices = [faktura({ gross_total: 0.8 })];
    db.payments = [wplata(P1, 0.1, 1), wplata(P2, 0.7, 2)];
    await run(P2);
    expect(wpis().p_title).toBe('Otrzymana płatność');
    expect(plain(wpis().p_body)).toBe('0,70 zł za FV/1/2026 od Acme Sp. z o.o., faktura opłacona w całości');
  });

  it('bez nabywcy i bez numeru: treść bez „od”, „za fakturę bez numeru”', async () => {
    db.invoices = [faktura({ buyer_data: { name: '  ' }, internal_number: null })];
    db.payments = [wplata(P1, 300, 1)];
    await run();
    expect(plain(wpis().p_body)).toBe('300,00 zł za fakturę bez numeru, pozostało do zapłaty 930,00 zł');
  });

  it('teksty bez długich myślników', async () => {
    db.payments = [wplata(P1, 300, 1), wplata(P2, 930, 2)];
    await run(P1);
    await run(P2);
    for (const { args } of db.rpcCalls) expect(`${String(args.p_title)} ${String(args.p_body)}`).not.toMatch(/[—–]/);
  });
});

describe('migracja 00197 (tekst; zachowanie na bazie w tests/rls-dzwonek-wplaty.test.ts)', () => {
  const DIR = join(process.cwd(), 'supabase/migrations');
  const sql = () => readFileSync(join(DIR, '00197_app_notifications_payment_received.sql'), 'utf8');
  const outsideBodies = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');

  it('nagłówek: PRZED wdrożeniem, po 00192; opis zmiany CHECK; bez DROP tabel i kolumn, bez DML', () => {
    const tekst = sql();
    expect(tekst).toMatch(/KIEDY WGRAĆ: PRZED wdrożeniem, po 00192/);
    expect(tekst).toMatch(/ZMIANA CHECK: app_notifications_kind_check/);
    expect(outsideBodies(tekst)).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION)\b/i);
  });

  it('CHECK rodzajów: pełna lista z 00188 i 00192 plus payment_received, ta sama nazwa ograniczenia', () => {
    const tekst = outsideBodies(sql());
    expect(tekst).toContain('DROP CONSTRAINT IF EXISTS app_notifications_kind_check');
    expect(tekst).toMatch(
      /ADD CONSTRAINT app_notifications_kind_check CHECK \(kind IN \('inbox_new', 'invoice_accepted', 'invoice_rejected', 'tax_deadline', 'expense_comment', 'expense_document_request', 'payment_received'\)\)/,
    );
  });

  it('rodzaj w kodzie i w ostatniej definicji CHECK w migracjach', () => {
    let last: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const text = readFileSync(join(DIR, file), 'utf8').replace(/--[^\n]*/g, '');
      for (const m of text.matchAll(/app_notifications_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi)) {
        last = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((k) => k[1]!);
      }
    }
    expect(last).toContain('payment_received');
    expect(APP_NOTIFICATION_KINDS).toContain('payment_received');
  });
});
