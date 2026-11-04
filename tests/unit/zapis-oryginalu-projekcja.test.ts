import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

/**
 * D-A4-1b-3 PR C (spec v3, 5.3, 4.8 i 7.2): projekcja oryginału K do zapisu
 * w FaktFlow — `buildOriginalImportProjection` (nagłówek i pozycje zbudowane
 * budowniczymi C0 z `lib/import/imported-invoice-row.ts`, przekazywane do
 * `decide_ksef_duplicate_original` jako `p_import`) oraz jej lustro
 * `originalImportProjectionProblem` (te same kody w tej samej kolejności co
 * SQL `ksef_original_import_mismatch`).
 *
 * CZERWONE na commicie kontraktu (commit 1): obie funkcje są szkieletami,
 * które rzucają „PR C: nie zaimplementowane”. Plik się ładuje (typy zgodne,
 * macierz budowana prawdziwym generatorem FaktFlow), a każdy test pada na
 * zachowaniu projekcji. Stałe modułu (`ORIGINAL_IMPORT_*`) już istnieją —
 * ich zgodność z SQL pilnuje `zapis-oryginalu-migracja.test.ts` (grupa A),
 * więc tu nie ma testów samych stałych.
 *
 * Pokrycie:
 * - projekcja na macierzy rundy (INV-1, INV-2): klucze = `ORIGINAL_IMPORT_*_KEYS`,
 *   brak kolumn ustawianych przez SQL, `notes` = Stopka, `fa3_data.import`
 *   (source, originalSha256, …), brak `lines` w `fa3_data`, `xml`, sumy pozycji
 *   = nagłówek co do grosza, zgodność z budowniczymi C0, serializowalność do jsonb;
 * - lustro: `NULL` dla każdego przypadku macierzy (R-C1c) w każdej ofercie;
 * - wspólna tabela `originalImportMismatchCases()` na bazie `originalImportBase()`
 *   (ta sama co R-C6 na bazie — wypełnia ją grupa B; wołana LENIWIE wewnątrz testu);
 * - własne przypadki 4.8 niezależne od tabeli wspólnej: kolejność kodów
 *   (pierwszy niezgodny wygrywa), dowolny kształt wejścia bez rzucania,
 *   stawki FA(3) spoza FaktFlow zależne od oferty.
 */

import { parseFa3Xml, type ParsedInvoice } from '@/lib/import/fa3-parser';
import { buildImportedInvoiceRow, buildImportedLineRows, importedInvoiceContent } from '@/lib/import/imported-invoice-row';
import {
  ORIGINAL_GATE_RULES,
  ORIGINAL_IMPORT_SOURCE,
  type DuplicateOriginalOffer,
  type KsefDuplicateCheck,
} from '@/lib/ksef/duplicate-check';
import {
  buildOriginalImportProjection,
  ORIGINAL_IMPORT_INVOICE_KEYS,
  ORIGINAL_IMPORT_LINE_KEYS,
  ORIGINAL_IMPORT_PROBLEMS,
  ORIGINAL_IMPORT_SQL_COLUMNS,
  ORIGINAL_IMPORT_VAT_RATES,
  originalImportProjectionProblem,
  type KsefOriginalImportProjection,
  type OriginalImportProblem,
  type OriginalImportProblemContext,
} from '@/lib/ksef/duplicate-original-projection';
import { summarizeInvoiceXml } from '@/lib/ksef/duplicate-verdict';
import { originalImportBase, originalImportMismatchCases } from './helpers/ksef-duplicate-decision-cases';
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
/** 11 cyfr z NIEpoprawną sumą kontrolną PESEL. */
const ELEVEN_DIGITS_BAD_CHECKSUM = '12345678901';
const BANK_ACCOUNT = '61109010140000071219812874';
const ISSUE = '2026-09-10';
const GENERATED_AT = new Date('2026-09-10T08:00:00Z');
const NOW = new Date('2026-09-10T09:00:00Z');
const ART_113 = 'art. 113 ust. 1 ustawy o VAT';
/** Zwolnienie przedmiotowe — nie wyklucza metody kasowej (AUD-68, `buildInvoiceAnnotations`). */
const ART_43 = 'art. 43 ust. 1 pkt 19 ustawy o VAT';

const SELLER = {
  nip: SELLER_NIP,
  name: 'Firma testowa sp. z o.o.',
  email: 'biuro@example.test',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
} as const;

const ADDRESS_PL = { countryCode: 'PL', addressLine1: 'ul. Kliencka 2', addressLine2: '00-002 Warszawa' };
const ADDRESS_DE = { countryCode: 'DE', addressLine1: 'Teststraße 1', addressLine2: '10115 Berlin' };

const BUYER_B2B: BuyerParty = {
  nip: BUYER_NIP,
  name: 'Nabywca testowy sp. z o.o.',
  email: 'nabywca@example.test',
  address: ADDRESS_PL,
};
const BUYER_EU: BuyerParty = { vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: ADDRESS_DE };

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
  // ── Stawki pojedynczo ──
  { name: 'stawka 23', lines: single('23'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },
  { name: 'stawka 8', lines: single('8'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },
  { name: 'stawka 5', lines: single('5'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },
  { name: 'stawka 0 (0 KR)', lines: single('0'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },
  {
    name: 'stawka zw z podstawą (art. 113)',
    lines: single('zw'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    exemptionBasis: ART_113,
    expectAnnotations: { vatExemptionBasis: ART_113, vatExemptionBasisKind: 'P_19A' },
  },
  {
    name: 'stawka oo (P_18=1)',
    lines: single('oo'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    expectAnnotations: { reverseCharge: 1 },
  },
  { name: 'stawka np', lines: single('np'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },

  // ── Stawki mieszane ──
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
    name: 'mieszane 23 + oo',
    lines: [...single('23', 100, 1), ...single('oo', 100, 1)],
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    expectAnnotations: { reverseCharge: 1 },
  },

  // ── np II (nabywca VAT-UE; z nabywcą NIP validateInvoice odmawia) ──
  {
    name: 'np_ii z nabywcą VAT-UE',
    lines: single('np_ii', 500, 1),
    buyer: BUYER_EU,
    expectBuyer: { vatUeNumber: 'DE123456789' },
    expectAnnotations: { reverseCharge: 1 },
  },
  {
    name: 'np + np_ii z nabywcą VAT-UE',
    lines: [...single('np', 100, 1), ...single('np_ii', 500, 1)],
    buyer: BUYER_EU,
    expectBuyer: { vatUeNumber: 'DE123456789' },
    expectAnnotations: { reverseCharge: 1 },
  },

  // ── Nabywca ──
  { name: 'nabywca NIP', lines: single('23'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },
  {
    name: 'nabywca PESEL z adresem w Polsce',
    lines: single('23'),
    buyer: consumer('pesel', { name: 'Jan Testowy', pesel: PESEL, address: ADDRESS_PL }),
    expectBuyer: { pesel: PESEL },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'cash' },
  },
  {
    // GEN-PESEL-KRAJ: generator pisze KodKraju z adresu; plik niesie DE + PESEL, odczyt = nrInny.
    name: 'nabywca PESEL z adresem zagranicznym → nrInny',
    lines: single('23'),
    buyer: consumer('pesel', { name: 'Jan Testowy', pesel: PESEL, address: ADDRESS_DE }),
    expectBuyer: { nrInny: PESEL },
  },
  {
    name: 'nabywca NrInny: dowód osobisty (id_card)',
    lines: single('23'),
    buyer: consumer('id_card', { name: 'Anna Testowa', idNumber: 'ABC123456', address: ADDRESS_PL }),
    expectBuyer: { nrInny: 'ABC123456' },
  },
  {
    name: 'nabywca NrInny: paszport (passport)',
    lines: single('23'),
    buyer: consumer('passport', { name: 'John Test', idNumber: 'C01X00T47', address: ADDRESS_DE }),
    expectBuyer: { nrInny: 'C01X00T47' },
  },
  {
    // 11 cyfr z poprawną sumą PESEL i KodKraju PL — FA(3) ich nie rozróżnia.
    name: 'nabywca NrInny 11 cyfr z sumą PESEL i adresem PL → pesel',
    lines: single('23'),
    buyer: consumer('passport', { name: 'Jan Paszportowy', idNumber: PESEL, address: ADDRESS_PL }),
    expectBuyer: { pesel: PESEL },
  },
  {
    name: 'nabywca NrInny 11 cyfr bez sumy PESEL (adres PL) → nrInny',
    lines: single('23'),
    buyer: consumer('id_card', { name: 'Jan Dowodowy', idNumber: ELEVEN_DIGITS_BAD_CHECKSUM, address: ADDRESS_PL }),
    expectBuyer: { nrInny: ELEVEN_DIGITS_BAD_CHECKSUM },
  },
  {
    name: 'nabywca VAT-UE z innego kraju UE',
    lines: single('23'),
    buyer: BUYER_EU,
    expectBuyer: { vatUeNumber: 'DE123456789' },
  },
  {
    name: 'nabywca VAT-UE z prefiksem PL',
    lines: single('23'),
    buyer: { vatUeNumber: `PL${BUYER_NIP}`, name: 'Spółka z numerem VAT-UE PL', address: ADDRESS_PL },
    expectBuyer: { vatUeNumber: `PL${BUYER_NIP}` },
  },
  {
    name: 'nabywca BrakID',
    lines: single('23'),
    buyer: consumer('no_id', { name: 'Konsument', address: ADDRESS_PL }),
    expectBuyer: { brakId: true },
  },
  { name: 'JST=1', lines: single('23'), buyer: { ...BUYER_B2B, jst: 1 }, expectBuyer: { nip: BUYER_NIP } },
  { name: 'GV=1', lines: single('23'), buyer: { ...BUYER_B2B, gv: 1 }, expectBuyer: { nip: BUYER_NIP } },
  {
    name: 'JST=1 i GV=1',
    lines: single('23'),
    buyer: { ...BUYER_B2B, jst: 1, gv: 1 },
    expectBuyer: { nip: BUYER_NIP },
  },

  // ── Adnotacje ──
  {
    name: 'MPP (P_18A=1)',
    lines: single('23', 15000, 1),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    splitPayment: true,
    expectAnnotations: { splitPayment: 1 },
  },
  {
    name: 'metoda kasowa (P_16=1)',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    cashMethod: true,
    expectAnnotations: { cashMethod: 1 },
  },
  {
    name: 'zw z P_19A (art. 43)',
    lines: single('zw'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    exemptionBasis: ART_43,
    expectAnnotations: { vatExemptionBasis: ART_43, vatExemptionBasisKind: 'P_19A' },
  },
  {
    name: 'zw z metodą kasową (P_16=1 + P_19A)',
    lines: single('zw'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    exemptionBasis: ART_43,
    cashMethod: true,
    expectAnnotations: { cashMethod: 1, vatExemptionBasis: ART_43, vatExemptionBasisKind: 'P_19A' },
  },

  // ── Daty ──
  {
    name: 'P_6 różne od P_1',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    saleDate: '2026-09-05',
  },
  { name: 'bez P_6', lines: single('23'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP }, saleDate: null },
  {
    name: 'P_16 z P_6',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    saleDate: '2026-09-05',
    cashMethod: true,
    expectAnnotations: { cashMethod: 1 },
  },

  // ── Uwagi (Stopka) ──
  {
    name: 'z uwagami (Stopka)',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    notes: 'Dziękujemy za zakup. Zamówienie nr 42 & "pilne" <3',
  },
  {
    name: 'z uwagami z odstępami na brzegach (przycięcie)',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    notes: '  Termin realizacji: 14 dni.  ',
  },
  { name: 'bez uwag', lines: single('23'), buyer: BUYER_B2B, expectBuyer: { nip: BUYER_NIP } },

  // ── Płatność ──
  {
    name: 'płatność: przelew z rachunkiem i nazwą banku',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    payment: { ...TRANSFER, bankName: 'Santander Bank Polska' },
  },
  {
    name: 'płatność: gotówka',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'cash' },
  },
  {
    name: 'płatność: karta',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'card' },
  },
  {
    name: 'płatność: inna',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'other' },
  },

  // ── Liczby ──
  {
    name: 'ilość i cena z 4 miejscami po przecinku',
    lines: [{ name: 'Materiał na metry', unit: 'm', qty: 1.2345, price: 12.3456, rate: '23' }],
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
  },
  {
    name: 'pozycja z ceną 0',
    lines: [
      { name: 'Usługa wdrożeniowa', unit: 'usł.', qty: 1, price: 100, rate: '23' },
      { name: 'Gratis do zamówienia', unit: 'szt.', qty: 1, price: 0, rate: '23' },
    ],
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
  },
  {
    name: '40 pozycji po 0,02 zł przy 23% (zaokrąglenia)',
    lines: Array.from({ length: 40 }, (_, i) => ({
      name: `Drobiazg ${i + 1}`,
      unit: 'szt.',
      qty: 1,
      price: 0.02,
      rate: '23' as const,
    })),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
  },
];

/** Para (nazwa, przypadek) dla `it.each` — tytuł testu z pełną nazwą. */
const EACH = MATRIX.map((c) => [c.name, c] as const);
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


// ─── Projekcja i kontekst dla przypadku macierzy ─────────────────────────────

const PREPARED_AT = new Date('2026-09-11T10:00:00.000Z');
const CHECKED_AT = '2026-09-11T08:00:00.000Z';
const ACQUIRED_AT = '2026-09-10T09:30:00.000Z';
const OFFERS: readonly DuplicateOriginalOffer[] = ['pair', 'record', 'review-pair', 'review-record'];
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `original_check` znacznika `faktflow-original` dla pliku z macierzy (to, co zapisuje runner). */
function checkOf(b: Built): KsefDuplicateCheck {
  return {
    v: 1,
    env: 'test',
    checkedAt: CHECKED_AT,
    reason: 'faktflow-original',
    sha256: sha256Hex(b.xml),
    archivePath: `${T}/ksef-import/${b.ksefNumber}.xml`,
    sizeBytes: Buffer.byteLength(b.xml, 'utf8'),
    summary: summarizeInvoiceXml(b.xml),
    sameContentExceptHeader: false,
    ownHistory: false,
    acquiredAt: ACQUIRED_AT,
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
  };
}

interface Base {
  b: Built;
  parsed: ParsedInvoice;
  check: KsefDuplicateCheck;
  projection: KsefOriginalImportProjection;
}

const bases = new Map<string, Base>();

/** Plik z macierzy → odczyt → projekcja (jak `prepareOriginalImport`, ale bez magazynu i bramy). */
function baseOf(c: MatrixCase): Base {
  const cached = bases.get(c.name);
  if (cached) return cached;
  const b = build(c);
  const parsed = parseFa3Xml(b.xml, { ksefNumber: b.ksefNumber });
  const { content, amounts } = importedInvoiceContent(parsed);
  const check = checkOf(b);
  const projection = buildOriginalImportProjection(parsed, content, amounts, {
    tenantId: T,
    env: 'test',
    check,
    ksefNumber: b.ksefNumber,
    now: PREPARED_AT,
  });
  const base = { b, parsed, check, projection };
  bases.set(c.name, base);
  return base;
}

/** Kontekst lustra 4.8 dla bazy: numer X = P_2, NIP firmy = sprzedawca, `original_check` pliku. */
function contextOf(base: Base, offer: DuplicateOriginalOffer): OriginalImportProblemContext {
  return {
    internalNumber: base.b.number,
    tenantNip: SELLER_NIP,
    tenantId: T,
    ksefNumber: base.b.ksefNumber,
    check: base.check,
    offer,
  };
}

const centsOf = (value: unknown) => Math.round(Number(value) * 100);
/** Kwota z dodanym przesunięciem, nadal z 2 miejscami po przecinku (bez śmieci zmiennoprzecinkowych). */
const plus = (value: unknown, delta: number) => Math.round((Number(value) + delta) * 100) / 100;

// ─── buildOriginalImportProjection na macierzy rundy ─────────────────────────

describe('buildOriginalImportProjection: macierz rundy', () => {
  it.each(EACH)('%s: klucze nagłówka i pozycji = ORIGINAL_IMPORT_*_KEYS, bez kolumn ustawianych przez SQL', (_name, c) => {
    const { projection } = baseOf(c);

    expect(projection.v).toBe(1);
    expect(Object.keys(projection).sort()).toEqual(['invoice', 'lines', 'v', 'xml']);
    expect(Object.keys(projection.invoice).sort()).toEqual([...ORIGINAL_IMPORT_INVOICE_KEYS].sort());
    expect(projection.lines.length).toBeGreaterThan(0);
    for (const line of projection.lines) {
      expect(Object.keys(line).sort()).toEqual([...ORIGINAL_IMPORT_LINE_KEYS].sort());
    }
    for (const column of ORIGINAL_IMPORT_SQL_COLUMNS) expect(projection.invoice).not.toHaveProperty(column);
    expect(projection.lines[0]).not.toHaveProperty('invoice_id');
  });

  it.each(EACH)('%s: numer = P_2, VAT, sprzedawca, nabywca B2C bez NIP, uwagi = Stopka', (_name, c) => {
    const { projection, b } = baseOf(c);

    expect(projection.invoice.internal_number).toBe(b.number);
    expect(projection.invoice.invoice_type).toBe('VAT');
    expect(projection.invoice.issue_date).toBe(ISSUE);
    expect(projection.invoice.seller_nip).toBe(SELLER_NIP);
    // Lustro `check_b2c_has_id` (00012:106-111): konsument nie ma NIP.
    expect(projection.invoice.is_b2c && projection.invoice.buyer_id_type === 'nip').toBe(false);
    // Uwagi z pliku (Stopka) trafiają na K; bez uwag — NULL, nigdy pusty napis.
    expect(projection.invoice.notes).toBe(c.notes?.trim() ?? null);
  });

  it.each(EACH)('%s: fa3_data.import niesie pochodzenie zapisu, a na górze nie ma lines', (_name, c) => {
    const { projection, check } = baseOf(c);
    const fa3 = projection.invoice.fa3_data as Record<string, unknown>;

    expect(fa3.import).toEqual({
      source: ORIGINAL_IMPORT_SOURCE,
      originalSha256: check.sha256,
      checkedAt: CHECKED_AT,
      preparedAt: PREPARED_AT.toISOString(),
      gateRules: ORIGINAL_GATE_RULES,
    });
    expect(Object.keys(fa3)).not.toContain('lines');
  });

  it.each(EACH)('%s: xml = ścieżka, SHA-256 i rozmiar pliku z archiwum', (_name, c) => {
    const { projection, check } = baseOf(c);

    expect(projection.xml).toEqual({ storage_path: check.archivePath, sha256: check.sha256, size_bytes: check.sizeBytes });
  });

  it.each(EACH)('%s: INV-2 — sumy pozycji (netto, VAT, brutto) = nagłówek co do grosza', (_name, c) => {
    const { projection, b } = baseOf(c);
    const sum = (key: 'net_amount' | 'vat_amount' | 'gross_amount') => projection.lines.reduce((acc, l) => acc + centsOf(l[key]), 0);

    expect(sum('net_amount')).toBe(centsOf(projection.invoice.net_total));
    expect(sum('vat_amount')).toBe(centsOf(projection.invoice.vat_total));
    expect(sum('gross_amount')).toBe(centsOf(projection.invoice.gross_total));
    expect(projection.invoice.gross_total).toBe(b.invoice.grossTotal);
  });

  it.each(EACH)('%s: nagłówek i pozycje = budowniczowie C0 (jedno źródło z Magicznym importem), serializowalne do jsonb', (_name, c) => {
    const { projection, parsed, check, b } = baseOf(c);
    const { content, amounts } = importedInvoiceContent(parsed);
    const row = buildImportedInvoiceRow(parsed, {
      tenantId: T,
      direction: 'outgoing',
      origin: 'ksef_import',
      ksefStatus: 'accepted',
      ksefEnvironment: 'test',
      ksefAcceptedAt: check.acquiredAt,
      ksefNumber: b.ksefNumber,
      xmlStoragePath: check.archivePath,
      notes: parsed.footerNote ?? null,
      provenance: {
        source: ORIGINAL_IMPORT_SOURCE,
        originalSha256: check.sha256,
        checkedAt: CHECKED_AT,
        preparedAt: PREPARED_AT.toISOString(),
        gateRules: ORIGINAL_GATE_RULES,
      },
    }, content, amounts);

    const expectedInvoice = Object.fromEntries(ORIGINAL_IMPORT_INVOICE_KEYS.map((key) => [key, row[key]]));
    expect(projection.invoice).toEqual(expectedInvoice);
    expect(projection.lines).toEqual(buildImportedLineRows(parsed, amounts));
    // `p_import` leci do PostgREST jako JSON: nic nie może zniknąć ani się zmienić po serializacji.
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
  });
});

describe('buildOriginalImportProjection: czystość', () => {
  it('te same wejście → ta sama projekcja; czas wpływa tylko na fa3_data.import.preparedAt; wejście nietknięte', () => {
    const b = build(byName('mieszane 23 + zw'));
    const parsed = parseFa3Xml(b.xml, { ksefNumber: b.ksefNumber });
    const { content, amounts } = importedInvoiceContent(parsed);
    const check = checkOf(b);
    const before = JSON.stringify({ parsed, content, amounts, check });
    const ctx = { tenantId: T, env: 'test' as const, check, ksefNumber: b.ksefNumber, now: PREPARED_AT };
    const otherNow = new Date('2026-12-31T23:59:59.000Z');

    const first = buildOriginalImportProjection(parsed, content, amounts, ctx);
    const second = buildOriginalImportProjection(parsed, content, amounts, ctx);
    const later = buildOriginalImportProjection(parsed, content, amounts, { ...ctx, now: otherNow });

    expect(second).toEqual(first);
    expect(JSON.stringify({ parsed, content, amounts, check })).toBe(before);
    expect(JSON.stringify(later)).toContain(otherNow.toISOString());
    expect(JSON.stringify(later).replace(otherNow.toISOString(), PREPARED_AT.toISOString())).toBe(JSON.stringify(first));
  });
});

// ─── Lustro 4.8 na macierzy rundy (R-C1c po stronie TS) ──────────────────────

describe('originalImportProjectionProblem: macierz rundy → NULL', () => {
  it.each(EACH)('%s: poprawna projekcja nie ma niezgodności w żadnej ofercie', (_name, c) => {
    const base = baseOf(c);

    for (const offer of OFFERS) {
      expect(originalImportProjectionProblem(base.projection, contextOf(base, offer)), `oferta ${offer}`).toBeNull();
    }
  });
});

// ─── Wspólna tabela przypadków (R-C6) ────────────────────────────────────────

/** R-C6 wymienia te kody i przypadek poprawny (`0 WDT` przy ofercie review-*). */
const R_C6_CODES: readonly OriginalImportProblem[] = [
  'shape', 'lines', 'number', 'seller', 'issue-date', 'gross', 'buyer', 'currency', 'xml', 'totals', 'fa3',
];

describe('ORIGINAL_IMPORT_MISMATCH_CASES: ta sama tabela co R-C6 (SQL), tu na lustrze TS', () => {
  it('każdy przypadek: lustro daje oczekiwany kod (pierwszy niezgodny) — lista rozbieżności pusta', () => {
    const cases = originalImportMismatchCases();
    // Tabela nie jest pusta ani dziurawa: kody z R-C6 i przynajmniej jeden przypadek poprawny (null).
    const codes = new Set(cases.map((c) => c.expected));
    for (const code of R_C6_CODES) expect(codes, `brak przypadku dla ${code}`).toContain(code);
    expect(codes).toContain(null);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    const failures: string[] = [];

    for (const c of cases) {
      // Baza, jej kontekst i użycie przypadku — jak opisuje helper (`originalImportBase`): świeża kopia na przypadek.
      const base = originalImportBase();
      const got = originalImportProjectionProblem(c.mutate(base.projection), { ...base.ctx, offer: c.offer, ...c.ctx });
      if (got !== c.expected) failures.push(`${c.name} (${c.offer}): oczekiwano ${String(c.expected)}, jest ${String(got)}`);
    }

    expect(failures).toEqual([]);
  });
});

// ─── Własne przypadki 4.8 (niezależne od tabeli wspólnej) ────────────────────

/** Projekcja jako luźny obiekt — przypadki 4.8 psują kształt dowolnie, jak jsonb. */
interface Loose {
  v: unknown;
  invoice: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  xml: Record<string, unknown>;
}

interface OwnCase {
  name: string;
  offer?: DuplicateOriginalOffer;
  mutate?: (p: Loose, base: Base) => void;
  ctx?: (base: Base) => Partial<OriginalImportProblemContext>;
  expected: OriginalImportProblem | null;
}

/** Baza własnych przypadków 4.8: plik z trzema pozycjami (8%, 5%, 0%) i nabywcą z NIP. */
const TABLE_BASE_CASE = 'mieszane 8 + 5 + 0';

const OWN_CASES: readonly OwnCase[] = [
  // shape — program
  { name: 'shape: v ≠ 1', mutate: (p) => { p.v = 2; }, expected: 'shape' },
  { name: 'shape: invoice nie jest obiektem', mutate: (p) => { p.invoice = 'x' as unknown as Loose['invoice']; }, expected: 'shape' },
  { name: 'shape: lines puste', mutate: (p) => { p.lines = []; }, expected: 'shape' },
  { name: 'shape: lines nie jest tablicą', mutate: (p) => { p.lines = {} as unknown as Loose['lines']; }, expected: 'shape' },
  { name: 'shape: 1001 pozycji (limit 1000)', mutate: (p) => { p.lines = Array.from({ length: 1001 }, () => ({ ...p.lines[0]! })); }, expected: 'shape' },
  { name: 'shape: xml nie jest obiektem', mutate: (p) => { p.xml = null as unknown as Loose['xml']; }, expected: 'shape' },
  { name: 'shape: obcy klucz invoice.id', mutate: (p) => { p.invoice.id = 'x'; }, expected: 'shape' },
  { name: 'shape: internal_number pusty', mutate: (p) => { p.invoice.internal_number = ''; }, expected: 'shape' },
  { name: 'shape: internal_number 101 znaków', mutate: (p) => { p.invoice.internal_number = 'F'.repeat(101); }, expected: 'shape' },
  { name: 'shape: issue_date nie jest datą (2026-02-30)', mutate: (p) => { p.invoice.issue_date = '2026-02-30'; }, expected: 'shape' },
  { name: 'shape: is_b2c = NULL', mutate: (p) => { p.invoice.is_b2c = null; }, expected: 'shape' },
  { name: 'shape: kwota z 3 miejscami po przecinku', mutate: (p) => { p.invoice.net_total = 100.123; }, expected: 'shape' },
  { name: 'shape: kwota ≥ 1e10', mutate: (p) => { p.invoice.gross_total = 1e10; }, expected: 'shape' },
  { name: 'shape: is_b2c = true przy buyer_id_type = nip (check_b2c_has_id)', mutate: (p) => { p.invoice.is_b2c = true; }, expected: 'shape' },
  { name: 'shape: buyer_id_type spoza enum', mutate: (p) => { p.invoice.buyer_id_type = 'dowod'; }, expected: 'shape' },
  { name: 'shape: buyer_pesel 10 cyfr', mutate: (p) => { p.invoice.buyer_pesel = '4405140135'; }, expected: 'shape' },
  { name: 'shape: seller_nip 9 cyfr', mutate: (p) => { p.invoice.seller_nip = '526000124'; }, expected: 'shape' },
  { name: 'shape: notes 5001 znaków', mutate: (p) => { p.invoice.notes = 'u'.repeat(5001); }, expected: 'shape' },
  // lines — program
  { name: 'lines: obcy klucz pozycji (invoice_id)', mutate: (p) => { p.lines[0]!.invoice_id = 'x'; }, expected: 'lines' },
  { name: 'lines: unit 51 znaków (R-C5a)', mutate: (p) => { p.lines[0]!.unit = 'u'.repeat(51); }, expected: 'lines' },
  { name: 'lines: name 513 znaków', mutate: (p) => { p.lines[0]!.name = 'n'.repeat(513); }, expected: 'lines' },
  { name: 'lines: ordinal powtórzony', mutate: (p) => { p.lines[1]!.ordinal = p.lines[0]!.ordinal; }, expected: 'lines' },
  { name: 'lines: ordinal 0', mutate: (p) => { p.lines[0]!.ordinal = 0; }, expected: 'lines' },
  { name: 'lines: ilość z 5 miejscami po przecinku', mutate: (p) => { p.lines[0]!.quantity = 1.23456; }, expected: 'lines' },
  { name: 'lines: stawka „nieznana” (pair)', mutate: (p) => { p.lines[0]!.vat_rate = 'nieznana'; }, expected: 'lines' },
  { name: 'lines: stawka „nieznana” także w przeglądzie', offer: 'review-pair', mutate: (p) => { p.lines[0]!.vat_rate = 'nieznana'; }, expected: 'lines' },
  // number, seller, kind — klient / program
  { name: 'number: numer X (NULL) w kontekście', ctx: () => ({ internalNumber: null }), expected: 'number' },
  { name: 'number: internal_number inny niż numer X', mutate: (p) => { p.invoice.internal_number = 'FV/INNY/9'; }, expected: 'number' },
  { name: 'number: summary.number inny niż numer X', ctx: (base) => ({ check: { ...base.check, summary: { ...base.check.summary!, number: 'FV/INNY/9' } } }), expected: 'number' },
  { name: 'seller: seller_nip inny niż NIP firmy', ctx: () => ({ tenantNip: BUYER_NIP }), expected: 'seller' },
  { name: 'kind: invoice_type ≠ VAT', mutate: (p) => { p.invoice.invoice_type = 'KOR'; }, expected: 'kind' },
  // issue-date, gross, buyer, currency
  { name: 'issue-date: issue_date ≠ summary.issueDate', ctx: (base) => ({ check: { ...base.check, summary: { ...base.check.summary!, issueDate: '2026-09-11' } } }), expected: 'issue-date' },
  // I3: wiersz „summary.issueDate brak → issue-date” (fail-closed) przeniesiony do wspólnej tabeli R-C6
  // (`originalImportMismatchCases()` w helperze), żeby SQL pinował tę samą semantykę co TS.
  { name: 'issue-date: data ze strefą w pliku (xs:date) — porównanie pierwszych 10 znaków → poprawna', ctx: (base) => ({ check: { ...base.check, summary: { ...base.check.summary!, issueDate: '2026-09-10+02:00' } } }), expected: null },
  { name: 'gross: gross_total ≠ summary.gross', mutate: (p) => { p.invoice.gross_total = plus(p.invoice.gross_total, 0.01); }, expected: 'gross' },
  { name: 'buyer: buyer_nip ≠ NIP nabywcy z pliku', mutate: (p) => { p.invoice.buyer_nip = '5260001246'; }, expected: 'buyer' },
  { name: 'buyer: NIP nabywcy w pliku z myślnikami = same cyfry → poprawna', ctx: (base) => ({ check: { ...base.check, summary: { ...base.check.summary!, buyerNip: '525-224-15-85' } } }), expected: null },
  { name: 'currency: summary.currency = EUR', ctx: (base) => ({ check: { ...base.check, summary: { ...base.check.summary!, currency: 'EUR' } } }), expected: 'currency' },
  // xml, totals, fa3
  { name: 'xml: storage_path ≠ check.archivePath', mutate: (p) => { p.xml.storage_path = `${T}/ksef-import/inny.xml`; }, expected: 'xml' },
  { name: 'xml: sha256 ≠ check.sha256', mutate: (p) => { p.xml.sha256 = 'a'.repeat(64); }, expected: 'xml' },
  { name: 'xml: size_bytes ≠ check.sizeBytes', mutate: (p) => { p.xml.size_bytes = plus(p.xml.size_bytes, 1); }, expected: 'xml' },
  {
    name: 'xml: ścieżka zgodna z check.archivePath, ale ≠ <firma>/ksef-import/<K>.xml',
    mutate: (p) => { p.xml.storage_path = `${T}/ksef-import/obca.xml`; },
    ctx: (base) => ({ check: { ...base.check, archivePath: `${T}/ksef-import/obca.xml` } }),
    expected: 'xml',
  },
  { name: 'totals: net_total ≠ suma netto pozycji', mutate: (p) => { p.invoice.net_total = plus(p.invoice.net_total, 0.01); }, expected: 'totals' },
  { name: 'totals: vat_total ≠ suma VAT pozycji', mutate: (p) => { p.invoice.vat_total = plus(p.invoice.vat_total, 0.01); }, expected: 'totals' },
  { name: 'totals: brutto pozycji ≠ gross_total', mutate: (p) => { p.lines[0]!.gross_amount = plus(p.lines[0]!.gross_amount, 0.01); }, expected: 'totals' },
  { name: 'fa3: fa3_data ma klucz lines', mutate: (p) => { (p.invoice.fa3_data as Record<string, unknown>).lines = []; }, expected: 'fa3' },
  {
    name: 'fa3: import.source ≠ ksef_duplicate_decision',
    mutate: (p) => { ((p.invoice.fa3_data as Record<string, unknown>).import as Record<string, unknown>).source = 'magic_import'; },
    expected: 'fa3',
  },
  {
    name: 'fa3: import.originalSha256 ≠ check.sha256',
    mutate: (p) => { ((p.invoice.fa3_data as Record<string, unknown>).import as Record<string, unknown>).originalSha256 = 'c'.repeat(64); },
    expected: 'fa3',
  },
  // kolejność kodów (pierwszy niezgodny wygrywa; kolejność = ORIGINAL_IMPORT_PROBLEMS)
  { name: 'kolejność: shape przed lines', mutate: (p) => { p.invoice.id = 'x'; p.lines[0]!.vat_rate = 'nieznana'; }, expected: 'shape' },
  { name: 'kolejność: lines przed number', mutate: (p) => { p.lines[0]!.vat_rate = 'nieznana'; p.invoice.internal_number = 'FV/INNY/9'; }, expected: 'lines' },
  { name: 'kolejność: number przed seller', mutate: (p) => { p.invoice.internal_number = 'FV/INNY/9'; p.invoice.seller_nip = BUYER_NIP; }, expected: 'number' },
  { name: 'kolejność: seller przed kind', mutate: (p) => { p.invoice.seller_nip = BUYER_NIP; p.invoice.invoice_type = 'KOR'; }, expected: 'seller' },
  { name: 'kolejność: kind przed gross', mutate: (p) => { p.invoice.invoice_type = 'KOR'; p.invoice.gross_total = 1; }, expected: 'kind' },
  { name: 'kolejność: gross przed totals', mutate: (p) => { p.invoice.gross_total = plus(p.invoice.gross_total, 1); }, expected: 'gross' },
  { name: 'kolejność: xml przed totals', mutate: (p) => { p.xml.sha256 = 'a'.repeat(64); p.invoice.net_total = plus(p.invoice.net_total, 1); }, expected: 'xml' },
  { name: 'kolejność: totals przed fa3', mutate: (p) => { p.invoice.net_total = plus(p.invoice.net_total, 1); (p.invoice.fa3_data as Record<string, unknown>).lines = []; }, expected: 'totals' },
];

describe('originalImportProjectionProblem: przypadki 4.8 (własne, niezależne od tabeli wspólnej)', () => {
  it.each(OWN_CASES.map((oc) => [oc.name, oc] as const))('%s', (_name, oc) => {
    const base = baseOf(byName(TABLE_BASE_CASE));
    const projection = structuredClone(base.projection) as unknown as Loose;
    oc.mutate?.(projection, base);
    const offer = oc.offer ?? 'pair';

    const got = originalImportProjectionProblem(projection, { ...contextOf(base, offer), ...oc.ctx?.(base) });

    expect(got).toBe(oc.expected);
  });

  it.each([null, undefined, 42, 'x', [], {}, { v: 1 }, { v: 1, invoice: 'x', lines: [], xml: {} }, { v: 1, invoice: {}, lines: [{}], xml: {} }])(
    'dowolny kształt wejścia (%j): nie rzuca, wynik to kod 4.8 (shape dla nie-projekcji)',
    (garbage) => {
      const base = baseOf(byName(TABLE_BASE_CASE));

      const got = originalImportProjectionProblem(garbage, contextOf(base, 'pair'));

      expect(ORIGINAL_IMPORT_PROBLEMS).toContain(got);
      expect(got).toBe('shape');
    },
  );

  // Zepsute wartości w środku poprawnej projekcji i kontekście: funkcja lustrzana SQL nigdy nie rzuca
  // (każde sprawdzenie typu poprzedza rzut), kod zależy od miejsca uszkodzenia — tu pilnujemy tylko, że jest kodem 4.8 albo null.
  const BROKEN: ReadonlyArray<readonly [string, (p: Loose, base: Base) => Partial<OriginalImportProblemContext> | void]> = [
    ['pozycja null', (p) => { p.lines[0] = null as unknown as Loose['lines'][number]; }],
    ['pozycja tablicą', (p) => { p.lines[0] = [] as unknown as Loose['lines'][number]; }],
    ['pozycja napisem', (p) => { p.lines[0] = 'x' as unknown as Loose['lines'][number]; }],
    ['numer faktury obiektem', (p) => { p.invoice.internal_number = {}; }],
    ['daty obiektami', (p) => { p.invoice.issue_date = {}; p.invoice.sale_date = []; }],
    ['kwoty obiektami', (p) => { p.invoice.net_total = {}; p.invoice.vat_total = []; p.invoice.gross_total = null; }],
    ['fa3_data.import null', (p) => { (p.invoice.fa3_data as Record<string, unknown>).import = null; }],
    ['fa3_data.import napisem', (p) => { (p.invoice.fa3_data as Record<string, unknown>).import = 'x'; }],
    ['fa3_data.import.source obiektem', (p) => { ((p.invoice.fa3_data as Record<string, unknown>).import as Record<string, unknown>).source = {}; }],
    ['xml z samymi śmieciami', (p) => { p.xml = { storage_path: {}, sha256: [], size_bytes: 'a' }; }],
    ['pozycja z obiektowymi kwotami', (p) => { p.lines[0]!.net_amount = {}; p.lines[0]!.vat_rate = []; }],
    ['znacznik bez summary', (_p, base) => ({ check: { ...base.check, summary: null } })],
    ['znacznik bez ścieżki i skrótu', (_p, base) => ({ check: { ...base.check, archivePath: null, sha256: null, sizeBytes: null } })],
    ['NIP firmy pusty, numer X pusty', () => ({ tenantNip: '', internalNumber: '' })],
  ];

  it.each(BROKEN.map(([name, make]) => [name, make] as const))('uszkodzenie w środku (%s): nie rzuca, wynik to kod 4.8 albo null', (_name, make) => {
    const base = baseOf(byName(TABLE_BASE_CASE));
    const projection = structuredClone(base.projection) as unknown as Loose;
    const over = make(projection, base) ?? {};

    const run = () => originalImportProjectionProblem(projection, { ...contextOf(base, 'pair'), ...over });

    expect(run).not.toThrow();
    expect([...ORIGINAL_IMPORT_PROBLEMS, null]).toContain(run());
  });
});

describe('originalImportProjectionProblem: stawki FA(3) spoza FaktFlow zależą od oferty (F42)', () => {
  const FA3_ONLY = [...ORIGINAL_IMPORT_VAT_RATES.reviewOnly];

  it.each(FA3_ONLY.flatMap((rate) => OFFERS.map((offer) => [rate, offer] as const)))(
    'stawka %s przy ofercie %s',
    (rate, offer) => {
      const base = baseOf(byName(TABLE_BASE_CASE));
      const projection = structuredClone(base.projection) as unknown as Loose;
      projection.lines[0]!.vat_rate = rate;

      const got = originalImportProjectionProblem(projection, contextOf(base, offer));

      // pair/record: tylko 8 stawek FaktFlow; review-*: także stawki FA(3) spoza FaktFlow, jak w Magicznym imporcie.
      expect(got).toBe(offer === 'pair' || offer === 'record' ? 'lines' : null);
    },
  );

  it.each(ORIGINAL_IMPORT_VAT_RATES.faktflow.flatMap((rate) => OFFERS.map((offer) => [rate, offer] as const)))(
    'stawka FaktFlow %s przy ofercie %s: przyjęta',
    (rate, offer) => {
      const base = baseOf(byName(TABLE_BASE_CASE));
      const projection = structuredClone(base.projection) as unknown as Loose;
      projection.lines[0]!.vat_rate = rate;

      expect(originalImportProjectionProblem(projection, contextOf(base, offer))).toBeNull();
    },
  );
});
