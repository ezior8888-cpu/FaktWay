import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';
import type { FakeKsef, MemoryDb, Row } from './helpers/ksef-pelna-sciezka';

/**
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026 (2), (3); spec v3 §2.7.2, U5a–U5h):
 * szkic wycofany — dokument z wpisem `number_taken` w `ksef_submissions`
 * (decyzja klienta „ta sama / inna sprzedaż” albo automatyczny werdykt
 * KSEF_NUMBER_TAKEN po „Wróć do szkicu”). Numer jest zajęty w KSeF przez
 * fakturę K, więc job, który wraca do takiego szkicu (ponowienie pg-boss od
 * zera, stare zlecenie, cron), kończy się czysto: bez przejęcia, bez POST
 * i bez zapisu `failed` (inaczej I7 wznowiłby pełną wysyłkę, a KSeF
 * odpowiedziałby 440).
 *
 * Prawdziwe: runner (`runSubmitInvoice`, `onSubmitInvoiceExhausted`)
 * i `submission-log` (z `findKsefNumberTaken`, C10) nad bazą w pamięci
 * (`helpers/ksef-pelna-sciezka`); atrapy tylko dla HTTP KSeF, magazynu
 * i klienta `@/lib/supabase/server` (wiersz faktury, przejęcie 00124).
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NUMBER = 'FV 2026/10/001';
const GENERATED_AT = new Date('2026-10-01T10:00:00.000Z');
/** Numer KSeF oryginału (faktura spoza FaktWay, która zajęła numer). */
const K = '5260001246-20260928-0100A0B0C0D0-1A';
const K2 = '5260001246-20260929-0200A0B0C0D0-2B';
const CLAIMED = '2026-10-03T12:00:00.000000+00:00';

type ClaimReply = { data: unknown; error: { code?: string; message: string } | null };

const m = vi.hoisted(() => ({
  ksef: null as unknown as FakeKsef,
  mem: { db: {}, failWrite: null } as MemoryDb,
  storage: new Map<string, string>(),
  updateStatus: vi.fn(),
  captureMessage: vi.fn(),
  audit: vi.fn(),
  sendEvent: vi.fn(),
  /** Wiersz faktury czytany przez `@/lib/supabase/server` (idempotencja, stan, rodzaj). */
  invoice: {} as Record<string, unknown>,
  /** Każde `.update()` klienta `@/lib/supabase/server` — zapis porażki, kolejka Offline24. */
  serverUpdates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** Odpowiedź `claim_ksef_send` (00124); domyślnie przejęte. */
  claim: null as unknown as () => ClaimReply,
  /** Globalny wyłącznik `killAllKsefSubmissions`. */
  paused: false,
}));

vi.mock('@/lib/ksef/client', async (orig) =>
  (await import('./helpers/ksef-pelna-sciezka')).ksefClientModule(await orig(), () => m.ksef));
vi.mock('@/lib/ksef/encryption', async () => (await import('./helpers/ksef-pelna-sciezka')).encryptionModule());
vi.mock('@/lib/supabase/admin', async () => (await import('./helpers/ksef-pelna-sciezka')).adminClientModule(() => m.mem));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }), invalidate: vi.fn() },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (orig) => {
  const real = await orig<typeof import('@/lib/storage/r2')>();
  return {
    ...real,
    uploadInvoiceXml: async (tenantId: string, invoiceId: string, issueDate: string, xml: string, o?: { attemptId?: string | null }) => {
      const storagePath = real.invoiceXmlKeyFor({ tenantId, invoiceId, issueDate, attemptId: o?.attemptId });
      m.storage.set(storagePath, xml);
      const { sha256Hex } = await import('./helpers/ksef-pelna-sciezka');
      return { storagePath, sha256Hash: sha256Hex(xml), sizeBytes: xml.length, etag: '"e"' };
    },
    invoiceXmlExistsForId: async () => false,
    uploadToR2IfAbsent: async (key: string, body: Buffer) => {
      if (m.storage.has(key)) return false;
      m.storage.set(key, body.toString('utf8'));
      return true;
    },
    downloadFromR2: async (key: string) => {
      const xml = m.storage.get(key);
      if (xml === undefined) throw new Error(`brak pliku ${key}`);
      return Buffer.from(xml, 'utf8');
    },
    downloadInvoiceXml: async (path: string) => {
      const xml = m.storage.get(path);
      if (xml === undefined) throw new Error(`brak pliku ${path}`);
      return xml;
    },
  };
});
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-10-01T10:00:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => m.paused }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: m.audit }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/health-status', () => ({ isKsefHealthy: async () => true }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (orig) => ({
  ...await orig<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '1234567890', token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
// Wiersz faktury, zapis porażki i przejęcie wysyłki (00124) — klient z `@/lib/supabase/server`.
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null;
      const q = {
        select: () => q, eq: () => q, neq: () => q, in: () => q, is: () => q, or: () => q,
        update: (p: Record<string, unknown>) => {
          patch = p;
          m.serverUpdates.push({ table, patch: p });
          if (table === 'invoices') Object.assign(m.invoice, p);
          return q;
        },
        maybeSingle: async () => ({
          data: table !== 'invoices' ? null : patch ? { id: m.invoice.id } : { ...m.invoice },
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      m.rpcCalls.push({ fn, args });
      if (fn === 'claim_ksef_send') return m.claim();
      if (fn === 'ksef_has_contact_evidence') {
        const rows = (m.mem.db.ksef_submissions ?? []) as Array<Record<string, unknown>>;
        return { data: rows.some((r) => ['intent', 'sent', 'accepted', 'duplicate'].includes(String(r.status))), error: null };
      }
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import { onSubmitInvoiceExhausted, runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { heldErrorMessage, KSEF_PAUSED } from '@/lib/ksef/submission-holds';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { freshKsef, seedKsefInvoice } from './helpers/ksef-pelna-sciezka';

const faktura = () => finalizeInvoice({
  internalNumber: NUMBER,
  type: 'VAT',
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  seller: { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});
/** Plik oryginału w KSeF: ten sam numer faktury, inny program i inna kwota. */
const originalXml = () => generateFA3Xml(faktura() as Invoice, { generatedAt: GENERATED_AT })
  .replace(/<SystemInfo>[^<]*<\/SystemInfo>/, '<SystemInfo>Inny Program 2.0</SystemInfo>')
  .replace(/<P_15>[^<]*<\/P_15>/, '<P_15>999.99</P_15>');

type SubmitEvent = Parameters<typeof runSubmitInvoice>[0];

const event = (extra: Partial<SubmitEvent> = {}): SubmitEvent => ({
  invoiceId: ID, tenantId: T, nip: '1234567890', environment: 'test' as const,
  invoice: faktura() as Invoice, sendAttemptId: ATTEMPT, ...extra,
});
const ctx = (attempt = 0): JobContext => ({
  attempt,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: m.sendEvent, scheduleAfter: vi.fn() },
});
const failing = (run: Promise<unknown>) => run.then(() => { throw new Error('oczekiwano błędu'); }, (e: unknown) => e as Error);

function submissions(): Row[] {
  return (m.mem.db.ksef_submissions ?? []) as Row[];
}
const claimCalls = () => m.rpcCalls.filter((c) => c.fn === 'claim_ksef_send');
const invoiceUpdates = () => m.serverUpdates.filter((u) => u.table === 'invoices');
type SentryContext = { level?: string; tags?: Record<string, unknown>; extra?: Record<string, unknown> };
/** Ostrzeżenia Sentry wyjścia „szkic wycofany” (tag `kind: 'retired-number-taken'`, §2.7.2). */
const retiredWarnings = () => m.captureMessage.mock.calls
  .map(([, context]) => context as SentryContext | undefined)
  .filter((c) => c?.tags?.kind === 'retired-number-taken');

const DECISION_CHECK = {
  v: 1, env: 'test', checkedAt: '2026-10-02T08:00:00.000Z', reason: 'no-own-file', sha256: 'bb'.repeat(32),
  archivePath: `${T}/ksef-import/${K}.xml`, sizeBytes: 1200, sameContentExceptHeader: null, ownHistory: false,
  acquiredAt: '2026-09-28T07:15:00.000Z', httpStatus: null, knownInvoice: null, recheck: null,
  summary: { systemInfo: 'Inny Program 2.0', number: NUMBER, issueDate: '2026-10-01', buyerNip: '5252241585', buyerName: 'Klient', gross: '999.99', currency: 'PLN' },
};

/** Wpis `number_taken` w trzech kształtach z §3.1 (decyzja klienta, automatyczny z K, bez znacznika). */
function takenRow(shape: 'decided' | 'automatic' | 'unmarked', extra: Row = {}): Row {
  const base: Row = {
    id: `nt-${shape}`, tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'number_taken',
    error_code: 'NUMBER_TAKEN', session_reference_number: `S-${shape}`, invoice_reference_number: `I-${shape}`,
    request_payload_hash: 'aa'.repeat(32), attempted_at: '2026-10-02T07:00:00.000Z', completed_at: '2026-10-02T09:00:00.000Z',
  };
  if (shape === 'decided') {
    return {
      ...base, original_ksef_number: K, original_session_reference_number: 'S-OBCA',
      error_message: `Decyzja klienta: inna sprzedaż — numer ${NUMBER} zajęty w KSeF przez fakturę ${K}`,
      original_check: { ...DECISION_CHECK, decision: { choice: 'other_sale', via: 'client', at: '2026-10-03T08:00:00.000Z', reason: 'no-own-file', env: 'test' } },
      ...extra,
    };
  }
  if (shape === 'automatic') {
    return {
      ...base, original_ksef_number: K, original_session_reference_number: 'S-OBCA', original_check: null,
      error_message: `Numer faktury zajęty w KSeF przez fakturę ${K} spoza FaktWay`, ...extra,
    };
  }
  return { ...base, original_ksef_number: null, original_session_reference_number: null, original_check: null, ...extra };
}

/** Szkic po decyzji albo po „Wróć do szkicu” (reset 00131: pola dostarczenia wyczyszczone). */
function draft(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID, tenant_id: T, direction: 'outgoing', ksef_status: 'draft', ksef_number: null, ksef_environment: null,
    invoice_type: 'VAT', invoice_kind: 'regular', internal_number: NUMBER, last_error_code: null, fa3_data: {}, ...extra,
  };
}

/** Tekst TRIGGER_OTHER z 2.11.A (`v_num`, `v_k`) — odmowa przejęcia przez wyzwalacz c_guard_ksef_retired_draft. */
const TRIGGER_OTHER = `Dokument ${NUMBER} jest wycofany: numer jest zajęty w KSeF przez fakturę ${K}. Tego dokumentu nie wyślesz do KSeF — tę sprzedaż wystaw jako nową fakturę z nowym numerem.`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.ksef = freshKsef();
  // KSeF ma oryginał o tym numerze — każda wysyłka tego szkicu skończyłaby się 440.
  seedKsefInvoice(m.ksef, { session: 'S-OBCA', ksefNumber: K, xml: originalXml() });
  m.mem = { db: { ksef_submissions: [], invoices: [] }, failWrite: null };
  m.storage = new Map();
  m.invoice = draft();
  m.serverUpdates = [];
  m.rpcCalls = [];
  m.claim = () => ({ data: CLAIMED, error: null });
  m.paused = false;
});
afterEach(() => vi.unstubAllEnvs());

describe('U5a: job wraca do szkicu wycofanego → czyste wyjście, bez przejęcia i bez wysyłki', () => {
  it.each([
    ['decyzja klienta (inna sprzedaż)', 'decided', false],
    ['decyzja klienta (inna sprzedaż)', 'decided', true],
    ['automatyczny KSEF_NUMBER_TAKEN', 'automatic', false],
    ['automatyczny KSEF_NUMBER_TAKEN', 'automatic', true],
  ] as const)('%s (wpis %s), reconcileOnly=%s → {retired, K}; bez claim_ksef_send, zapisów i POST; jedno ostrzeżenie', async (_l, shape, reconcileOnly) => {
    m.mem.db.ksef_submissions = [takenRow(shape)];
    const before = structuredClone(m.mem.db);
    const c = ctx();

    const result = await runSubmitInvoice(event(reconcileOnly ? { reconcileOnly: true } : {}), c);

    expect(result).toEqual({ retired: true, originalKsefNumber: K });
    expect(claimCalls()).toEqual([]);
    expect(m.serverUpdates).toEqual([]);
    expect(m.updateStatus).not.toHaveBeenCalled();
    expect(m.ksef.invoicePosts).toBe(0);
    expect(m.mem.db).toEqual(before);
    expect(retiredWarnings()).toHaveLength(1);
    expect(retiredWarnings()[0]).toMatchObject({
      level: 'warning',
      extra: expect.objectContaining({ tenantId: T, invoiceId: ID, originalKsefNumber: K }),
    });
    expect(Boolean(retiredWarnings()[0]?.extra?.reconcileOnly)).toBe(reconcileOnly);
    expect(c.logger.warn).toHaveBeenCalled();
  });
});

describe('U5b: który wpis number_taken opisuje szkic — prawdziwe zapytanie findKsefNumberTaken (C10, 2.1.4 krok 2)', () => {
  it('decyzja wygrywa z późniejszym wpisem automatycznym (inny K) → K decyzji', async () => {
    m.mem.db.ksef_submissions = [
      takenRow('automatic', { id: 'nt-pozniejszy', original_ksef_number: K2, completed_at: '2026-10-05T10:00:00.000Z' }),
      takenRow('decided', { id: 'nt-decyzja', completed_at: '2026-10-04T10:00:00.000Z' }),
    ];

    await expect(runSubmitInvoice(event(), ctx())).resolves.toEqual({ retired: true, originalKsefNumber: K });
  });

  it('wpis z K wygrywa z późniejszym wpisem bez znacznika (markKsefSubmissionsNumberTaken zamyka też wpisy bez K)', async () => {
    m.mem.db.ksef_submissions = [
      takenRow('unmarked', { id: 'nt-bez-k', completed_at: '2026-10-05T10:00:00.000Z' }),
      takenRow('automatic', { id: 'nt-z-k', completed_at: '2026-10-02T09:00:00.000Z' }),
    ];

    await expect(runSubmitInvoice(event(), ctx())).resolves.toEqual({ retired: true, originalKsefNumber: K });
  });

  it('same wpisy bez znacznika → szkic wycofany bez K (null), też bez wysyłki', async () => {
    m.mem.db.ksef_submissions = [takenRow('unmarked')];

    await expect(runSubmitInvoice(event(), ctx())).resolves.toEqual({ retired: true, originalKsefNumber: null });
    expect(m.ksef.invoicePosts).toBe(0);
  });
});

describe('U5c: wyścig — decyzja zapada między odczytem stanu a przejęciem (wyzwalacz odmawia P0001)', () => {
  it('claim_ksef_send → P0001, a wpis number_taken już jest → {retired}; bez RetryAfterError, zapisów i POST', async () => {
    // Faktura czekała na klienta: failed KSEF_DUPLICATE_RECONCILE z otwartym znacznikiem 440 (cron I5 / „Tylko uzgodnij”).
    m.invoice = draft({ ksef_status: 'failed', last_error_code: 'KSEF_DUPLICATE_RECONCILE' });
    m.mem.db.ksef_submissions = [takenRow('decided', {
      id: 'marker', status: 'sent', error_code: '440', completed_at: null, error_message: null,
      original_check: { ...DECISION_CHECK },
    })];
    m.claim = () => {
      // decide_ksef_duplicate w innej transakcji: znacznik → number_taken z decyzją, faktura → draft.
      Object.assign(submissions()[0]!, takenRow('decided', { id: 'marker' }));
      m.invoice.ksef_status = 'draft';
      m.invoice.last_error_code = null;
      return { data: null, error: { code: 'P0001', message: TRIGGER_OTHER } };
    };
    const c = ctx();

    const outcome = await runSubmitInvoice(event({ reconcileOnly: true }), c).then(
      (value) => ({ value, error: null as Error | null }),
      (error: unknown) => ({ value: null, error: error as Error }),
    );

    expect(outcome.error).toBeNull();
    expect(outcome.value).toEqual({ retired: true, originalKsefNumber: K });
    expect(claimCalls()).toHaveLength(1);
    expect(m.serverUpdates).toEqual([]);
    expect(m.ksef.invoicePosts).toBe(0);
    expect(retiredWarnings()).toHaveLength(1);
  });
});

describe('U5d–U5f: onExhausted na szkicu wycofanym — bez zapisu failed i bez invoice/submit.failed', () => {
  it('U5d: błąd KSEF_PAUSED (hamulec) → {handled:false, reason:retired-number-taken}; bez zapisu, zdarzenia i audytu; ostrzeżenie', async () => {
    m.mem.db.ksef_submissions = [takenRow('decided')];

    const result = await onSubmitInvoiceExhausted(new NonRetriableError(heldErrorMessage(KSEF_PAUSED, 'regular')), event(), ctx());

    expect(result).toEqual({ handled: false, reason: 'retired-number-taken' });
    expect(m.serverUpdates).toEqual([]);
    expect(m.sendEvent).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.submit_failed' }));
    expect(m.invoice.ksef_status).toBe('draft');
    expect(retiredWarnings()).toHaveLength(1);
  });

  it('U5e: zdarzenie z innego środowiska (production przy KSEF_ENV=test) → bez ENV_MISMATCH na szkicu wycofanym', async () => {
    m.mem.db.ksef_submissions = [takenRow('automatic')];

    const result = await onSubmitInvoiceExhausted(new Error('cokolwiek'), event({ environment: 'production' }), ctx());

    expect(result).toEqual({ handled: false, reason: 'retired-number-taken' });
    expect(invoiceUpdates()).toEqual([]);
    expect(m.invoice).toMatchObject({ ksef_status: 'draft', last_error_code: null });
    expect(m.sendEvent).not.toHaveBeenCalled();
  });

  it('U5f: zły payload (identyfikatory są, brak faktury w zdarzeniu) → bez INVALID_EVENT na szkicu wycofanym', async () => {
    m.mem.db.ksef_submissions = [takenRow('decided')];
    const broken = { invoiceId: ID, tenantId: T, nip: '1234567890', environment: 'test', sendAttemptId: ATTEMPT } as unknown as SubmitEvent;

    const result = await onSubmitInvoiceExhausted(new Error('Niepoprawny payload'), broken, ctx());

    expect(result).toEqual({ handled: false, reason: 'retired-number-taken' });
    expect(invoiceUpdates()).toEqual([]);
    expect(m.invoice).toMatchObject({ ksef_status: 'draft', last_error_code: null });
  });
});

describe('U5g (dawny U6): hamulec włączony i szkic wycofany', () => {
  it('stare zlecenie przy killAllKsefSubmissions → {retired}, nie NonRetriable KSEF_PAUSED (I7 nie wznowi pełnej wysyłki)', async () => {
    m.paused = true;
    m.mem.db.ksef_submissions = [takenRow('decided')];

    const outcome = await runSubmitInvoice(event(), ctx()).then(
      (value) => ({ value, error: null as Error | null }),
      (error: unknown) => ({ value: null, error: error as Error }),
    );

    expect(outcome.error?.message ?? null).toBeNull();
    expect(outcome.value).toEqual({ retired: true, originalKsefNumber: K });
    expect(m.serverUpdates).toEqual([]);
    expect(claimCalls()).toEqual([]);
  });
});

describe('U5h strażnik: bez wpisu number_taken tej faktury wszystko jak dotąd', () => {
  it('strażnik: onExhausted KSEF_PAUSED faktury w sending bez wpisów → failed KSEF_PAUSED i invoice/submit.failed', async () => {
    m.invoice = draft({ ksef_status: 'sending' });

    const result = await onSubmitInvoiceExhausted(new NonRetriableError(heldErrorMessage(KSEF_PAUSED, 'regular')), event(), ctx());

    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(invoiceUpdates().at(-1)?.patch).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_PAUSED', ksef_send_owner: null });
    expect(m.sendEvent).toHaveBeenCalledWith('emit-failure', expect.objectContaining({ name: 'invoice/submit.failed' }));
  });

  it('strażnik: szkic z wpisem number_taken INNEJ faktury (i innej firmy) nie jest wycofany — onExhausted zapisuje failed jak dotąd', async () => {
    m.mem.db.ksef_submissions = [
      takenRow('decided', { id: 'cudza-faktura', invoice_id: OTHER_ID }),
      takenRow('automatic', { id: 'cudza-firma', tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ];

    const result = await onSubmitInvoiceExhausted(new NonRetriableError(heldErrorMessage(KSEF_PAUSED, 'regular')), event(), ctx());

    expect(result).toMatchObject({ handled: true, finalStatus: 'failed' });
    expect(invoiceUpdates().at(-1)?.patch).toMatchObject({ ksef_status: 'failed', last_error_code: 'KSEF_PAUSED' });
    expect(retiredWarnings()).toEqual([]);
  });

  it('strażnik: zwykły szkic bez wpisów dochodzi do przejęcia (jedno claim_ksef_send) i wysyłki', async () => {
    m.ksef = freshKsef();

    await runSubmitInvoice(event(), ctx());

    expect(claimCalls()).toHaveLength(1);
    expect(m.ksef.invoicePosts).toBe(1);
    expect(retiredWarnings()).toEqual([]);
  });

  it('strażnik: odmowa przejęcia P0001 bez wpisu number_taken → zwykły błąd (ponowienie), nie wycofanie', async () => {
    m.invoice = draft({ ksef_status: 'failed', last_error_code: 'KSEF_UNAVAILABLE' });
    m.claim = () => ({ data: null, error: { code: 'P0001', message: 'Faktura nie może być teraz wysłana' } });

    const error = await failing(runSubmitInvoice(event(), ctx()));

    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(error).not.toBeInstanceOf(RetryAfterError);
    expect(m.ksef.invoicePosts).toBe(0);
    expect(retiredWarnings()).toEqual([]);
  });
});
