import { createHash } from 'node:crypto';

import { NoSuchKey } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR C (spec v3, 5.3, 1.1 i 7.2): `lib/ksef/duplicate-original-import.ts`
 * — część serwerowa zapisu oryginału:
 * - `prepareOriginalImport`: SUCHY przebieg przed RPC decyzji (archiwum → SHA-256
 *   i rozmiar → brama → zmiana bramy → zapisywalność → projekcja i lustro 4.8);
 *   tylko odczyty, nigdy nie pisze i nie alarmuje (INV-13);
 * - `originalRecheckKindFor`: rodzaj znacznika `recheckNeeded` dla odmowy suchego
 *   przebiegu (wspólny dla akcji klienta i operatora, 5.6 krok 9);
 * - `originalDecisionAlarms`: alarmy po decyzji ze stanu bazy (T5, INV-13) —
 *   `ksef-duplicate-import-no-date` / `-no-session`, odcisk `[kind, invoiceId]`.
 *
 * Magazyn (R2) i Sentry są zamockowane; brama, projekcja i lustro 4.8 to
 * prawdziwy kod, a pliki powstają prawdziwym generatorem FaktFlow (kopia
 * minimalnych budowniczych macierzy rundy). Baza dla alarmów to baza w pamięci
 * (`helpers/baza-w-pamieci.ts`).
 *
 * CZERWONE na commicie kontraktu (commit 1): `prepareOriginalImport`,
 * `originalRecheckKindFor` i `originalDecisionAlarms` są szkieletami, które
 * rzucają „PR C: nie zaimplementowane”.
 */

const m = vi.hoisted(() => ({
  download: vi.fn(),
  upload: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: m.download, uploadToR2IfAbsent: m.upload }));
vi.mock('@sentry/nextjs', () => {
  // M6: implementacja może użyć `withScope` (zakres z dowolną metodą: setTag, setFingerprint, …) i `logger` —
  // atrapy tego nie zabraniają. Alarmy i tak liczą się po `captureMessage` / `captureException`.
  const scope: Record<string, unknown> = new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : () => scope) });
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), log: vi.fn() };
  return {
    captureMessage: m.captureMessage,
    captureException: m.captureException,
    addBreadcrumb: vi.fn(),
    withScope: (callback: (s: unknown) => unknown) => callback(scope),
    logger,
  };
});

import type { createAdminClient } from '@/lib/supabase/admin';
import {
  KSEF_ORIGINAL_ALARM_KINDS,
  ORIGINAL_GATE_RULES,
  ORIGINAL_GATE_UNBUILDABLE_PROBLEMS,
  ORIGINAL_IMPORT_SOURCE,
  ORIGINAL_RECHECK_KINDS,
  type DuplicateOriginalOffer,
  type KsefDuplicateCheck,
  type KsefOriginalImportGate,
  type OriginalGateProblem,
} from '@/lib/ksef/duplicate-check';
import {
  originalDecisionAlarms,
  originalRecheckKindFor,
  prepareOriginalImport,
  type PrepareOriginalImportFailureKind,
  type PrepareOriginalImportInput,
} from '@/lib/ksef/duplicate-original-import';
import { originalImportProjectionProblem } from '@/lib/ksef/duplicate-original-projection';
import { summarizeInvoiceXml } from '@/lib/ksef/duplicate-verdict';
import { memoryClient, type MemoryTables } from './helpers/baza-w-pamieci';
import { buildInvoiceAnnotations } from '@/lib/invoices/annotations';
import { buyerPartyFromBuyerData } from '@/lib/invoices/map-buyer-party';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, validateInvoice } from '@/lib/xml/invoice-calculator';
import type { BuyerParty, Invoice, InvoiceAnnotations, PaymentInfo, VatRate } from '@/types/invoice';

// ─── Macierz rundy (spec 7.2: C0b, brama, projekcja, R-C1c) ───────────────────
// Kopia minimalnych budowniczych z `import-runda-generator.test.ts` (nie
// importujemy z pliku testu): faktura FaktFlow → `finalizeInvoice` →
// `validateInvoice` (bez błędów) → `generateFA3Xml` z walidacją. NIP sprzedawcy
// i nabywców mają poprawną sumę kontrolną (F48) — to NIP-y testowe.

const T = '11111111-1111-4111-8111-111111111111';
const SELLER_NIP = '5260001246';
const BUYER_NIP = '5252241585';
const PESEL = '44051401359';
const BANK_ACCOUNT = '61109010140000071219812874';
const ISSUE = '2026-09-10';
const GENERATED_AT = new Date('2026-09-10T08:00:00Z');
const NOW = new Date('2026-09-10T09:00:00Z');
const ART_113 = 'art. 113 ust. 1 ustawy o VAT';

const SELLER = {
  nip: SELLER_NIP,
  name: 'Firma testowa sp. z o.o.',
  email: 'biuro@example.test',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
} as const;

const ADDRESS_PL = { countryCode: 'PL', addressLine1: 'ul. Kliencka 2', addressLine2: '00-002 Warszawa' };

const BUYER_B2B: BuyerParty = {
  nip: BUYER_NIP,
  name: 'Nabywca testowy sp. z o.o.',
  email: 'nabywca@example.test',
  address: ADDRESS_PL,
};

const TRANSFER: Omit<PaymentInfo, 'amountDue'> = {
  currency: 'PLN',
  dueDate: '2026-09-24',
  method: 'transfer',
  bankAccount: BANK_ACCOUNT,
};

/** Identyfikator nabywcy, który plik ma nieść (reszta pól pusta). */
interface BuyerExpect {
  nip?: string;
  pesel?: string;
  nrInny?: string;
  vatUeNumber?: string;
  brakId?: true;
}

interface LineSpec {
  name?: string;
  unit?: string;
  qty: number;
  price: number;
  rate: VatRate;
}

interface MatrixCase {
  /** Nazwa przypadku w tytule testu (unikalna). */
  name: string;
  lines: LineSpec[];
  buyer: BuyerParty;
  expectBuyer: BuyerExpect;
  /** Data sprzedaży (P_6): brak pola = `ISSUE`, `null` = faktura bez P_6. */
  saleDate?: string | null;
  notes?: string;
  payment?: Omit<PaymentInfo, 'amountDue'>;
  /** Wejście `buildInvoiceAnnotations` (jak formularz faktury). */
  exemptionBasis?: string | null;
  splitPayment?: boolean;
  cashMethod?: boolean;
  /** Adnotacje różne od domyślnych (2 = nie dotyczy), które plik ma nieść. */
  expectAnnotations?: Partial<InvoiceAnnotations>;
}

const single = (rate: VatRate, price = 50, qty = 2): LineSpec[] => [
  { name: 'Usługa wdrożeniowa', unit: 'usł.', qty, price, rate },
];

const consumer = (
  idType: 'pesel' | 'id_card' | 'passport' | 'no_id',
  fields: { name: string; pesel?: string; idNumber?: string; address: typeof ADDRESS_PL },
): BuyerParty => buyerPartyFromBuyerData({ type: 'b2c', idType, ...fields });

const MATRIX: readonly MatrixCase[] = [
  { name: 'stawka 23', lines: single('23'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },
  {
    name: 'mieszane 23 + zw',
    lines: [...single('23', 100, 1), ...single('zw', 200, 1)],
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    exemptionBasis: ART_113,
    expectAnnotations: { vatExemptionBasis: ART_113, vatExemptionBasisKind: 'P_19A' },
  },
  {
    name: 'mieszane 8 + 5 + 0',
    lines: [
      { name: 'Książka', unit: 'szt.', qty: 3, price: 33.33, rate: '8' },
      { name: 'Woda', unit: 'szt.', qty: 1, price: 100, rate: '5' },
      { name: 'Eksport próbki', unit: 'szt.', qty: 1, price: 100, rate: '0' },
    ],
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
  },
  {
    name: 'nabywca PESEL z adresem w Polsce',
    lines: single('23'),
    buyer: consumer('pesel', { name: 'Jan Testowy', pesel: PESEL, address: ADDRESS_PL }),
    expectBuyer: { pesel: PESEL },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'cash' },
  },
  {
    name: 'z uwagami (Stopka)',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    notes: 'Dziękujemy za zakup. Zamówienie nr 42 & "pilne" <3',
  },
];

const byName = (name: string): MatrixCase => {
  const found = MATRIX.find((c) => c.name === name);
  if (!found) throw new Error(`brak przypadku macierzy: ${name}`);
  return found;
};

interface Built {
  invoice: Invoice;
  xml: string;
  /** Numer dokumentu (P_2) — dawny numer X, który po zapisie przechodzi na K. */
  number: string;
  /** Numer KSeF oryginału w teście. */
  ksefNumber: string;
}

const built = new Map<string, Built>();

/** Faktura → `finalizeInvoice` → `validateInvoice` (bez błędów) → `generateFA3Xml` z walidacją (domyślnie `validate: true`). */
function build(c: MatrixCase): Built {
  const cached = built.get(c.name);
  if (cached) return cached;
  const index = MATRIX.indexOf(c) + 1;
  const finalized = finalizeInvoice({
    internalNumber: `FV/GR/${String(index).padStart(2, '0')}`,
    type: 'VAT',
    issueDate: ISSUE,
    saleDate: c.saleDate === null ? undefined : (c.saleDate ?? ISSUE),
    seller: SELLER,
    buyer: c.buyer,
    lines: c.lines.map((l, i) => ({
      ordinal: i + 1,
      name: l.name ?? `Pozycja ${i + 1}`,
      unit: l.unit ?? 'szt.',
      quantity: l.qty,
      unitPriceNet: l.price,
      vatRate: l.rate,
    })),
    payment: c.payment ?? TRANSFER,
    notes: c.notes,
  });
  // Jak formularz faktury: adnotacje z `buildInvoiceAnnotations`, doklejone po sumach.
  const annotations = buildInvoiceAnnotations({
    lines: finalized.lines,
    vatExemptionBasis: c.exemptionBasis ?? null,
    splitPayment: c.splitPayment === true,
    cashMethod: c.cashMethod,
  });
  const invoice: Invoice = annotations ? { ...finalized, annotations } : finalized;
  const errors = validateInvoice(invoice, NOW);
  if (errors.length > 0) throw new Error(`${c.name}: validateInvoice odmówiło: ${JSON.stringify(errors)}`);
  const xml = generateFA3Xml(invoice, { generatedAt: GENERATED_AT });
  const result: Built = {
    invoice,
    xml,
    number: invoice.internalNumber!,
    ksefNumber: `${SELLER_NIP}-20260910-GR${String(index).padStart(10, '0')}-AF`,
  };
  built.set(c.name, result);
  return result;
}


// ─── Pliki, znaczniki i wejście suchego przebiegu ────────────────────────────

const NOW_PREP = new Date('2026-09-11T10:00:00.000Z');
const OFFERS_PAIR: readonly DuplicateOriginalOffer[] = ['pair', 'record'];
const OFFERS_REVIEW: readonly DuplicateOriginalOffer[] = ['review-pair', 'review-record'];
const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const importableGate = (over: Partial<KsefOriginalImportGate> = {}): KsefOriginalImportGate => ({
  v: 1, rules: ORIGINAL_GATE_RULES, kind: 'importable', problems: [], preview: null, ...over,
});
const reviewGate = (problems: OriginalGateProblem[], over: Partial<KsefOriginalImportGate> = {}): KsefOriginalImportGate => ({
  v: 1, rules: ORIGINAL_GATE_RULES, kind: 'review', problems, preview: null, ...over,
});

interface Fixture {
  b: Built;
  /** Plik, który zwróci magazyn (po zmianach). */
  xml: string;
  check: KsefDuplicateCheck;
}

/**
 * Plik z macierzy (opcjonalnie zmieniony) wraz ze znacznikiem `original_check` zbudowanym z TYCH bajtów
 * (SHA-256, rozmiar, `summary`) i zapisaną bramą — tak, jak zapisuje go runner.
 */
function fixtureOf(caseName: string, gate: KsefOriginalImportGate, mutate: (xml: string) => string = (xml) => xml): Fixture {
  const b = build(byName(caseName));
  const xml = mutate(b.xml);
  const bytes = Buffer.from(xml, 'utf8');
  const check: KsefDuplicateCheck = {
    v: 1,
    env: 'test',
    checkedAt: '2026-09-11T08:00:00.000Z',
    reason: 'faktflow-original',
    sha256: sha256Hex(bytes),
    archivePath: `${T}/ksef-import/${b.ksefNumber}.xml`,
    sizeBytes: bytes.length,
    summary: summarizeInvoiceXml(xml),
    sameContentExceptHeader: false,
    ownHistory: false,
    acquiredAt: '2026-09-10T09:30:00.000Z',
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
    importGate: gate,
  };
  return { b, xml, check };
}

/** Magazyn oddaje bajty pliku z fikstury. */
const serve = (fx: Fixture) => m.download.mockResolvedValue(Buffer.from(fx.xml, 'utf8'));

const inputOf = (fx: Fixture, offer: DuplicateOriginalOffer, over: Partial<PrepareOriginalImportInput> = {}): PrepareOriginalImportInput => ({
  tenantId: T,
  internalNumber: fx.b.number,
  tenantNip: SELLER_NIP,
  offer,
  check: fx.check,
  ksefNumber: fx.b.ksefNumber,
  env: 'test',
  now: NOW_PREP,
  ...over,
});

const prepare = (fx: Fixture, offer: DuplicateOriginalOffer, over: Partial<PrepareOriginalImportInput> = {}) =>
  prepareOriginalImport(inputOf(fx, offer, over));

const failureOf = async (promise: ReturnType<typeof prepareOriginalImport>) => {
  const result = await promise;
  if (result.ok) throw new Error('oczekiwano odmowy suchego przebiegu, jest ok:true');
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Krok 1–2: archiwum ──────────────────────────────────────────────────────

describe('prepareOriginalImport: archiwum (kroki 1–2)', () => {
  it('odczyt przez downloadFromR2(archivePath, tenantId); brak obiektu (NoSuchKey) → archive-missing', async () => {
    const fx = fixtureOf('stawka 23', importableGate());
    m.download.mockRejectedValue(new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} }));

    const result = await failureOf(prepare(fx, 'pair'));

    expect(result.kind).toBe('archive-missing');
    expect(m.download).toHaveBeenCalledWith(fx.check.archivePath, T);
  });

  it('odpowiedź 404 magazynu (bez klasy NoSuchKey) → archive-missing', async () => {
    const fx = fixtureOf('stawka 23', importableGate());
    m.download.mockRejectedValue(Object.assign(new Error('Not Found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));

    expect((await failureOf(prepare(fx, 'pair'))).kind).toBe('archive-missing');
  });

  it.each([
    ['błąd sieci', new Error('socket hang up')],
    ['odmowa magazynu 503', Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } })],
    ['wartość, która nie jest Error', 'ECONNRESET'],
  ])('%s → read-failed z przyczyną (cause) do Sentry po stronie wołającego', async (_name, error) => {
    const fx = fixtureOf('stawka 23', importableGate());
    m.download.mockRejectedValue(error);

    const result = await failureOf(prepare(fx, 'pair'));

    expect(result.kind).toBe('read-failed');
    expect(result.cause).toBe(error);
  });

  it('inne bajty niż w znaczniku (inny SHA-256) → archive-mismatch', async () => {
    const fx = fixtureOf('stawka 23', importableGate());
    m.download.mockResolvedValue(Buffer.from(fx.xml.replace('Usługa wdrożeniowa', 'Usługa zmieniona'), 'utf8'));

    expect((await failureOf(prepare(fx, 'pair'))).kind).toBe('archive-mismatch');
  });

  it('te same bajty, ale rozmiar w znaczniku inny → archive-mismatch', async () => {
    const fx = fixtureOf('stawka 23', importableGate());
    serve(fx);

    const result = await failureOf(prepare({ ...fx, check: { ...fx.check, sizeBytes: fx.check.sizeBytes! + 1 } }, 'pair'));

    expect(result.kind).toBe('archive-mismatch');
  });
});

// ─── Krok 3–4: brama i zmiana bramy (pair / record) ──────────────────────────

describe('prepareOriginalImport: pair i record — zmiana bramy (krok 4)', () => {
  it.each([
    ['stawka 23'],
    ['z uwagami (Stopka)'],
    ['nabywca PESEL z adresem w Polsce'],
    ['mieszane 23 + zw'],
    ['mieszane 8 + 5 + 0'],
  ].flatMap(([name]) => OFFERS_PAIR.map((offer) => [name!, offer] as const)))('%s, oferta %s: plik zgodny z zapisaną bramą → ok z projekcją i bramą', async (name, offer) => {
    const fx = fixtureOf(name, importableGate());
    serve(fx);

    const result = await prepare(fx, offer);

    if (!result.ok) throw new Error(`oczekiwano ok, jest ${result.kind} (${result.detail ?? ''})`);
    expect(result.gate).toMatchObject({ v: 1, rules: ORIGINAL_GATE_RULES, kind: 'importable', problems: [] });
    expect(result.projection.v).toBe(1);
    expect(result.projection.xml).toEqual({ storage_path: fx.check.archivePath, sha256: fx.check.sha256, size_bytes: fx.check.sizeBytes });
    expect(result.projection.invoice.internal_number).toBe(fx.b.number);
    const provenance = (result.projection.invoice.fa3_data as { import: Record<string, unknown> }).import;
    expect(provenance).toMatchObject({ source: ORIGINAL_IMPORT_SOURCE, originalSha256: fx.check.sha256, preparedAt: NOW_PREP.toISOString() });
    // Projekcja przechodzi lustro 4.8 — to samo, co sprawdzi baza.
    expect(originalImportProjectionProblem(result.projection, {
      internalNumber: fx.b.number, tenantNip: SELLER_NIP, tenantId: T, ksefNumber: fx.b.ksefNumber, check: fx.check, offer,
    })).toBeNull();
  });

  it.each(OFFERS_PAIR)('%s: plik przestał wyglądać na plik z FaktFlow (brama importable → review) → gate-drift z opisem różnicy', async (offer) => {
    const fx = fixtureOf('stawka 23', importableGate(), (xml) => xml.replace('<P_9A>', '<P_9B>61.5</P_9B><P_9A>'));
    serve(fx);

    const result = await failureOf(prepare(fx, offer));

    expect(result.kind).toBe('gate-drift');
    expect(typeof result.detail).toBe('string');
    expect(result.detail!.length).toBeGreaterThan(0);
  });

  it.each(OFFERS_PAIR)('%s: zapisana brama review, a plik jest importable → też gate-drift (kind inny)', async (offer) => {
    const fx = fixtureOf('stawka 23', reviewGate(['gross-prices']));
    serve(fx);

    expect((await failureOf(prepare(fx, offer))).kind).toBe('gate-drift');
  });

  it.each(OFFERS_PAIR)('%s: SAMA wyższa (albo niższa) wartość rules to nie zmiana bramy → ok', async (offer) => {
    for (const rules of [ORIGINAL_GATE_RULES + 1, 99, 0]) {
      const fx = fixtureOf('stawka 23', importableGate({ rules }));
      serve(fx);

      const result = await prepare(fx, offer);

      expect(result.ok, `rules ${rules}`).toBe(true);
    }
  });
});

// ─── Krok 4–5: review-* ──────────────────────────────────────────────────────

describe('prepareOriginalImport: review-pair i review-record — operator ocenia plik, który widzi', () => {
  it.each(OFFERS_REVIEW)('%s: rozjazd względem zapisanej bramy to nie błąd — ok (zapisana review, plik dziś importable)', async (offer) => {
    const fx = fixtureOf('stawka 23', reviewGate(['rates']));
    serve(fx);

    const result = await prepare(fx, offer);

    if (!result.ok) throw new Error(`oczekiwano ok, jest ${result.kind} (${result.detail ?? ''})`);
    expect(result.gate.kind).toBe('importable');
  });

  it.each(OFFERS_REVIEW)('%s: zapisane inne problemy niż dziś → ok, brama w wyniku to ocena bieżącego pliku', async (offer) => {
    const fx = fixtureOf('stawka 23', reviewGate(['rates']), (xml) => xml.replace('<P_9A>', '<P_9B>61.5</P_9B><P_9A>'));
    serve(fx);

    const result = await prepare(fx, offer);

    if (!result.ok) throw new Error(`oczekiwano ok, jest ${result.kind} (${result.detail ?? ''})`);
    expect(result.gate.kind).toBe('review');
    expect(result.gate.problems).toEqual(['gross-prices']);
  });

  it.each(OFFERS_REVIEW)('%s: stawka 0 WDT (FA(3) spoza FaktFlow) jest zapisywalna — ok, stawka dosłownie w pozycji', async (offer) => {
    const fx = fixtureOf('stawka 23', reviewGate(['rates']), (xml) => {
      let out = xml.replace('<P_12>23</P_12>', '<P_12>0 WDT</P_12>');
      out = out.replace('<P_13_1>', '<P_13_6_2>').replace('</P_13_1>', '</P_13_6_2>');
      return out.replace(/<P_14_1>[^<]*<\/P_14_1><P_15>123\.00/, '<P_15>100.00');
    });
    serve(fx);

    const result = await prepare(fx, offer);

    if (!result.ok) throw new Error(`oczekiwano ok, jest ${result.kind} (${result.detail ?? ''})`);
    expect(result.gate.problems).toEqual(['rates']);
    expect(result.projection.lines.map((l) => l.vat_rate)).toEqual(['0 WDT']);
  });

  const UNBUILDABLE: ReadonlyArray<{
    problem: (typeof ORIGINAL_GATE_UNBUILDABLE_PROBLEMS)[number];
    mutate?: (xml: string) => string;
    input?: (b: Built) => Partial<PrepareOriginalImportInput>;
  }> = [
    { problem: 'parse', mutate: () => 'to nie jest XML' },
    { problem: 'currency', mutate: (xml) => xml.replace('<KodWaluty>PLN</KodWaluty>', '<KodWaluty>EUR</KodWaluty>') },
    { problem: 'kind', mutate: (xml) => xml.replace('<RodzajFaktury>VAT</RodzajFaktury>', '<RodzajFaktury>UPR</RodzajFaktury>') },
    { problem: 'number', input: () => ({ internalNumber: 'FV/INNY/9' }) },
    { problem: 'seller', input: () => ({ tenantNip: BUYER_NIP }) },
    { problem: 'no-lines', mutate: (xml) => xml.replace(/<FaWiersz>.*<\/FaWiersz>/, '') },
  ];

  it('lista przypadków obejmuje wszystkie problemy, przy których oryginału nie zapisze nawet operator', async () => {
    // Wymusza uruchomienie kodu (a nie samej tabeli): jedna odmowa na problem.
    const seen: string[] = [];
    for (const u of UNBUILDABLE) {
      const fx = fixtureOf('stawka 23', reviewGate([u.problem]), u.mutate);
      serve(fx);
      const result = await failureOf(prepare(fx, 'review-pair', u.input?.(fx.b)));
      seen.push(result.detail ?? '');
    }

    expect(seen.sort()).toEqual([...ORIGINAL_GATE_UNBUILDABLE_PROBLEMS].sort());
  });

  it.each(UNBUILDABLE.flatMap((u) => OFFERS_REVIEW.map((offer) => [u.problem, offer, u] as const)))(
    'problem %s przy ofercie %s → not-buildable:<problem> (bez zapisu K przez nikogo)',
    async (problem, offer, u) => {
      const fx = fixtureOf('stawka 23', reviewGate([problem]), u.mutate);
      serve(fx);

      const result = await failureOf(prepare(fx, offer, u.input?.(fx.b)));

      expect(result.kind).toBe('not-buildable');
      expect(result.detail).toBe(problem);
    },
  );

  it.each(OFFERS_REVIEW)('%s: pozycja bez stawki (nieznana) → not-buildable:lines — lustro 4.8 przed RPC', async (offer) => {
    const fx = fixtureOf('mieszane 23 + zw', reviewGate(['line-fields']), (xml) => xml.replace('<P_12>23</P_12>', ''));
    serve(fx);

    const result = await failureOf(prepare(fx, offer));

    expect(result.kind).toBe('not-buildable');
    expect(result.detail).toBe('lines');
  });

  it.each(OFFERS_REVIEW)('%s: sumy pozycji ≠ nagłówek (netto pozycji ≠ P_13_1) → not-buildable:totals', async (offer) => {
    const fx = fixtureOf('stawka 23', reviewGate(['amounts']), (xml) => xml.replace('<P_11>100.00</P_11>', '<P_11>90.00</P_11>'));
    serve(fx);

    const result = await failureOf(prepare(fx, offer));

    expect(result.kind).toBe('not-buildable');
    expect(result.detail).toBe('totals');
  });
});

// ─── Krok 6: lustro 4.8 także przy pair/record (błąd programu) ───────────────

describe('prepareOriginalImport: pair i record — projekcja niezgodna z lustrem 4.8 to błąd programu (not-buildable)', () => {
  it.each(OFFERS_PAIR)('%s: dane w znaczniku niezgodne z plikiem (summary.gross) → not-buildable:gross', async (offer) => {
    const fx = fixtureOf('stawka 23', importableGate());
    serve(fx);
    const tampered = { ...fx, check: { ...fx.check, summary: { ...fx.check.summary!, gross: '999.99' } } };

    const result = await failureOf(prepare(tampered, offer));

    expect(result.kind).toBe('not-buildable');
    expect(result.detail).toBe('gross');
  });

  it.each(OFFERS_PAIR)('%s: NIP nabywcy w znaczniku inny niż w pliku → not-buildable:buyer', async (offer) => {
    const fx = fixtureOf('stawka 23', importableGate());
    serve(fx);
    const tampered = { ...fx, check: { ...fx.check, summary: { ...fx.check.summary!, buyerNip: '5260001246' } } };

    const result = await failureOf(prepare(tampered, offer));

    expect(result.kind).toBe('not-buildable');
    expect(result.detail).toBe('buyer');
  });
});

// ─── Tylko odczyty ───────────────────────────────────────────────────────────

describe('prepareOriginalImport: tylko odczyty (INV-13) — nigdy nie pisze i nie alarmuje', () => {
  it('sukces i każda odmowa: żadnego zapisu do magazynu, żadnego Sentry', async () => {
    const good = fixtureOf('stawka 23', importableGate());
    serve(good);
    await prepare(good, 'pair');

    m.download.mockRejectedValue(new NoSuchKey({ message: 'x', $metadata: {} }));
    await prepare(good, 'pair');
    m.download.mockRejectedValue(new Error('socket hang up'));
    await prepare(good, 'pair');
    m.download.mockResolvedValue(Buffer.from('inne bajty', 'utf8'));
    await prepare(good, 'pair');

    const drift = fixtureOf('stawka 23', importableGate(), (xml) => xml.replace('<P_9A>', '<P_9B>61.5</P_9B><P_9A>'));
    serve(drift);
    await prepare(drift, 'pair');
    const unbuildable = fixtureOf('stawka 23', reviewGate(['kind']), (xml) => xml.replace('<RodzajFaktury>VAT</RodzajFaktury>', '<RodzajFaktury>UPR</RodzajFaktury>'));
    serve(unbuildable);
    await prepare(unbuildable, 'review-pair');

    expect(m.download).toHaveBeenCalledTimes(6);
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.captureMessage).not.toHaveBeenCalled();
    expect(m.captureException).not.toHaveBeenCalled();
  });

  it('nie zmienia wejścia (znacznika)', async () => {
    const fx = fixtureOf('stawka 23', importableGate());
    serve(fx);
    const before = JSON.stringify(fx.check);

    await prepare(fx, 'pair');

    expect(JSON.stringify(fx.check)).toBe(before);
  });
});

// ─── originalRecheckKindFor ──────────────────────────────────────────────────

describe('originalRecheckKindFor: rodzaj znacznika recheckNeeded dla odmowy suchego przebiegu (5.6 krok 9)', () => {
  it.each<[PrepareOriginalImportFailureKind, string | undefined, string | null]>([
    ['archive-missing', undefined, 'archive-missing'],
    ['archive-mismatch', undefined, 'archive-mismatch'],
    ['gate-drift', 'zapisano importable [], jest review [rates]', 'gate-drift'],
    ['not-buildable', 'number', 'import-mismatch'],
    ['not-buildable', 'seller', 'import-mismatch'],
    ['not-buildable', 'lines', 'not-buildable'],
    ['not-buildable', 'totals', 'not-buildable'],
    ['not-buildable', 'gross', 'not-buildable'],
    ['not-buildable', 'kind', 'not-buildable'],
    ['not-buildable', 'currency', 'not-buildable'],
    ['not-buildable', undefined, 'not-buildable'],
    ['read-failed', undefined, null],
  ])('%s (detail: %s) → %s', (kind, detail, expected) => {
    const got = originalRecheckKindFor({ kind, ...(detail !== undefined ? { detail } : {}) });

    expect(got).toBe(expected);
    if (got !== null) expect(ORIGINAL_RECHECK_KINDS).toContain(got);
  });
});

// ─── originalDecisionAlarms ──────────────────────────────────────────────────

type AdminClient = ReturnType<typeof createAdminClient>;

describe('originalDecisionAlarms: alarmy po decyzji ze stanu bazy (T5), odcisk [kind, invoiceId]', () => {
  const X = '33333333-3333-4333-8333-333333333333';
  const K_ID = '44444444-4444-4444-8444-444444444444';
  const KSEF = `${SELLER_NIP}-20260910-0100A0B0C0D0-1A`;
  const SESSION = '20260910-SO-0100A0B0C0-0100A0B0C0-AA';

  const kRow = (over: Record<string, unknown> = {}) => ({
    id: K_ID, tenant_id: T, direction: 'outgoing', origin: 'ksef_import', ksef_status: 'accepted', ksef_number: KSEF,
    ksef_accepted_at: '2026-09-10T09:30:00.000Z', ...over,
  });
  const sessionRow = (over: Record<string, unknown> = {}) => ({
    id: 'sub-1', tenant_id: T, invoice_id: K_ID, status: 'accepted', session_reference_number: SESSION,
    response_ksef_number: KSEF, ...over,
  });

  const adminOf = (tables: MemoryTables) => memoryClient(tables) as unknown as AdminClient;
  const run = (admin: AdminClient, importedInvoiceId: string | null = K_ID) =>
    originalDecisionAlarms(admin, { tenantId: T, invoiceId: X, importedInvoiceId });

  const alarm = (kind: string) => [
    expect.any(String),
    expect.objectContaining({
      level: 'warning',
      tags: expect.objectContaining({ area: 'ksef.duplicate-decision', kind }),
      fingerprint: [kind, X],
      extra: expect.objectContaining({ tenantId: T, invoiceId: X, importedInvoiceId: K_ID }),
    }),
  ];

  it('K z datą nadania i wpisem z sesją → bez alarmu', async () => {
    await run(adminOf({ invoices: [kRow()], ksef_submissions: [sessionRow()] }));

    expect(m.captureMessage).not.toHaveBeenCalled();
    expect(m.captureException).not.toHaveBeenCalled();
  });

  it('K bez ksef_accepted_at → jeden alarm ksef-duplicate-import-no-date', async () => {
    await run(adminOf({ invoices: [kRow({ ksef_accepted_at: null })], ksef_submissions: [sessionRow()] }));

    expect(m.captureMessage).toHaveBeenCalledTimes(1);
    expect(m.captureMessage).toHaveBeenCalledWith(...alarm(KSEF_ORIGINAL_ALARM_KINDS.importNoDate));
  });

  it.each([
    ['brak wpisów K', []],
    ['wpis K bez numeru sesji', [sessionRow({ session_reference_number: null })]],
    ['wpis z sesją, ale dla innego numeru KSeF', [sessionRow({ response_ksef_number: `${SELLER_NIP}-20260910-0100A0B0C0D0-9Z` })]],
  ])('%s → jeden alarm ksef-duplicate-import-no-session', async (_name, submissions) => {
    await run(adminOf({ invoices: [kRow()], ksef_submissions: submissions }));

    expect(m.captureMessage).toHaveBeenCalledTimes(1);
    expect(m.captureMessage).toHaveBeenCalledWith(...alarm(KSEF_ORIGINAL_ALARM_KINDS.importNoSession));
  });

  it('K bez daty i bez sesji → oba alarmy, każdy z własnym odciskiem', async () => {
    await run(adminOf({ invoices: [kRow({ ksef_accepted_at: null })], ksef_submissions: [] }));

    const kinds = m.captureMessage.mock.calls.map(([, options]) => (options as { tags: { kind: string } }).tags.kind).sort();
    expect(kinds).toEqual([KSEF_ORIGINAL_ALARM_KINDS.importNoDate, KSEF_ORIGINAL_ALARM_KINDS.importNoSession].sort());
    for (const [, options] of m.captureMessage.mock.calls) {
      const { tags, fingerprint } = options as { tags: { kind: string }; fingerprint: string[] };
      expect(fingerprint).toEqual([tags.kind, X]);
    }
  });

  it('ponowienie (zgubiona odpowiedź) → ten sam alarm z tym samym odciskiem (Sentry go nie zdubluje)', async () => {
    const admin = adminOf({ invoices: [kRow({ ksef_accepted_at: null })], ksef_submissions: [sessionRow()] });

    await run(admin);
    await run(admin);

    expect(m.captureMessage).toHaveBeenCalledTimes(2);
    expect(m.captureMessage.mock.calls[1]![1]).toEqual(m.captureMessage.mock.calls[0]![1]);
  });

  it('decyzja bez zapisu (importedInvoiceId null) → nic do sprawdzenia: bez odczytu bazy i bez alarmu', async () => {
    const tables: MemoryTables = { invoices: [kRow({ ksef_accepted_at: null })], ksef_submissions: [] };
    const admin = memoryClient(tables);
    const from = vi.spyOn(admin, 'from');

    await run(admin as unknown as AdminClient, null);

    expect(from).not.toHaveBeenCalled();
    expect(m.captureMessage).not.toHaveBeenCalled();
  });

  it('błąd odczytu bazy → captureException, bez alarmów danych, nigdy nie rzuca', async () => {
    const chain: unknown = new Proxy(() => chain, {
      get: (_target, prop) => (prop === 'then'
        ? (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'db down' } }).then(resolve)
        : chain),
      apply: () => chain,
    });
    const failing = { from: () => chain } as unknown as AdminClient;

    await expect(run(failing)).resolves.toBeUndefined();

    // Odczyty K i jego wpisów mogą iść równolegle — każdy może zgłosić swój błąd, więc nie dokładnie raz.
    expect(m.captureException).toHaveBeenCalled();
    expect(m.captureMessage).not.toHaveBeenCalled();
  });

  it('wyjątek klienta bazy (rzucone from) → captureException, nigdy nie rzuca', async () => {
    const throwing = { from: () => { throw new Error('połączenie zerwane'); } } as unknown as AdminClient;

    await expect(run(throwing)).resolves.toBeUndefined();

    expect(m.captureException).toHaveBeenCalled();
    expect(m.captureMessage).not.toHaveBeenCalled();
  });
});
