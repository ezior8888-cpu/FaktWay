import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';

const db = vi.hoisted(() => ({
  format: 'jpk_v7m' as 'jpk_v7m' | 'jpk_fa',
  uploads: [] as string[],
  updates: [] as unknown[],
  breakXml: false,
}));

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
        format: db.format,
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

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: builder,
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'wlasciciel@example.test' } }, error: null }) } },
  }),
}));
// Eksport zapisuje obiekt tylko, gdy go nie ma (#71).
vi.mock('@/lib/storage/r2', () => ({
  uploadToR2IfAbsent: async (_p: string, buffer: Buffer) => {
    db.uploads.push(buffer.toString('utf8'));
    return true;
  },
  downloadFromR2: async () => Buffer.from(''),
}));
// JPK_V7M jest wstrzymany (#66) — tu sprawdzamy sam plik, jak w exports-jpk-v7m-job.
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
    issuer: { nip: '5260001246', name: 'Moja Firma' },
    issuedInvoices: [
      {
        invoiceNumber: 'FV/WDT/1', currency: 'PLN',
        invoiceType: 'regular',
        issueDate: '2026-08-05',
        buyerName: 'Klient',
        buyerNip: '5252241585',
        netTotal: 1000,
        vatTotal: 230,
        grossTotal: 1230,
        ksefNumber: '5260001246-20260805-0100001AF629-AF',
        lines: [{ position: 1, name: 'Towar do DE', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '0 WDT', vatAmount: 0 }],
      } as JpkInvoice,
    ],
    receivedInvoices: [],
    expenses: [],
  }),
}));

/** Psuje plik tak, jak zrobiłby to błąd generatora: kod urzędu spoza słownika MF. */
const zepsuj = (xml: string) =>
  db.breakXml ? xml.replace(/(<(?:\w+:)?KodUrzedu>)\d+(<\/(?:\w+:)?KodUrzedu>)/, '$10000$2') : xml;

vi.mock('@/lib/exports/jpk-v7m-generator', async (orig) => {
  const real = await orig<typeof import('@/lib/exports/jpk-v7m-generator')>();
  return { ...real, generateJpkV7m: (...a: Parameters<typeof real.generateJpkV7m>) => zepsuj(real.generateJpkV7m(...a)) };
});
vi.mock('@/lib/exports/jpk-fa-generator', async (orig) => {
  const real = await orig<typeof import('@/lib/exports/jpk-fa-generator')>();
  return { ...real, generateJpkFa: (...a: Parameters<typeof real.generateJpkFa>) => zepsuj(real.generateJpkFa(...a)) };
});

import { onExportsGenerateExhausted, runExportsGenerate } from '@/lib/jobs/runners/exports-generate';

/**
 * W9 (C5a): faktura z importu historii KSeF ze stawką FA(3) bez odpowiednika
 * w FaktWay („0 WDT” — WDT ma w JPK_V7M własne pole) blokuje JPK za okres.
 * Odmowa ma nazwać dokument, nie ponawiać się bez sensu i trafić do Centrum
 * eksportu jako powód dla człowieka — nie „Nie udało się wygenerować pliku”.
 */

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

beforeEach(() => {
  db.uploads = [];
  db.updates = [];
  db.breakXml = false;
});

describe.each(['jpk_v7m', 'jpk_fa'] as const)('job eksportu %s z fakturą „0 WDT” z importu', (format) => {
  beforeEach(() => {
    db.format = format;
  });

  it('bez pliku, bez ponawiania, z numerem faktury w powodzie; Centrum eksportu pokazuje ten powód', async () => {
    const failure = await runExportsGenerate({ exportJobId: 'job-1' }, ctx).then(
      () => new Error('job nie odmówił'),
      (e: Error) => e,
    );

    expect(failure).toMatchObject({ name: 'NonRetriableError' });
    expect(failure.message).toMatch(/JPK wstrzymany:.*FV\/WDT\/1.*0 WDT/);
    expect(db.uploads).toEqual([]);

    db.updates = [];
    await onExportsGenerateExhausted(failure, { exportJobId: 'job-1' });
    expect(db.updates).toEqual([{ status: 'failed', error_message: failure.message }]);
  });
});
