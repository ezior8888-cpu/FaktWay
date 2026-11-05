import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A4b PR2a: ponowienie dokumentu specjalnego (KOR, ZAL, ROZ) z kopii na
 * wierszu. Cron cyklu życia i operator odtwarzają zdarzenie
 * `invoice/submit.requested` z kolumn `KSEF_RESEND_SOURCE_COLUMNS`:
 * zwykła — `fa3_data`, ZAL — `fa3_data.advanceEnvelope`, KOR/ROZ —
 * `special_data` (00137). Do PR2a builder zwracał `special-kind` dla każdego
 * dokumentu specjalnego, więc failed KOR/ZAL nie miały ponowienia.
 *
 * Prawdziwa ścieżka pierwszego zdarzenia: akcja „Zapisz i wyślij” →
 * `enqueueKsefSubmitAfterDraft` → zdarzenie. Zastąpione są tylko baza (klient
 * sesji z filtrami, klient serwisowy z blobem certyfikatu), zapis zlecenia
 * pg-boss (`sendJobEvent` — kopia JSON i krok transakcji na atrapie) oraz
 * flagi, MFA, weryfikacja, zdrowie KSeF i odszyfrowanie certyfikatu.
 * Wiersz „z bazy” to treść INSERT po przejściu przez jsonb (inna kolejność
 * kluczy, bez `undefined`) — tak, jak przeczyta go cron.
 */

const st = vi.hoisted(() => ({
  ids: {
    tenant: '11111111-1111-4111-8111-111111111111',
    parent: '22222222-2222-4222-8222-222222222222',
    invoice: '33333333-3333-4333-8333-333333333333',
    advance: '44444444-4444-4444-8444-444444444444',
  },
  inserted: [] as Record<string, unknown>[],
  events: [] as Array<{ name: string; groupId?: string; singletonKey?: string; data: Record<string, unknown> }>,
  sql: [] as Array<{ sql: string; values: unknown[] }>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Testowy NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach akcji.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: async () => undefined,
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: async () => undefined,
  SensitiveMfaRequiredError: class SensitiveMfaRequiredError extends Error {},
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false, isMfOutage: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({
  decryptCredentials: () => ({ type: 'token', nip: '1234567890', token: 't' }),
}));
vi.mock('@/lib/jobs/enqueue', () => ({
  sendJobEvent: async (
    event: unknown,
    options?: { inTransaction?: (tx: { executeSql: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<void> },
  ) => {
    await options?.inTransaction?.({
      executeSql: async (sql: string, values?: unknown[]) => {
        st.sql.push({ sql, values: values ?? [] });
        return { rows: [{ id: st.ids.invoice }], rowCount: 1 };
      },
    });
    // Kopia w chwili zapisu zlecenia (pg-boss trzyma jsonb), nie żywa referencja.
    st.events.push(JSON.parse(JSON.stringify(event)) as (typeof st.events)[number]);
    return { ids: ['job-1'] };
  },
}));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => ({
    supabase: { from: sessionFrom },
    user: { id: 'fixture-user' },
    tenantId: st.ids.tenant,
    role: 'owner',
  }),
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/supabase/server', () => ({
  // Blob certyfikatu czyta enqueue kluczem serwisowym (00112).
  createAdminClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      single: async () => ({ data: { ksef_credentials_encrypted: '\\x00' }, error: null }),
    };
    return { from: () => q };
  },
  createClient: async () => ({ from: sessionFrom }),
}));

import { saveAndSendAdvanceAction } from '@/components/invoices/advance-actions';
import { saveAndSendCorrectionAction } from '@/components/invoices/correction-actions';
import { saveFinalAction } from '@/components/invoices/final-actions';
import {
  buildKsefRequeueEvent,
  KSEF_RESEND_SOURCE_COLUMN_KEYS,
  KSEF_RESEND_SOURCE_COLUMNS,
  ksefResendFacts,
  ksefSendPayloadFromRow,
  storedSendPayload,
  type KsefRequeueSourceRow,
  type KsefResendSourceColumn,
} from '@/lib/invoices/ksef-requeue-event';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

type Row = Record<string, unknown>;
type CapturedEvent = (typeof st.events)[number];

const { tenant: TENANT, parent: PARENT, invoice: NEW_ID, advance: ADVANCE } = st.ids;
const TENANT_NIP = '1234567890';
const ATTEMPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Dzień wystawienia (Europe/Warsaw) i dzień później.
const TODAY = '2026-10-02';
const YESTERDAY = '2026-10-01';
const NOW = new Date('2026-10-02T10:00:00Z');
const NEXT_DAY = new Date('2026-10-03T10:00:00Z');

const sellerAddress = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const buyerAddress = { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' };
const seller = { nip: TENANT_NIP, name: 'Firma testowa', address: sellerAddress };
/** P_16/P_18A faktury pierwotnej — korekta je przejmuje (AUD-23), więc kopia też. */
const PARENT_ANNOTATIONS = { cashMethod: 1, splitPayment: 1 };

const tenantRow = { id: TENANT, nip: TENANT_NIP, name: 'Firma testowa', address_json: sellerAddress, vat_cash_method: false };
const parentRow: Row = {
  id: PARENT, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular',
  ksef_status: 'accepted', ksef_environment: 'test',
  issue_date: '2026-09-30', internal_number: 'FV 1/09/2026', ksef_number: 'KSEF-TEST-1',
  net_total: 1000, vat_total: 230, gross_total: 1230,
  seller_data: seller,
  buyer_data: { nip: TENANT_NIP, name: 'Nabywca testowy', address: buyerAddress },
  fa3_data: { annotations: PARENT_ANNOTATIONS },
};
/** Zaliczka przyjęta w KSeF, rozliczana przez ROZ. */
const advanceRow: Row = {
  id: ADVANCE, internal_number: 'ZAL/1/09/2026', ksef_number: 'KSEF-TEST-ZAL-1', issue_date: '2026-09-20',
  advance_amount: 123, gross_total: 123, net_total: 100, vat_total: 23, invoice_kind: 'advance',
  fa3_data: { lines: [{ vatRate: '23' }] },
};

/**
 * Klient sesji z filtrami (jak w `data-wystawienia-dzis-zal-kor-roz.test.ts`):
 * faktura pierwotna tylko przy pasujących filtrach, zaliczki po `.in('id')`,
 * INSERT faktury zapisany jako kopia JSON (supabase-js serializuje przy wysyłce).
 */
function sessionFrom(table: string) {
  const record = { operation: 'select' as 'select' | 'insert' | 'delete', filters: {} as Row };
  const result = (): { data: unknown; error: null } => {
    if (table === 'tenants') return { data: tenantRow, error: null };
    if (table === 'invoices' && record.operation === 'insert') return { data: { id: NEW_ID }, error: null };
    if (table === 'invoices' && record.filters.id === PARENT) {
      const match = Object.entries(record.filters).every(([key, value]) => parentRow[key] === value);
      return { data: match ? parentRow : null, error: null };
    }
    if (table === 'invoices' && Array.isArray(record.filters.id)) return { data: [advanceRow], error: null };
    // Wcześniejsze korekty tej faktury pierwotnej, ROZ rozliczające tę zaliczkę — brak.
    if (table === 'invoices') return { data: [], error: null };
    if (table === 'invoice_line_items' && record.operation === 'select') {
      return { data: [{ name: 'Usługa', unit: 'szt.', quantity: 10, unit_price_net: 100, vat_rate: '23' }], error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { record.filters[key] = value; return chain; },
    neq: () => chain,
    or: () => chain,
    in: (key: string, values: unknown[]) => { record.filters[key] = values; return chain; },
    overlaps: () => chain,
    order: () => chain,
    limit: () => chain,
    insert: (payload: unknown) => {
      record.operation = 'insert';
      if (table === 'invoices') st.inserted.push(JSON.parse(JSON.stringify(payload)) as Row);
      return chain;
    },
    delete: () => { record.operation = 'delete'; return chain; },
    maybeSingle: async () => result(),
    single: async () => result(),
    then: <T,>(resolve: (value: ReturnType<typeof result>) => T, reject?: (e: unknown) => T) =>
      Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}

type CorrectionLine = NonNullable<CorrectionInvoiceSchemaIn['linesBefore']>[number];
const line = (o: Partial<CorrectionLine> = {}): CorrectionLine =>
  ({ name: 'Usługa', unit: 'szt.', quantity: 10, unitPriceNet: 100, vatRate: '23', ...o });

function correctionInput(o: Partial<CorrectionInvoiceSchemaIn>): CorrectionInvoiceSchemaIn {
  return {
    invoiceType: 'correction',
    internalNumber: 'FK/1/10/2026',
    issueDate: TODAY,
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-16',
    parentInvoiceId: PARENT,
    parentInvoiceNumber: 'FV 1/09/2026',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: 'KSEF-TEST-1',
    correctionType: 'cancellation',
    correctionReason: 'Zmiana ilości po reklamacji',
    typKorekty: '2',
    seller,
    buyer: { type: 'b2b', idType: 'nip', nip: TENANT_NIP, name: 'Nabywca testowy', address: buyerAddress },
    ...o,
  };
}

const KOR_VARIANTS: Array<[string, Partial<CorrectionInvoiceSchemaIn>]> = [
  ['KOR przed/po z PKWiU, typKorekty 1, kompensata', {
    correctionType: 'before_after', typKorekty: '1', paymentMethod: 'compensation',
    linesBefore: [line()], linesAfter: [line({ quantity: 8, pkwiuCode: '62.01.11.0' })],
  }],
  ['KOR anulowanie', { correctionType: 'cancellation', linesBefore: [line()] }],
];

const advanceInput = {
  invoiceType: 'advance', internalNumber: 'ZAL/1/10/2026', issueDate: TODAY,
  paymentMethod: 'transfer', paymentDueDate: '2026-10-16', bankAccount: '1'.repeat(26),
  splitPayment: true, seller,
  buyer: { type: 'b2b', idType: 'nip', nip: TENANT_NIP, name: 'Nabywca testowy', address: buyerAddress },
  advanceAmount: 123, totalContractAmount: 1000, vatRate: '23', description: 'Testowa zaliczka na usługę',
};

const finalInput = {
  invoiceType: 'final', internalNumber: 'ROZ/1/10/2026', issueDate: TODAY,
  paymentMethod: 'transfer', paymentDueDate: '2026-10-16', bankAccount: '1'.repeat(26),
  splitPayment: false, seller,
  buyer: { type: 'b2b', idType: 'nip', nip: TENANT_NIP, name: 'Nabywca testowy', address: buyerAddress },
  advanceInvoiceIds: [ADVANCE], totalAdvances: 123,
  lines: [{ name: 'Testowa usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
};

/** jsonb w bazie i w pg-boss: `undefined` znika, kolejność kluczy bez znaczenia. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

/** Zapis jsonb: klucze krótsze przed dłuższymi, przy równej długości bajtowo — nie w kolejności zapisu. */
function jsonb(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)),
    );
  }));
}

/**
 * Wiersz tak, jak przeczyta go cron: kolumny krotki `KSEF_RESEND_SOURCE_COLUMNS`
 * (sprawdza ją „kontrakt kolumn” niżej) plus `id, tenant_id, tenants(nip)`.
 * Kolumna, której INSERT nie zapisał, ma wartość domyślną NULL (special_data ZAL).
 */
function storedRow(insert: Row | undefined): KsefRequeueSourceRow {
  expect(insert, 'akcja nie zapisała faktury').toBeDefined();
  const db = jsonb(insert) as Row;
  return {
    id: NEW_ID,
    tenant_id: db.tenant_id as string,
    tenants: { nip: TENANT_NIP },
    invoice_kind: db.invoice_kind ?? null,
    issue_date: db.issue_date ?? null,
    fa3_data: db.fa3_data ?? null,
    special_data: db.special_data ?? null,
  };
}

function withoutAttempt(data: unknown): Row {
  const copy = { ...(plain(data) as Row) };
  delete copy.sendAttemptId;
  return copy;
}

/** Prawdziwe „Zapisz i wyślij” korekty — pierwsze zdarzenie i zapisany wiersz. */
async function sendCorrection(extra: Partial<CorrectionInvoiceSchemaIn>) {
  const result = await saveAndSendCorrectionAction(correctionInput(extra), TENANT);
  expect(result).toMatchObject({ success: true, invoiceId: NEW_ID });
  expect(st.events).toHaveLength(1);
  return { first: st.events[0] as CapturedEvent, insert: st.inserted[0] as Row, row: storedRow(st.inserted[0]) };
}

async function sendAdvance() {
  const result = await saveAndSendAdvanceAction(advanceInput, TENANT);
  expect(result).toMatchObject({ success: true, invoiceId: NEW_ID });
  expect(st.events).toHaveLength(1);
  return { first: st.events[0] as CapturedEvent, insert: st.inserted[0] as Row, row: storedRow(st.inserted[0]) };
}

/** ROZ ma tylko szkic (wysyłka wstrzymana do C4) — wiersz z INSERT szkicu. */
async function saveFinal() {
  const result = await saveFinalAction(finalInput, TENANT);
  expect(result).toMatchObject({ success: true, invoiceId: NEW_ID });
  return { insert: st.inserted[0] as Row, row: storedRow(st.inserted[0]) };
}

/** Zwykła faktura „z bazy” (fikcyjna, bez akcji) — do przypadków kontraktu kolumn. */
function regularRow(patch: Partial<KsefRequeueSourceRow> = {}): KsefRequeueSourceRow {
  return {
    id: NEW_ID,
    tenant_id: TENANT,
    tenants: { nip: TENANT_NIP },
    invoice_kind: 'regular',
    issue_date: '2026-09-30',
    special_data: null,
    fa3_data: {
      internalNumber: 'FV/1/09/2026', type: 'VAT', issueDate: '2026-09-30', seller,
      lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    },
    ...patch,
  };
}

function fa3(row: KsefRequeueSourceRow): Row {
  return row.fa3_data as Row;
}

beforeEach(() => {
  st.inserted = [];
  st.events = [];
  st.sql = [];
  vi.stubEnv('KSEF_ENV', 'test');
  // Wysyłka przyjmuje tylko dzisiejszą datę wystawienia (A1, 00147).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('strażnik harnessu: pierwsze zdarzenie z prawdziwych akcji i prawdziwego enqueue', () => {
  it.each(KOR_VARIANTS)('%s: zdarzenie niesie correctionData, a INSERT special_data = { correctionData }', async (_name, extra) => {
    const { first, insert } = await sendCorrection(extra);
    expect(first).toMatchObject({ name: 'invoice/submit.requested', groupId: TENANT, singletonKey: NEW_ID });
    expect(first.data).toMatchObject({ tenantId: TENANT, invoiceId: NEW_ID, nip: TENANT_NIP, environment: 'test' });
    expect(Object.keys(first.data).sort()).toEqual(
      ['correctionData', 'environment', 'invoice', 'invoiceId', 'nip', 'sendAttemptId', 'tenantId'],
    );
    const correctionData = first.data.correctionData as Row;
    expect(correctionData).toMatchObject({ invoiceType: 'correction', issueDate: TODAY, annotations: PARENT_ANNOTATIONS });
    expect(correctionData.correctionType).toBe(extra.correctionType);
    if (extra.correctionType === 'before_after') {
      expect(correctionData).toMatchObject({ typKorekty: '1', paymentMethod: 'compensation' });
      expect((correctionData.linesAfter as Row[])[0]?.pkwiuCode).toBe('62.01.11.0');
    }
    expect(plain(insert.special_data)).toEqual(plain({ correctionData }));
    expect(plain(insert.fa3_data)).toEqual(plain(first.data.invoice));
    // Pierwsza wysyłka: draft → queued w transakcji zlecenia (00131).
    expect(st.sql).toEqual([{
      sql: expect.stringContaining('enqueue_ksef_send'),
      values: [NEW_ID, TENANT, first.data.sendAttemptId],
    }]);
  });

  it('ZAL: zdarzenie niesie advanceData = fa3_data.advanceEnvelope, INSERT bez special_data', async () => {
    const { first, insert } = await sendAdvance();
    expect(first).toMatchObject({ name: 'invoice/submit.requested', groupId: TENANT, singletonKey: NEW_ID });
    expect(Object.keys(first.data).sort()).toEqual(
      ['advanceData', 'environment', 'invoice', 'invoiceId', 'nip', 'sendAttemptId', 'tenantId'],
    );
    const invoice = first.data.invoice as Row;
    expect(first.data.advanceData).toMatchObject({ invoiceType: 'advance', issueDate: TODAY });
    expect(plain(first.data.advanceData)).toEqual(plain(invoice.advanceEnvelope));
    expect(invoice).toMatchObject({ type: 'ZAL', issueDate: TODAY, annotations: { cashMethod: 2, splitPayment: 1 } });
    expect(insert).not.toHaveProperty('special_data');
    expect(plain(insert.fa3_data)).toEqual(plain(invoice));
  });

  it('ROZ: szkic zapisuje special_data = { finalData, finalAdvanceSettlementRows }, bez zlecenia', async () => {
    const { insert } = await saveFinal();
    expect(st.events).toEqual([]);
    const special = plain(insert.special_data) as Row;
    expect(Object.keys(special).sort()).toEqual(['finalAdvanceSettlementRows', 'finalData']);
    expect(special.finalData).toMatchObject({ invoiceType: 'final', issueDate: TODAY, advanceInvoiceIds: [ADVANCE] });
    expect(special.finalAdvanceSettlementRows).toEqual([
      expect.objectContaining({ internal_number: 'ZAL/1/09/2026', advance_amount: 123, vat_rate: '23' }),
    ]);
  });

  it('atrapa jsonb zmienia kolejność kluczy — porównania nie mogą od niej zależeć', async () => {
    const { insert, row } = await sendAdvance();
    expect(Object.keys(fa3(row))).not.toEqual(Object.keys(insert.fa3_data as Row));
    expect(plain(row.fa3_data)).toEqual(plain(insert.fa3_data));
    expect(row).toMatchObject({ id: NEW_ID, tenant_id: TENANT, invoice_kind: 'advance', issue_date: TODAY, special_data: null });
  });
});

describe('A4b PR2a: zdarzenie odtworzone z kopii na wierszu = pierwsze zdarzenie', () => {
  const DOCUMENTS: Array<[string, () => Promise<{ first: CapturedEvent; row: KsefRequeueSourceRow }>]> = [
    ...KOR_VARIANTS.map(([name, extra]): [string, () => Promise<{ first: CapturedEvent; row: KsefRequeueSourceRow }>] =>
      [`${name} (TEST)`, () => sendCorrection(extra)]),
    ['ZAL', sendAdvance],
  ];

  it.each(DOCUMENTS)('%s: te same dane zdarzenia poza sendAttemptId, ten sam klucz i grupa', async (_name, send) => {
    const { first, row } = await send();
    const built = buildKsefRequeueEvent(row, 'test', ATTEMPT_B, { reconcileOnly: false });
    expect(built).toMatchObject({ ok: true, sendAttemptId: ATTEMPT_B });
    if (!built.ok) return;
    expect(built.event.name).toBe(first.name);
    expect(built.event.groupId).toBe(first.groupId);
    expect(built.event.singletonKey).toBe(first.singletonKey);
    expect(withoutAttempt(built.event.data)).toEqual(withoutAttempt(first.data));
    // Nowe zlecenie = nowa próba (00124); pełna wysyłka bez znacznika uzgodnienia.
    expect((built.event.data as Row).sendAttemptId).toBe(ATTEMPT_B);
    expect(built.event.data).not.toHaveProperty('reconcileOnly');
  });
});

describe('A4b PR2a: odmowy przy odtwarzaniu zdarzenia', () => {
  it('stary KOR (special_data NULL, sprzed 00137) → missing-special-data', async () => {
    const { row } = await sendCorrection(KOR_VARIANTS[0]![1]);
    const legacy: KsefRequeueSourceRow = { ...row, special_data: null };
    expect(buildKsefRequeueEvent(legacy, 'test', ATTEMPT_B, { reconcileOnly: false }))
      .toEqual({ ok: false, reason: 'missing-special-data' });
    // Brak danych rozstrzyga przed hamulcem — także „tylko uzgodnij” na produkcji.
    expect(buildKsefRequeueEvent(legacy, 'production', ATTEMPT_B, { reconcileOnly: true }))
      .toEqual({ ok: false, reason: 'missing-special-data' });
  });

  it('stara ZAL (fa3_data bez advanceEnvelope, sprzed 02.10.2026) → missing-special-data', async () => {
    const { row } = await sendAdvance();
    const envelopeless = { ...fa3(row) };
    delete envelopeless.advanceEnvelope;
    const legacy: KsefRequeueSourceRow = { ...row, fa3_data: envelopeless };
    expect(buildKsefRequeueEvent(legacy, 'test', ATTEMPT_B, { reconcileOnly: false }))
      .toEqual({ ok: false, reason: 'missing-special-data' });
    expect(buildKsefRequeueEvent(legacy, 'test', ATTEMPT_B, { reconcileOnly: true }))
      .toEqual({ ok: false, reason: 'missing-special-data' });
  });

  it('KOR na KSeF produkcyjnym (KOR_HOLD) → kind-held, także „tylko uzgodnij”', async () => {
    const { row } = await sendCorrection(KOR_VARIANTS[0]![1]);
    expect(buildKsefRequeueEvent(row, 'production', ATTEMPT_B, { reconcileOnly: false }))
      .toEqual({ ok: false, reason: 'kind-held' });
    // Runner rzuca hamulec przed uzgodnieniem i nadpisuje kod — nie zlecamy.
    expect(buildKsefRequeueEvent(row, 'production', ATTEMPT_B, { reconcileOnly: true }))
      .toEqual({ ok: false, reason: 'kind-held' });
  });

  it.each(['test', 'production'] as const)(
    'ROZ z INSERT saveFinalAction na %s → kind-held (do C4), a storedSendPayload = zapisana kopia',
    async (env) => {
      const { row } = await saveFinal();
      expect(buildKsefRequeueEvent(row, env, ATTEMPT_B, { reconcileOnly: false }))
        .toEqual({ ok: false, reason: 'kind-held' });
      expect(buildKsefRequeueEvent(row, env, ATTEMPT_B, { reconcileOnly: true }))
        .toEqual({ ok: false, reason: 'kind-held' });
      const special = row.special_data as Row;
      expect(plain(storedSendPayload(row))).toEqual(plain({
        invoice: row.fa3_data,
        finalData: special.finalData,
        finalAdvanceSettlementRows: special.finalAdvanceSettlementRows,
        auditKind: 'final',
      }));
    },
  );

  it('ZAL dzień po dacie wystawienia → issue-date; „tylko uzgodnij” → zlecenie z reconcileOnly (data bez znaczenia)', async () => {
    const { first, row } = await sendAdvance();
    expect(buildKsefRequeueEvent(row, 'test', ATTEMPT_B, { reconcileOnly: false, now: NEXT_DAY }))
      .toEqual({ ok: false, reason: 'issue-date' });

    const reconcile = buildKsefRequeueEvent(row, 'test', ATTEMPT_B, { reconcileOnly: true, now: NEXT_DAY });
    expect(reconcile).toMatchObject({ ok: true, sendAttemptId: ATTEMPT_B });
    if (!reconcile.ok) return;
    expect((reconcile.event.data as Row).reconcileOnly).toBe(true);
    const data = withoutAttempt(reconcile.event.data);
    delete data.reconcileOnly;
    expect(data).toEqual(withoutAttempt(first.data));
  });

  // Bezpiecznik 00147 czyta fa3_data.issueDate (runner) i kopertę (hak sesji);
  // zlecenie sprawdza oba i kolumnę, żeby worker nie skończył go ISSUE_DATE_PASSED.
  it.each([
    ['fa3_data.issueDate', (row: KsefRequeueSourceRow): KsefRequeueSourceRow =>
      ({ ...row, fa3_data: { ...fa3(row), issueDate: YESTERDAY } })],
    ['fa3_data.advanceEnvelope.issueDate', (row: KsefRequeueSourceRow): KsefRequeueSourceRow =>
      ({ ...row, fa3_data: { ...fa3(row), advanceEnvelope: { ...(fa3(row).advanceEnvelope as Row), issueDate: YESTERDAY } } })],
    ['kolumna issue_date', (row: KsefRequeueSourceRow): KsefRequeueSourceRow => ({ ...row, issue_date: YESTERDAY })],
  ])('ZAL, w której tylko %s jest wczorajsza → issue-date', async (_source, stale) => {
    const { row } = await sendAdvance();
    expect(buildKsefRequeueEvent(stale(row), 'test', ATTEMPT_B, { reconcileOnly: false }))
      .toEqual({ ok: false, reason: 'issue-date' });
  });

  it('KOR, w której tylko correctionData.issueDate jest wczorajsza → issue-date', async () => {
    const { row } = await sendCorrection(KOR_VARIANTS[0]![1]);
    const special = row.special_data as { correctionData: Row };
    const stale: KsefRequeueSourceRow = {
      ...row,
      special_data: { correctionData: { ...special.correctionData, issueDate: YESTERDAY } },
    };
    expect(buildKsefRequeueEvent(stale, 'test', ATTEMPT_B, { reconcileOnly: false }))
      .toEqual({ ok: false, reason: 'issue-date' });
  });

  it('nieznane środowisko (null) → dokument specjalny wstrzymany (fail-closed), także „tylko uzgodnij”', async () => {
    const { row } = await sendAdvance();
    expect(ksefSendPayloadFromRow(row, { environment: null, reconcileOnly: true }))
      .toEqual({ ok: false, reason: 'kind-held' });
    const ok = ksefSendPayloadFromRow(row, { environment: 'test', reconcileOnly: false });
    expect(ok).toMatchObject({ ok: true, payload: { auditKind: 'advance' } });
    if (!ok.ok) return;
    expect(plain(ok.payload.advanceData)).toEqual(plain(fa3(row).advanceEnvelope));
  });

  it('strażnik: zwykła faktura z pozycjami — ponowienie bez względu na datę wystawienia', () => {
    const row = regularRow();
    const built = buildKsefRequeueEvent(row, 'test', ATTEMPT_B, { reconcileOnly: false });
    expect(built).toMatchObject({ ok: true, sendAttemptId: ATTEMPT_B });
    if (!built.ok) return;
    expect(plain(built.event)).toEqual(plain({
      groupId: TENANT,
      singletonKey: NEW_ID,
      name: 'invoice/submit.requested',
      data: { tenantId: TENANT, invoiceId: NEW_ID, invoice: row.fa3_data, nip: TENANT_NIP, environment: 'test', sendAttemptId: ATTEMPT_B },
    }));
  });
});

describe('A4b PR2a: fakty dla panelu operatora (ksefResendFacts)', () => {
  it('ZAL z kopią w dniu wystawienia → dane zapisane, rodzaj niewstrzymany, data aktualna; dzień później — data minęła', async () => {
    const { row } = await sendAdvance();
    expect(ksefResendFacts(row, 'test')).toEqual({ sendData: 'stored', kindHeld: false, issueDatePassed: false });
    expect(ksefResendFacts(row, 'test', NEXT_DAY)).toEqual({ sendData: 'stored', kindHeld: false, issueDatePassed: true });
  });

  it('KOR z kopią: na produkcji rodzaj wstrzymany; stary KOR bez kopii → brak danych', async () => {
    const { row } = await sendCorrection(KOR_VARIANTS[1]![1]);
    expect(ksefResendFacts(row, 'test')).toEqual({ sendData: 'stored', kindHeld: false, issueDatePassed: false });
    expect(ksefResendFacts(row, 'production')).toEqual({ sendData: 'stored', kindHeld: true, issueDatePassed: false });
    expect(ksefResendFacts({ ...row, special_data: null }, 'test'))
      .toEqual({ sendData: 'missing', kindHeld: false, issueDatePassed: false });
  });

  it('ROZ z kopią → dane zapisane, rodzaj wstrzymany w każdym środowisku', async () => {
    const { row } = await saveFinal();
    expect(ksefResendFacts(row, 'test')).toMatchObject({ sendData: 'stored', kindHeld: true });
    expect(ksefResendFacts(row, 'production')).toMatchObject({ sendData: 'stored', kindHeld: true });
  });

  it('zwykła faktura z dawną datą → data nie ma znaczenia (issueDatePassed: false)', () => {
    expect(ksefResendFacts(regularRow(), 'test')).toEqual({ sendData: 'stored', kindHeld: false, issueDatePassed: false });
  });
});

describe('A4b PR2a: kontrakt kolumn (KSEF_RESEND_SOURCE_COLUMNS)', () => {
  it('krotka = invoice_kind, issue_date, fa3_data, special_data (atrapa wiersza wyżej rzutuje te same)', () => {
    expect(KSEF_RESEND_SOURCE_COLUMN_KEYS).toEqual(['invoice_kind', 'issue_date', 'fa3_data', 'special_data']);
    expect(KSEF_RESEND_SOURCE_COLUMNS).toBe('invoice_kind, issue_date, fa3_data, special_data');
  });

  it.each(['invoice_kind', 'issue_date', 'fa3_data', 'special_data'] satisfies KsefResendSourceColumn[])(
    'ZAL bez pobranej kolumny %s → wyjątek (nie cicha odmowa ani zwykła faktura)',
    async (column) => {
      const { row } = await sendAdvance();
      const partial: Partial<KsefRequeueSourceRow> = { ...row };
      delete partial[column];
      const unselected = partial as KsefRequeueSourceRow;
      const message = `KSEF_RESEND_SOURCE_COLUMNS: kolumna ${column} nie została pobrana`;
      expect(() => buildKsefRequeueEvent(unselected, 'test', ATTEMPT_B, { reconcileOnly: false })).toThrow(message);
      expect(() => ksefResendFacts(unselected, 'test')).toThrow(message);
    },
  );

  it('zwykła faktura bez klucza special_data → wyjątek, mimo kompletnego fa3_data', () => {
    const partial: Partial<KsefRequeueSourceRow> = regularRow();
    delete partial.special_data;
    expect(() => buildKsefRequeueEvent(partial as KsefRequeueSourceRow, 'test', ATTEMPT_B, { reconcileOnly: false }))
      .toThrow('KSEF_RESEND_SOURCE_COLUMNS: kolumna special_data nie została pobrana');
  });

  it('invoice_kind NULL → missing-special-data (nigdy domyślnie zwykła), fakty: rodzaj wstrzymany', () => {
    const row = regularRow({ invoice_kind: null });
    expect(buildKsefRequeueEvent(row, 'test', ATTEMPT_B, { reconcileOnly: false }))
      .toEqual({ ok: false, reason: 'missing-special-data' });
    expect(ksefResendFacts(row, 'test')).toMatchObject({ sendData: 'missing', kindHeld: true });
  });

  it('zwykła faktura z niepustym special_data → incomplete (lustro granicy wysyłki)', () => {
    const row = regularRow({ special_data: { correctionData: { invoiceType: 'correction', issueDate: TODAY } } });
    expect(buildKsefRequeueEvent(row, 'test', ATTEMPT_B, { reconcileOnly: false }))
      .toEqual({ ok: false, reason: 'incomplete' });
    expect(ksefResendFacts(row, 'test')).toMatchObject({ sendData: 'missing' });
  });
});

describe('A4b PR2a: każdy odczyt wiersza do ponowienia używa jednej krotki kolumn', () => {
  it.each([
    'lib/jobs/runners/ksef-lifecycle-reconcile.ts',
    'app/admin/ksef/actions.ts',
    'lib/admin/ksef-lifecycle.ts',
    // A4b PR2b: „Wyślij ponownie” klienta i fakty na stronie faktury (do PR2b — literały bez special_data).
    'app/(dashboard)/invoices/[id]/page.tsx',
    'components/invoices/actions-detail.ts',
  ])('%s', (file) => {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    // Sam wynik, bez wypisywania całego pliku przy porażce.
    expect(source.includes('${KSEF_RESEND_SOURCE_COLUMNS}'), `${file}: select bez krotki kolumn`).toBe(true);
  });
});
