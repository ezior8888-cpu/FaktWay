import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * PR C0 (D-A4-1b-3, specyfikacja 5.9) — strażnik tożsamości przed
 * przeniesieniem mapowania wiersza importu z `lib/import/import-engine.ts`
 * do `lib/import/imported-invoice-row.ts`. Refaktor nie ma czerwieni: test
 * jest zielony przed i po, a migawka zapisana na kodzie sprzed refaktoru
 * nie może się zmienić ani o znak. Nie liczyć go jako dowodu naprawy.
 *
 * Inwarianty spisane PRZED zmianą:
 * - C0-1: `processImportedInvoices` dla tych samych wejść wysyła do bazy
 *   identyczne obiekty `insert` (nagłówek i pozycje) w tej samej kolejności;
 * - C0-2: `warnings` i ostrzeżenia JPK (`noteHeld`) identyczne (treść i kolejność);
 * - C0-3: `fa3_data` (`buildImportFa3Json`) ten sam przy ustalonym `importedAt`;
 * - C0-4: zapisy kontrahentów i produktów bez zmian (moduł ich nie dotyka);
 * - C0-5: eksportowane funkcje czyste — sprawdza recenzja kodu modułu, nie ten test.
 *
 * Prawdziwa ścieżka: plik FA(3) → `decodeKsefXml` → `parseFa3Xml` (nigdy
 * literał `ParsedInvoice` — zmiana parsera w C0b ma być tu widoczna) →
 * `archiveImportedKsefXml` (jak `magic-import-ksef.ts`) → silnik. Wyjątek —
 * dwa testy z jawnymi nadpisaniami wyniku parsera dla gałęzi, których plik
 * zgodny z XSD dziś nie uruchomi (opis przy teście). Atrapy:
 * baza w pamięci (`./helpers/baza-w-pamieci`) z zapisem każdego `insert` /
 * `update` / `delete` w kolejności wywołań i magazyn plików (tylko upload).
 * Zapis przechodzi przez JSON — dokładnie to, co supabase-js wysyła do
 * PostgREST (pole `undefined` znika tak samo jak w bazie). Migawka obiektów
 * sortuje klucze — ich kolejność przypina osobna migawka surowego JSON partii.
 *
 * Determinizm: data `2026-10-08T10:00:00Z` (`ksef_accepted_at`,
 * `fa3_data.import.importedAt`, `last_used_at` = `new Date()` w silniku),
 * stały `importJobId`, identyfikatory wierszy z licznika danego testu,
 * fikstury z generatora ze stałym `generatedAt`.
 *
 * C0b: migawka zmieniona ŚWIADOMIE, jednorazowo (GEN-RUNDA, 5.10). Specyfikacja
 * zapowiadała zmianę tylko dla `ff-zw`, `ff-pesel`, `ff-nrinny` i `ff-stopka`, ale
 * `fa3_data.parsed` zapisuje CAŁY `ParsedInvoice`, więc nowe pola parsera trafiają do
 * migawki KAŻDEJ fikstury z pliku FA(3): `parsed.invoiceTypeCode` (surowe RodzajFaktury),
 * `parsed.buyer.jst` / `parsed.buyer.gv` (z pliku; wiersz `buyer_data.jst` / `gv` dostaje
 * je stąd) i `parsed.footerNote` (tam, gdzie plik ma Stopkę). Dodatkowo, jak zapowiedziano:
 * `ff-zw` — brak ostrzeżenia o VAT (VAT 0, GR-4); `ff-pesel` — PESEL z NrID (`buyer_id_type`
 * `pesel` + `buyer_pesel`, brak ostrzeżenia „brak identyfikatora”); `ff-nrinny` — NrID
 * → NrInny: `is_b2c` true→false i `buyer_id_type` no_id→nip (gałąź NrInny/VAT-UE, GR-5
 * „jak dziś” — FA(3) nie mówi, czy to konsument), `buyer_id_number` = NrInny,
 * `buyer_data.nrInny`, `noIdMarker` false, bez ostrzeżenia „brak identyfikatora”;
 * `ff-stopka` — `footerNote`.
 * Wszystko inne — kwoty, stawki, adnotacje, daty, kolejność zapisów — bez zmian.
 * NIP fikcyjne: sprzedawca 1234567890, nabywca 1111111111.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.client }));
// `recordXmlDocument` (xml_documents) bierze klienta z `@/lib/supabase/admin` — ta sama baza.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => state.client }));
vi.mock('@/lib/storage/r2', () => ({
  uploadToR2IfAbsent: vi.fn(async () => true),
  downloadFromR2: vi.fn(async () => {
    throw new Error('magazyn w teście C0: odczyt nieoczekiwany');
  }),
  downloadInvoiceXmlUnchecked: vi.fn(async () => {
    throw new Error('magazyn w teście C0: odczyt nieoczekiwany');
  }),
}));

import { parseFa3Xml, type ParsedInvoice } from '@/lib/import/fa3-parser';
import { processImportedInvoices, type ImportEngineParams } from '@/lib/import/import-engine';
import { archiveImportedKsefXml, decodeKsefXml } from '@/lib/import/ksef-xml-archive';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, roundToCents } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { BuyerParty, Invoice, InvoiceAnnotations, PaymentInfo, VatRate } from '@/types/invoice';

// ─── Baza w pamięci z zapisem każdej operacji zapisu ─────────────────────────

type WriteOp = 'insert' | 'update' | 'delete';
interface RecordedWrite {
  table: string;
  op: WriteOp;
  payload?: unknown;
  /** Filtry po operacji (`eq`, `is`…) — warunek UPDATE/DELETE jest częścią zapisu. */
  filters: unknown[][];
}

const WRITE_OPS: ReadonlySet<string> = new Set<WriteOp>(['insert', 'update', 'delete']);
const FILTER_METHODS: ReadonlySet<string> = new Set(['eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'gt', 'or']);

/** To, co supabase-js wysyła do PostgREST: JSON (bez `undefined`). */
function wire(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * `memoryClient` z zapisem operacji. Identyfikator nowego wiersza z licznika
 * tego klienta (nie z licznika modułu pomocnika) — migawka nie zależy od
 * kolejności testów ani od uruchomienia jednego testu z `-t`.
 */
function recordingClient(
  tables: MemoryTables,
  writes: RecordedWrite[],
  options: Parameters<typeof memoryClient>[1] = {},
) {
  const inner = memoryClient(tables, options);
  let seq = 0;
  const withId = (table: string, row: unknown): Row => ({ id: `${table}-${++seq}`, ...(row as Row) });
  return {
    from(table: string) {
      const query = inner.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
      let current: RecordedWrite | null = null;
      const chain: Record<string, (...args: unknown[]) => unknown> = {
        // Silnik dziś nie robi upsertu; jego pojawienie się w refaktorze to zmiana zachowania.
        upsert: () => {
          throw new Error(`test C0: upsert do ${table} — silnik importu go nie używał`);
        },
      };
      for (const [name, method] of Object.entries(query)) {
        if (name === 'then') {
          chain.then = (...args: unknown[]) => method(...args);
          continue;
        }
        chain[name] = (...args: unknown[]) => {
          let forward = args;
          if (WRITE_OPS.has(name)) {
            current = { table, op: name as WriteOp, ...(args.length ? { payload: wire(args[0]) } : {}), filters: [] };
            writes.push(current);
            if (name === 'insert') {
              const rows = args[0];
              forward = [Array.isArray(rows) ? rows.map((r) => withId(table, r)) : withId(table, rows)];
            }
          } else if (current && FILTER_METHODS.has(name)) {
            current.filters.push([name, ...args.map(wire)]);
          }
          method(...forward);
          return chain;
        };
      }
      return chain;
    },
  };
}

// ─── Fikstury ────────────────────────────────────────────────────────────────

const T = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-08T10:00:00Z');
const NIP = '1234567890';
const BUYER_NIP = '1111111111';

const SELLER = {
  nip: NIP, name: 'Firma testowa sp. z o.o.', email: 'biuro@example.test',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
} as const;
const BUYER: BuyerParty = {
  nip: BUYER_NIP, name: 'Nabywca testowy sp. z o.o.', email: 'nabywca@example.test',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' },
};
const TRANSFER: Omit<PaymentInfo, 'amountDue'> = {
  currency: 'PLN', dueDate: '2026-09-24', method: 'transfer', bankAccount: '61109010140000071219812874',
};

interface LineSpec { name: string; unit: string; qty: number; price: number; rate: VatRate }

/** Faktura FaktWay (`finalizeInvoice` jak formularz); adnotacje doklejane po sumach. */
function faktflowInvoice(
  number: string,
  lines: LineSpec[],
  o: { buyer?: BuyerParty; payment?: Omit<PaymentInfo, 'amountDue'>; notes?: string; annotations?: InvoiceAnnotations } = {},
): Invoice {
  const finalized = finalizeInvoice({
    internalNumber: number,
    type: 'VAT',
    issueDate: '2026-09-10',
    saleDate: '2026-09-10',
    seller: SELLER,
    buyer: o.buyer ?? BUYER,
    lines: lines.map((l, i) => ({ ordinal: i + 1, name: l.name, unit: l.unit, quantity: l.qty, unitPriceNet: l.price, vatRate: l.rate })),
    payment: o.payment ?? TRANSFER,
    notes: o.notes,
  });
  return o.annotations ? { ...finalized, annotations: o.annotations } : finalized;
}

/** Plik taki, jaki FaktWay wysyła do KSeF (stały `generatedAt`; NIP fikcyjny bez sumy kontrolnej → bez `validate`). */
const faktflowXml = (invoice: Invoice) =>
  generateFA3Xml(invoice, { validate: false, generatedAt: new Date('2026-09-10T08:00:00Z') });

const GENERATED = {
  'ff-23': () => faktflowXml(faktflowInvoice('FV/C0/23', [
    { name: 'Usługa wdrożeniowa', unit: 'szt.', qty: 2, price: 50, rate: '23' },
    { name: 'Abonament miesięczny', unit: 'mies.', qty: 1, price: 49.99, rate: '23' },
  ])),
  'ff-pesel': () => faktflowXml(faktflowInvoice('FV/C0/PESEL', [
    { name: 'Naprawa roweru', unit: 'usł.', qty: 1, price: 120, rate: '23' },
  ], {
    buyer: { pesel: '44051401359', name: 'Jan Testowy', address: { countryCode: 'PL', addressLine1: 'ul. Kliencka 3', addressLine2: '00-003 Warszawa' } },
    payment: { currency: 'PLN', dueDate: '2026-09-10', method: 'cash' },
  })),
  'ff-zw': () => faktflowXml(faktflowInvoice('FV/C0/ZW', [
    { name: 'Szkolenie BHP', unit: 'usł.', qty: 1, price: 300, rate: 'zw' },
  ], { annotations: { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } })),
  'ff-nrinny': () => faktflowXml(faktflowInvoice('FV/C0/NRINNY', [
    { name: 'Konsultacja', unit: 'godz.', qty: 2, price: 100, rate: '23' },
  ], {
    buyer: { nrInny: 'AB1234567', name: 'John Test', address: { countryCode: 'DE', addressLine1: 'Teststraße 1', addressLine2: '10115 Berlin' } },
  })),
  'ff-stopka': () => faktflowXml(faktflowInvoice('FV/C0/STOPKA', [
    { name: 'Książka o fakturach', unit: 'szt.', qty: 2, price: 39.9, rate: '8' },
  ], { notes: 'Dziękujemy za zakup. Zamówienie nr 42.' })),
} as const;

/** Pliki statyczne — opis pochodzenia w komentarzu na początku każdego pliku. */
const STATIC = ['ceny-brutto', 'korekta', 'stawka-nieznana'] as const;

/**
 * Przypadki brzegowe wiersza — każdy plik to `ceny-brutto.xml` z opisaną na
 * początku zmianą (i własnym P_2). Dodane po sprawdzeniu mutacjami: bez nich
 * migawka nie zauważała m.in. zamiany gałęzi nabywcy UE, karty, terminu
 * zapłaty, numeru pozycji, rodzaju ZAL/ROZ, dat sprzedaży, oznaczeń FP/GTU,
 * kwot faktury bez sum stawek, adresu sprzedawcy z zagranicy, nabywcy bez
 * identyfikatora i faktury bez bloku płatności. Poza partią (`FIXTURES`), żeby
 * jej migawka została bez zmian. Nowe pliki tylko na końcu listy — numery KSeF
 * (`ksefNumberOf`) wcześniejszych fikstur zależą od ich miejsca.
 */
const EDGE = [
  'nabywca-ue', 'zaliczka', 'rozliczeniowa', 'okres-fa', 'daty-pozycji-fp-gtu',
  'tylko-p15', 'tylko-p15-niezgodne', 'vat-naglowka-niezgodny', 'dane-stron', 'bez-platnosci',
] as const;

type FixtureName = keyof typeof GENERATED | (typeof STATIC)[number] | (typeof EDGE)[number];
const FIXTURES: readonly FixtureName[] = [...(Object.keys(GENERATED) as Array<keyof typeof GENERATED>), ...STATIC];
/** `FIXTURES` na początku — numery KSeF fikstur sprzed przypadków brzegowych bez zmian. */
const ALL_FIXTURES: readonly FixtureName[] = [...FIXTURES, ...EDGE];

function fixtureBytes(name: FixtureName): Buffer {
  if (name in GENERATED) return Buffer.from(GENERATED[name as keyof typeof GENERATED](), 'utf8');
  return readFileSync(new URL(`../fixtures/import-wiersze/${name}.xml`, import.meta.url));
}

/** Numer KSeF stały dla fikstury (kształt NIP-data-12 znaków-2 znaki). */
const ksefNumberOf = (name: FixtureName) =>
  `${NIP}-20260910-C0${String(ALL_FIXTURES.indexOf(name) + 1).padStart(10, '0')}-AF`;

/** Jak `magic-import-ksef.ts`: archiwum z bajtów, potem parser na zdekodowanym tekście. */
async function fromKsef(name: FixtureName): Promise<ParsedInvoice> {
  const bytes = fixtureBytes(name);
  const ksefNumber = ksefNumberOf(name);
  const xmlArchive = await archiveImportedKsefXml(T, ksefNumber, bytes);
  return { ...parseFa3Xml(decodeKsefXml(bytes), { ksefNumber }), xmlArchive };
}

/** Plik bez numeru KSeF (import pliku, `bulk-import.ts`). */
const fromFile = (name: FixtureName): ParsedInvoice => parseFa3Xml(decodeKsefXml(fixtureBytes(name)));

const KSEF_HISTORY_SALE = {
  source: 'ksef_history', invoiceDirection: 'outgoing', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
} as const satisfies Partial<ImportEngineParams>;

// ─── Przebieg ────────────────────────────────────────────────────────────────

let tables: MemoryTables;
let writes: RecordedWrite[];

function useDatabase(options: Parameters<typeof memoryClient>[1] = {}) {
  writes = [];
  state.client = recordingClient(tables, writes, options);
}

async function run(params: Omit<ImportEngineParams, 'tenantId' | 'importJobId'>) {
  const result = await processImportedInvoices({ tenantId: T, importJobId: JOB, ...params });
  return { result, writes: [...writes] };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  tables = { invoices: [], invoice_line_items: [], contractors: [], products: [], xml_documents: [] };
  useDatabase();
});
afterEach(() => {
  vi.useRealTimers();
  state.client = null;
});

describe('C0: fikstury', () => {
  it('pliki FaktWay i statyczne (poza stawka-nieznana) przechodzą XSD FA(3); stawka-nieznana odpada tylko na P_12', async () => {
    for (const name of ALL_FIXTURES) {
      const result = await validateFA3(decodeKsefXml(fixtureBytes(name)));
      if (name === 'stawka-nieznana') {
        expect(result.errors.map((e) => e.message).join('\n')).toMatch(/P_12'.*The value '17' is not an element of the set/);
        expect(result.errors).toHaveLength(1);
      } else {
        expect(result.errors, `${name}: plik testowy musi przejść XSD FA(3)`).toEqual([]);
      }
    }
  });

  it('każda fikstura niesie przypadek, który ma przypinać', () => {
    const xml = (name: FixtureName) => decodeKsefXml(fixtureBytes(name));
    expect(xml('ff-pesel')).toContain('<KodKraju>PL</KodKraju><NrID>44051401359</NrID>');
    expect(xml('ff-nrinny')).toContain('<KodKraju>DE</KodKraju><NrID>AB1234567</NrID>');
    expect(xml('ff-zw')).toContain('<P_19>1</P_19><P_19A>art. 113 ust. 1 ustawy o VAT</P_19A>');
    expect(xml('ff-stopka')).toContain('<StopkaFaktury>Dziękujemy za zakup. Zamówienie nr 42.</StopkaFaktury>');
    expect(xml('ceny-brutto').match(/<P_11A>33\.33<\/P_11A>/g)).toHaveLength(3);
    expect(xml('ceny-brutto')).not.toMatch(/<P_9A>|<P_11>/);
    expect(xml('korekta')).toContain('<RodzajFaktury>KOR</RodzajFaktury>');
    expect(xml('stawka-nieznana')).toContain('<P_12>17</P_12>');
  });

  it('każdy przypadek brzegowy to ceny-brutto.xml z opisaną zmianą i własnym numerem', () => {
    const xml = (name: FixtureName) => decodeKsefXml(fixtureBytes(name));
    const numbers = new Set<string>();
    for (const name of EDGE) {
      expect(xml(name), name).toMatch(/^<\?xml[^\n]*\n<!-- PR C0: ceny-brutto\.xml .*Plik statyczny: nie regenerować\. -->\n/);
      expect(xml(name).match(/<P_9B>33\.33<\/P_9B>/g), name).toHaveLength(3);
      numbers.add(/<P_2>([^<]+)<\/P_2>/.exec(xml(name))![1]!);
    }
    expect([...numbers].sort()).toEqual([
      'FV/C0/BEZPLAT', 'FV/C0/OKRES', 'FV/C0/P14', 'FV/C0/P15', 'FV/C0/P15-ZLE', 'FV/C0/P6A', 'FV/C0/ROZ', 'FV/C0/STRONY', 'FV/C0/UE', 'FV/C0/ZAL',
    ]);
    // Zmiana sprawdzana w treści pliku, bez komentarza z jej opisem. Komentarz
    // stoi zaraz po deklaracji XML (sprawdzone wyżej), więc treść = wszystko po
    // jego końcu — bez wycinania wyrażeniem regularnym (CodeQL
    // js/incomplete-multi-character-sanitization).
    const body = (name: FixtureName) => {
      const text = xml(name);
      const end = text.indexOf('-->');
      expect(end, name).toBeGreaterThan(0);
      return text.slice(end + '-->'.length);
    };

    expect(body('nabywca-ue')).toMatch(/<KodUE>DE<\/KodUE>\s*<NrVatUE>123456789<\/NrVatUE>/);
    expect(body('nabywca-ue')).not.toContain('<NIP>1111111111</NIP>');
    expect(body('nabywca-ue')).toContain('<FormaPlatnosci>2</FormaPlatnosci>');
    expect(body('nabywca-ue')).not.toContain('<TerminPlatnosci>');
    expect([...body('nabywca-ue').matchAll(/<NrWierszaFa>(\d+)<\/NrWierszaFa>/g)].map((m) => m[1])).toEqual(['1', '3', '5']);
    expect(body('zaliczka')).toContain('<RodzajFaktury>ZAL</RodzajFaktury>');
    expect(body('zaliczka')).toContain('<P_6>2026-09-10</P_6>');
    expect(body('rozliczeniowa')).toContain('<RodzajFaktury>ROZ</RodzajFaktury>');
    expect(body('okres-fa')).toMatch(/<OkresFa>\s*<P_6_Od>2026-09-01<\/P_6_Od>\s*<P_6_Do>2026-09-30<\/P_6_Do>\s*<\/OkresFa>/);
    expect(body('okres-fa')).not.toContain('<P_6>');
    expect(body('daty-pozycji-fp-gtu')).not.toContain('<P_6>');
    expect([...body('daty-pozycji-fp-gtu').matchAll(/<P_6A>([^<]+)<\/P_6A>/g)].map((m) => m[1])).toEqual(['2026-09-02', '2026-09-03', '2026-09-04']);
    expect(body('daty-pozycji-fp-gtu')).toMatch(/<RodzajFaktury>VAT<\/RodzajFaktury>\s*<FP>1<\/FP>/);
    expect(body('daty-pozycji-fp-gtu').match(/<GTU>GTU_12<\/GTU>/g)).toHaveLength(1);
    for (const name of ['tylko-p15', 'tylko-p15-niezgodne'] as const) expect(body(name), name).not.toMatch(/<P_13_|<P_14_/);
    expect(body('tylko-p15')).toContain('<P_15>99.99</P_15>');
    expect(body('tylko-p15-niezgodne')).toContain('<P_15>99.90</P_15>');
    expect(body('vat-naglowka-niezgodny')).toMatch(/<P_13_1>81\.29<\/P_13_1>\s*<P_14_1>18\.71<\/P_14_1>\s*<P_15>100\.00<\/P_15>/);
    // Sprzedawca z zagranicy z jedną linią adresu; nabywca bez identyfikatora, nazwy i adresu; płatność „bon”.
    expect(body('dane-stron')).toMatch(/<Podmiot1>[\s\S]*<KodKraju>DE<\/KodKraju>\s*<AdresL1>Teststraße 1, 10115 Berlin<\/AdresL1>\s*<\/Adres>\s*<\/Podmiot1>/);
    expect(body('dane-stron')).toMatch(/<Podmiot2>\s*<DaneIdentyfikacyjne>\s*<BrakID>1<\/BrakID>\s*<\/DaneIdentyfikacyjne>\s*<JST>/);
    expect(body('dane-stron')).toContain('<FormaPlatnosci>3</FormaPlatnosci>');
    expect(body('dane-stron')).not.toContain('<AdresL2>00-002');
    expect(body('bez-platnosci')).not.toMatch(/<Platnosc>|<FormaPlatnosci>|<TerminPlatnosci>|<NrRB>/);
  });
});

describe('C0: processImportedInvoices — zapisy do bazy i ostrzeżenia bez zmian (migawka)', () => {
  it.each(FIXTURES)('historia KSeF, sprzedaż przyjęta (TEST), z oryginałem XML: %s', async (name) => {
    expect(await run({ ...KSEF_HISTORY_SALE, invoices: [await fromKsef(name)] })).toMatchSnapshot();
  });

  it('import pliku (jpk_fa → origin file_import, szkic bez numeru KSeF): ff-23 i stawka-nieznana', async () => {
    expect(await run({ source: 'jpk_fa', invoices: [fromFile('ff-23'), fromFile('stawka-nieznana')] })).toMatchSnapshot();
  });

  it('historia KSeF, faktury odebrane (incoming, TEST): ff-23 i stawka-nieznana', async () => {
    expect(await run({
      source: 'ksef_history', invoiceDirection: 'incoming', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
      invoices: [await fromKsef('ff-23'), await fromKsef('stawka-nieznana')],
    })).toMatchSnapshot();
  });

  it('partia: wszystkie fikstury naraz, kontrahent i produkt już w bazie (kolejność zapisów, C0-4)', async () => {
    tables.contractors!.push({
      id: 'contractor-istniejacy', tenant_id: T, nip: BUYER_NIP, name: 'Stara nazwa', email: 'stary@example.test', address: null,
    });
    tables.products!.push({ id: 'product-istniejacy', tenant_id: T, name: 'Usługa wdrożeniowa', unit: 'szt.', use_count: 3 });
    const invoices: ParsedInvoice[] = [];
    for (const name of FIXTURES) invoices.push(await fromKsef(name));
    expect(await run({ ...KSEF_HISTORY_SALE, invoices })).toMatchSnapshot();
  });

  it('ponowienie: duplikat z importu sprzed C5b (bez adnotacji i ścieżki XML) — uzupełnienie z oryginału', async () => {
    await run({ ...KSEF_HISTORY_SALE, invoices: [await fromKsef('ff-23')] });
    const stored = tables.invoices!.find((r) => r.internal_number === 'FV/C0/23')!;
    delete (stored.fa3_data as Row).annotations;
    stored.xml_storage_path = null;
    useDatabase();
    expect(await run({ ...KSEF_HISTORY_SALE, invoices: [await fromKsef('ff-23')] })).toMatchSnapshot();
  });

  it('błąd zapisu pozycji: nagłówek usunięty, faktura nieudana', async () => {
    useDatabase({ failInsertInto: ['invoice_line_items'] });
    expect(await run({ ...KSEF_HISTORY_SALE, invoices: [await fromKsef('ff-23')] })).toMatchSnapshot();
  });

  it('błąd zapisu xml_documents: faktura zostaje, ostrzeżenie o JPK i tak jest', async () => {
    useDatabase({ failInsertInto: ['xml_documents'] });
    expect(await run({ ...KSEF_HISTORY_SALE, invoices: [await fromKsef('stawka-nieznana')] })).toMatchSnapshot();
  });
});

describe('C0: przypadki brzegowe wiersza i kolejność kluczy (dodane po sprawdzeniu mutacjami)', () => {
  const insertedInvoices = (w: RecordedWrite[]) =>
    w.filter((x) => x.table === 'invoices' && x.op === 'insert').map((x) => x.payload as Row);

  it.each(EDGE)('historia KSeF, sprzedaż przyjęta (TEST), z oryginałem XML: %s', async (name) => {
    expect(await run({ ...KSEF_HISTORY_SALE, invoices: [await fromKsef(name)] })).toMatchSnapshot();
  });

  it('skrzynka KSeF (ksef_inbox → origin ksef_inbox, odebrana, przyjęta, numer KSeF bez oryginału): ff-23', async () => {
    const invoice = parseFa3Xml(decodeKsefXml(fixtureBytes('ff-23')), { ksefNumber: ksefNumberOf('ff-23') });
    const out = await run({
      source: 'ksef_inbox', invoiceDirection: 'incoming', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test', invoices: [invoice],
    });
    expect(insertedInvoices(out.writes).map((r) => r.origin)).toEqual(['ksef_inbox']);
    expect(out).toMatchSnapshot();
  });

  it('zdjęcie OCR (ocr_photo → origin ocr, odebrana, szkic bez numeru KSeF): ff-23', async () => {
    const out = await run({ source: 'ocr_photo', invoiceDirection: 'incoming', invoiceKsefStatus: 'draft', invoices: [fromFile('ff-23')] });
    expect(insertedInvoices(out.writes).map((r) => r.origin)).toEqual(['ocr']);
    expect(out).toMatchSnapshot();
  });

  /**
   * Wyjątek od „nigdy literał `ParsedInvoice`”: wynik `parseFa3Xml` z JAWNYMI
   * nadpisaniami. Te gałęzie silnika nie mają wejścia z pliku zgodnego z XSD —
   * FA(3) wymaga NIP sprzedawcy (10 cyfr), sumy faktury parser bierze z tych
   * samych pól, z których liczy kwoty pozycji, a problem adnotacji daje tylko
   * plik niezgodny z XSD. Przypina: `seller_data.nip`
   * zastępczy, obcięcie `seller_nip` do 10 cyfr, bezpiecznik „pozycje nie
   * sumują się do sum faktury” (z tolerancją VAT poniżej grosza)
   * i `fa3_data.annotationProblems`.
   */
  it('wejście spoza pliku zgodnego z XSD: sprzedawca bez NIP / z dłuższym NIP, VAT faktury ≠ VAT pozycji, nieczytelne adnotacje', async () => {
    const bezNip = await fromKsef('ff-23');
    const dluzszyNip = await fromKsef('ff-stopka');
    const { nip: sellerNip, ...sellerBezNip } = bezNip.seller;
    expect(sellerNip).toBe(NIP);
    const invoices: ParsedInvoice[] = [
      { ...bezNip, seller: sellerBezNip, annotationProblems: ['P_16 „3”'] },
      {
        ...dluzszyNip,
        seller: { ...dluzszyNip.seller, nip: `${NIP}99` },
        // 10 groszy: powyżej progu grosza, poniżej 0,5 zł — pozycje i nagłówek pliku zgodne, różni się tylko suma faktury.
        totals: { ...dluzszyNip.totals, vatTotal: roundToCents(dluzszyNip.totals.vatTotal + 0.1) },
      },
    ];
    const out = await run({ ...KSEF_HISTORY_SALE, invoices });
    const [first, second] = insertedInvoices(out.writes);
    expect(first).toMatchObject({ seller_nip: null, seller_data: { nip: '0000000000' }, fa3_data: { annotationProblems: ['P_16 „3”'] } });
    expect(second).toMatchObject({ seller_nip: NIP, seller_data: { nip: NIP }, vat_total: 6.48 });
    expect(out).toMatchSnapshot();
  });

  /**
   * Bezpiecznik „pozycje nie sumują się do sum faktury” — połówka netto i dolna
   * granica VAT. Wejście: `ceny-brutto` (3 pozycje → tolerancja netto 0,04)
   * z jawnie przesuniętą sumą faktury; plik zgodny z XSD takiej różnicy nie daje
   * (sumy parser liczy z tych samych pól co pozycje). Wprost, bez migawki.
   */
  it.each([
    { pole: 'netTotal', roznica: 0.05, opis: 'netto o 5 groszy powyżej tolerancji 4 groszy (3 pozycje)' },
    { pole: 'vatTotal', roznica: 0.01, opis: 'VAT o grosz — tolerancja VAT jest poniżej grosza' },
  ] as const)('bezpiecznik sum: $opis → zatrzymanie JPK', async ({ pole, roznica }) => {
    const parsed = await fromKsef('ceny-brutto');
    expect(parsed.lines).toHaveLength(3);
    const invoice = { ...parsed, totals: { ...parsed.totals, [pole]: roundToCents(parsed.totals[pole] + roznica) } };
    const { result } = await run({ ...KSEF_HISTORY_SALE, invoices: [invoice] });
    expect(result.invoicesImported).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('netto albo VAT pozycji nie sumuje się do sum faktury z KSeF');
    expect(result.warnings[0]).toContain('JPK_FA i JPK_V7M za 2026-09 nie powstaną');
  });

  /**
   * Gałęzie `heldDocumentWarning`, które zwracają `null`: szkic z importu pliku
   * (zaliczka — rodzaj specjalny) i faktura odebrana (korekta). JPK dotyczy
   * tylko sprzedaży przyjętej w KSeF — tu ostrzeżenie o JPK nie może się pojawić;
   * zostaje wyłącznie ostrzeżenie o rodzaju dokumentu.
   */
  it.each<{ opis: string; rodzaj: string; params: () => Parameters<typeof run>[0] | Promise<Parameters<typeof run>[0]> }>([
    { opis: 'szkic z pliku (jpk_fa), zaliczka', rodzaj: 'advance', params: () => ({ source: 'jpk_fa', invoices: [fromFile('zaliczka')] }) },
    {
      opis: 'faktura odebrana (ksef_history, incoming), korekta',
      rodzaj: 'correction',
      params: async () => ({
        source: 'ksef_history', invoiceDirection: 'incoming', invoiceKsefStatus: 'accepted', ksefEnvironment: 'test',
        invoices: [await fromKsef('korekta')],
      }),
    },
  ])('bez zatrzymania JPK: $opis', async ({ params, rodzaj }) => {
    const { result } = await run(await params());
    expect(result.invoicesImported).toBe(1);
    expect(result.warnings).not.toContainEqual(expect.stringContaining('JPK'));
    expect(result.warnings).toEqual([expect.stringContaining(`typ źródłowy „${rodzaj}”`)]);
  });

  // C0b: parser czyta PESEL z `KodKraju` PL + `NrID` (GR-2), więc test nie potrzebuje już nadpisania
  // wyniku parsera — prawdziwa ścieżka plik → parser → wiersz daje to, co dotąd dawało tylko nadpisanie.
  it('nabywca z PESEL — odczytany przez parser z NrID (C0b), wartości wprost', async () => {
    const parsed = await fromKsef('ff-pesel');
    expect(parsed.buyer.pesel).toBe('44051401359');
    expect(parsed.warnings).toEqual([]);
    const out = await run({ ...KSEF_HISTORY_SALE, invoices: [parsed] });
    expect(insertedInvoices(out.writes)).toMatchObject([{
      is_b2c: true, buyer_id_type: 'pesel', buyer_nip: null, buyer_pesel: '44051401359', buyer_id_number: null,
      buyer_data: { pesel: '44051401359', noIdMarker: false },
    }]);
  });

  it('partia: kolejność kluczy każdego zapisu (surowy JSON — migawka obiektów sortuje klucze)', async () => {
    // Ten sam scenariusz co „partia: wszystkie fikstury naraz…” wyżej (C0-1, C0-4).
    tables.contractors!.push({
      id: 'contractor-istniejacy', tenant_id: T, nip: BUYER_NIP, name: 'Stara nazwa', email: 'stary@example.test', address: null,
    });
    tables.products!.push({ id: 'product-istniejacy', tenant_id: T, name: 'Usługa wdrożeniowa', unit: 'szt.', use_count: 3 });
    const invoices: ParsedInvoice[] = [];
    for (const name of FIXTURES) invoices.push(await fromKsef(name));
    const out = await run({ ...KSEF_HISTORY_SALE, invoices });
    // Jeden zapis na wiersz — różnica kolejności kluczy to jedna zmieniona linia migawki, nie przesunięcie setek.
    expect(out.writes.map((w) => JSON.stringify(w)).join('\n')).toMatchSnapshot('zapisy jako JSON w kolejności kluczy');
  });
});
