import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GusLookupResult } from '@/lib/gus/client';
import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  format: 'jpk_fa',
  generation: 0,
  generationCount: 0,
  stored: new Map<string, Buffer>(),
  putBodies: [] as Buffer[],
  downloads: [] as string[],
  fileRows: [] as Row[],
}));

// These generators deliberately return different bytes on every call, as the
// real JPK timestamps and XLSX metadata can do between the two old steps.
vi.mock('@/lib/exports/jpk-fa-generator', async (original) => ({
  // Klasy błędów (np. JpkFaCorrectionNotSupportedError z main) zostają prawdziwe.
  ...(await original<typeof import('@/lib/exports/jpk-fa-generator')>()),
  generateJpkFa: () => {
    state.generationCount++;
    return `<JPK_FA generated="${++state.generation}"/>`;
  },
}));
vi.mock('@/lib/exports/jpk-v7m-generator', async (original) => ({
  ...(await original<typeof import('@/lib/exports/jpk-v7m-generator')>()),
  generateJpkV7m: () => {
    state.generationCount++;
    return `<JPK_V7M generated="${++state.generation}"/>`;
  },
}));
// Atrapa wyżej nie jest prawdziwym plikiem JPK_V7M, więc strażnik pliku (F13 część 2b,
// własne testy w bezpieczniki-jpk-v7m-eksport.test.ts) słusznie by go odrzucił; tu liczy się skrót bajtów.
vi.mock('@/lib/bezpieczniki/jpk-v7m', async (original) => ({
  ...(await original<typeof import('@/lib/bezpieczniki/jpk-v7m')>()),
  sprawdzJpkV7m: () => [],
}));
vi.mock('@/lib/exports/kpir-generator', () => ({
  generateKpirXlsx: async () => {
    state.generationCount++;
    return Buffer.from(`XLSX generated ${++state.generation}`);
  },
}));
vi.mock('@/lib/exports/tax-office', () => ({
  MissingTaxOfficeError: class MissingTaxOfficeError extends Error {
    constructor() { super('Brak urzędu skarbowego'); }
  },
  readTenantTaxOffice: async () => '1433',
}));
vi.mock('@/lib/exports/taxpayer-email', () => ({ readTaxpayerEmail: async () => 'owner@example.test' }));
// JPK_FA czyta adres siedziby z GUS (`readIssuerRegisteredAddress`). Bez atrapy
// test pytał testową bazę GUS przez sieć i padał, gdy ta nie odpowiadała.
// `gusUsesSandbox` zostaje prawdziwy.
vi.mock('@/lib/gus/client', async (original) => ({
  ...(await original<typeof import('@/lib/gus/client')>()),
  lookupCompanyByNip: async (nip: string): Promise<GusLookupResult> => ({
    kind: 'found',
    data: {
      nip, regon: '012345678', name: 'Firma',
      postalCode: '00-001', city: 'Warszawa', street: 'ul. Testowa', buildingNumber: '1',
      voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Śródmieście',
    },
  }),
}));
vi.mock('@/lib/exports/data-fetcher', () => ({
  fetchInvoicesForExport: async () => ({
    issuer: { nip: '1234567890', name: 'Firma' },
    issuedInvoices: [{ netTotal: 100, vatTotal: 23, grossTotal: 123 }],
    receivedInvoices: [],
    expenses: [],
  }),
}));
// Ten test sprawdza tylko hash zapisanego pliku: bramki main (JPK_V7M
// wstrzymany #66, kontrola XSD AUD-121) wyłączone atrapą.
vi.mock('@/lib/exports/suspended-formats', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/suspended-formats')>()),
  isExportFormatSuspended: () => false,
}));
vi.mock('@/lib/exports/jpk-schema-check', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/jpk-schema-check')>()),
  assertJpkMatchesSchema: async () => undefined,
}));
vi.mock('@/lib/storage/r2', () => ({
  uploadToR2IfAbsent: async (path: string, body: Buffer) => {
    state.putBodies.push(Buffer.from(body));
    if (state.stored.has(path)) return false;
    state.stored.set(path, Buffer.from(body));
    return true;
  },
  downloadFromR2: async (path: string) => {
    state.downloads.push(path);
    const body = state.stored.get(path);
    if (!body) throw new Error('Missing stored export');
    return Buffer.from(body);
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        update: () => q,
        single: async () => ({
          data: table === 'export_jobs' ? {
            id: 'job-1', tenant_id: 'tenant-a', format: state.format,
            period_start: '2026-09-01', period_end: '2026-09-30',
            include_issued: true, include_received: false, include_corrections: true,
          } : null,
          error: null,
        }),
        upsert: async (row: Row) => {
          state.fileRows.push(row);
          return { error: null };
        },
        then: <T,>(resolve: (result: { error: null }) => T) =>
          Promise.resolve({ error: null as null }).then(resolve),
      });
      return q;
    },
  }),
}));

import { runExportsGenerate } from '@/lib/jobs/runners/exports-generate';

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: {
    run: async (_name, work) => work(),
    sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn(),
  },
};

beforeEach(() => {
  state.format = 'jpk_fa';
  state.generation = 0;
  state.generationCount = 0;
  state.stored.clear();
  state.putBodies = [];
  state.downloads = [];
  state.fileRows = [];
});

describe('eksport: hash zapisanych bajtów', () => {
  it.each(['jpk_fa', 'jpk_v7m', 'kpir_excel'])(
    '%s: generuje raz i zapisuje hash dokładnie wysłanego pliku',
    async (format) => {
      state.format = format;
      await runExportsGenerate({ exportJobId: 'job-1' }, context);

      expect(state.generationCount).toBe(1);
      expect(state.putBodies).toHaveLength(1);
      const file = state.fileRows[0]!;
      const stored = state.stored.get(String(file.r2_path))!;
      expect(stored).toEqual(state.putBodies[0]);
      expect(file.file_hash).toBe(createHash('sha256').update(stored).digest('hex'));
      expect(file.size_bytes).toBe(stored.length);
      expect(state.downloads).toEqual([]);
    },
  );

  it('po ponowieniu zachowuje pierwszy obiekt i hashuje jego rzeczywistą treść', async () => {
    await runExportsGenerate({ exportJobId: 'job-1' }, context);
    const first = state.fileRows[0]!;
    const path = String(first.r2_path);
    const firstBytes = Buffer.from(state.stored.get(path)!);

    await runExportsGenerate({ exportJobId: 'job-1' }, context);

    expect(state.generationCount).toBe(2);
    expect(state.putBodies[1]).not.toEqual(firstBytes);
    expect(state.stored.get(path)).toEqual(firstBytes);
    expect(state.downloads).toEqual([path]);
    const retried = state.fileRows[1]!;
    expect(retried.file_hash).toBe(createHash('sha256').update(firstBytes).digest('hex'));
    expect(retried.size_bytes).toBe(firstBytes.length);
  });
});
