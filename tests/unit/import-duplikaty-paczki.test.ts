import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * Sesja 32 planu skalowania (F-089): silnik importu pytał o duplikaty
 * i kontrahentów jednym `.in()` z CAŁĄ listą z pliku. PostgREST dostaje
 * filtr w adresie GET, więc 1500 numerów faktur to adres ok. 35 tys. znaków —
 * bramka go odrzuca i import kończy się błędem „Faktury: odczyt duplikatów…”
 * (po zapisaniu kontrahentów z pliku). Do tego produkcja ucina każdą
 * odpowiedź do 1000 wierszy (`PGRST_DB_MAX_ROWS`), więc paczka, która
 * dopasuje więcej, po cichu gubi duplikaty.
 *
 * Prawdziwa ścieżka: plik CSV Fakturowni → `runBulkImportFile` (parser,
 * silnik, zapis wyniku w `import_jobs`). Atrapy tylko dla magazynu plików
 * i bazy: baza w pamięci (`maxRows: 1000` jak produkcja) za „bramką”, która
 * odtwarza każde zapytanie na prawdziwym budowniczym `supabase-js` (bez
 * wysyłania) i mierzy adres, jaki poszedłby do PostgREST. Adres dłuższy niż
 * 8000 znaków bramka odrzuca jak Kong (414) — próg to `urlLengthLimit`
 * z postgrest-js; nginx w Kongu domyślnie przyjmuje wiersz żądania do 8 KB.
 *
 * NIP-y w teście mają celowo złą sumę kontrolną (jak testowy 1234567890),
 * więc żaden nie jest prawdziwy.
 */

const state = vi.hoisted(() => ({ client: null as unknown, csv: '' }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => state.client }));
vi.mock('@/lib/import/file-storage', () => ({ downloadImportFile: vi.fn(async () => Buffer.from(state.csv, 'utf8')) }));

import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import { processImportedInvoices } from '@/lib/import/import-engine';
import { runBulkImportFile } from '@/lib/jobs/runners/bulk-import';
import type { JobContext } from '@/lib/jobs/registry';

const T = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const FILE_PATH = `imports/${T}/faktury.csv`;
const SELLER_NIP = '1234567890';
/** Próg bramki w atrapie (414 powyżej). */
const GATEWAY_URL_LIMIT = 8000;
/** Kryterium sesji 32: najwięcej wartości w jednym `.in()`. */
const MAX_IN_VALUES = 100;

const uuid = (prefix: string, n: number) => `${prefix}${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;

/** 10 cyfr ze złą sumą kontrolną NIP — na pewno nie istniejący podatnik. */
function fictionalNip(n: number): string {
  const prefix = String(900_000_000 + n);
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const check = weights.reduce((sum, w, i) => sum + w * Number(prefix[i]), 0) % 11;
  return `${prefix}${(check + 1) % 10}`;
}

// ─── Bramka: zapis zapytań i pomiar adresu ─────────────────────────────────

interface QueryRecord {
  table: string;
  method: string;
  /** Ścieżka z parametrami, jak w wierszu żądania HTTP. */
  url: string;
  /** Liczba wartości w każdym `.in()` tego zapytania. */
  inValues: number[];
}

/** Budowniczy z prawdziwego supabase-js — tylko do zbudowania adresu, nic nie wysyła. */
const shadowClient = createClient('http://kong:8000', 'klucz-testowy', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

type Chain = Record<PropertyKey, (...args: unknown[]) => unknown>;

function gatewayClient(
  inner: ReturnType<typeof memoryClient>,
  log: QueryRecord[],
  options: { failRead?: (record: QueryRecord, readNo: number) => boolean } = {},
) {
  let reads = 0;
  return {
    from(table: string) {
      const record: QueryRecord = { table, method: 'GET', url: '', inValues: [] };
      let mem = inner.from(table) as unknown as Chain;
      let shadow = shadowClient.from(table) as unknown as Chain;
      const chain: object = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'then') {
            return (ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) => {
              const built = shadow as unknown as { url: URL; method: string };
              record.url = built.url.pathname + built.url.search;
              record.method = built.method;
              log.push(record);
              if (record.url.length > GATEWAY_URL_LIMIT) {
                return Promise.resolve({ data: null, error: { message: '414 Request-URI Too Large' }, count: null }).then(ok, fail);
              }
              if (record.method === 'GET' && options.failRead?.(record, ++reads)) {
                return Promise.resolve({ data: null, error: { message: 'db down' }, count: null }).then(ok, fail);
              }
              return (mem as unknown as PromiseLike<unknown>).then(ok, fail);
            };
          }
          return (...args: unknown[]) => {
            if (prop === 'in') record.inValues.push((args[1] as unknown[]).length);
            mem = mem[prop]!(...args) as Chain;
            shadow = shadow[prop]!(...args) as Chain;
            return chain;
          };
        },
      });
      return chain;
    },
  };
}

const longestIn = (log: QueryRecord[]) => Math.max(0, ...log.flatMap((r) => r.inValues));
const longestReadUrl = (log: QueryRecord[]) => Math.max(0, ...log.filter((r) => r.method === 'GET').map((r) => r.url.length));

// ─── Dane ──────────────────────────────────────────────────────────────────

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const CSV_INVOICES = 1500;
const BUYERS = 300;
const KNOWN_BUYERS = 120;
/** Co dziesiąty numer z pliku jest już w bazie (150 duplikatów, także za pierwszym tysiącem wierszy sterty). */
const isStored = (i: number) => i % 10 === 0;
const csvNumber = (i: number) => `FV/${i}/11/2026`;
const buyerOf = (i: number) => i % BUYERS;

function fakturowniaCsv(count: number): string {
  const header = 'Numer;Data wystawienia;Sprzedawca;NIP sprzedawcy;Nabywca;NIP nabywcy;Netto;VAT;Brutto;Stawka VAT';
  const rows = Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    return `${csvNumber(i)};2026-11-05;Sprzedawca Testowy;${SELLER_NIP};Nabywca ${buyerOf(i)};${fictionalNip(buyerOf(i))};100,00;23,00;123,00;23`;
  });
  return [header, ...rows].join('\n');
}

function storedInvoice(id: string, tenantId: string, patch: Row): Row {
  return {
    id, tenant_id: tenantId, direction: 'outgoing', seller_nip: SELLER_NIP, issue_date: '2026-10-01',
    ksef_number: null, ksef_status: 'draft', ksef_environment: null, xml_storage_path: null, origin: 'manual', ...patch,
  };
}

let tables: MemoryTables;
let log: QueryRecord[];

const tenantInvoices = (direction = 'outgoing') =>
  tables.invoices!.filter((r) => r.tenant_id === T && r.direction === direction);

beforeEach(() => {
  log = [];
  state.csv = fakturowniaCsv(CSV_INVOICES);
  // Sterta: 1100 innych faktur firmy i innej firmy, potem 150 numerów z pliku.
  const filler = Array.from({ length: 1100 }, (_, k) =>
    storedInvoice(uuid('f', k + 1), k % 2 ? T : OTHER_TENANT, { internal_number: `ZZ/${k + 1}/2025` }));
  const stored = Array.from({ length: CSV_INVOICES }, (_, k) => k + 1).filter(isStored)
    .map((i) => storedInvoice(uuid('a', i), T, { internal_number: csvNumber(i) }));
  tables = {
    import_jobs: [{ id: JOB, tenant_id: T, source: 'fakturownia_csv', source_file_path: FILE_PATH, status: 'pending' }],
    contractors: Array.from({ length: KNOWN_BUYERS }, (_, n) => ({
      id: uuid('c', n + 1), tenant_id: T, nip: fictionalNip(n), name: `Nabywca ${n} (stara nazwa)`, email: null, address: null,
    })),
    products: [],
    invoices: [...filler, ...stored],
    invoice_line_items: [],
    xml_documents: [],
  };
  state.client = gatewayClient(memoryClient(tables, { maxRows: 1000 }), log);
});

const runImport = () => runBulkImportFile(
  { importJobId: JOB, tenantId: T, filePath: FILE_PATH, source: 'fakturownia_csv' },
  ctx,
);

// ─── Testy ─────────────────────────────────────────────────────────────────

describe(`import CSV z ${CSV_INVOICES} fakturami (runner → silnik)`, () => {
  it(`żadne zapytanie nie ma w .in() więcej niż ${MAX_IN_VALUES} wartości ani adresu ponad ${GATEWAY_URL_LIMIT} znaków`, async () => {
    await runImport().catch(() => undefined);
    expect(log.some((r) => r.inValues.length > 0)).toBe(true);
    // Pomiar do opisu PR: najdłuższe `.in()` i najdłuższy adres odczytu.
    const measured = JSON.stringify({ longestIn: longestIn(log), longestReadUrl: longestReadUrl(log) });
    expect(longestIn(log), measured).toBeLessThanOrEqual(MAX_IN_VALUES);
    expect(longestReadUrl(log), measured).toBeLessThanOrEqual(GATEWAY_URL_LIMIT);
  });

  it('import kończy się, a duplikaty i kontrahenci są rozpoznani jak dotąd', async () => {
    await expect(runImport()).resolves.toEqual({ success: true, imported: CSV_INVOICES - 150 });

    const job = tables.import_jobs![0]!;
    expect(job).toMatchObject({
      status: 'completed', invoices_imported: CSV_INVOICES - 150,
      contractors_created: BUYERS - KNOWN_BUYERS, contractors_updated: KNOWN_BUYERS,
    });
    const warnings = job.warnings as string[];
    for (let i = 10; i <= CSV_INVOICES; i += 10) expect(warnings).toContain(`Pominięto duplikat (DB): ${csvNumber(i)}`);
    expect(warnings.filter((w) => w.startsWith('Pominięto duplikat'))).toHaveLength(150);

    // Każdy numer z pliku dokładnie raz w firmie; faktury innej firmy nietknięte.
    const byNumber = new Map<string, number>();
    for (const row of tenantInvoices()) byNumber.set(String(row.internal_number), (byNumber.get(String(row.internal_number)) ?? 0) + 1);
    for (let i = 1; i <= CSV_INVOICES; i += 1) expect(byNumber.get(csvNumber(i))).toBe(1);
    expect(tables.invoices!.filter((r) => r.tenant_id === OTHER_TENANT)).toHaveLength(550);

    // Kontrahenci: jeden wiersz na NIP, znani zaktualizowani, nie zdublowani.
    const nips = tables.contractors!.map((c) => c.nip);
    expect(new Set(nips).size).toBe(BUYERS);
    expect(tables.contractors!.find((c) => c.nip === fictionalNip(7))).toMatchObject({ id: uuid('c', 8), name: 'Nabywca 7' });
  });

  it('błąd jednej strony odczytu duplikatów przerywa import przed zapisem faktur (nie „brak duplikatów”)', async () => {
    let invoiceReads = 0;
    state.client = gatewayClient(memoryClient(tables, { maxRows: 1000 }), log, {
      failRead: (record) => record.table === 'invoices' && record.url.includes('internal_number=in.') && ++invoiceReads === 3,
    });
    await expect(runImport()).rejects.toThrow('Faktury: odczyt duplikatów (numer) — db down');
    expect(tenantInvoices()).toHaveLength(550 + 150);
    expect(tables.invoice_line_items).toHaveLength(0);
  });
});

describe('paczka, która dopasowuje ponad 1000 wierszy, nie jest ucinana', () => {
  /** Zakupy: dwóch sprzedawców może mieć ten sam numer (00120), więc 50 numerów trafia w 1200 cudzych faktur. */
  const NUMBERS = 50;
  const OTHER_SELLERS = 24;
  const SUPPLIER = fictionalNip(999);
  const purchase = (k: number): ParsedInvoice => ({
    invoiceNumber: `${k}/11/2026`,
    issueDate: '2026-11-05',
    invoiceType: 'regular',
    seller: { nip: SUPPLIER, name: 'Dostawca' },
    buyer: { nip: SELLER_NIP, name: 'Firma testowa' },
    lines: [{ position: 1, name: 'Usługa transportowa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100 }],
    totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
    warnings: [],
  });

  it('duplikat zakupu za tysięcznym dopasowaniem jest rozpoznany', async () => {
    const others: Row[] = [];
    for (let s = 0; s < OTHER_SELLERS; s += 1) {
      for (let k = 1; k <= NUMBERS; k += 1) {
        // id w innej kolejności niż sterta (permutacja), żeby strony po id nie pokrywały się z kolejnością wstawienia.
        const n = ((s * NUMBERS + k) * 7919) % 100_000;
        others.push(storedInvoice(uuid('b', n), T, {
          direction: 'incoming', internal_number: `${k}/11/2026`, seller_nip: fictionalNip(s), issue_date: '2026-11-05',
        }));
      }
    }
    const ours = [7, 37].map((k) => storedInvoice(uuid('e', k), T, {
      direction: 'incoming', internal_number: `${k}/11/2026`, seller_nip: SUPPLIER, issue_date: '2026-11-05',
    }));
    tables.invoices = [...others, ...ours];
    expect(tables.invoices).toHaveLength(OTHER_SELLERS * NUMBERS + 2);

    const result = await processImportedInvoices({
      tenantId: T,
      importJobId: JOB,
      source: 'csv',
      invoiceDirection: 'incoming',
      invoiceKsefStatus: 'draft',
      catalogPolicy: { contractors: 'skip', products: 'skip' },
      invoices: Array.from({ length: NUMBERS }, (_, k) => purchase(k + 1)),
    });

    expect(result.warnings).toEqual(expect.arrayContaining(['Pominięto duplikat (DB): 7/11/2026', 'Pominięto duplikat (DB): 37/11/2026']));
    expect(result.invoicesImported).toBe(NUMBERS - 2);
    const fromSupplier = tenantInvoices('incoming').filter((r) => r.seller_nip === SUPPLIER);
    expect(fromSupplier.filter((r) => r.internal_number === '7/11/2026')).toHaveLength(1);
    expect(fromSupplier).toHaveLength(NUMBERS);
    expect(longestIn(log)).toBeLessThanOrEqual(MAX_IN_VALUES);
  });
});

describe(`numery KSeF: ${CSV_INVOICES} wartości w paczkach`, () => {
  const ksefNumber = (i: number) => `${SELLER_NIP}-20261105-${i.toString(16).toUpperCase().padStart(12, '0')}-${(i % 256).toString(16).toUpperCase().padStart(2, '0')}`;
  const sale = (i: number): ParsedInvoice => ({
    invoiceNumber: `KS/${i}/11/2026`,
    issueDate: '2026-11-05',
    invoiceType: 'regular',
    seller: { nip: SELLER_NIP, name: 'Sprzedawca Testowy' },
    buyer: { nip: fictionalNip(buyerOf(i)), name: `Nabywca ${buyerOf(i)}` },
    lines: [{ position: 1, name: 'Usługa transportowa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100 }],
    totals: { netTotal: 100, vatTotal: 23, grossTotal: 123 },
    warnings: [],
    ksefNumber: ksefNumber(i),
  });

  it('duplikaty po numerze KSeF rozpoznane, każde .in() najwyżej 100 wartości', async () => {
    // Te same numery KSeF co w pliku, ale inne numery faktur — rozpoznaje je tylko zapytanie po `ksef_number`.
    tables.invoices = [
      ...tables.invoices!.filter((r) => r.tenant_id === OTHER_TENANT),
      ...Array.from({ length: CSV_INVOICES }, (_, k) => k + 1).filter(isStored).map((i) =>
        storedInvoice(uuid('d', i), T, { internal_number: `STARY/${i}`, ksef_number: ksefNumber(i), ksef_status: 'accepted' })),
    ];

    const result = await processImportedInvoices({
      tenantId: T,
      importJobId: JOB,
      source: 'csv',
      invoiceDirection: 'outgoing',
      invoiceKsefStatus: 'draft',
      catalogPolicy: { contractors: 'skip', products: 'skip' },
      invoices: Array.from({ length: CSV_INVOICES }, (_, k) => sale(k + 1)),
    });

    expect(result.invoicesImported).toBe(CSV_INVOICES - 150);
    for (let i = 10; i <= CSV_INVOICES; i += 10) expect(result.warnings).toContain(`Pominięto duplikat (DB, KSeF): ${ksefNumber(i)}`);
    expect(log.filter((r) => r.url.includes('ksef_number=in.')).length).toBeGreaterThanOrEqual(15);
    expect(longestIn(log)).toBeLessThanOrEqual(MAX_IN_VALUES);
    expect(longestReadUrl(log)).toBeLessThanOrEqual(GATEWAY_URL_LIMIT);
  });
});
