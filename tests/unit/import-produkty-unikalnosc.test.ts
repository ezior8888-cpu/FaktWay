import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * Sesja 21 planu skalowania (DB-08 + #345): `products` dostaje UNIQUE na
 * kluczu katalogu (00184), więc dwa importy naraz nie tworzą dubla. Silnik
 * importu musi wtedy przeżyć 23505: drugi zapis tej samej pozycji to nie
 * awaria, a reszta nowych produktów z tej samej paczki ma trafić do katalogu.
 *
 * Atrapa egzekwuje unikalność jak Postgres: wstawienie paczki jest
 * atomowe — jeden konflikt i nie wchodzi żaden wiersz, błąd 23505.
 * „Drugi import” to wiersz dopisany między odczytem katalogu a zapisem.
 *
 * Przy okazji klucz liczony od jednostki zapisywanej w bazie: pusta
 * jednostka zapisuje się jako „szt.”, a klucz brał pustą — pozycja nigdy nie
 * trafiała w swój produkt i każdy import dokładał dubel (przy UNIQUE: 23505).
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => state.client }));

import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import { processImportedInvoices, type ImportEngineParams } from '@/lib/import/import-engine';

const T = '11111111-1111-4111-8111-111111111111';

let tables: MemoryTables;
/** Wiersze dopisane przez „drugi import” tuż przed pierwszym zapisem produktów. */
let concurrentWriter: Row[] = [];
let productInserts = 0;
/** Nazwa produktu, którego pojedynczy zapis pada innym błędem niż 23505. */
let brokenRow: string | null = null;

/** Klucz indeksu `uq_products_tenant_catalog_key` (00184) w wersji JS. */
const dbKey = (r: Row) => [
  r.tenant_id,
  String(r.name).replace(/\s+/g, ' ').trim().toLowerCase(),
  String(r.unit).trim().toLowerCase(),
].join('|');

function uniqueProductsClient(base: ReturnType<typeof memoryClient>) {
  return {
    from(table: string) {
      const query = base.from(table);
      if (table !== 'products') return query;
      const plainInsert = query.insert;
      query.insert = (payload: Row | Row[]) => {
        productInserts += 1;
        if (concurrentWriter.length) {
          tables.products!.push(...concurrentWriter);
          concurrentWriter = [];
        }
        const list = Array.isArray(payload) ? payload : [payload];
        const failWith = (error: { code: string; message: string }) => {
          const result = { data: null, error, count: null };
          const failed = {
            select: () => failed,
            single: () => failed,
            then: <A, B>(ok: (v: typeof result) => A, fail?: (e: unknown) => B) => Promise.resolve(result).then(ok, fail),
          };
          return failed as unknown as typeof query;
        };
        if (!Array.isArray(payload) && payload.name === brokenRow) return failWith({ code: 'XX000', message: 'db down' });
        const taken = new Set(tables.products!.map(dbKey));
        const conflict = list.some((row) => {
          const key = dbKey(row);
          if (taken.has(key)) return true;
          taken.add(key);
          return false;
        });
        if (!conflict) return plainInsert(payload);
        return failWith({ code: '23505', message: 'duplicate key value violates unique constraint "uq_products_tenant_catalog_key"' });
      };
      return query;
    },
  };
}

function invoice(n: string, lines: Array<{ name: string; unit: string }>): ParsedInvoice {
  return {
    invoiceNumber: n,
    issueDate: '2026-09-10',
    invoiceType: 'regular',
    seller: { nip: '1234567890', name: 'Sprzedawca Testowy' },
    buyer: { nip: '1111111111', name: 'Nabywca' },
    lines: lines.map((line, i) => ({
      position: i + 1, name: line.name, unit: line.unit, quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100,
    })),
    totals: { netTotal: 100 * lines.length, vatTotal: 23 * lines.length, grossTotal: 123 * lines.length },
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

const productsNamed = (name: string) => tables.products!.filter((p) => p.name === name);
const insertWarnings = (warnings: string[]) => warnings.filter((w) => w.startsWith('Produkty: insert'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'));
  concurrentWriter = [];
  productInserts = 0;
  brokenRow = null;
  tables = { contractors: [], products: [], invoices: [], invoice_line_items: [], xml_documents: [] };
  state.client = uniqueProductsClient(memoryClient(tables));
});

describe('UNIQUE na katalogu produktów (00184): import przeżywa 23505', () => {
  it('drugi import dopisał ten sam produkt w międzyczasie: bez dubla, reszta paczki trafia do katalogu', async () => {
    concurrentWriter = [{ id: 'p-obcy', tenant_id: T, name: 'Szkolenie zespołu', unit: 'usł.', use_count: 1 }];

    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/1/09/2026', [{ name: 'Szkolenie zespołu', unit: 'usł.' }, { name: 'Wdrożenie systemu', unit: 'usł.' }])],
    });

    expect(productsNamed('Szkolenie zespołu')).toEqual([expect.objectContaining({ id: 'p-obcy' })]);
    expect(productsNamed('Wdrożenie systemu')).toHaveLength(1);
    expect(result.productsCreated).toBe(1);
    expect(insertWarnings(result.warnings)).toEqual([]);
  });

  it('cała paczka zajęta przez drugi import: zero nowych, bez ostrzeżenia i bez wyjątku', async () => {
    concurrentWriter = [
      { id: 'p-a', tenant_id: T, name: 'Szkolenie zespołu', unit: 'usł.', use_count: 1 },
      { id: 'p-b', tenant_id: T, name: 'Wdrożenie systemu', unit: 'usł.', use_count: 1 },
    ];

    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/2/09/2026', [{ name: 'Szkolenie zespołu', unit: 'usł.' }, { name: 'Wdrożenie systemu', unit: 'usł.' }])],
    });

    expect(result.productsCreated).toBe(0);
    expect(tables.products).toHaveLength(2);
    expect(insertWarnings(result.warnings)).toEqual([]);
  });

  it('bez konfliktu: jeden zapis paczką (bez zapytań wiersz po wierszu)', async () => {
    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/3/09/2026', [{ name: 'Szkolenie zespołu', unit: 'usł.' }, { name: 'Wdrożenie systemu', unit: 'usł.' }])],
    });

    expect(result.productsCreated).toBe(2);
    expect(productInserts).toBe(1);
  });

  it('po 23505 paczki inny błąd jednego wiersza: ostrzeżenie z nazwą produktu, bez myślnika, reszta trafia do katalogu', async () => {
    concurrentWriter = [{ id: 'p-obcy', tenant_id: T, name: 'Szkolenie zespołu', unit: 'usł.', use_count: 1 }];
    brokenRow = 'Wdrożenie systemu';

    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/8/09/2026', [
        { name: 'Szkolenie zespołu', unit: 'usł.' },
        { name: 'Wdrożenie systemu', unit: 'usł.' },
        { name: 'Audyt bezpieczeństwa', unit: 'usł.' },
      ])],
    });

    expect(result.productsCreated).toBe(1);
    expect(productsNamed('Audyt bezpieczeństwa')).toHaveLength(1);
    expect(productsNamed('Wdrożenie systemu')).toEqual([]);
    expect(result.warnings.filter((w) => w.startsWith('Produkt'))).toEqual(['Produkt „Wdrożenie systemu…” nie trafił do katalogu: db down']);
  });

  it('błąd inny niż 23505: jak dotąd ostrzeżenie i zero nowych', async () => {
    state.client = memoryClient(tables, { failInsertInto: ['products'] });

    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/4/09/2026', [{ name: 'Szkolenie zespołu', unit: 'usł.' }])],
    });

    expect(result.productsCreated).toBe(0);
    expect(insertWarnings(result.warnings)).toEqual(['Produkty: insert — db down']);
  });
});

describe('klucz produktu liczony od jednostki zapisywanej w bazie', () => {
  it('pozycja bez jednostki trafia w produkt „szt.” zamiast dokładać dubel', async () => {
    tables.products!.push({ id: 'p-1', tenant_id: T, name: 'Konsultacja techniczna', unit: 'szt.', use_count: 3 });

    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/5/09/2026', [{ name: 'Konsultacja techniczna', unit: '' }])],
    });

    expect(result.productsCreated).toBe(0);
    expect(productsNamed('Konsultacja techniczna')).toEqual([expect.objectContaining({ id: 'p-1', use_count: 4 })]);
    expect(result.warnings).toEqual([]);
  });

  it('pusta jednostka i „szt.” w jednym imporcie trafiają w ten sam istniejący produkt: oba użycia doliczone', async () => {
    tables.products!.push({ id: 'p-1', tenant_id: T, name: 'Konsultacja techniczna', unit: 'szt.', use_count: 3 });

    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/7/09/2026', [{ name: 'Konsultacja techniczna', unit: '' }, { name: 'Konsultacja techniczna', unit: 'szt.' }])],
    });

    expect(result.productsCreated).toBe(0);
    expect(productsNamed('Konsultacja techniczna')).toEqual([expect.objectContaining({ id: 'p-1', use_count: 5 })]);
    expect(result.warnings).toEqual([]);
  });

  it('ta sama nazwa z pustą jednostką i z „szt.” w jednym imporcie: jeden produkt, liczba użyć zsumowana', async () => {
    const result = await processImportedInvoices({
      ...SALE,
      invoices: [invoice('FV/6/09/2026', [{ name: 'Konsultacja techniczna', unit: '' }, { name: 'Konsultacja techniczna', unit: 'szt.' }])],
    });

    expect(result.productsCreated).toBe(1);
    expect(productsNamed('Konsultacja techniczna')).toEqual([expect.objectContaining({ unit: 'szt.', use_count: 2 })]);
    expect(result.warnings).toEqual([]);
  });
});
