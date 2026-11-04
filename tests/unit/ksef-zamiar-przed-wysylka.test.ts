import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice } from '@/types/invoice';

/**
 * A2 z planu „zero zgubionych faktur” (M2: duplikat w KSeF). Wpis `sent`
 * w `ksef_submissions` powstawał dopiero po odpowiedzi na POST faktury. Gdy
 * KSeF przyjął plik, a odpowiedź nie dotarła (nasz timeout 408, padnięty
 * worker) albo zapis wpisu się nie udał, ponowienie nie wiedziało o tamtej
 * wysyłce: wysyłało fakturę drugi raz, KSeF odpowiadał 440 z numerem sesji,
 * której nie było w historii, i faktura kończyła jako `failed
 * KSEF_DUPLICATE_RECONCILE` — przyjęta w KSeF, a w FaktWay „do uzgodnienia
 * przez operatora”.
 *
 * Teraz po otwarciu sesji, PRZED wysłaniem faktury, powstaje wpis `intent`
 * z numerem sesji. Ponowienie rozstrzyga zamiar: zamyka tamtą sesję i pyta
 * KSeF o jej faktury — jest faktura → uzgodnienie po referencji, pusto →
 * wysyłka od nowa.
 *
 * Prawdziwe: runner, `submitInvoiceFullFlow`, `submitInvoice`, generator FA(3),
 * `submission-log`. Atrapy: HTTP do KSeF (sesje, faktury, wykrywanie
 * duplikatu po numerze faktury jak w KSeF) i baza w pamięci.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NUMBER = 'FV 2026/10/001';

type Row = Record<string, unknown>;
type StoredInvoice = {
  referenceNumber: string; invoiceNumber: string; invoiceHash: string;
  code: number; ksefNumber: string | null; originalSession?: string; originalKsef?: string;
};

const m = vi.hoisted(() => ({
  db: { ksef_submissions: [] as Row[] },
  /** Zwraca błąd bazy dla wybranych zapisów historii wysyłki. */
  failWrite: null as null | ((op: 'insert' | 'update', payload: Row) => boolean),
  ksef: {
    sessions: new Map<string, { open: boolean; invoices: StoredInvoice[] }>(),
    invoicePosts: 0,
    seq: 0,
    /** KSeF przyjmuje plik, ale odpowiedź nie dociera (nasz timeout 408). */
    loseInvoicePostResponse: false,
    /** Żądanie nie dociera do KSeF (timeout 408 przed przyjęciem pliku). */
    dropInvoicePost: false,
    /** KSeF odmawia przyjęcia pliku (HTTP 4xx). */
    rejectInvoicePost: null as null | number,
    statusFails: false,
    listFails: false,
  },
  updateStatus: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@/lib/ksef/client', async (orig) => {
  const real = await orig<typeof import('@/lib/ksef/client')>();
  const { KsefApiError } = real;
  const k = m.ksef;
  const statusReply = (inv: StoredInvoice) => ({
    referenceNumber: inv.referenceNumber,
    invoiceHash: inv.invoiceHash,
    ksefNumber: inv.ksefNumber ?? undefined,
    acquisitionTimestamp: inv.ksefNumber ? '2026-10-01T10:00:00Z' : undefined,
    status: inv.code === 440
      ? { code: 440, description: 'Duplikat faktury', details: ['Duplikat faktury'],
          extensions: { originalSessionReferenceNumber: inv.originalSession, originalKsefNumber: inv.originalKsef } }
      : { code: inv.code, description: inv.code === 200 ? 'Sukces' : 'Status' },
  });
  return {
    ...real,
    ksefFetch: async (path: string, opts: { method?: string; body?: { encryptedInvoiceContent?: string; invoiceHash?: string } } = {}) => {
      const method = opts.method ?? 'GET';
      const [route, query] = path.split('?');
      if (route === '/sessions/online' && method === 'POST') {
        k.seq += 1;
        const ref = `S-${k.seq}`;
        k.sessions.set(ref, { open: true, invoices: [] });
        return { referenceNumber: ref };
      }
      let hit = /^\/sessions\/online\/([^/]+)\/invoices$/.exec(route!);
      if (hit && method === 'POST') {
        k.invoicePosts += 1;
        const session = k.sessions.get(hit[1]!);
        if (k.dropInvoicePost) throw new KsefApiError(408, 'Request timeout', 'timeout');
        if (k.rejectInvoicePost) throw new KsefApiError(k.rejectInvoicePost, { exceptionDetailList: [{ exceptionCode: 21405 }] } as never, 'Błąd walidacji');
        if (!session?.open) throw new KsefApiError(400, 'Sesja zamknięta', 'Sesja zamknięta');
        const xml = String(opts.body?.encryptedInvoiceContent ?? '');
        const invoiceNumber = /<P_2>([^<]*)<\/P_2>/.exec(xml)?.[1] ?? '';
        k.seq += 1;
        const earlier = [...k.sessions.entries()]
          .flatMap(([s, v]) => v.invoices.map((i) => ({ s, i })))
          .find(({ i }) => i.invoiceNumber === invoiceNumber && i.code === 200);
        const stored: StoredInvoice = earlier
          ? { referenceNumber: `I-${k.seq}`, invoiceNumber, invoiceHash: String(opts.body?.invoiceHash), code: 440,
              ksefNumber: null, originalSession: earlier.s, originalKsef: earlier.i.ksefNumber ?? undefined }
          : { referenceNumber: `I-${k.seq}`, invoiceNumber, invoiceHash: String(opts.body?.invoiceHash), code: 200,
              ksefNumber: `K-${k.seq}` };
        session.invoices.push(stored);
        if (k.loseInvoicePostResponse) throw new KsefApiError(408, 'Request timeout', 'timeout');
        return { referenceNumber: stored.referenceNumber };
      }
      hit = /^\/sessions\/online\/([^/]+)\/close$/.exec(route!);
      if (hit && method === 'POST') {
        const session = k.sessions.get(hit[1]!);
        if (session) session.open = false;
        return {};
      }
      hit = /^\/sessions\/([^/]+)\/invoices$/.exec(route!);
      if (hit && method === 'GET') {
        if (k.listFails) throw new KsefApiError(503, 'Service Unavailable', 'KSeF niedostępny');
        const session = k.sessions.get(decodeURIComponent(hit[1]!));
        if (!session) {
          throw new KsefApiError(400, { exception: { exceptionDetailList: [{ exceptionCode: 21173 }] } } as never, 'Brak sesji');
        }
        void query;
        return { continuationToken: null, invoices: session.invoices.map((inv, n) => ({ ordinalNumber: n + 1, invoicingDate: '2026-10-01T10:00:00Z', invoiceNumber: inv.invoiceNumber, ...statusReply(inv) })) };
      }
      hit = /^\/sessions\/([^/]+)\/invoices\/([^/]+)$/.exec(route!);
      if (hit && method === 'GET') {
        if (k.statusFails) throw new KsefApiError(503, 'Service Unavailable', 'KSeF niedostępny');
        const inv = k.sessions.get(decodeURIComponent(hit[1]!))?.invoices.find((i) => i.referenceNumber === decodeURIComponent(hit![2]!));
        if (!inv) throw new KsefApiError(404, 'Not found', 'Brak faktury');
        return statusReply(inv);
      }
      throw new Error(`Nieobsłużone żądanie KSeF w teście: ${method} ${path}`);
    },
  };
});
vi.mock('@/lib/ksef/encryption', () => ({
  generateSessionEncryption: async () => ({ encryptedSymmetricKey: 'k', initializationVector: 'iv' }),
  // „Szyfrowanie” zostawia XML jawny, żeby atrapa KSeF odczytała numer faktury (P_2).
  encryptInvoiceXml: (xml: string) => ({
    invoiceHash: createHash('sha256').update(xml).digest('base64'),
    invoiceSize: xml.length,
    encryptedInvoiceHash: 'eh',
    encryptedInvoiceSize: xml.length,
    encryptedInvoiceContent: xml,
  }),
}));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }), invalidate: vi.fn() },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));

// Baza w pamięci dla `ksef_submissions` (klient serwisowy z `@/lib/supabase/admin`).
vi.mock('@/lib/supabase/admin', () => {
  function from(table: string) {
    const rows = (m.db as Record<string, Row[]>)[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    let order: { key: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const exec = () => {
      if (op !== 'select' && m.failWrite?.(op, payload)) return { data: null, error: { message: 'db down' } };
      if (op === 'insert') {
        rows.push({ id: `row-${rows.length + 1}`, attempted_at: new Date(Date.now() + rows.length).toISOString(), ...payload });
        return { data: null, error: null };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      if (order) {
        const { key, ascending } = order;
        hit = [...hit].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      }
      if (limit !== null) hit = hit.slice(0, limit);
      return { data: hit, error: null };
    };
    const q = {
      select: () => q,
      insert: (p: Row) => { op = 'insert'; payload = p; return q; },
      update: (p: Row) => { op = 'update'; payload = p; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      not: (k: string, _op: string, v: unknown) => { filters.push((r) => (r[k] ?? null) !== v); return q; },
      order: (key: string, o?: { ascending?: boolean }) => { order = { key, ascending: o?.ascending ?? true }; return q; },
      limit: (n: number) => { limit = n; return q; },
      maybeSingle: async () => { const r = exec(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      single: async () => { const r = exec(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      then: <A, B>(ok: (v: ReturnType<typeof exec>) => A, fail?: (e: unknown) => B) => Promise.resolve(exec()).then(ok, fail),
    };
    return q;
  }
  return { createAdminClient: () => ({ from }) };
});

vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (orig) => ({
  ...await orig<typeof import('@/lib/storage/r2')>(),
  uploadInvoiceXml: m.upload,
  invoiceXmlExistsForId: async () => false,
}));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-10-01T10:00:00.000Z') }));
vi.mock('@/lib/xml/validator', () => ({ validateInvoiceXml: async () => ({ valid: true, errors: [] }), InvoiceXmlSchemaError: class extends Error {} }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
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
// Wiersz faktury i przejęcie wysyłki (00124) — runner czyta je klientem z `@/lib/supabase/server`.
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const q = {
      select: () => q, eq: () => q, in: () => q, or: () => q, update: () => q,
      maybeSingle: async () => ({
        data: { id: ID, direction: 'outgoing', ksef_status: 'sending', ksef_number: null, ksef_environment: 'test',
          invoice_type: 'VAT', invoice_kind: 'regular', internal_number: NUMBER, fa3_data: {} },
        error: null,
      }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return {
      from: () => q,
      rpc: async (fn: string) => fn === 'ksef_has_contact_evidence'
        // Jak 00136: intent, sent, accepted, duplicate są dowodem kontaktu.
        ? { data: m.db.ksef_submissions.some((r) => ['intent', 'sent', 'accepted', 'duplicate'].includes(String(r.status))), error: null }
        : { data: '2026-10-03T12:00:00.000000+00:00', error: null },
    };
  },
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { NonRetriableError, RetryAfterError } from '@/lib/jobs/errors';
import { classifySendError } from '@/lib/ksef/send-error-codes';
import { decideResend, failedInvoiceButtons, KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { operatorInvoiceButtons } from '@/lib/admin/ksef-operator-policy';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { invoiceXmlKeyFor } from '@/lib/storage/r2';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

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

const event = (extra: Record<string, unknown> = {}) => ({
  invoiceId: ID, tenantId: T, nip: '1234567890', environment: 'test' as const,
  invoice: faktura() as Invoice, sendAttemptId: ATTEMPT, ...extra,
});

const ctx = (attempt: number): JobContext => ({
  attempt,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
});

const submissions = () => m.db.ksef_submissions;
const accepted = () => m.updateStatus.mock.calls.find(([, patch]) => (patch as Row).ksef_status === 'accepted')?.[1] as Row | undefined;
const storedInKsef = () => [...m.ksef.sessions.values()].flatMap((s) => s.invoices);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  m.db.ksef_submissions = [];
  m.failWrite = null;
  Object.assign(m.ksef, {
    sessions: new Map(), invoicePosts: 0, seq: 0, loseInvoicePostResponse: false,
    dropInvoicePost: false, rejectInvoicePost: null, statusFails: false, listFails: false,
  });
  m.upload.mockImplementation(async (_t: string, _i: string, _d: string, _xml: string, o?: { attemptId?: string | null }) => ({
    storagePath: invoiceXmlKeyFor({ tenantId: T, invoiceId: ID, issueDate: '2026-10-01', attemptId: o?.attemptId }),
    sha256Hash: 'a'.repeat(64), sizeBytes: 10, etag: '"e"',
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('A2: KSeF przyjął plik, a my o tym nie wiemy — ponowienie uzgadnia, nie wysyła drugi raz', () => {
  it('odpowiedź na POST faktury zginęła (timeout 408) → druga próba: accepted z numerem pierwszej wysyłki, jeden POST', async () => {
    m.ksef.loseInvoicePostResponse = true;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);
    expect(storedInKsef()).toHaveLength(1);

    m.ksef.loseInvoicePostResponse = false;
    await runSubmitInvoice(event(), ctx(1));

    expect(m.ksef.invoicePosts).toBe(1);
    expect(accepted()).toMatchObject({ ksef_status: 'accepted', ksef_number: 'K-2' });
    expect(submissions()).toEqual([
      expect.objectContaining({ status: 'accepted', session_reference_number: 'S-1', invoice_reference_number: 'I-2', response_ksef_number: 'K-2' }),
    ]);
  });

  it('zapis wpisu sent padł po udanym POST, a status padł 5xx → druga próba uzgadnia po zamiarze, jeden POST', async () => {
    m.failWrite = (op, p) => p.status === 'sent' && (op === 'insert' || op === 'update');
    m.ksef.statusFails = true;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);

    m.failWrite = null;
    m.ksef.statusFails = false;
    await runSubmitInvoice(event(), ctx(1));

    expect(m.ksef.invoicePosts).toBe(1);
    expect(accepted()).toMatchObject({ ksef_number: 'K-2' });
  });

  it('bez zapisanego zamiaru faktura nie wychodzi: błąd bazy przed POST → ponowienie, zero POST', async () => {
    m.failWrite = (op, p) => op === 'insert' && p.status === 'intent';
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);
    expect(m.ksef.invoicePosts).toBe(0);
    expect(storedInKsef()).toHaveLength(0);
    // Sesja otwarta na próżno zostaje zamknięta.
    expect([...m.ksef.sessions.values()].every((s) => !s.open)).toBe(true);
  });

  it('POST nie dotarł do KSeF → zamiar porzucony (sesja pusta), druga próba wysyła w nowej sesji', async () => {
    m.ksef.dropInvoicePost = true;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);

    m.ksef.dropInvoicePost = false;
    await runSubmitInvoice(event(), ctx(1));

    expect(storedInKsef()).toHaveLength(1);
    expect(accepted()).toMatchObject({ ksef_status: 'accepted' });
    expect(submissions()).toEqual([
      expect.objectContaining({ session_reference_number: 'S-1', status: 'abandoned' }),
      expect.objectContaining({ session_reference_number: 'S-2', status: 'accepted', response_ksef_number: 'K-3' }),
    ]);
  });

  it('KSeF nie odpowiada na pytanie o faktury sesji → ponowienie uzgadniania, nigdy druga wysyłka', async () => {
    m.ksef.loseInvoicePostResponse = true;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);

    m.ksef.loseInvoicePostResponse = false;
    m.ksef.listFails = true;
    await expect(runSubmitInvoice(event(), ctx(1))).rejects.toBeInstanceOf(RetryAfterError);
    expect(m.ksef.invoicePosts).toBe(1);
    expect(submissions()).toEqual([expect.objectContaining({ status: 'intent', session_reference_number: 'S-1' })]);
  });

  const oldIntent = (hoursAgo: number) => ({
    id: 'row-old', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'intent',
    session_reference_number: 'S-NIEZNANA', invoice_reference_number: null,
    attempted_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  });

  it('KSeF nie zna sesji zamiaru sprzed ponad 48 h (21173) → zamiar zamknięty jako STALE, wysyłka od nowa', async () => {
    m.db.ksef_submissions = [oldIntent(72)];
    await runSubmitInvoice(event(), ctx(1));

    expect(m.ksef.invoicePosts).toBe(1);
    expect(accepted()).toMatchObject({ ksef_status: 'accepted' });
    expect(submissions()[0]).toMatchObject({ session_reference_number: 'S-NIEZNANA', status: 'abandoned', error_code: 'STALE' });
  });

  it('KSeF nie zna sesji świeżego zamiaru (1 h) → tylko ponowienie uzgadniania, bez wysyłki', async () => {
    m.db.ksef_submissions = [oldIntent(1)];
    await expect(runSubmitInvoice(event(), ctx(1))).rejects.toBeInstanceOf(RetryAfterError);

    expect(m.ksef.invoicePosts).toBe(0);
    expect(submissions()[0]).toMatchObject({ status: 'intent' });
  });

  it('KSeF odmówił przyjęcia pliku (HTTP 400) → zamiar zamknięty jako porzucony z kodem, bez dowodu kontaktu', async () => {
    m.ksef.rejectInvoicePost = 400;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(NonRetriableError);

    expect(submissions()).toEqual([
      expect.objectContaining({ session_reference_number: 'S-1', status: 'abandoned', error_code: '400' }),
    ]);
  });
});

describe('A2b: „Tylko uzgodnij” stwierdza, że KSeF nie ma faktury — wynik z wyjściem, nie ślepa uliczka', () => {
  it('zamiar w pustej sesji → porzucony; faktura NOT_IN_KSEF (klasa transient): klient i operator mogą wysłać ponownie albo wrócić do szkicu', async () => {
    m.ksef.dropInvoicePost = true;
    await expect(runSubmitInvoice(event(), ctx(0))).rejects.toBeInstanceOf(RetryAfterError);
    m.ksef.dropInvoicePost = false;

    const error = await runSubmitInvoice(event({ reconcileOnly: true }), ctx(0)).then(
      () => { throw new Error('oczekiwano błędu'); },
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(NonRetriableError);
    expect(classifySendError(error).code).toBe('NOT_IN_KSEF');
    expect(m.ksef.invoicePosts).toBe(1); // tylko pierwsza, nieudana próba — uzgodnienie nie wysyła
    expect(submissions()).toEqual([expect.objectContaining({ status: 'abandoned', error_code: 'NOT_IN_SESSION' })]);

    const failed = {
      direction: 'outgoing', status: 'failed', errorCode: 'NOT_IN_KSEF', invoiceKind: 'regular',
      facts: { sendData: 'stored', kindHeld: false, issueDatePassed: false }, environmentKnown: true,
    } as const;
    expect(decideResend(failed)).toMatchObject({ allowed: true });
    const buttons = operatorInvoiceButtons({ ...failed, openSent: false, evidence: false });
    expect(buttons.requeue.enabled).toBe(true);
    expect(buttons.reset.enabled).toBe(true);
    // Klient: oba przyciski i zdanie bez obietnicy automatycznego ponowienia.
    expect(failedInvoiceButtons({ ...failed, canManage: true }))
      .toEqual({ resend: true, reset: true, settings: false, info: KSEF_SEND_MESSAGES.notInKsef });
    expect(error.message).toContain(KSEF_SEND_MESSAGES.notInKsef);
  });

  it('zostaje inny dowód kontaktu (wpis sent bez odpowiedzi) → nadal RESULT_UNCERTAIN dla operatora', async () => {
    m.db.ksef_submissions = [{
      id: 'row-x', tenant_id: T, invoice_id: ID, submission_type: 'online', status: 'duplicate',
      session_reference_number: 'S-OBCA', invoice_reference_number: 'I-OBCA', attempted_at: new Date().toISOString(),
    }];
    const error = await runSubmitInvoice(event({ reconcileOnly: true }), ctx(0)).then(
      () => { throw new Error('oczekiwano błędu'); },
      (e: unknown) => e as Error,
    );
    expect(classifySendError(error).code).toBe('RESULT_UNCERTAIN');
    expect(m.ksef.invoicePosts).toBe(0);
  });
});
