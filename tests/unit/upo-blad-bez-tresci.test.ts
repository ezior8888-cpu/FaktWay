/**
 * F-093-UPO: błąd pobrania UPO nie niesie treści odpowiedzi KSeF.
 *
 * Komunikat błędu z `downloadUpoFromKsef` idzie dosłownie do
 * `upo_receipts.last_error` (krok `mark-failed`, panel `/admin/centrum/bledy`,
 * `scripts/ops/kontrola-faktur-ksef.sh`) i jako komunikat błędu joba do logu
 * workera, `inngest_run_log.error_message`, a po wyczerpaniu prób do Sentry.
 * Treść odpowiedzi KSeF może nieść dane kontrahenta, więc zostają tylko status
 * HTTP i kody KSeF (reguła z `lib/ksef/history-sync/errors.ts`).
 *
 * Prawdziwa ścieżka: `runDownloadUpo` → prawdziwe `downloadUpoFromKsef`
 * (i prawdziwy limiter). Atrapy tylko dla HTTP (`fetch`, sesja KSeF)
 * i bazy (klient admina, poświadczenia, historia wysyłek, dziennik audytu).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  credentials: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(),
  xml: vi.fn(),
  pdf: vi.fn(),
}));

// Baza.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.admin }));
vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: mocks.credentials }));
vi.mock('@/lib/ksef/submission-log', () => ({
  findSessionReferenceForKsefNumber: vi.fn(async () => SESSION_REF),
}));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: mocks.audit }));
// HTTP: sesja KSeF (uwierzytelnienie w MF) i magazyn plików.
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token-testowy' }), invalidate: mocks.invalidate },
}));
vi.mock('@/lib/ksef/upo-storage', () => ({ uploadUpoXml: mocks.xml, uploadUpoPdf: mocks.pdf }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));

import { NonRetriableError } from '@/lib/jobs/errors';
import { runDownloadUpo } from '@/lib/jobs/runners/download-upo';
import { downloadUpoFromKsef } from '@/lib/ksef/upo-client';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const RECEIPT = '33333333-3333-4333-8333-333333333333';
const KSEF_NUMBER = '1234567890-20261001-0100A0B0C0D0-1A';
const SESSION_REF = '20261001-SO-0000000000-0000000000-01';

/** Dane, których nie może być w żadnym komunikacie: NIP i nazwa kontrahenta z treści odpowiedzi. */
const PRIVATE = ['1234567890', 'Kowalski', 'PRYWATNE-DANE-KONTRAHENTA', 'ul. Prosta'];

/** Odpowiedź KSeF w obu kształtach z `open-api.json` MF, z danymi kontrahenta w opisach. */
const PROBLEM_BODY = JSON.stringify({
  title: 'Bad Request',
  status: 400,
  errors: [{ code: 21405, description: 'Błąd walidacji: nabywca NIP 1234567890, Jan Kowalski, ul. Prosta 1' }],
  exception: {
    exceptionDetailList: [
      { exceptionCode: 21406, exceptionDescription: 'PRYWATNE-DANE-KONTRAHENTA', details: ['NIP 1234567890'] },
    ],
  },
});

const event = {
  invoiceId: INVOICE,
  tenantId: TENANT,
  ksefNumber: KSEF_NUMBER,
  nip: '1234567890',
  sessionReferenceNumber: SESSION_REF,
  environment: 'test' as const,
};

let tables: Record<string, Row[]>;

/** Minimalny klient PostgREST w pamięci: tylko to, czego używa runner UPO. */
function client() {
  return {
    from(table: string) {
      let operation: 'select' | 'insert' | 'update' = 'select';
      let patch: Row = {};
      let one = false;
      const predicates: Array<(r: Row) => boolean> = [];
      const execute = () => {
        let rows = (tables[table] ?? []).filter((r) => predicates.every((check) => check(r)));
        if (operation === 'insert') {
          const inserted = { id: RECEIPT, download_attempts: 0, last_error: null, ...patch };
          (tables[table] ??= []).push(inserted);
          rows = [inserted];
        }
        if (operation === 'update') rows.forEach((r) => Object.assign(r, patch));
        const result = rows.map((r) => ({ ...r }));
        return { data: one ? (result[0] ?? null) : result, error: null };
      };
      const builder = {
        select: () => builder,
        insert: (value: Row) => { operation = 'insert'; patch = value; return builder; },
        update: (value: Row) => { operation = 'update'; patch = value; return builder; },
        eq: (key: string, value: unknown) => { predicates.push((r) => r[key] === value); return builder; },
        in: (key: string, values: unknown[]) => { predicates.push((r) => values.includes(r[key])); return builder; },
        single: () => { one = true; return Promise.resolve(execute()); },
        maybeSingle: () => { one = true; return Promise.resolve(execute()); },
      };
      return builder;
    },
  };
}

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

function replyWith(status: number, body: string, contentType = 'application/problem+json') {
  const fetchMock = vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function runFailing(): Promise<Error> {
  const error = await runDownloadUpo(event, context).then(
    () => { throw new Error('runDownloadUpo powinno rzucić przy błędzie KSeF'); },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

function receipt(): Row {
  const row = tables.upo_receipts.find((r) => r.invoice_id === INVOICE);
  if (!row) throw new Error('brak rekordu UPO');
  return row;
}

function expectNoPrivateData(text: unknown) {
  expect(typeof text).toBe('string');
  for (const fragment of PRIVATE) expect(text, `„${fragment}” z treści odpowiedzi KSeF`).not.toContain(fragment);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  tables = {
    invoices: [{
      id: INVOICE, tenant_id: TENANT, ksef_number: KSEF_NUMBER, ksef_status: 'accepted', ksef_environment: 'test',
      internal_number: 'FV 1/2026', issue_date: '2026-10-01', gross_total: 123, buyer_data: { name: 'Nabywca' },
      buyer_nip: '1234567890', seller_nip: '1234567890', tenants: { id: TENANT, name: 'Sprzedawca', nip: '1234567890' },
    }],
    upo_receipts: [],
  };
  mocks.admin.mockImplementation(client);
  mocks.credentials.mockResolvedValue({ type: 'token', nip: '1234567890', token: 'token-ksef' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('F-093-UPO: błąd pobrania UPO bez treści odpowiedzi KSeF', () => {
  it('400 z danymi kontrahenta: last_error i komunikat joba mają status i kody, bez treści; bez ponowień', async () => {
    const fetchMock = replyWith(400, PROBLEM_BODY);

    const error = await runFailing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(NonRetriableError);
    expectNoPrivateData(error.message);
    // Cały napis: żaden fragment treści (tytuł, początek opisu) nie może się dokleić.
    expect(error.message).toBe('KSeF zwrócił HTTP 400 kody:21405,21406');

    const row = receipt();
    expect(row.status).toBe('failed');
    expect(row.download_attempts).toBe(1);
    expectNoPrivateData(row.last_error);
    expect(row.last_error).toBe(error.message);
  });

  it('500 z danymi w treści: ponowienie zostaje, treść nie przechodzi', async () => {
    replyWith(500, PROBLEM_BODY);

    const error = await runFailing();

    expect(error).not.toBeInstanceOf(NonRetriableError);
    expectNoPrivateData(error.message);
    expect(error.message).toBe('KSeF zwrócił HTTP 500 kody:21405,21406');
    expect(receipt().last_error).toBe(error.message);
  });

  it('kody bez powtórzeń i najwyżej 10: lista z odpowiedzi nie wydłuża last_error bez końca', async () => {
    const codes = [21405, 21405, ...Array.from({ length: 12 }, (_, i) => 30001 + i)];
    replyWith(400, JSON.stringify({ errors: codes.map((code) => ({ code, description: 'Jan Kowalski' })) }));

    const error = await runFailing();

    expect(error.message).toBe(
      'KSeF zwrócił HTTP 400 kody:21405,30001,30002,30003,30004,30005,30006,30007,30008,30009',
    );
    expect(receipt().last_error).toBe(error.message);
  });

  it('treść nie-JSON (strona HTML bramki) daje „kody:-”, bez fragmentu strony', async () => {
    replyWith(502, '<html><body>PRYWATNE-DANE-KONTRAHENTA NIP 1234567890</body></html>', 'text/html');

    const error = await runFailing();

    expect(error.message).toBe('KSeF zwrócił HTTP 502 kody:-');
    expect(receipt().last_error).toBe(error.message);
  });
});

describe('F-093-UPO: decyzja o ponowieniu bez zmian', () => {
  // Stan sprzed naprawy, przepisany z `lib/ksef/upo-client.ts`: 404 i 401 mają
  // własne gałęzie, reszta to `retryable: status >= 500`. 429 jest dziś bez
  // ponowień (UPO wraca dopiero przez cron `upo-retry-stale`) — to osobne
  // ustalenie, nie część tej naprawy. Zmiana któregoś wiersza ma być świadoma.
  it.each([
    { status: 400, retryable: false, errorCode: 'HTTP_400' },
    { status: 403, retryable: false, errorCode: 'HTTP_403' },
    { status: 409, retryable: false, errorCode: 'HTTP_409' },
    { status: 422, retryable: false, errorCode: 'HTTP_422' },
    { status: 429, retryable: false, errorCode: 'HTTP_429' },
    { status: 500, retryable: true, errorCode: 'HTTP_500' },
    { status: 502, retryable: true, errorCode: 'HTTP_502' },
    { status: 503, retryable: true, errorCode: 'HTTP_503' },
    { status: 404, retryable: true, errorCode: 'UPO_NOT_READY' },
    { status: 401, retryable: true, errorCode: 'SESSION_EXPIRED' },
  ])('HTTP $status → retryable=$retryable ($errorCode)', async ({ status, retryable, errorCode }) => {
    replyWith(status, PROBLEM_BODY);

    const result = await downloadUpoFromKsef(TENANT, KSEF_NUMBER, { env: 'test', sessionReferenceNumber: SESSION_REF });
    expect(result).toMatchObject({ success: false, retryable, errorCode });

    // Ten sam wynik w runnerze: bez ponowień tylko `NonRetriableError`.
    const error = await runFailing();
    expect(error instanceof NonRetriableError).toBe(!retryable);
    if (status === 401) expect(mocks.invalidate).toHaveBeenCalledWith('1234567890', 'test');
  });
});
