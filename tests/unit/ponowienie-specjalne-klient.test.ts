import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A4b PR2b: „Wyślij ponownie” klienta dla KOR/ZAL z kopii na wierszu (decyzja
 * Bartosza 06.10.2026 (b): tylko w dniu wystawienia) i prawdziwe teksty dla
 * każdego stanu, który polityka klienta rozróżnia. Do PR2b akcja odmawiała
 * każdemu dokumentowi specjalnemu jednym tekstem („special”), KOR_HOLD
 * obiecywał automat, a odmowy kolejki w trybie ponowienia mówiły „zapisana
 * jako szkic”, choć faktura zostaje z błędem wysyłki.
 *
 * Prawdziwa ścieżka: `resendInvoiceAction` → polityka (`decideResend`) →
 * fakty i dane zdarzenia z `ksef-requeue-event` (te same co cron i operator)
 * → `enqueueKsefSubmitAfterDraft` → krok transakcji `requeue_ksef_send`.
 * Pierwsze zdarzenie dają prawdziwe akcje „Zapisz i wyślij” (KOR, ZAL).
 * Zastąpione są tylko: baza (faza 1 — klient sesji z filtrami jak
 * w `ponowienie-specjalne-zdarzenie.test.ts`; faza 2 — `memoryDb`, który
 * rzutuje wybrane kolumny jak PostgREST), zapis zlecenia pg-boss (kopia JSON
 * i krok transakcji na atrapie; `requeue_ksef_send` przestawia failed → queued
 * jak RPC z 00131), flagi, MFA, weryfikacja, zdrowie KSeF, odszyfrowanie
 * certyfikatu, R2, PDF i e-mail.
 */

const st = vi.hoisted(() => ({
  ids: {
    tenant: '11111111-1111-4111-8111-111111111111',
    parent: '22222222-2222-4222-8222-222222222222',
    invoice: '33333333-3333-4333-8333-333333333333',
    advance: '44444444-4444-4444-8444-444444444444',
    user: '55555555-5555-4555-8555-555555555555',
  },
  inserted: [] as Record<string, unknown>[],
  events: [] as Array<{ name: string; groupId?: string; singletonKey?: string; data: Record<string, unknown> }>,
  sql: [] as Array<{ sql: string; values: unknown[] }>,
  audits: [] as Array<Record<string, unknown>>,
  /** Globalny wyłącznik operatora (`killAllKsefSubmissions`). */
  paused: false,
  /** Blob certyfikatu czytany kluczem serwisowym; `null` = firma bez certyfikatu. */
  blob: '\\x00' as string | null,
  role: 'owner',
  /** Faza 2 (ponowienie): baza w pamięci zamiast klienta sesji fazy 1. */
  db: null as null | { from: (table: string) => unknown },
  /** Lustro `requeue_ksef_send` (00131): failed → queued w transakcji zlecenia. */
  onRequeue: null as null | ((values: unknown[]) => void),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Testowy NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach akcji.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/audit/log', () => ({
  logAudit: async (entry: Record<string, unknown>) => {
    st.audits.push(entry);
  },
}));
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlagForExecution: vi.fn(async (flag: string) => flag === 'killAllKsefSubmissions' && st.paused),
}));
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
        if (sql.includes('requeue_ksef_send')) st.onRequeue?.(values ?? []);
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
    supabase: st.db ?? { from: sessionFrom },
    user: { id: st.ids.user },
    tenantId: st.ids.tenant,
    role: st.role,
  }),
  requireOrgRole: async () => {
    throw new Error('requireOrgRole: nieużywane w tym teście');
  },
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/supabase/server', () => ({
  // Blob certyfikatu czyta enqueue kluczem serwisowym (00112).
  createAdminClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      single: async () => ({ data: { ksef_credentials_encrypted: st.blob }, error: null }),
    };
    return { from: () => q };
  },
  createClient: async () => ({ from: sessionFrom }),
}));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: vi.fn(), verifyInvoicePdfDeliveryState: vi.fn() }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: vi.fn() }));

import { resendInvoiceAction } from '@/components/invoices/actions-detail';
import { saveAndSendAdvanceAction } from '@/components/invoices/advance-actions';
import { saveAndSendCorrectionAction } from '@/components/invoices/correction-actions';
import { KSEF_RESEND_SOURCE_COLUMNS } from '@/lib/invoices/ksef-requeue-event';
import {
  KSEF_SEND_MESSAGES,
  KSEF_SPECIAL_SEND_MESSAGES,
  resendMissingCredentialsMessage,
  resendPausedMessage,
} from '@/lib/invoices/ksef-send-policy';
import { SUPPORT_EMAIL } from '@/lib/site';
import { finalizeInvoice, validateInvoice } from '@/lib/xml/invoice-calculator';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

import { jsonb, memoryDb, type MemoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

type CapturedEvent = (typeof st.events)[number];

const { tenant: TENANT, parent: PARENT, invoice: NEW_ID, user: USER } = st.ids;
const TENANT_NIP = '1234567890';

// Dzień wystawienia (Europe/Warsaw) i dzień później.
const TODAY = '2026-10-02';
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

/**
 * Faza 1 — klient sesji z filtrami (jak w `ponowienie-specjalne-zdarzenie.test.ts`):
 * faktura pierwotna tylko przy pasujących filtrach, INSERT faktury zapisany
 * jako kopia JSON. Nie obsłuży odczytu NEW_ID — ponowienie czyta z `memoryDb`.
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
    // Wcześniejsze korekty tej faktury pierwotnej — brak.
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

const KOR_BEFORE_AFTER: Partial<CorrectionInvoiceSchemaIn> = {
  correctionType: 'before_after', typKorekty: '1', paymentMethod: 'compensation',
  linesBefore: [line()], linesAfter: [line({ quantity: 8, pkwiuCode: '62.01.11.0' })],
};
const KOR_CANCELLATION: Partial<CorrectionInvoiceSchemaIn> = { correctionType: 'cancellation', linesBefore: [line()] };

const advanceInput = {
  invoiceType: 'advance', internalNumber: 'ZAL/1/10/2026', issueDate: TODAY,
  paymentMethod: 'transfer', paymentDueDate: '2026-10-16', bankAccount: '1'.repeat(26),
  splitPayment: true, seller,
  buyer: { type: 'b2b', idType: 'nip', nip: TENANT_NIP, name: 'Nabywca testowy', address: buyerAddress },
  advanceAmount: 123, totalContractAmount: 1000, vatRate: '23', description: 'Testowa zaliczka na usługę',
};

/** jsonb w bazie i w pg-boss: `undefined` znika, kolejność kluczy bez znaczenia. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

function withoutAttempt(data: unknown): Row {
  const copy = { ...(plain(data) as Row) };
  delete copy.sendAttemptId;
  return copy;
}

interface FirstSend {
  first: CapturedEvent;
  insert: Row;
}

/** Prawdziwe „Zapisz i wyślij” korekty (TEST) — pierwsze zdarzenie i treść INSERT. */
async function sendCorrection(extra: Partial<CorrectionInvoiceSchemaIn>): Promise<FirstSend> {
  const result = await saveAndSendCorrectionAction(correctionInput(extra), TENANT);
  expect(result).toMatchObject({ success: true, invoiceId: NEW_ID });
  expect(st.events).toHaveLength(1);
  return { first: st.events[0] as CapturedEvent, insert: st.inserted[0] as Row };
}

/** Prawdziwe „Zapisz i wyślij” zaliczki — pierwsze zdarzenie i treść INSERT. */
async function sendAdvance(): Promise<FirstSend> {
  const result = await saveAndSendAdvanceAction(advanceInput, TENANT);
  expect(result).toMatchObject({ success: true, invoiceId: NEW_ID });
  expect(st.events).toHaveLength(1);
  return { first: st.events[0] as CapturedEvent, insert: st.inserted[0] as Row };
}

/**
 * Faza 2: wiersz `failed` w bazie w pamięci (treść po jsonb, kolumna
 * niezapisana = NULL) i profil firmy. Zdarzenia, SQL i audyt liczymy od zera.
 */
function seedFailed(fields: Row, patch: Row = {}): MemoryDb {
  const db = memoryDb({
    invoices: [{
      ...fields,
      id: NEW_ID,
      tenant_id: TENANT,
      direction: 'outgoing',
      ksef_status: 'failed',
      last_error_code: 'KSEF_UNAVAILABLE',
      ...patch,
    }],
    tenants: [{ id: TENANT, nip: TENANT_NIP }],
  });
  st.db = db;
  st.events = [];
  st.sql = [];
  st.audits = [];
  st.onRequeue = (values) => {
    const row = db.tables.invoices?.find((r) => r.id === values[0]);
    if (row) row.ksef_status = 'queued';
  };
  return db;
}

/** Wiersz z INSERT akcji „Zapisz i wyślij” po przejściu przez jsonb. */
function seedFromInsert(insert: Row, patch: Row = {}): MemoryDb {
  return seedFailed(jsonb(insert), patch);
}

/** Zwykła faktura z kompletnym `fa3_data` (fixture jak w `ksef-ponowna-wysylka.test.ts` — NIP-y z poprawną sumą). */
function seedRegular(patch: Row = {}): MemoryDb {
  const snapshot = finalizeInvoice({
    internalNumber: 'FV 7/10/2026',
    type: 'VAT',
    issueDate: TODAY,
    saleDate: TODAY,
    seller: { nip: '5260001246', name: 'Moja Firma', address: sellerAddress },
    buyer: { nip: '5252241585', name: 'Klient', address: buyerAddress },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
  return seedFailed({
    invoice_kind: 'regular', invoice_type: 'VAT', issue_date: TODAY, fa3_data: jsonb(snapshot), special_data: null,
  }, patch);
}

function errorOf(result: Awaited<ReturnType<typeof resendInvoiceAction>>): string {
  expect(result.success, 'oczekiwano odmowy ponownej wysyłki').toBe(false);
  return result.success ? '' : result.error;
}

function invoiceRow(db: MemoryDb): Row {
  const row = db.tables.invoices?.[0];
  expect(row).toBeDefined();
  return row as Row;
}

beforeEach(() => {
  st.inserted = [];
  st.events = [];
  st.sql = [];
  st.audits = [];
  st.paused = false;
  st.blob = '\\x00';
  st.role = 'owner';
  st.db = null;
  st.onRequeue = null;
  vi.stubEnv('KSEF_ENV', 'test');
  // Wysyłka dokumentu specjalnego przyjmuje tylko dzisiejszą datę wystawienia (A1, 00147).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('strażnik harnessu: pierwsze zdarzenie z prawdziwych akcji, wiersz z bazy w pamięci', () => {
  it('KOR przed/po: INSERT ma special_data i fa3_data, a memoryDb rzutuje tylko wybrane kolumny', async () => {
    const { first, insert } = await sendCorrection(KOR_BEFORE_AFTER);
    expect(first).toMatchObject({ name: 'invoice/submit.requested', groupId: TENANT, singletonKey: NEW_ID });
    expect(plain(insert.special_data)).toEqual(plain({ correctionData: first.data.correctionData }));
    const db = seedFromInsert(insert);
    const { data } = await (db.from('invoices').select('invoice_kind, issue_date, special_data') as unknown as {
      maybeSingle: () => Promise<{ data: Row | null }>;
    }).maybeSingle();
    expect(data).toEqual({ invoice_kind: 'correction', issue_date: TODAY, special_data: plain(insert.special_data) });
  });

  it('ZAL: INSERT bez special_data — w bazie w pamięci kolumna wybrana = NULL', async () => {
    const { insert } = await sendAdvance();
    expect(insert).not.toHaveProperty('special_data');
    const db = seedFromInsert(insert);
    const { data } = await (db.from('invoices').select('invoice_kind, special_data') as unknown as {
      maybeSingle: () => Promise<{ data: Row | null }>;
    }).maybeSingle();
    expect(data).toEqual({ invoice_kind: 'advance', special_data: null });
  });
});

type SpecialDoc = { kind: 'correction' | 'advance'; cancellation: boolean; send: () => Promise<FirstSend> };

const DOCUMENTS: Array<[string, SpecialDoc]> = [
  ['KOR przed/po z PKWiU, typKorekty 1, kompensata (TEST)', {
    kind: 'correction', cancellation: false, send: () => sendCorrection(KOR_BEFORE_AFTER),
  }],
  ['KOR anulowanie (TEST)', { kind: 'correction', cancellation: true, send: () => sendCorrection(KOR_CANCELLATION) }],
  ['ZAL', { kind: 'advance', cancellation: false, send: sendAdvance }],
];

describe('A4b PR2b: „Wyślij ponownie” KOR/ZAL z kopii na wierszu (w dniu wystawienia)', () => {
  it.each(DOCUMENTS)('%s: requeue z aktorem, dane zdarzenia = pierwsze zdarzenie poza sendAttemptId', async (_name, doc) => {
    const { first, insert } = await doc.send();
    const db = seedFromInsert(insert);
    if (doc.cancellation) {
      // Strażnik: walidator zwykłej faktury odrzuca ujemne ilości anulowania —
      // dlatego akcja waliduje tylko zwykłe faktury (correction-actions.ts linesToStoredItems).
      expect(validateInvoice(insert.fa3_data as Parameters<typeof validateInvoice>[0]))
        .toContainEqual(expect.stringMatching(/ilość musi być > 0/));
    }

    const result = await resendInvoiceAction(NEW_ID);

    // Do PR2b: { success: false, error: tekst „special” } dla każdego dokumentu specjalnego.
    expect(JSON.stringify(result)).not.toMatch(/ilość musi być > 0/);
    expect(result).toEqual({ success: true });
    expect(st.events).toHaveLength(1);
    const second = st.events[0] as CapturedEvent;
    expect(second.name).toBe(first.name);
    expect(second.groupId).toBe(first.groupId);
    expect(second.singletonKey).toBe(first.singletonKey);
    expect(withoutAttempt(second.data)).toEqual(withoutAttempt(first.data));
    expect(second.data.sendAttemptId).not.toBe(first.data.sendAttemptId);
    // Ponowienie klienta: failed → queued przez RPC z aktorem (nie liczy się do limitu I6), pełna wysyłka.
    expect(st.sql.at(-1)).toEqual({
      sql: expect.stringContaining('requeue_ksef_send'),
      values: [NEW_ID, TENANT, second.data.sendAttemptId, USER, false],
    });
    expect(invoiceRow(db).ksef_status).toBe('queued');
    expect(st.audits).toContainEqual(expect.objectContaining({
      action: 'invoice.submit_requested',
      entityId: NEW_ID,
      metadata: expect.objectContaining({ kind: doc.kind, send: 'requeue', mode: 'online_queued' }),
    }));
  });

  // Spec §3.2 p. 12 nazywa ten przypadek strażnikiem, ale na PR2a pierwsze ponowienie ZAL dostaje
  // „special”, więc wiersz nigdy nie przechodzi w queued. Strażnik dla zwykłej faktury jest niżej.
  it('ZAL po udanym ponowieniu jest queued — drugie kliknięcie dostaje M.status, bez drugiego zlecenia', async () => {
    const { insert } = await sendAdvance();
    const db = seedFromInsert(insert);

    await expect(resendInvoiceAction(NEW_ID)).resolves.toEqual({ success: true });
    expect(invoiceRow(db).ksef_status).toBe('queued');
    expect(st.events).toHaveLength(1);

    await expect(resendInvoiceAction(NEW_ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.status });
    expect(st.events).toHaveLength(1);
  });

  it('odczyt faktury do ponowienia używa krotki KSEF_RESEND_SOURCE_COLUMNS (jak cron i operator)', async () => {
    const db = seedRegular();

    await expect(resendInvoiceAction(NEW_ID)).resolves.toEqual({ success: true });
    const reads = db.reads.filter((r) => r.table === 'invoices');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.filters).toEqual({ id: NEW_ID, tenant_id: TENANT });
    // Do PR2b: literał 'ksef_status, direction, invoice_kind, invoice_type, last_error_code, fa3_data'.
    expect(reads[0]!.columns).toContain(KSEF_RESEND_SOURCE_COLUMNS);
  });
});

describe('A4b PR2b: odmowy z powodem i wyjściem, bez zlecenia', () => {
  it('stary KOR bez kopii (special_data NULL) → S.incomplete(correction) z adresem pomocy', async () => {
    const { insert } = await sendCorrection(KOR_BEFORE_AFTER);
    seedFromInsert(insert, { special_data: null });

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    // Do PR2b: jeden tekst „special” — bez powodu i bez wyjścia dla zablokowanego szkicu.
    expect(error).toMatch(/kopii danych korekty/);
    expect(error).toContain(SUPPORT_EMAIL);
    expect(error).toBe(KSEF_SPECIAL_SEND_MESSAGES.incomplete('correction'));
    expect(st.events).toEqual([]);
    expect(st.sql).toEqual([]);
  });

  it('KOR, gdy KSEF_ENV = production tylko przy ponowieniu → S.kindHeld(correction)', async () => {
    const { insert } = await sendCorrection(KOR_BEFORE_AFTER);
    seedFromInsert(insert);
    vi.stubEnv('KSEF_ENV', 'production');

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    expect(error).toMatch(/korekt do produkcyjnego KSeF jest wstrzymana/);
    expect(error).toBe(KSEF_SPECIAL_SEND_MESSAGES.kindHeld('correction'));
    expect(st.events).toEqual([]);
    expect(st.sql).toEqual([]);
  });

  it('ZAL dzień po dacie wystawienia → S.issueDatePassed(advance), bez „uzgodni operator”', async () => {
    const { insert } = await sendAdvance();
    seedFromInsert(insert);
    vi.setSystemTime(NEXT_DAY);

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    expect(error).toMatch(/datę wystawienia sprzed dzisiaj/);
    expect(error).not.toMatch(/uzgodni (ją|go) operator/);
    expect(error).toBe(KSEF_SPECIAL_SEND_MESSAGES.issueDatePassed('advance'));
    expect(st.events).toEqual([]);
    expect(st.sql).toEqual([]);
  });

  it('ZAL z KSEF_PAUSED bez koperty advanceEnvelope → S.incomplete(advance), nie „wyjdzie automatycznie” (M.hold)', async () => {
    const { insert } = await sendAdvance();
    const fa3 = { ...(jsonb(insert.fa3_data) as Row) };
    delete fa3.advanceEnvelope;
    seedFromInsert(insert, { last_error_code: 'KSEF_PAUSED', fa3_data: fa3 });

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    // Do PR2b: M.hold obiecuje automat, którego I7 dla tego wiersza nie wykona (brak danych).
    expect(error).not.toBe(KSEF_SEND_MESSAGES.hold);
    expect(error).toMatch(/kopii danych faktury zaliczkowej/);
    expect(error).toBe(KSEF_SPECIAL_SEND_MESSAGES.incomplete('advance'));
    expect(st.events).toEqual([]);
  });

  it('KOR_HOLD na TEST z kopią → M.korHold: bez obietnicy automatu, z adresem pomocy (jedyne wymuszenie decyzji a po stronie serwera)', async () => {
    const { insert } = await sendCorrection(KOR_BEFORE_AFTER);
    seedFromInsert(insert, { last_error_code: 'KOR_HOLD' });

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    // Do PR2b: M.hold „Faktura wyjdzie automatycznie po przywróceniu wysyłki”.
    expect(error).not.toMatch(/automatycznie/);
    expect(error).toContain(SUPPORT_EMAIL);
    expect(error).toBe(KSEF_SEND_MESSAGES.korHold);
    expect(st.events).toEqual([]);
    expect(st.sql).toEqual([]);
  });

  it.each([
    ['zwykła', async () => seedRegular()],
    ['ZAL', async () => seedFromInsert((await sendAdvance()).insert)],
  ] as const)('%s, gdy KSEF_ENV jest niepoprawne → M.envUnknown (nie ogólny błąd z catch)', async (_name, seed) => {
    await seed();
    vi.stubEnv('KSEF_ENV', 'bogus');

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    // Do PR2b: zwykła — wyjątek requireConfiguredKsefEnvironment w kolejce i ogólny tekst; ZAL — „special”.
    expect(error).toMatch(/środowiska KSeF/);
    expect(error).toBe(KSEF_SEND_MESSAGES.envUnknown);
    expect(st.events).toEqual([]);
    expect(st.sql).toEqual([]);
  });
});

describe('A4b PR2b: odmowy kolejki w trybie ponowienia — faktura zostaje z błędem wysyłki, nie „zapisana jako szkic”', () => {
  it('wyłącznik operatora, zwykła faktura KSEF_UNAVAILABLE → resendPausedMessage(regular), wiersz dalej failed', async () => {
    const db = seedRegular();
    st.paused = true;

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    // Do PR2b: KSEF_PAUSED_MESSAGE „Faktura została zapisana jako szkic”.
    expect(error).not.toMatch(/szkic/);
    expect(error).toMatch(/nie wykonaliśmy/);
    expect(error).toBe(resendPausedMessage('regular'));
    expect(st.sql).toEqual([]);
    expect(st.events).toEqual([]);
    expect(invoiceRow(db).ksef_status).toBe('failed');
  });

  it('wyłącznik operatora, ZAL w dniu wystawienia → resendPausedMessage(advance)', async () => {
    const { insert } = await sendAdvance();
    const db = seedFromInsert(insert);
    st.paused = true;

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    // Do PR2b: polityka odmawiała wcześniej tekstem „special”.
    expect(error).toMatch(/wstrzymana przez operatora/);
    expect(error).not.toMatch(/zapisan[ao] jako szkic/);
    expect(error).toBe(resendPausedMessage('advance'));
    expect(st.sql).toEqual([]);
    expect(invoiceRow(db).ksef_status).toBe('failed');
  });

  it('firma bez certyfikatu (blob NULL), zwykła faktura → resendMissingCredentialsMessage(regular)', async () => {
    const db = seedRegular();
    st.blob = null;

    const error = errorOf(await resendInvoiceAction(NEW_ID));
    // Do PR2b: „Faktura została zapisana jako szkic.”
    expect(error).not.toMatch(/zapisana jako szkic/);
    expect(error).toMatch(/nie wykonaliśmy/);
    expect(error).toBe(resendMissingCredentialsMessage('regular'));
    expect(st.sql).toEqual([]);
    expect(invoiceRow(db).ksef_status).toBe('failed');
  });
});

describe('strażniki: granice ponowienia, które PR2b zostawia bez zmian', () => {
  it('strażnik: zwykła faktura po udanym ponowieniu jest queued — drugie kliknięcie dostaje M.status, bez drugiego zlecenia', async () => {
    const db = seedRegular();
    await expect(resendInvoiceAction(NEW_ID)).resolves.toEqual({ success: true });
    expect(invoiceRow(db).ksef_status).toBe('queued');
    expect(st.events).toHaveLength(1);

    await expect(resendInvoiceAction(NEW_ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.status });
    expect(st.events).toHaveLength(1);
  });

  it('strażnik: rola member → M.role i żadnego odczytu faktury', async () => {
    const { insert } = await sendAdvance();
    const db = seedFromInsert(insert);
    st.role = 'member';

    await expect(resendInvoiceAction(NEW_ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.role });
    expect(db.reads.filter((r) => r.table === 'invoices')).toEqual([]);
    expect(st.events).toEqual([]);
  });
});
