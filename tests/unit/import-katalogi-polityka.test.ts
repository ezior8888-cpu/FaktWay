import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * Silnik importu dla synchronizacji historii KSeF (decyzja Bartosza 22.10.2026):
 *   - `catalogPolicy` — `insert-only` nie nadpisuje kontrahenta i nie zwiększa
 *     `use_count` produktu (IMP-PROD), `skip` nie pisze katalogów wcale
 *     (zakupy z historii to archiwum), domyślnie — bez zmian (`upsert`),
 *   - `ksefAcceptedAt` — chwila nadania numeru w KSeF zamiast chwili importu
 *     (IMP-ACC); niepoprawna wartość = chwila importu z ostrzeżeniem,
 *   - `processImportedInvoicesDetailed().held` — notatki JPK osobno; wynik
 *     `processImportedInvoices` bez zmian (migawka import-wiersze-tozsamosc).
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => state.client }));

import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import {
  processImportedInvoices,
  processImportedInvoicesDetailed,
  type ImportEngineParams,
} from '@/lib/import/import-engine';

const T = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-22T10:00:00.000Z');

let tables: MemoryTables;

function invoice(n: string, extra: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    invoiceNumber: n,
    issueDate: '2026-09-10',
    invoiceType: 'regular',
    seller: { nip: '1234567890', name: 'Sprzedawca Testowy' },
    buyer: { nip: '1111111111', name: 'Nabywca z KSeF' },
    lines: [{ position: 1, name: 'Usługa programistyczna', unit: 'godz.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100 }],
    totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
    warnings: [],
    ...extra,
  };
}

const KSEF_SALE: Omit<ImportEngineParams, 'invoices'> = {
  tenantId: T,
  importJobId: 'strumien-1',
  source: 'ksef_history',
  invoiceDirection: 'outgoing',
  invoiceKsefStatus: 'accepted',
  ksefEnvironment: 'test',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  tables = {
    contractors: [{ id: 'c-1', tenant_id: T, nip: '1111111111', name: 'Nazwa poprawiona ręcznie', email: 'ksiegowosc@example.test', address: null }],
    products: [{ id: 'p-1', tenant_id: T, name: 'Usługa programistyczna', unit: 'godz.', use_count: 7 }],
    invoices: [],
    invoice_line_items: [],
    xml_documents: [],
  };
  state.client = memoryClient(tables);
});

describe('catalogPolicy', () => {
  it('insert-only: nowy kontrahent i produkt dopisane, istniejące bez zmian (bez use_count)', async () => {
    const result = await processImportedInvoices({
      ...KSEF_SALE,
      catalogPolicy: { contractors: 'insert-only', products: 'insert-only' },
      invoices: [
        invoice('FV/1/09/2026', { ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-01' }),
        invoice('FV/2/09/2026', {
          ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-02',
          buyer: { nip: '2222222222', name: 'Nowy Nabywca' },
          lines: [{ position: 1, name: 'Szkolenie zespołu', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100 }],
        }),
      ],
    });
    expect(result.invoicesImported).toBe(2);
    expect(tables.contractors.find((c) => c.nip === '1111111111')).toMatchObject({
      name: 'Nazwa poprawiona ręcznie', email: 'ksiegowosc@example.test',
    });
    expect(tables.contractors.map((c) => c.nip).sort()).toEqual(['1111111111', '2222222222']);
    expect(tables.products.find((p) => p.id === 'p-1')?.use_count).toBe(7);
    expect(tables.products.map((p) => p.name).sort()).toEqual(['Szkolenie zespołu', 'Usługa programistyczna']);
    expect(result.contractorsUpdated).toBe(0);
  });

  it('skip: katalogi nietknięte (zakupy z historii — archiwum)', async () => {
    const before = JSON.stringify({ c: tables.contractors, p: tables.products });
    const result = await processImportedInvoices({
      ...KSEF_SALE,
      invoiceDirection: 'incoming',
      catalogPolicy: { contractors: 'skip', products: 'skip' },
      invoices: [invoice('ZAKUP/7', {
        ksefNumber: '9999999999-20260910-BBBBBBBBBBBB-01',
        seller: { nip: '3333333333', name: 'Dostawca' },
      })],
    });
    expect(result).toMatchObject({ invoicesImported: 1, contractorsCreated: 0, contractorsUpdated: 0, productsCreated: 0 });
    expect(JSON.stringify({ c: tables.contractors, p: tables.products })).toBe(before);
  });

  it('domyślnie (bez polityki) — jak dotąd: kontrahent nadpisany, use_count zwiększony', async () => {
    await processImportedInvoices({
      ...KSEF_SALE,
      invoices: [invoice('FV/3/09/2026', { ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-03' })],
    });
    expect(tables.contractors.find((c) => c.nip === '1111111111')?.name).toBe('Nabywca z KSeF');
    expect(tables.products.find((p) => p.id === 'p-1')?.use_count).toBe(8);
  });
});

describe('ksefAcceptedAt (IMP-ACC)', () => {
  const accepted = () => (tables.invoices[0] as Row).ksef_accepted_at;

  it('chwila nadania numeru w KSeF trafia do ksef_accepted_at', async () => {
    const result = await processImportedInvoices({
      ...KSEF_SALE,
      invoices: [invoice('FV/4/09/2026', {
        ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-04',
        ksefAcceptedAt: '2024-03-05T09:15:00+01:00',
      })],
    });
    expect(result.invoicesImported).toBe(1);
    expect(accepted()).toBe('2024-03-05T08:15:00.000Z');
    expect(result.warnings.join('\n')).not.toContain('brak daty przyjęcia');
  });

  it('pusta albo niepoprawna wartość — chwila importu i ostrzeżenie', async () => {
    const result = await processImportedInvoices({
      ...KSEF_SALE,
      invoices: [invoice('FV/5/09/2026', { ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-05', ksefAcceptedAt: '' })],
    });
    expect(accepted()).toBe(NOW.toISOString());
    expect(result.warnings).toContain('FV/5/09/2026: brak daty przyjęcia w KSeF — użyto chwili importu');
  });

  it('bez pola — jak dotąd: chwila importu, bez ostrzeżenia', async () => {
    const result = await processImportedInvoices({
      ...KSEF_SALE,
      invoices: [invoice('FV/6/09/2026', { ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-06' })],
    });
    expect(accepted()).toBe(NOW.toISOString());
    expect(result.warnings.join('\n')).not.toContain('brak daty przyjęcia');
  });
});

describe('held', () => {
  it('notatki JPK osobno w wyniku szczegółowym; wynik zwykły bez klucza `held`', async () => {
    const params: ImportEngineParams = {
      ...KSEF_SALE,
      invoices: [invoice('FV/7/09/2026', {
        ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-07',
        lines: [{ position: 1, name: 'Usługa programistyczna', unit: 'godz.', quantity: 1, unitPriceNet: 100, vatRate: '22', netAmount: 100 }],
        totals: { netTotal: 100, vatTotal: 22, grossTotal: 122 },
      })],
    };
    const detailed = await processImportedInvoicesDetailed(params);
    expect(detailed.held).toHaveLength(1);
    expect(detailed.warnings[0]).toBe(detailed.held[0]);

    tables.invoices.length = 0;
    tables.invoice_line_items.length = 0;
    const plain = await processImportedInvoices(params);
    expect(Object.keys(plain).sort()).toEqual([
      'contractorsCreated', 'contractorsUpdated', 'invoicesFailed', 'invoicesImported', 'productsCreated', 'warnings',
    ]);
  });
});
