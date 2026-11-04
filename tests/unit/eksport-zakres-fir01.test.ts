import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NonRetriableError } from '@/lib/jobs/errors';
import type { JobContext } from '@/lib/jobs/registry';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * FIR-01 (przegląd architektury 26.10.2026): zakres eksportu ustalał tylko
 * formularz w przeglądarce. Runner ufał flagom joba, więc Co-Pilot z
 * odznaczonymi „Fakturami korygującymi” wysyłał księgowej KPiR bez zaliczek
 * (ZAL), faktur rozliczeniowych (ROZ) i korekt, a z odznaczonymi „Fakturami
 * wystawionymi” — KPiR bez żadnego przychodu. Plik wyglądał poprawnie.
 *
 * Prawdziwa ścieżka: runner → pobieranie danych → generator KPiR. Atrapa
 * tylko bazy (w pamięci) i magazynu plików.
 */

const mocks = vi.hoisted(() => ({
  tables: {} as MemoryTables,
  uploads: [] as Buffer[],
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const client = memoryClient(mocks.tables);
    return {
      from: (table: string) =>
        table === 'export_files'
          ? {
              upsert: async (row: Row) => {
                (mocks.tables.export_files ??= []).push(row);
                return { data: null, error: null };
              },
            }
          : client.from(table),
    };
  },
}));
vi.mock('@/lib/storage/r2', () => ({
  uploadToR2IfAbsent: async (_path: string, buffer: Buffer) => {
    mocks.uploads.push(buffer);
    return true;
  },
  downloadFromR2: vi.fn(),
}));

import { runExportsGenerate } from '@/lib/jobs/runners/exports-generate';

const FIRMA = 'firma-a';
// Jeden kształt id (kolejność `localeCompare` atrapy = kolejność kodów znaków).
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function faktura(o: Row): Row {
  return {
    tenant_id: FIRMA, direction: 'outgoing', ksef_status: 'accepted', ksef_environment: 'test',
    origin: 'app', invoice_type: null, currency: 'PLN', sale_date: null, payment_due_date: null,
    buyer_data: { name: 'Klient' }, buyer_nip: null, seller_data: null, seller_nip: null,
    fa3_data: null, parent_invoice_id: null, advance_invoice_ids: [], correction_reason: null,
    ksef_number: null, net_total: 0, vat_total: 0, gross_total: 0,
    ...o,
  };
}

const FV = faktura({ id: id(1), internal_number: 'FV/1', invoice_kind: 'regular', issue_date: '2026-09-05', net_total: 1000, vat_total: 230, gross_total: 1230 });
const ZAL = faktura({ id: id(2), internal_number: 'ZAL/1', invoice_kind: 'advance', issue_date: '2026-09-10', net_total: 10000, vat_total: 2300, gross_total: 12300 });
const ROZ = faktura({ id: id(3), internal_number: 'ROZ/1', invoice_kind: 'final', issue_date: '2026-09-20', net_total: 35000, vat_total: 8050, gross_total: 43050, advance_invoice_ids: [id(2)] });
const KOR = faktura({ id: id(4), internal_number: 'KOR/1', invoice_kind: 'correction', issue_date: '2026-09-25', net_total: -100, vat_total: -23, gross_total: -123, parent_invoice_id: id(1), correction_reason: 'Rabat' });
/** Przyjęta faktura zakupowa bez środowiska KSeF — KPiR jej nie czyta (koszty idą z wydatków). */
const OBCA_BEZ_SRODOWISKA = faktura({ id: id(5), direction: 'incoming', internal_number: 'OBCA/1', invoice_kind: 'regular', issue_date: '2026-09-12', ksef_environment: null, net_total: 500 });

const KOSZT: Row = {
  id: id(10), tenant_id: FIRMA, is_deductible: true, issue_date: '2026-09-15',
  source: 'manual', ksef_invoice_id: null,
  document_number: 'FK/9', document_type: 'invoice',
  seller_name: 'Dostawca', seller_nip: null, seller_address: null,
  net_amount: 200, vat_amount: 46, gross_amount: 246, vat_deductible_amount: 46,
  kpir_column: 'col_13', category_label: 'Usługi', is_reviewed: true, ocr_extracted_data: null,
};

/** Przychód KPiR: 1000 + 10 000 + (35 000 − 10 000 zaliczki) − 100 korekty. */
const PELNY_PRZYCHOD = 35900;

function job(flags: { include_issued: boolean; include_received: boolean; include_corrections: boolean }): Row {
  return {
    id: 'job-1', tenant_id: FIRMA, format: 'kpir_excel', status: 'pending',
    trigger_source: 'co_pilot_monthly', period_start: '2026-09-01', period_end: '2026-09-30',
    invoices_count: 0, ...flags,
  };
}

const context: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: {
    run: async (_name, work) => work(),
    sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn(),
  },
};

/** Numery dokumentów (kol. 3) i suma przychodu (kol. 7, wiersz podsumowania) z pliku. */
async function kpirZPliku(): Promise<{ numery: string[]; przychod: unknown }> {
  expect(mocks.uploads).toHaveLength(1);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(mocks.uploads[0] as unknown as ArrayBuffer);
  const sheet = wb.getWorksheet('KPiR')!;
  const numery: string[] = [];
  for (let r = 2; r < sheet.rowCount; r++) numery.push(String(sheet.getRow(r).getCell(3).value));
  return { numery, przychod: sheet.getRow(sheet.rowCount).getCell(7).value };
}

beforeEach(() => {
  mocks.uploads = [];
  mocks.tables = {
    tenants: [{ id: FIRMA, nip: '1234567890', name: 'Firma A', address_json: null }],
    invoices: [FV, ZAL, ROZ, KOR].map((row) => ({ ...row })),
    invoice_line_items: [],
    expenses: [{ ...KOSZT }],
    export_files: [],
  };
});

describe('FIR-01: KPiR z Co-Pilota ma pełny przychód, niezależnie od ustawień paczki', () => {
  it.each([
    ['odznaczone „Faktury korygujące”', { include_issued: true, include_received: true, include_corrections: false }],
    ['odznaczone „Faktury wystawione”', { include_issued: false, include_received: true, include_corrections: true }],
    ['odznaczone wszystko', { include_issued: false, include_received: false, include_corrections: false }],
  ])('%s: plik ma sprzedaż, zaliczki, ROZ i korekty', async (_opis, flags) => {
    mocks.tables.export_jobs = [job(flags)];

    await expect(runExportsGenerate({ exportJobId: 'job-1' }, context))
      .resolves.toMatchObject({ success: true });

    const { numery, przychod } = await kpirZPliku();
    expect(numery).toEqual(['FV/1', 'ZAL/1', 'FK/9', 'ROZ/1', 'KOR/1']);
    expect(przychod).toBe(PELNY_PRZYCHOD);
  });

  it('wiersz joba po wygenerowaniu mówi prawdę o zakresie pliku', async () => {
    mocks.tables.export_jobs = [job({ include_issued: false, include_received: false, include_corrections: false })];

    await runExportsGenerate({ exportJobId: 'job-1' }, context);

    expect(mocks.tables.export_jobs[0]).toMatchObject({
      status: 'completed',
      include_issued: true,
      include_received: true,
      include_corrections: true,
      // Sprzedaż z pliku — bez faktur zakupowych, których KPiR nie czyta.
      invoices_count: 4,
    });
  });

  it('KPiR nie czyta faktur otrzymanych: zakupowa bez środowiska KSeF nie zatrzymuje pliku', async () => {
    mocks.tables.invoices!.push({ ...OBCA_BEZ_SRODOWISKA });
    mocks.tables.export_jobs = [job({ include_issued: true, include_received: true, include_corrections: true })];

    await expect(runExportsGenerate({ exportJobId: 'job-1' }, context))
      .resolves.toMatchObject({ success: true, invoicesCount: 4 });

    const { numery } = await kpirZPliku();
    expect(numery).not.toContain('OBCA/1');
  });
});

describe('FIR-01: format spoza reguły (enum w bazie wyprzedza kod)', () => {
  it('job kończy się od razu, bez ponowień i bez pliku', async () => {
    mocks.tables.export_jobs = [{ ...job({ include_issued: true, include_received: false, include_corrections: true }), format: 'nowy_format' }];

    await expect(runExportsGenerate({ exportJobId: 'job-1' }, context)).rejects.toBeInstanceOf(NonRetriableError);
    expect(mocks.uploads).toEqual([]);
    // Zakres liczony przed `mark-generating` — wiersz nie udaje generowania.
    expect(mocks.tables.export_jobs[0]).toMatchObject({ status: 'pending' });
  });
});
