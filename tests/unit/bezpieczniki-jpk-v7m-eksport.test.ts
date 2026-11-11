import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';

/**
 * Żelazny filtr F13, część 2b: strażnik pliku JPK_V7M (`sprawdzJpkV7m`, #594)
 * także w Centrum eksportu. Moduł księgowości sprawdzał plik po XSD, a eksport
 * z Centrum (większość klientów, plik dla księgowej) tylko XSD: plik z błędem
 * generatora w sumach albo w deklaracji, zgodny ze schematem, wychodził do klienta.
 * Teraz: alarm `FILTR-RT-JPK-*` w Sentry, bez pliku, bez ponawiania, a w Centrum
 * eksportu treść odmowy z kodem.
 *
 * Ścieżka: `runExportsGenerate` z prawdziwym generatorem i XSD; atrapy bazy,
 * magazynu plików i Sentry; plik psuje się tak, jak zrobiłby to błąd generatora.
 */

const db = vi.hoisted(() => ({ uploads: [] as string[], updates: [] as unknown[], psuj: false }));
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

function builder(table: string) {
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q,
    eq: () => q,
    in: () => q,
    limit: () => q,
    update: (row: unknown) => {
      db.updates.push(row);
      return q;
    },
    upsert: () => q,
    single: async () => ({
      data: {
        id: 'job-1',
        tenant_id: 'ten-1',
        format: 'jpk_v7m',
        period_start: '2026-08-01',
        period_end: '2026-08-31',
        include_issued: true,
        include_received: true,
        include_corrections: true,
        status: 'pending',
      },
      error: null,
    }),
    maybeSingle: async () => {
      if (table === 'tenants') return { data: { tax_office_code: '1433' }, error: null };
      if (table === 'memberships') return { data: { user_id: 'u-1' }, error: null };
      return { data: null, error: null };
    },
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  });
  return q;
}

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: builder,
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'wlasciciel@example.test' } }, error: null }) } },
  }),
}));
vi.mock('@/lib/storage/r2', () => ({
  uploadToR2IfAbsent: async (_p: string, buffer: Buffer) => {
    db.uploads.push(buffer.toString('utf8'));
    return true;
  },
  downloadFromR2: async () => Buffer.from(''),
}));
// JPK_V7M w Centrum eksportu bywa wstrzymany flagą; tu sprawdzamy sam plik.
vi.mock('@/lib/exports/suspended-formats', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/suspended-formats')>()),
  isExportFormatSuspended: () => false,
}));
vi.mock('@/lib/exports/issuer-address', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/issuer-address')>()),
  readIssuerRegisteredAddress: async () => ({
    voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', buildingNumber: '1', city: 'Warszawa', postCode: '00-001',
  }),
}));
vi.mock('@/lib/exports/data-fetcher', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/data-fetcher')>()),
  fetchInvoicesForExport: async () => ({
    issuer: { nip: '1234567890', name: 'Firma Testowa' },
    issuedInvoices: [
      {
        invoiceNumber: 'FV/1/08/2026', currency: 'PLN',
        invoiceType: 'regular',
        issueDate: '2026-08-05',
        buyerName: 'Nabywca Testowy',
        buyerNip: '1234567890',
        netTotal: 1000,
        vatTotal: 230,
        grossTotal: 1230,
        ksefNumber: '1234567890-20260805-0100001AF629-AF',
        lines: [{ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23', vatAmount: 230 }],
      } as JpkInvoice,
    ],
    receivedInvoices: [],
    expenses: [],
  }),
}));

/** Błąd generatora w deklaracji: P_51 o 1 zł za dużo. Schemat XSD tego nie widzi. */
const zepsuj = (xml: string) =>
  db.psuj ? xml.replace(/(<(?:\w+:)?P_51>)(\d+)(<\/(?:\w+:)?P_51>)/, (_m, a: string, n: string, b: string) => `${a}${Number(n) + 1}${b}`) : xml;

vi.mock('@/lib/exports/jpk-v7m-generator', async (orig) => {
  const real = await orig<typeof import('@/lib/exports/jpk-v7m-generator')>();
  return { ...real, generateJpkV7m: (...a: Parameters<typeof real.generateJpkV7m>) => zepsuj(real.generateJpkV7m(...a)) };
});

import { onExportsGenerateExhausted, runExportsGenerate } from '@/lib/jobs/runners/exports-generate';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

beforeEach(() => {
  db.uploads = [];
  db.updates = [];
  db.psuj = false;
  sentry.captureMessage.mockClear();
});

describe('Centrum eksportu: strażnik pliku JPK_V7M (F13 część 2b)', () => {
  it('plik z błędem w deklaracji: bez pliku, bez ponawiania, alarm w Sentry, treść odmowy w Centrum eksportu', async () => {
    db.psuj = true;
    const failure = await runExportsGenerate({ exportJobId: 'job-1' }, ctx).then(
      () => new Error('job nie odmówił'),
      (e: Error) => e,
    );

    expect(failure).toMatchObject({ name: 'NonRetriableError' });
    expect(failure.message).toMatch(/^Plik JPK_V7M wstrzymany: kontrola spójności wykryła błąd po naszej stronie \(FILTR-RT-JPK-0\d\)/);
    expect(db.uploads).toEqual([]);
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^FILTR-RT-JPK-0\d/),
      expect.objectContaining({ level: 'error', fingerprint: expect.arrayContaining(['vat', '2026-08']) }),
    );

    db.updates = [];
    await onExportsGenerateExhausted(failure, { exportJobId: 'job-1' });
    expect(db.updates).toEqual([{ status: 'failed', error_message: failure.message }]);
  });

  it('dobry plik przechodzi bez alarmu', async () => {
    await runExportsGenerate({ exportJobId: 'job-1' }, ctx);
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]).toContain('<P_51>');
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });
});
