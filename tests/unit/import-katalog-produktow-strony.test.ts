import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables } from './helpers/baza-w-pamieci';

/**
 * Sesja 27 planu skalowania: silnik importu czyta CAŁY katalog produktów
 * firmy, żeby dopasować pozycję faktury do istniejącego produktu. Jedno
 * zapytanie oddawało najwyżej 1000 wierszy (PGRST_DB_MAX_ROWS), więc pozycja
 * pasująca do produktu spoza tej części szła do INSERT — tabela `products`
 * nie ma UNIQUE, powstawał dubel. Historia KSeF woła silnik dla każdej
 * pobranej faktury, więc dubel rósł z każdą kolejną fakturą.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => state.client }));

import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import { processImportedInvoices, type ImportEngineParams } from '@/lib/import/import-engine';

const T = '11111111-1111-4111-8111-111111111111';
const PRODUCTS = 1200;
/** Produkt spoza pierwszych 1000 wierszy (kolejność sterty = kolejność wstawienia). */
const BEYOND = 1100;
const productId = (n: number) => `${String(n).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;

let tables: MemoryTables;

function invoice(n: string, line: string): ParsedInvoice {
  return {
    invoiceNumber: n,
    issueDate: '2026-09-10',
    invoiceType: 'regular',
    seller: { nip: '1234567890', name: 'Sprzedawca Testowy' },
    buyer: { nip: '1111111111', name: 'Nabywca' },
    lines: [{ position: 1, name: line, unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100 }],
    totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
    warnings: [],
  };
}

const SALE: Omit<ImportEngineParams, 'invoices'> = {
  tenantId: T,
  importJobId: 'import-1',
  source: 'csv',
  invoiceDirection: 'outgoing',
  invoiceKsefStatus: 'draft',
};

const productsNamed = (name: string) => tables.products.filter((p) => p.name === name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'));
  tables = {
    contractors: [],
    products: Array.from({ length: PRODUCTS }, (_, i) => ({
      id: productId(i + 1), tenant_id: T, name: `Transport trasa ${i + 1}`, unit: 'usł.', use_count: 3,
    })),
    invoices: [],
    invoice_line_items: [],
    xml_documents: [],
  };
  state.client = memoryClient(tables, { maxRows: 1000 });
});

describe(`katalog ${PRODUCTS} produktów przy limicie PostgREST 1000`, () => {
  it('upsert (import pliku): pozycja pasująca do produktu nr 1100 zwiększa jego use_count, bez dubla', async () => {
    const result = await processImportedInvoices({ ...SALE, invoices: [invoice('FV/1/09/2026', `Transport trasa ${BEYOND}`)] });
    expect(result.productsCreated).toBe(0);
    expect(productsNamed(`Transport trasa ${BEYOND}`)).toEqual([expect.objectContaining({ id: productId(BEYOND), use_count: 4 })]);
    expect(tables.products).toHaveLength(PRODUCTS);
  });

  it('insert-only (historia KSeF): istniejący produkt spoza pierwszych 1000 — bez dubla, use_count bez zmian', async () => {
    const result = await processImportedInvoices({
      ...SALE,
      source: 'ksef_history',
      invoiceKsefStatus: 'accepted',
      ksefEnvironment: 'test',
      catalogPolicy: { contractors: 'insert-only', products: 'insert-only' },
      invoices: [{ ...invoice('FV/2/09/2026', `Transport trasa ${BEYOND}`), ksefNumber: '1234567890-20260910-AAAAAAAAAAAA-01' }],
    });
    expect(result.productsCreated).toBe(0);
    expect(productsNamed(`Transport trasa ${BEYOND}`)).toEqual([expect.objectContaining({ id: productId(BEYOND), use_count: 3 })]);
  });

  it('naprawdę nowa pozycja dalej trafia do katalogu', async () => {
    const result = await processImportedInvoices({ ...SALE, invoices: [invoice('FV/3/09/2026', 'Transport trasa nowa')] });
    expect(result.productsCreated).toBe(1);
    expect(productsNamed('Transport trasa nowa')).toHaveLength(1);
  });
});
