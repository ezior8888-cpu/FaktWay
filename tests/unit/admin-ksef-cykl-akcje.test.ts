import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje operatora `/admin/ksef` (PR 3c cyklu życia): `requireAdmin()` przed
 * kluczem serwisowym, RPC `requeue_ksef_send` / `reset_ksef_send` z aktorem
 * = operator, zlecenie pg-boss w tej samej transakcji, audyt systemowy.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR = { userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'operator@example.test' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOW = '2026-10-03T10:00:00Z';
const TODAY = '2026-10-03';

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  admin: vi.fn(),
  rpc: vi.fn(),
  send: vi.fn(),
  paused: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  /** `configuredKsefEnvironment()` akcji (null = KSEF_ENV nieustawione albo błędne). */
  env: vi.fn((): string | null => 'test'),
  invoice: null as Record<string, unknown> | null,
  /** Inne faktury firmy (np. dokument, który ma już numer KSeF oryginału) — odczyt po `id`. */
  otherInvoices: [] as Array<Record<string, unknown>>,
  /** Wpisy `ksef_submissions` faktury; bez `status` = `sent`. */
  openSent: [] as Array<{ id: string; status?: string } & Record<string, unknown>>,
  /** `audit_logs` w pamięci — ślad powiadomień klienta o decyzji (D-A4-1b-3 PR B). */
  auditLogs: [] as Array<Record<string, unknown>>,
  /** Zapis do `audit_logs` kończy się błędem bazy. */
  failAuditInsert: false,
  /** Napisy `select(...)` w kolejności wywołań — kontrakt kolumn odczytu. */
  selects: [] as Array<{ table: string; columns: string }>,
  /** E-mail właściciela firmy (`readTenantOwnerContact`; odrzucenie = błąd odczytu). */
  ownerEmail: vi.fn(),
  /** `sendInvoiceDuplicateDecisionEmail` (przypomnienie o decyzji). */
  duplicateEmail: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  /** Wiersze dziennika prób `ksef_send_attempts` (A5, 00150) zapisane przez akcję. */
  attempts: [] as Array<Record<string, unknown>>,
  /** Zapis do dziennika prób kończy się błędem bazy (zapis fail-open). */
  failAttemptInsert: false,
}));

vi.mock('@/lib/auth/admin-guard', () => ({ requireAdmin: m.requireAdmin }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: m.admin }));
// Dziennik prób (`recordSendRefusal`) bierze klienta serwisowego z `@/lib/supabase/server` — ta sama atrapa bazy.
vi.mock('@/lib/supabase/server', async (orig) => ({
  ...await orig<typeof import('@/lib/supabase/server')>(),
  createAdminClient: () => m.admin(),
}));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: m.send }));
vi.mock('@/lib/ksef/submission-holds', () => ({ isKsefSubmissionPaused: m.paused }));
vi.mock('@/lib/ksef/claim-environment', () => ({
  configuredKsefEnvironment: m.env,
  requireConfiguredKsefEnvironment: () => 'test',
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
// D-A4-1b-3 PR B: przypomnienie o decyzji — e-mail (Resend) i adres właściciela; Sentry bez sieci.
vi.mock('@/lib/email/send', () => ({
  sendInvoiceDuplicateDecisionEmail: m.duplicateEmail,
  sendInvoiceFailedEmail: vi.fn(),
  sendInvoiceAcceptedEmail: vi.fn(),
}));
vi.mock('@/lib/supabase/admin-queries', async (orig) => ({
  ...await orig<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantAdminEmail: m.ownerEmail,
  // Wariant ścisły (przegląd PR B #1/#4): błąd odczytu rzuca, prawdziwy brak = null.
  readTenantOwnerContact: async (tenantId: string) => {
    const email = (await m.ownerEmail(tenantId)) as string | null;
    return { ownerUserId: email ? 'owner-user' : null, email };
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: m.captureException, captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { operatorRequeueAction, operatorResetAction, type OperatorActionResult } from '@/app/admin/ksef/actions';
import * as operatorActions from '@/app/admin/ksef/actions';
import {
  OPERATOR_DUPLICATE_MESSAGES,
  OPERATOR_MESSAGES,
  operatorIssueDateMessage,
  operatorKindHeldMessage,
  operatorLegacyDataMessage,
  operatorRequeueEventRefusal,
} from '@/lib/admin/ksef-operator-policy';
import { KSEF_RESEND_SOURCE_COLUMNS } from '@/lib/invoices/ksef-requeue-event';
import { sendAttemptMessage } from '@/lib/ksef/send-attempt-ledger';

import { CLIENT } from './helpers/decyzja-klienta';
import { fillExpected } from './helpers/ksef-duplicate-decision-cases';

type Tx = { executeSql: ReturnType<typeof vi.fn> };

/** Kolumny napisu select na najwyższym poziomie: `a, b, rel(x, y)` → `['a', 'b', 'rel(x, y)']`. */
function topLevelColumns(columns: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Jak PostgREST: tylko wybrane kolumny; wybrana, a nieobecna w danych → null;
 * niewybrana — brak klucza (akcja, która czyta niepobraną kolumnę, widzi undefined).
 */
function project(source: Record<string, unknown>, columns: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of topLevelColumns(columns)) {
    const open = column.indexOf('(');
    if (open === -1) {
      out[column] = source[column] ?? null;
      continue;
    }
    const key = column.slice(0, open).trim();
    const nested = column.slice(open + 1, column.lastIndexOf(')'));
    const value = source[key];
    out[key] = Array.isArray(value)
      ? value.map((v) => project(v as Record<string, unknown>, nested))
      : value && typeof value === 'object'
        ? project(value as Record<string, unknown>, nested)
        : null;
  }
  return out;
}

/** Wartość kolumny albo ścieżki jsonb PostgREST (`metadata->>klucz`); `undefined`, gdy wiersz nie ma kolumny. */
function columnValue(row: Record<string, unknown>, key: string): unknown {
  const [root, ...path] = key.split(/->>?/);
  let value: unknown = row[root!];
  for (const part of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  return value;
}

function fakeAdminClient() {
  return {
    from: (table: string) => {
      const statusOk: Array<(status: string) => boolean> = [];
      // Filtry pomijają kolumny, których wiersz fikstury nie ma (wpisy `{ id, status }` starszych testów).
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const has = (r: Record<string, unknown>, k: string) => k.split(/->>?/)[0]! in r;
      let columns = '*';
      let inserted: Record<string, unknown> | null = null;
      const rows = (): Array<Record<string, unknown>> => {
        const source = table === 'ksef_submissions'
          ? m.openSent.filter((r) => statusOk.every((f) => f(r.status ?? 'sent')))
          : table === 'audit_logs'
            ? m.auditLogs
            : table === 'invoices'
              ? [m.invoice, ...m.otherInvoices].filter((r): r is Record<string, unknown> => r !== null)
              : [];
        return source.filter((r) => filters.every((f) => f(r)));
      };
      const insertResult = () => {
        if (table === 'audit_logs' && m.failAuditInsert) return { data: null, error: { code: 'XX000', message: 'db down' } };
        if (table === 'ksef_send_attempts' && inserted) {
          if (m.failAttemptInsert) return { data: null, error: { code: 'XX000', message: 'db down' } };
          m.attempts.push(inserted);
        }
        if (table === 'audit_logs' && inserted) {
          m.auditLogs.push({ id: `audit-${m.auditLogs.length + 1}`, created_at: new Date().toISOString(), ...inserted });
        }
        return { data: null, error: null };
      };
      const one = async () => {
        if (inserted) return insertResult();
        const first = rows()[0] ?? null;
        if (table !== 'invoices') return { data: first, error: null };
        return { data: first ? (columns === '*' ? first : project(first, columns)) : null, error: null };
      };
      const q = {
        select: (c: string) => {
          columns = c;
          m.selects.push({ table, columns: c });
          return q;
        },
        insert: (row: Record<string, unknown>) => { inserted = row; return q; },
        eq: (k: string, v: unknown) => {
          if (k === 'status' && table === 'ksef_submissions') statusOk.push((st) => st === v);
          else filters.push((r) => !has(r, k) || columnValue(r, k) === v);
          return q;
        },
        in: (k: string, vs: unknown[]) => {
          if (k === 'status' && table === 'ksef_submissions') statusOk.push((st) => vs.includes(st));
          else filters.push((r) => !has(r, k) || vs.includes(columnValue(r, k)));
          return q;
        },
        neq: (k: string, v: unknown) => { filters.push((r) => !has(r, k) || columnValue(r, k) !== v); return q; },
        is: (k: string, v: unknown) => { filters.push((r) => !has(r, k) || (columnValue(r, k) ?? null) === v); return q; },
        not: (k: string, _op: string, v: unknown) => { filters.push((r) => !has(r, k) || (columnValue(r, k) ?? null) !== v); return q; },
        limit: () => q,
        abortSignal: () => q,
        order: () => q,
        gte: () => q,
        lte: () => q,
        maybeSingle: one,
        single: one,
        then: (ok: (v: unknown) => unknown) => ok(inserted
          ? insertResult()
          : { data: table === 'invoices' ? [] : rows(), error: null }),
      };
      return q;
    },
    rpc: m.rpc,
  };
}

function sendRunningStep(tx: Tx, outcome: 'ok' | Error = 'ok') {
  m.send.mockImplementation(async (_event: unknown, options?: { inTransaction?: (tx: Tx) => Promise<void> }) => {
    await options?.inTransaction?.(tx);
    if (outcome !== 'ok') throw outcome;
    return { ids: ['job-1'] };
  });
}

function row(extra: Record<string, unknown> = {}) {
  return {
    id: ID, tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', ksef_status: 'failed',
    last_error_code: 'INFRA', internal_number: 'FV/9', tenants: { nip: '5260001246' },
    issue_date: TODAY, special_data: null,
    fa3_data: { internalNumber: 'FV/9', type: 'VAT', lines: [{ ordinal: 1 }], seller: { nip: '5260001246' } },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Dzień wystawienia dokumentów z `row()` (Europe/Warsaw: 03.10.2026, 12:00).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  m.env.mockReset();
  m.env.mockReturnValue('test');
  m.selects = [];
  m.requireAdmin.mockResolvedValue(OPERATOR);
  m.admin.mockImplementation(fakeAdminClient);
  m.rpc.mockResolvedValue({ data: { id: ID }, error: null });
  m.paused.mockResolvedValue(false);
  m.invoice = row();
  m.otherInvoices = [];
  m.openSent = [];
  m.auditLogs = [];
  m.failAuditInsert = false;
  m.attempts = [];
  m.failAttemptInsert = false;
  m.ownerEmail.mockResolvedValue('owner@example.test');
  m.duplicateEmail.mockResolvedValue({ sent: true, messageId: 'msg-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('operatorRequeueAction', () => {
  it('ponowna wysyłka: requeue_ksef_send z aktorem = operator w kroku transakcji, zdarzenie z sendAttemptId, audyt', async () => {
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx);

    const result = await operatorRequeueAction(ID, { reconcileOnly: false });

    expect(result).toEqual({ success: true, message: OPERATOR_MESSAGES.requeued });
    const event = m.send.mock.calls[0]![0] as { singletonKey: string; groupId: string; data: Record<string, unknown> };
    expect(event.singletonKey).toBe(ID);
    expect(event.groupId).toBe(TENANT);
    expect(event.data).toMatchObject({ tenantId: TENANT, invoiceId: ID, nip: '5260001246', environment: 'test' });
    expect(event.data.sendAttemptId).toMatch(UUID);
    const [sql, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/public\.requeue_ksef_send\(/);
    expect(values).toEqual([ID, TENANT, event.data.sendAttemptId, OPERATOR.userId, false]);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.operator_requeue', userId: OPERATOR.userId, entityId: ID,
      metadata: expect.objectContaining({ operator: OPERATOR.email, previousCode: 'INFRA' }),
    }));
    expect(m.revalidate).toHaveBeenCalledWith(`/admin/ksef/${ID}`);
  });

  it('„tylko uzgodnij” bez otwartego wpisu sent: odmowa bez zlecenia', async () => {
    await expect(operatorRequeueAction(ID, { reconcileOnly: true })).resolves.toEqual({
      success: false, error: OPERATOR_MESSAGES.noOpenSent,
    });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('„tylko uzgodnij” z wpisem sent: RPC z p_reconcile_only = true, audyt operator_reconcile', async () => {
    m.invoice = row({ ksef_status: 'rejected', last_error_code: null });
    m.openSent = [{ id: 'sub-1' }];
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx);

    const result = await operatorRequeueAction(ID, { reconcileOnly: true });

    expect(result).toEqual({ success: true, message: OPERATOR_MESSAGES.reconcileQueued });
    const [, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(values[3]).toBe(OPERATOR.userId);
    expect(values[4]).toBe(true);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.operator_reconcile' }));
  });

  it.each([
    ['cudzy duplikat 440', 'KSEF_DUPLICATE_RECONCILE', OPERATOR_MESSAGES.duplicateRequeue],
    ['inne środowisko', 'ENV_MISMATCH', OPERATOR_MESSAGES.envMismatchRequeue],
    ['błąd treści', 'XSD_INVALID', OPERATOR_MESSAGES.terminal],
  ])('A4: akcja decyduje jak przycisk — %s: „Wyślij ponownie” odmówione bez zlecenia', async (_l, code, reason) => {
    m.invoice = row({ last_error_code: code });
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: false, error: reason });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('A4: ENQUEUE_LOST — „Wyślij ponownie” operatora zlecone', async () => {
    m.invoice = row({ last_error_code: 'ENQUEUE_LOST' });
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx);
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: true, message: OPERATOR_MESSAGES.requeued });
  });

  it('A2: „tylko uzgodnij” przy samym zamiarze wysyłki (intent) — zlecenie; wpis zamknięty (abandoned) — odmowa', async () => {
    m.openSent = [{ id: 'sub-1', status: 'abandoned' }];
    await expect(operatorRequeueAction(ID, { reconcileOnly: true })).resolves.toEqual({
      success: false, error: OPERATOR_MESSAGES.noOpenSent,
    });

    m.openSent = [{ id: 'sub-2', status: 'intent' }];
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx);
    await expect(operatorRequeueAction(ID, { reconcileOnly: true })).resolves.toEqual({
      success: true, message: OPERATOR_MESSAGES.reconcileQueued,
    });
    const event = m.send.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(event.data.reconcileOnly).toBe(true);
  });

  // Komunikat jako funkcja: liczony w teście, nie przy zbieraniu tabeli.
  it.each([
    // A4b PR2a: korekta bez special_data (sprzed 00137) — zdarzenia nie da się odtworzyć.
    ['stary dokument specjalny', { invoice_kind: 'correction' }, (): string => operatorLegacyDataMessage('correction')],
    ['przychodząca', { direction: 'incoming' }, (): string => OPERATOR_MESSAGES.incoming],
    ['bez pozycji', { fa3_data: { internalNumber: 'FV/9' } }, (): string => OPERATOR_MESSAGES.incomplete],
  ])('%s → odmowa bez zlecenia', async (_l, patch, message) => {
    m.invoice = row(patch);
    const result = await operatorRequeueAction(ID, { reconcileOnly: false });
    expect(m.send).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: message() });
  });

  it('hamulec operatora: odmowa; awaria odczytu hamulca też (fail-closed)', async () => {
    m.paused.mockResolvedValue(true);
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: false, error: OPERATOR_MESSAGES.paused });
    m.paused.mockRejectedValue(new Error('db'));
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: false, error: OPERATOR_MESSAGES.pausedUnknown });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('odmowa RPC (P0001) wraca komunikatem RPC, bez audytu', async () => {
    const tx: Tx = { executeSql: vi.fn(async () => { throw Object.assign(new Error('Błąd treści dokumentu (XSD_INVALID) — wróć do szkicu i popraw'), { code: 'P0001' }); }) };
    sendRunningStep(tx);
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({
      success: false, error: 'Błąd treści dokumentu (XSD_INVALID) — wróć do szkicu i popraw',
    });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('brak faktury → komunikat, bez efektów', async () => {
    m.invoice = null;
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: false, error: OPERATOR_MESSAGES.notFound });
  });
});

/**
 * A4b PR2a: dokument specjalny odtwarzany z kopii na wierszu — ZAL z
 * `fa3_data.advanceEnvelope`, KOR/ROZ ze `special_data` (00137). Kolejność
 * w akcji: fakty (dane, rodzaj wstrzymany w środowisku, data wystawienia) →
 * decyzja (b): pełna wysyłka tylko w dniu wystawienia, uzgodnienie bez względu
 * na datę. Ta sama decyzja co przycisk; wspólny budowniczy zdarzenia z cronem.
 */
describe('operatorRequeueAction — dokumenty specjalne z kopii (A4b PR2a)', () => {
  const YESTERDAY = '2026-10-02';

  function zalRow(issueDate: string, extra: Record<string, unknown> = {}) {
    const advanceEnvelope = {
      invoiceType: 'advance', issueDate, advanceAmount: 1230, totalContractAmount: 2460, vatRate: '23',
      description: 'Zaliczka na projekt', seller: { nip: '5260001246' },
    };
    return {
      advanceEnvelope,
      row: row({
        invoice_kind: 'advance', internal_number: 'ZAL/9', issue_date: issueDate, last_error_code: 'KSEF_UNAVAILABLE',
        fa3_data: {
          internalNumber: 'ZAL/9', type: 'ZAL', issueDate, lines: [{ ordinal: 1 }], seller: { nip: '5260001246' },
          advanceEnvelope,
        },
        ...extra,
      }),
    };
  }

  function korRow(issueDate: string, extra: Record<string, unknown> = {}) {
    const correctionData = {
      invoiceType: 'correction', issueDate, parentInvoiceId: '99999999-9999-4999-8999-999999999999',
      parentInvoiceNumber: 'FV/1', correctionType: 'before_after', correctionReason: 'Zwrot towaru',
      seller: { nip: '5260001246' },
    };
    return {
      correctionData,
      row: row({
        invoice_kind: 'correction', internal_number: 'KOR/9', issue_date: issueDate, last_error_code: 'KOR_HOLD',
        fa3_data: { internalNumber: 'KOR/9', type: 'KOR', issueDate, lines: [{ ordinal: 1 }], seller: { nip: '5260001246' } },
        special_data: { correctionData },
        ...extra,
      }),
    };
  }

  function okTx(): Tx {
    const tx: Tx = { executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) };
    sendRunningStep(tx);
    return tx;
  }

  type SentEvent = { singletonKey: string; groupId: string; name: string; data: Record<string, unknown> };

  it('„Tylko uzgodnij” przy failed ZAL z otwartym wpisem sent: zdarzenie z kopertą advanceData i reconcileOnly, RPC z p_reconcile_only = true', async () => {
    const zal = zalRow(TODAY);
    m.invoice = zal.row;
    m.openSent = [{ id: 'sub-1' }];
    const tx = okTx();

    const result = await operatorRequeueAction(ID, { reconcileOnly: true });

    expect(result).toEqual({ success: true, message: OPERATOR_MESSAGES.reconcileQueued });
    const event = m.send.mock.calls[0]![0] as SentEvent;
    expect(event).toMatchObject({ groupId: TENANT, singletonKey: ID, name: 'invoice/submit.requested' });
    expect(event.data).toMatchObject({
      tenantId: TENANT, invoiceId: ID, nip: '5260001246', environment: 'test', reconcileOnly: true,
    });
    expect(event.data.advanceData).toEqual(zal.advanceEnvelope);
    expect(event.data).not.toHaveProperty('correctionData');
    expect(event.data.sendAttemptId).toMatch(UUID);
    const [, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([ID, TENANT, event.data.sendAttemptId, OPERATOR.userId, true]);
    expect(values[4]).toBe(true);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.operator_reconcile',
      metadata: expect.objectContaining({ sendAttemptId: event.data.sendAttemptId }),
    }));
  });

  it.each([
    ['ZAL w dniu wystawienia (KSEF_UNAVAILABLE)', () => zalRow(TODAY), 'advanceData'],
    ['KOR na TEST po hamulcu (KOR_HOLD)', () => korRow(TODAY), 'correctionData'],
  ] as const)('„Wyślij ponownie”: %s → pełna wysyłka z danymi z kopii, bez reconcileOnly', async (_l, make, key) => {
    const doc = make();
    m.invoice = doc.row;
    const tx = okTx();

    const result = await operatorRequeueAction(ID, { reconcileOnly: false });

    expect(result).toEqual({ success: true, message: OPERATOR_MESSAGES.requeued });
    const event = m.send.mock.calls[0]![0] as SentEvent;
    expect(event.data[key]).toEqual('advanceEnvelope' in doc ? doc.advanceEnvelope : doc.correctionData);
    expect(event.data).not.toHaveProperty('reconcileOnly');
    const [, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([ID, TENANT, event.data.sendAttemptId, OPERATOR.userId, false]);
  });

  it('KSeF produkcyjny: korekta z danymi po KOR_HOLD — „Wyślij ponownie” odmówione powodem hamulca korekt, bez zlecenia', async () => {
    m.env.mockReturnValue('production');
    m.invoice = korRow(TODAY).row;
    okTx();

    const result = await operatorRequeueAction(ID, { reconcileOnly: false });

    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: operatorKindHeldMessage('correction') });
  });

  it.each([
    ['A5: KSeF produkcyjny, korekta z danymi → KOR_HOLD (hold)', (): Record<string, unknown> => { m.env.mockReturnValue('production'); return korRow(TODAY).row; }, 'KOR_HOLD', 'hold', (): string => operatorKindHeldMessage('correction')],
    ['A5: ZAL z wczorajszą datą → ISSUE_DATE_PASSED (terminal)', (): Record<string, unknown> => zalRow(YESTERDAY).row, 'ISSUE_DATE_PASSED', 'terminal', (): string => operatorIssueDateMessage('advance')],
  ] as const)('%s — odmowa w dzienniku prób', async (_l, make, code, errorClass, message) => {
    m.invoice = make();
    okTx();

    const result = await operatorRequeueAction(ID, { reconcileOnly: false });

    expect(result).toEqual({ success: false, error: message() });
    expect(m.attempts).toEqual([expect.objectContaining({
      tenant_id: TENANT, invoice_id: ID, user_id: OPERATOR.userId, status: 'refused', stage: 'enqueue',
      error_code: code, error_class: errorClass, error_message: sendAttemptMessage(message()),
    })]);
  });

  it('ZAL z wczorajszą datą wystawienia: „Wyślij ponownie” odmówione (decyzja b), „Tylko uzgodnij” przy otwartym wpisie sent zlecone', async () => {
    const zal = zalRow(YESTERDAY);
    m.invoice = zal.row;
    const tx = okTx();

    const refused = await operatorRequeueAction(ID, { reconcileOnly: false });
    const sendsAfterRefusal = m.send.mock.calls.length;
    m.openSent = [{ id: 'sub-1' }];
    const reconciled = await operatorRequeueAction(ID, { reconcileOnly: true });

    expect(sendsAfterRefusal).toBe(0);
    expect(reconciled).toEqual({ success: true, message: OPERATOR_MESSAGES.reconcileQueued });
    const event = m.send.mock.calls[0]![0] as SentEvent;
    expect(event.data).toMatchObject({ reconcileOnly: true, advanceData: zal.advanceEnvelope });
    const [, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(values[4]).toBe(true);
    expect(refused).toEqual({ success: false, error: operatorIssueDateMessage('advance') });
  });

  it('ISSUE_DATE_PASSED (ZAL z danymi, wczorajsza data) z otwartym zamiarem intent: „Tylko uzgodnij” zlecone — uzgodnienie nie patrzy na datę', async () => {
    m.invoice = zalRow(YESTERDAY, { last_error_code: 'ISSUE_DATE_PASSED' }).row;
    m.openSent = [{ id: 'sub-1', status: 'intent' }];
    const tx = okTx();

    const result = await operatorRequeueAction(ID, { reconcileOnly: true });

    expect(result).toEqual({ success: true, message: OPERATOR_MESSAGES.reconcileQueued });
    const [, values] = tx.executeSql.mock.calls[0] as [string, unknown[]];
    expect(values[4]).toBe(true);
  });

  it('„Tylko uzgodnij” szkicu z otwartym zamiarem intent: odmowa jak przycisk (tylko failed / rejected), bez zlecenia', async () => {
    m.invoice = row({ ksef_status: 'draft', last_error_code: null });
    m.openSent = [{ id: 'sub-1', status: 'intent' }];
    okTx();

    const result = await operatorRequeueAction(ID, { reconcileOnly: true });

    expect(m.send).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: OPERATOR_MESSAGES.notFailedOrRejected });
  });

  it('KSEF_ENV nieustawione (configuredKsefEnvironment → null): odmowa obu trybów, także dla zwykłej faktury, bez zlecenia', async () => {
    m.env.mockReturnValue(null);
    okTx();

    const requeue = await operatorRequeueAction(ID, { reconcileOnly: false });
    m.openSent = [{ id: 'sub-1' }];
    const reconcile = await operatorRequeueAction(ID, { reconcileOnly: true });

    expect(m.send).not.toHaveBeenCalled();
    expect(OPERATOR_MESSAGES).toHaveProperty('envUnknown');
    expect(requeue).toEqual({ success: false, error: OPERATOR_MESSAGES.envUnknown });
    expect(reconcile).toEqual({ success: false, error: OPERATOR_MESSAGES.envUnknown });
  });

  it('odczyt wiersza pobiera kolumny kontraktu KSEF_RESEND_SOURCE_COLUMNS, każdą raz', async () => {
    okTx();
    await operatorRequeueAction(ID, { reconcileOnly: false });

    const invoiceSelect = m.selects.find((s) => s.table === 'invoices')?.columns ?? '';
    expect(typeof KSEF_RESEND_SOURCE_COLUMNS).toBe('string');
    expect(invoiceSelect).toContain(KSEF_RESEND_SOURCE_COLUMNS);
    const columns = topLevelColumns(invoiceSelect);
    expect(new Set(columns).size).toBe(columns.length);
  });
});

/**
 * A5, luka „odmowy operatora”: każda odmowa „Wyślij ponownie” / „Tylko
 * uzgodnij” po odczycie faktury zostawia wiersz `refused` / `enqueue`
 * w dzienniku prób — z kodem (katalog `ksef_error_codes`, gdy znaczy to samo;
 * odmowa z powodu klasy błędu faktury: jej kod), klasą z katalogu i operatorem
 * w `user_id`, jak odmowa klienta przed kolejką (`ksef-submit-enqueue.ts`).
 * Odpowiedź dla operatora bez zmian; zapis fail-open.
 */
describe('A5: odmowy operatora w dzienniku prób (ksef_send_attempts)', () => {
  const refusedRow = (code: string, errorClass: string | null, message: string) => ({
    tenant_id: TENANT, invoice_id: ID, user_id: OPERATOR.userId, ksef_environment: m.env(),
    status: 'refused', stage: 'enqueue', error_code: code, error_class: errorClass,
    error_message: sendAttemptMessage(message), retryable: false,
    started_at: NOW.replace('Z', '.000Z'), finished_at: NOW.replace('Z', '.000Z'),
  });

  it.each([
    ['wyłącznik wysyłek', (): void => { m.paused.mockResolvedValue(true); }, false, 'KSEF_PAUSED', 'hold', (): string => OPERATOR_MESSAGES.paused],
    ['nieczytelny wyłącznik (fail-closed)', (): void => { m.paused.mockRejectedValue(new Error('db')); }, false, 'PAUSE_UNKNOWN', null, (): string => OPERATOR_MESSAGES.pausedUnknown],
    ['cudzy duplikat 440', (): void => { m.invoice = row({ last_error_code: 'KSEF_DUPLICATE_RECONCILE' }); }, false, 'KSEF_DUPLICATE_RECONCILE', 'reconcile', (): string => OPERATOR_MESSAGES.duplicateRequeue],
    ['błąd treści', (): void => { m.invoice = row({ last_error_code: 'XSD_INVALID' }); }, false, 'XSD_INVALID', 'terminal', (): string => OPERATOR_MESSAGES.terminal],
    ['inne środowisko', (): void => { m.invoice = row({ last_error_code: 'ENV_MISMATCH' }); }, false, 'ENV_MISMATCH', 'terminal', (): string => OPERATOR_MESSAGES.envMismatchRequeue],
    ['stary dokument specjalny bez danych', (): void => { m.invoice = row({ invoice_kind: 'correction' }); }, false, 'SEND_DATA_MISSING', null, (): string => operatorLegacyDataMessage('correction')],
    ['zwykła bez pozycji', (): void => { m.invoice = row({ fa3_data: { internalNumber: 'FV/9' } }); }, false, 'SEND_DATA_MISSING', null, (): string => OPERATOR_MESSAGES.incomplete],
    ['stan inny niż failed (np. drugie kliknięcie po zleceniu)', (): void => { m.invoice = row({ ksef_status: 'queued' }); }, false, 'STATUS_NOT_ALLOWED', null, (): string => OPERATOR_MESSAGES.onlyFailed],
    ['odrzucona treść', (): void => { m.invoice = row({ ksef_status: 'rejected', last_error_code: null }); }, false, 'STATUS_NOT_ALLOWED', null, (): string => OPERATOR_MESSAGES.rejectedToDraft],
    ['„Tylko uzgodnij” bez otwartego wpisu', (): void => {}, true, 'NO_OPEN_SUBMISSION', null, (): string => OPERATOR_MESSAGES.noOpenSent],
    ['„Tylko uzgodnij” szkicu', (): void => { m.invoice = row({ ksef_status: 'draft', last_error_code: null }); }, true, 'STATUS_NOT_ALLOWED', null, (): string => OPERATOR_MESSAGES.notFailedOrRejected],
    ['KSEF_ENV nieustawione', (): void => { m.env.mockReturnValue(null); }, false, 'ENV_UNKNOWN', null, (): string => OPERATOR_MESSAGES.envUnknown],
  ] as const)('%s → wiersz refused z kodem, odpowiedź bez zmian', async (_l, arrange, reconcileOnly, code, errorClass, message) => {
    arrange();

    const result = await operatorRequeueAction(ID, { reconcileOnly });

    expect(result).toEqual({ success: false, error: message() });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.attempts).toEqual([refusedRow(code, errorClass, message())]);
  });

  it('firma i faktura bez NIP-u → NO_NIP', async () => {
    m.invoice = row({ tenants: { nip: null }, fa3_data: { internalNumber: 'FV/9', type: 'VAT', lines: [{ ordinal: 1 }], seller: {} } });

    const result = await operatorRequeueAction(ID, { reconcileOnly: false });

    expect(result).toEqual({ success: false, error: OPERATOR_MESSAGES.noNip });
    expect(m.attempts).toEqual([refusedRow('NO_NIP', null, OPERATOR_MESSAGES.noNip)]);
  });

  it('odmowa przy zleceniu (RPC P0001 w transakcji) → ENQUEUE_REFUSED z komunikatem RPC, bez audytu', async () => {
    const tx: Tx = { executeSql: vi.fn(async () => { throw Object.assign(new Error('Błąd treści dokumentu (XSD_INVALID) — wróć do szkicu i popraw'), { code: 'P0001' }); }) };
    sendRunningStep(tx);

    const result = await operatorRequeueAction(ID, { reconcileOnly: false });

    expect(result).toEqual({ success: false, error: 'Błąd treści dokumentu (XSD_INVALID) — wróć do szkicu i popraw' });
    expect(m.audit).not.toHaveBeenCalled();
    expect(m.attempts).toEqual([refusedRow('ENQUEUE_REFUSED', null, 'Błąd treści dokumentu (XSD_INVALID) — wróć do szkicu i popraw')]);
  });

  it('wyjątek przy decyzji (odczyt ksef_submissions pada) → ENQUEUE_ERROR i ten sam wyjątek dalej', async () => {
    const base = fakeAdminClient();
    const failing = {
      select: () => failing, eq: () => failing, in: () => failing, limit: () => failing,
      then: (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: 'db down' } }),
    };
    m.admin.mockImplementation(() => ({ ...base, from: (t: string) => (t === 'ksef_submissions' ? failing : base.from(t)) }));

    await expect(operatorRequeueAction(ID, { reconcileOnly: true })).rejects.toThrow('ksef_submissions: db down');

    expect(m.attempts).toEqual([refusedRow('ENQUEUE_ERROR', null, 'Error: ksef_submissions: db down')]);
  });

  it('udane zlecenie i brak faktury → bez wiersza refused', async () => {
    sendRunningStep({ executeSql: vi.fn(async () => ({ rows: [{ id: ID }], rowCount: 1 })) });
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: true, message: OPERATOR_MESSAGES.requeued });
    m.invoice = null;
    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: false, error: OPERATOR_MESSAGES.notFound });
    expect(m.attempts).toEqual([]);
  });

  it('zapis do dziennika pada → odpowiedź operatora bez zmian, ostrzeżenie w Sentry (fail-open)', async () => {
    m.failAttemptInsert = true;
    m.paused.mockResolvedValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(operatorRequeueAction(ID, { reconcileOnly: false })).resolves.toEqual({ success: false, error: OPERATOR_MESSAGES.paused });

    expect(m.attempts).toEqual([]);
    expect(m.captureMessage).toHaveBeenCalledWith('KSeF: dziennik prób wysyłki — zapis odmowy nieudany', expect.objectContaining({
      extra: { invoiceId: ID, code: 'KSEF_PAUSED' },
    }));
    warn.mockRestore();
  });

  // Po recenzji: ROZ (hamulec we wszystkich środowiskach) i gałęzie „Tylko uzgodnij” — osobna funkcja polityki.
  const rozRow = () => row({
    invoice_kind: 'final', internal_number: 'ROZ/9', last_error_code: 'ROZ_HOLD_RECONCILE',
    special_data: { finalData: { invoiceType: 'final', issueDate: TODAY }, finalAdvanceSettlementRows: [{ id: 'x' }] },
    fa3_data: { internalNumber: 'ROZ/9', type: 'ROZ', issueDate: TODAY, lines: [{ ordinal: 1 }], seller: { nip: '5260001246' } },
  });

  it.each([
    ['ROZ z danymi, „Wyślij ponownie”', (): void => { m.invoice = rozRow(); }, false, 'ROZ_HOLD_RECONCILE', 'hold', (): string => operatorKindHeldMessage('final')],
    ['ROZ z danymi, „Tylko uzgodnij”', (): void => { m.invoice = rozRow(); m.openSent = [{ id: 'sub-1' }]; }, true, 'ROZ_HOLD_RECONCILE', 'hold', (): string => operatorKindHeldMessage('final')],
    ['„Tylko uzgodnij” przy KSEF_ENV nieustawionym', (): void => { m.env.mockReturnValue(null); m.openSent = [{ id: 'sub-1' }]; }, true, 'ENV_UNKNOWN', null, (): string => OPERATOR_MESSAGES.envUnknown],
    ['„Tylko uzgodnij” korekty bez special_data', (): void => { m.invoice = row({ invoice_kind: 'correction' }); m.openSent = [{ id: 'sub-1' }]; }, true, 'SEND_DATA_MISSING', null, (): string => operatorLegacyDataMessage('correction')],
  ] as const)('%s → wiersz refused z kodem', async (_l, arrange, reconcileOnly, code, errorClass, message) => {
    arrange();

    const result = await operatorRequeueAction(ID, { reconcileOnly });

    expect(result).toEqual({ success: false, error: message() });
    expect(m.attempts).toEqual([refusedRow(code, errorClass, message())]);
  });

  it('północ między decyzją a zdarzeniem (ZAL) → ISSUE_DATE_PASSED z budowniczego zdarzenia, bez zlecenia', async () => {
    vi.setSystemTime(new Date('2026-10-03T21:59:59Z'));
    m.invoice = row({
      invoice_kind: 'advance', internal_number: 'ZAL/9', last_error_code: 'KSEF_UNAVAILABLE',
      fa3_data: {
        internalNumber: 'ZAL/9', type: 'ZAL', issueDate: TODAY, lines: [{ ordinal: 1 }], seller: { nip: '5260001246' },
        advanceEnvelope: { invoiceType: 'advance', issueDate: TODAY },
      },
    });
    // Odczyt wyłącznika to jedyne okno między faktami decyzji a budowniczym zdarzenia.
    m.paused.mockImplementation(async () => { vi.setSystemTime(new Date('2026-10-03T22:00:01Z')); return false; });

    const result = await operatorRequeueAction(ID, { reconcileOnly: false });

    expect(result).toEqual({ success: false, error: operatorIssueDateMessage('advance') });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.attempts).toEqual([expect.objectContaining({
      status: 'refused', stage: 'enqueue', error_code: 'ISSUE_DATE_PASSED', error_class: 'terminal',
      error_message: sendAttemptMessage(operatorIssueDateMessage('advance')),
    })]);
  });

  it('operatorRequeueEventRefusal: powód budowniczego → kod i komunikat (jak przycisk)', () => {
    expect(operatorRequeueEventRefusal('missing-special-data', 'correction')).toEqual({ code: 'SEND_DATA_MISSING', reason: operatorLegacyDataMessage('correction') });
    expect(operatorRequeueEventRefusal('incomplete', 'regular')).toEqual({ code: 'SEND_DATA_MISSING', reason: OPERATOR_MESSAGES.incomplete });
    expect(operatorRequeueEventRefusal('kind-held', 'correction')).toEqual({ code: 'KOR_HOLD', reason: operatorKindHeldMessage('correction') });
    expect(operatorRequeueEventRefusal('kind-held', 'final')).toEqual({ code: 'ROZ_HOLD_RECONCILE', reason: operatorKindHeldMessage('final') });
    // Zaliczka jest wstrzymana tylko przy nieznanym środowisku — kod jak komunikat.
    expect(operatorRequeueEventRefusal('kind-held', 'advance')).toEqual({ code: 'ENV_UNKNOWN', reason: OPERATOR_MESSAGES.envUnknown });
    expect(operatorRequeueEventRefusal('issue-date', 'advance')).toEqual({ code: 'ISSUE_DATE_PASSED', reason: operatorIssueDateMessage('advance') });
    expect(operatorRequeueEventRefusal('no-nip', 'regular')).toEqual({ code: 'NO_NIP', reason: OPERATOR_MESSAGES.noNip });
  });
});

describe('operatorResetAction', () => {
  it('reset_ksef_send z firmą i aktorem = operator, audyt operator_reset, odświeżenie', async () => {
    await expect(operatorResetAction(ID)).resolves.toEqual({ success: true, message: OPERATOR_MESSAGES.reset });
    expect(m.rpc).toHaveBeenCalledWith('reset_ksef_send', { p_invoice_id: ID, p_tenant_id: TENANT, p_actor_user_id: OPERATOR.userId });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.operator_reset', userId: OPERATOR.userId }));
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${ID}`);
  });

  it('odmowa RPC (dowód kontaktu) wraca komunikatem RPC', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Faktura mogła dotrzeć do KSeF — wymaga uzgodnienia, nie powrotu do szkicu' } });
    await expect(operatorResetAction(ID)).resolves.toEqual({
      success: false, error: 'Faktura mogła dotrzeć do KSeF — wymaga uzgodnienia, nie powrotu do szkicu',
    });
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe('autoryzacja operatora przed każdą operacją', () => {
  it.each([
    ['requeue', () => operatorRequeueAction(ID, { reconcileOnly: false })],
    ['reset', () => operatorResetAction(ID)],
  ])('%s: odmowa requireAdmin zatrzymuje wszystko przed kluczem serwisowym', async (_l, action) => {
    m.requireAdmin.mockRejectedValue(new Error('synthetic authorization denied'));
    await expect(action()).rejects.toThrow('synthetic authorization denied');
    expect(m.admin).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});

/**
 * D-A4-1b-3 PR B (decyzje Bartosza 04.10 i 07.10.2026 (5), (7), (12); spec v3
 * §2.6.4, U13a–U13d): operator zapisuje decyzję przekazaną przez klienta
 * („Zapisz decyzję klienta”) i przypomina mu o niej („Przypomnij klientowi”,
 * najwyżej raz na 24 h). Prawdziwe: akcje, polityka i ładowarka faktów,
 * ślad powiadomień w `audit_logs` (atrapa bazy wyżej). Atrapy: RPC, Resend,
 * adres właściciela.
 *
 * Na f49e687 tych akcji nie ma — operator nie ma jak zapisać decyzji klienta
 * ani przypomnieć o niej. Wywołanie przez `operatorAction` daje wtedy wynik
 * bez skutków, więc asercje zachowania (RPC, audyt, e-mail, teksty) są czerwone.
 */
type DuplicateChoice = 'same_sale' | 'other_sale';
interface DecideInput {
  choice: DuplicateChoice;
  note: string;
  originalKsefNumber: string;
  originalSha256: string;
  confirmed: boolean;
}
const NO_OPERATOR_PATH: OperatorActionResult = { success: false, error: 'brak akcji operatora' };
function operatorAction<A extends unknown[]>(name: string): (...args: A) => Promise<OperatorActionResult> {
  return async (...args: A) => {
    const fn: unknown = Reflect.get(operatorActions, name);
    return typeof fn === 'function' ? (fn as (...a: A) => Promise<OperatorActionResult>)(...args) : NO_OPERATOR_PATH;
  };
}
const decide = operatorAction<[string, DecideInput]>('operatorDecideDuplicateAction');
const remind = operatorAction<[string]>('operatorRemindDuplicateDecisionAction');

const K = '5260001246-20261001-0100A0B0C0D0-1A';
const K2 = '5260001246-20260915-0200A0B0C0D0-2B';
const SHA = 'bb'.repeat(32);
const NOTE = 'e-mail od właściciela 03.10, Jan Kowalski';
const NOTICE_ACTION = 'invoice.ksef_duplicate_decision_notified';
const OWNER_EMAIL = 'owner@example.test';
/** 2.11.D — teksty operatora (bez przeglądu prawnika). */
const T_NOTE = 'Notatka: co najmniej 10 znaków — kanał, data, osoba.';
const T_CONFIRM = 'Zaznacz potwierdzenie klienta („Rozumiem skutki”) i zapisz jeszcze raz.';
const T_SUCCESS = (label: string) => `Zapisano decyzję klienta (${label}). Dokument wrócił do szkicu jako wycofany.`;
const T_NOT_PENDING = 'Faktura nie czeka na decyzję klienta (stan albo kod inny niż failed / KSEF_DUPLICATE_RECONCILE).';
const T_REMIND_NO_EMAIL = 'Firma nie ma adresu e-mail właściciela — skontaktuj się z klientem innym kanałem (runbook KSEF_DUPLICATE_RECONCILE).';
const T_REMIND_NOT_RECORDED = 'Przypomnienie wysłane, ale nie zapisaliśmy śladu w audit_logs — nie wysyłaj go ponownie przez 24 h (klucz Resend chroni tylko dobę).';
const T_REMIND_TOO_SOON = /^Ostatnie powiadomienie: .+ — przypomnienie najwcześniej 24 h później\.$/;

/** Dane oryginału z PR A (00144) — no-own-file z kompletem danych, sprawdzone na KSeF TEST. */
const duplicateCheck = (extra: Record<string, unknown> = {}) => ({
  v: 1, env: 'test', checkedAt: '2026-10-03T08:00:00.000Z', reason: 'no-own-file', sha256: SHA,
  archivePath: `${TENANT}/ksef-import/${K}.xml`, sizeBytes: 1200, sameContentExceptHeader: null, ownHistory: false,
  acquiredAt: '2026-10-01T09:00:00.000Z', httpStatus: null, knownInvoice: null, recheck: null,
  summary: { systemInfo: 'Inny Program 2.0', number: 'FV/9', issueDate: TODAY, buyerNip: '5252241585', buyerName: 'Klient', gross: '123.00', currency: 'PLN' },
  ...extra,
});
/** Znacznik 440 (otwarty wpis `sent`) i starszy wpis bez znacznika. */
function duplicateRows(check: Record<string, unknown> = duplicateCheck()) {
  return [
    {
      id: 'sub-marker', tenant_id: TENANT, invoice_id: ID, status: 'sent', error_code: '440',
      session_reference_number: 'SES-OWN-1', invoice_reference_number: 'REF-1', request_payload_hash: 'aa'.repeat(32),
      response_ksef_number: null, original_ksef_number: K, original_session_reference_number: 'SES-ORIG-1',
      original_check: check, attempted_at: '2026-10-03T07:00:00.000Z', completed_at: null,
    },
    {
      id: 'sub-older', tenant_id: TENANT, invoice_id: ID, status: 'abandoned', error_code: 'NOT_IN_SESSION',
      session_reference_number: 'SES-OWN-0', invoice_reference_number: null, request_payload_hash: 'cc'.repeat(32),
      response_ksef_number: null, original_ksef_number: null, original_session_reference_number: null,
      original_check: null, attempted_at: '2026-10-02T07:00:00.000Z', completed_at: '2026-10-02T07:05:00.000Z',
    },
  ];
}
/** Faktura czekająca na klienta: failed KSEF_DUPLICATE_RECONCILE; ten sam nabywca, ta sama kwota co w KSeF. */
const pendingRow = (extra: Record<string, unknown> = {}) => row({
  ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE', ksef_number: null, stripe_invoice_id: null,
  offline_idempotency_key: null, offline_qr_offline: null, offline_qr_certyfikat: null, paid_amount: 0,
  buyer_nip: '5252241585', buyer_data: { name: 'Klient', nip: '5252241585' }, gross_total: 123, currency: 'PLN',
  ...extra,
});
const decideInput = (extra: Partial<DecideInput> = {}): DecideInput => ({
  choice: 'same_sale', note: NOTE, originalKsefNumber: K, originalSha256: SHA, confirmed: true, ...extra,
});
const notice = (createdAt: string, ksefNumber = K) => ({
  id: `notice-${createdAt}`, tenant_id: TENANT, user_id: null, action: NOTICE_ACTION, entity_type: 'invoice', entity_id: ID,
  metadata: {
    original_ksef_number: ksefNumber, via: 'auto', idempotency_key: `ksef-duplicate-decision/${ID}/${ksefNumber}`,
    emailed: true, push_sent: 1, reminder: null, operator: null, source: 'system',
  },
  created_at: createdAt,
});
const notices = () => m.auditLogs.filter((r) => r.action === NOTICE_ACTION);
const rpcCallsOf = (fn: string) => m.rpc.mock.calls.filter(([name]) => name === fn);

describe('D-A4-1b-3 PR B: decyzja klienta i przypomnienie — akcje operatora', () => {
  let blocker: string | null;
  let decideReply: { data: unknown; error: { code: string; message: string } | null };

  beforeEach(() => {
    m.invoice = pendingRow();
    m.openSent = duplicateRows();
    blocker = null;
    decideReply = {
      data: {
        invoice_id: ID, internal_number: 'FV/9', original_ksef_number: K, choice: 'same_sale', via: 'operator',
        reason: 'no-own-file', already_decided: false, submissions_closed: 1,
      },
      error: null,
    };
    m.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'decide_ksef_duplicate') return decideReply;
      if (fn === 'ksef_duplicate_decision_blocker') return { data: blocker, error: null };
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    });
  });

  describe('U13a: zapis decyzji — autoryzacja, notatka, „Rozumiem skutki” po stronie serwera', () => {
    it.each([
      ['Zapisz decyzję klienta', () => decide(ID, decideInput())],
      ['Przypomnij klientowi (U13c)', () => remind(ID)],
    ])('%s: odmowa requireAdmin zatrzymuje wszystko przed kluczem serwisowym', async (_l, action) => {
      m.requireAdmin.mockRejectedValue(new Error('synthetic authorization denied'));

      await expect(action()).rejects.toThrow('synthetic authorization denied');

      expect(m.admin).not.toHaveBeenCalled();
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    });

    it.each([
      ['za krótka', 'ok'],
      ['same spacje wokół krótkiej', '    ok tel   '],
    ])('notatka %s → komunikat o kanale, dacie i osobie; bez RPC', async (_l, note) => {
      const result = await decide(ID, decideInput({ note }));

      expect(result).toEqual({ success: false, error: T_NOTE });
      expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
      expect(m.audit).not.toHaveBeenCalled();
      expect(m.requireAdmin).toHaveBeenCalled();
    });

    it('„inna sprzedaż” przy tym samym NIP nabywcy bez potwierdzenia klienta → OPERATOR_CONFIRM; bez RPC (decyzja 7)', async () => {
      const result = await decide(ID, decideInput({ choice: 'other_sale', confirmed: false }));

      expect(result).toEqual({ success: false, error: T_CONFIRM });
      expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
    });
  });

  describe('U13b: zapis decyzji — RPC decide_ksef_duplicate z aktorem = operator', () => {
    it.each([
      ['same_sale', 'ta sama sprzedaż'],
      ['other_sale', 'inna sprzedaż'],
    ] as const)('%s: RPC z p_via operator, notatką i środowiskiem; audyt invoice.operator_duplicate_decision; odświeżenie', async (choice, label) => {
      decideReply = { data: { ...(decideReply.data as Record<string, unknown>), choice }, error: null };

      const result = await decide(ID, decideInput({ choice }));

      expect(result).toEqual({ success: true, message: T_SUCCESS(label) });
      expect(m.rpc).toHaveBeenCalledWith('decide_ksef_duplicate', {
        p_invoice_id: ID, p_tenant_id: TENANT, p_actor_user_id: OPERATOR.userId, p_choice: choice, p_via: 'operator',
        p_original_ksef_number: K, p_original_sha256: SHA, p_env: 'test', p_note: NOTE,
      });
      expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'invoice.operator_duplicate_decision', tenantId: TENANT, entityId: ID,
        metadata: expect.objectContaining({
          operator: OPERATOR.email, internalNumber: 'FV/9', choice, note: NOTE, originalKsefNumber: K, reason: 'no-own-file',
        }),
      }));
      expect(m.revalidate).toHaveBeenCalledWith(`/admin/ksef/${ID}`);
      expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${ID}`);
    });

    it('powtórzenie tej samej decyzji (already_decided) → sukces bez drugiego audytu', async () => {
      decideReply = { data: { ...(decideReply.data as Record<string, unknown>), already_decided: true }, error: null };

      const result = await decide(ID, decideInput());

      expect(result).toEqual({ success: true, message: T_SUCCESS('ta sama sprzedaż') });
      expect(rpcCallsOf('decide_ksef_duplicate')).toHaveLength(1);
      expect(m.audit).not.toHaveBeenCalled();
    });

    it.each([
      ['wpłaty na dokumencie (paid_amount)', () => { m.invoice = pendingRow({ paid_amount: 100 }); }, 'decyzja zablokowana'],
      ['dane oryginału z innego środowiska KSeF', () => { m.openSent = duplicateRows(duplicateCheck({ env: 'production' })); }, 'original_check.env „production” ≠ KSEF_ENV „test”'],
      // PR C: znacznik faktflow-original z SystemInfo FaktWay, ale bez oceny pliku (sprzed 00156) to `recheck-needed`
      // (lustro kroku 11c) — „Zapisz decyzję klienta” odmawia tekstem `recheckPending(null, null)`; operator czyta
      // blokadę SQL (`{ sqlBlocker: 'admin' }`), ale bez RPC decyzji i bez audytu. Wcześniej: „Powód faktflow-original”.
      ['powód faktflow-original z SystemInfo FaktWay, bez oceny pliku (PR C: recheck-needed)', () => { m.openSent = duplicateRows(duplicateCheck({ reason: 'faktflow-original', summary: { ...duplicateCheck().summary, systemInfo: 'KSeF SaaS v1.0' } })); }, OPERATOR_DUPLICATE_MESSAGES.recheckPending(null, null)],
    ])('%s → powód wyłączenia przycisku dla operatora; bez RPC i audytu', async (_l, arrange, reason) => {
      arrange();

      const result = await decide(ID, decideInput());

      expect(result.success).toBe(false);
      expect(result.success ? '' : result.error).toContain(reason);
      expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
      expect(rpcCallsOf('decide_ksef_duplicate_original')).toEqual([]);
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('odmowa RPC (P0001, np. wpłata niewidoczna w paid_amount) → komunikat RPC bez zmian, bez audytu', async () => {
      const refusal = 'Na dokumencie FV/9 są zapisane wpłaty — decyzji nie zapiszemy, dopóki wpłaty są przy tym dokumencie. W FaktWay nie zmienisz ich sam: napisz do nas: pomoc@faktway.pl, podając numer dokumentu — ustalimy, przy której fakturze je zapisać. Nie wystawiaj go ponownie.';
      decideReply = { data: null, error: { code: 'P0001', message: refusal } };

      const result = await decide(ID, decideInput());

      expect(rpcCallsOf('decide_ksef_duplicate')).toHaveLength(1);
      expect(result).toEqual({ success: false, error: refusal });
      expect(m.audit).not.toHaveBeenCalled();
      expect(m.captureException).not.toHaveBeenCalled();
    });
  });

  /**
   * Przegląd PR B (#3): błąd RPC inny niż P0001 dawał tekst resetu („Nie udało
   * się przywrócić szkicu”) bez Sentry — akcja nie przywraca szkicu, więc to
   * zła rada. Notatkę liczymy w znakach jak `length()` w bazie, nie
   * w jednostkach UTF-16.
   */
  describe('U13b: błąd RPC decide_ksef_duplicate — tekst decyzji, nie resetu szkicu', () => {
    it('P0002 (faktura nie tej firmy) → „Nie ma takiej faktury.” operatora, bez audytu', async () => {
      decideReply = { data: null, error: { code: 'P0002', message: 'Faktura nie należy do tej firmy' } };

      const result = await decide(ID, decideInput());

      expect(result).toEqual({ success: false, error: OPERATOR_MESSAGES.notFound });
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('22023 NOTE (baza liczy notatkę krócej niż akcja) → tekst o notatce, bez Sentry i audytu', async () => {
      decideReply = { data: null, error: { code: '22023', message: fillExpected('NOTE') } };

      const result = await decide(ID, decideInput());

      expect(rpcCallsOf('decide_ksef_duplicate')).toHaveLength(1);
      expect(result).toEqual({ success: false, error: T_NOTE });
      expect(m.captureException).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    });

    it.each([
      ['XX000 (nieznana blokada — rozjazd TS↔SQL)', { code: 'XX000', message: 'Unknown KSeF duplicate decision blocker: nowy-powod' }],
      ['42501 (rola bazy)', { code: '42501', message: 'KSeF duplicate decision is server-managed' }],
      ['22023 argumentu, nie notatki', { code: '22023', message: 'KSeF duplicate decision requires a lowercase hex SHA-256 of the original' }],
      ['transport (fetch failed, bez kodu)', { code: '', message: 'TypeError: fetch failed' }],
    ])('%s → ogólny tekst decyzji i Sentry.captureException z kontekstem; bez audytu', async (_l, error) => {
      decideReply = { data: null, error };

      const result = await decide(ID, decideInput());

      expect(result).toEqual({ success: false, error: CLIENT.generic });
      expect(m.captureException).toHaveBeenCalledTimes(1);
      expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
        tags: expect.objectContaining({ area: 'ksef.duplicate-decision' }),
        extra: expect.objectContaining({ tenantId: TENANT, invoiceId: ID, choice: 'same_sale', code: error.code }),
      }));
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('notatka „📧📞 Jan K” — 10 jednostek UTF-16, ale 8 znaków: tekst o notatce bez RPC (jak length() w bazie)', async () => {
      const note = '📧📞 Jan K';
      expect(note.length).toBe(10);
      expect([...note].length).toBe(8);

      const result = await decide(ID, decideInput({ note }));

      expect(result).toEqual({ success: false, error: T_NOTE });
      expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
      expect(m.audit).not.toHaveBeenCalled();
    });
  });

  /**
   * Przegląd PR B (#5): szkic już wycofany decyzją — akcja odpowiada sama, bez
   * RPC (widok `decided` z wpisu `number_taken`, nie atrapa odpowiedzi RPC).
   * Ten sam wybór o tym samym K to sukces; inny wybór albo inny K — ALREADY
   * z ZAPISANYM wyborem (ten sam tekst co RPC, krok 2), nigdy „Zapisano”.
   */
  describe('U13b: decyzja zapisana wcześniej (widok decided) — akcja odpowiada bez RPC', () => {
    /** Szkic wycofany decyzją klienta „ta sama sprzedaż” o K (wpis `number_taken` z `original_check.decision`). */
    function decidedSame() {
      m.invoice = pendingRow({ ksef_status: 'draft', last_error_code: null });
      m.openSent = [{
        ...duplicateRows()[0]!,
        id: 'sub-decided', status: 'number_taken', error_code: 'NUMBER_TAKEN', completed_at: '2026-10-03T09:00:00.000Z',
        original_check: {
          ...duplicateCheck(),
          decision: { choice: 'same_sale', via: 'client', at: '2026-10-03T09:00:00.000Z', reason: 'no-own-file', env: 'test' },
        },
      }];
    }

    it.each([
      ['inny wybór niż zapisany („inna sprzedaż” przy zapisanej „tej samej”)', { choice: 'other_sale' as const }],
      ['ten sam wybór, ale inny numer KSeF oryginału niż zapisany', { originalKsefNumber: K2 }],
    ])('%s → ALREADY z zapisanym wyborem; bez RPC i audytu', async (_l, patch) => {
      decidedSame();

      const result = await decide(ID, decideInput(patch));

      expect(result).toEqual({ success: false, error: fillExpected('ALREADY', 'FV/9', 'ta sama sprzedaż') });
      expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
      expect(m.audit).not.toHaveBeenCalled();
    });

    it('ta sama decyzja o tym samym K (zgubiona odpowiedź, drugie kliknięcie) → sukces bez RPC i audytu', async () => {
      decidedSame();

      const result = await decide(ID, decideInput());

      expect(result).toEqual({ success: true, message: T_SUCCESS('ta sama sprzedaż') });
      expect(rpcCallsOf('decide_ksef_duplicate')).toEqual([]);
      expect(m.audit).not.toHaveBeenCalled();
    });
  });

  describe('U13c: „Przypomnij klientowi” — kiedy nie wysyłamy', () => {
    it('faktura nie czeka na decyzję (szkic) → powód notPending, bez e-maila i śladu', async () => {
      m.invoice = pendingRow({ ksef_status: 'draft', last_error_code: null });

      const result = await remind(ID);

      expect(result).toEqual({ success: false, error: T_NOT_PENDING });
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    });

    it('blokada z bazy NOT NULL (wpłata, której panel nie widzi) → powód wyłączenia, bez e-maila', async () => {
      blocker = 'payments';

      const result = await remind(ID);

      expect(result.success).toBe(false);
      expect(result.success ? '' : result.error).toContain('decyzja zablokowana');
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
      // Odczyt blokady z bazy jest autorytatywny (obejmuje wiersze payments).
      expect(rpcCallsOf('ksef_duplicate_decision_blocker')).toHaveLength(1);
    });

    it('ostatnie powiadomienie o K młodsze niż 24 h → REMIND_TOO_SOON, bez e-maila (decyzja 12)', async () => {
      m.auditLogs = [notice('2026-10-03T08:00:00.000Z')];

      const result = await remind(ID);

      expect(result.success).toBe(false);
      expect(result.success ? '' : result.error).toMatch(T_REMIND_TOO_SOON);
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(notices()).toHaveLength(1);
    });

    it('firma bez e-maila właściciela → REMIND_NO_EMAIL, bez śladu', async () => {
      m.ownerEmail.mockResolvedValue(null);

      const result = await remind(ID);

      expect(result).toEqual({ success: false, error: T_REMIND_NO_EMAIL });
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
      expect(m.ownerEmail).toHaveBeenCalledWith(TENANT);
    });

    it('chwilowy błąd odczytu adresu właściciela (baza albo GoTrue) → REMIND_READ_FAILED, nie „innym kanałem”; bez e-maila i śladu (przegląd PR B #1/#4)', async () => {
      m.ownerEmail.mockRejectedValue(new Error('Nie można odczytać e-maila właściciela firmy: Service Unavailable'));

      const result = await remind(ID);

      expect(result).toEqual({ success: false, error: OPERATOR_DUPLICATE_MESSAGES.remindReadFailed });
      expect(m.duplicateEmail).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
      expect(m.captureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('U13d: „Przypomnij klientowi” — wysyłka i ślad', () => {
    it('ostatnie powiadomienie o K sprzed 25 h (ślad o innym K się nie liczy) → jeden e-mail z kluczem przypomnienie-1 i ślad via operator', async () => {
      m.auditLogs = [notice('2026-10-02T09:00:00.000Z'), notice('2026-10-03T09:00:00.000Z', K2)];
      const key = `ksef-duplicate-decision/${ID}/${K}/przypomnienie-1`;

      const result = await remind(ID);

      expect(result).toEqual({ success: true, message: `Wysłano przypomnienie do ${OWNER_EMAIL}.` });
      expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
      expect(m.duplicateEmail).toHaveBeenCalledWith(
        OWNER_EMAIL,
        expect.objectContaining({ invoiceId: ID, invoiceNumber: 'FV/9', ksefNumber: K, reminder: true }),
        expect.objectContaining({ idempotencyKey: key }),
      );
      expect(notices()).toHaveLength(3);
      expect(notices().at(-1)).toMatchObject({
        tenant_id: TENANT, action: NOTICE_ACTION, entity_type: 'invoice', entity_id: ID,
        metadata: expect.objectContaining({
          original_ksef_number: K, via: 'operator', idempotency_key: key, emailed: true, push_sent: 0, reminder: 1,
          operator: OPERATOR.email, source: 'system',
        }),
      });
      expect(m.revalidate).toHaveBeenCalledWith(`/admin/ksef/${ID}`);
    });

    it('faktura bez żadnego powiadomienia (zaległość sprzed PR B) → pierwsze przypomnienie z kluczem przypomnienie-0', async () => {
      const result = await remind(ID);

      expect(result).toEqual({ success: true, message: `Wysłano przypomnienie do ${OWNER_EMAIL}.` });
      expect(m.duplicateEmail).toHaveBeenCalledWith(
        OWNER_EMAIL, expect.anything(), expect.objectContaining({ idempotencyKey: `ksef-duplicate-decision/${ID}/${K}/przypomnienie-0` }),
      );
      expect(notices()).toHaveLength(1);
    });

    it('zapis śladu pada po wysyłce → REMIND_SENT_NOT_RECORDED i Sentry; dokładnie jeden e-mail', async () => {
      m.failAuditInsert = true;

      const result = await remind(ID);

      expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: false, error: T_REMIND_NOT_RECORDED });
      expect(m.captureException).toHaveBeenCalled();
    });

    it('e-mail niewysłany (Resend nieskonfigurowany) → REMIND_NOT_SENT z powodem, bez śladu', async () => {
      m.duplicateEmail.mockResolvedValue({ sent: false, reason: 'not-configured' });

      const result = await remind(ID);

      expect(m.duplicateEmail).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: false, error: 'Nie wysłano przypomnienia (not-configured).' });
      expect(notices()).toEqual([]);
    });
  });
});
