import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR C (spec v3, 5.2 i 7.2, INV-10): brama pochodzenia
 * `evaluateOriginalGate` — czy oryginał z oznaczeniem FaktFlow wygląda na plik
 * z generatora FaktFlow zwykłej faktury (`importable` — klient zapisze go
 * w FaktFlow sam) czy nie (`review` — przegląd operatora, I5R).
 *
 * CZERWONE na commicie kontraktu (commit 1): `evaluateOriginalGate` jest
 * szkieletem, który rzuca „PR C: nie zaimplementowane” — każdy test niżej pada
 * na zachowaniu (brak oceny pliku), nie na typach ani przygotowaniu danych
 * (macierz i pliki derywowane budują się prawdziwym generatorem FaktFlow).
 *
 * Co jest tu pinowane:
 * - INV-10 (a): KAŻDY plik z `generateFA3Xml` dla zwykłej faktury z macierzy
 *   rundy (`finalizeInvoice` → `validateInvoice` bez błędów → generator
 *   z walidacją) ma bramę `importable`, `problems = []`, `preview` zgodny z plikiem;
 * - 5.2: dla każdej z 16 reguł osobny plik czerwony → właściwy kod (jedna wada
 *   plus ewentualne skutki uboczne wyraźnie opisane w tabeli), `kind: 'review'`;
 * - reguły 1 (`currency`) i 2 (`parse`) kończą ocenę, pozostałe zbierane naraz
 *   w kolejności `ORIGINAL_GATE_PROBLEMS`, bez powtórzeń;
 * - INV-10 (b): brama używa wyłącznie jawnych reguł — `parsed.warnings` nie
 *   jest używane (plik z ostrzeżeniem parsera bez problemu reguł = `importable`);
 * - funkcja nigdy nie rzuca (każdy wyjątek → `parse`) i jest czysta: te same
 *   bajty → ta sama brama, niezależnie od zegara (ponowienie runnera od zera
 *   nadpisuje znacznik tym samym wynikiem);
 * - `importable` oznacza „lustro 4.8 przejdzie” (commit 3, fix 4): pliki, które
 *   nadal wyglądają na FaktFlow, a ich projekcja 4.8 odrzuciłaby (nazwa
 *   pozycji spoza 1–512 znaków, jednostka spoza 1–50, NIP nabywcy nie z 10
 *   cyfr, numer albo NIP sprzedawcy pusty po obu stronach), idą na `review`,
 *   zamiast zapętlać się w „nie do zapisania” bez wyjścia operatora.
 *
 * Szczegół nieustalony przez specyfikację: tekstowy zapis stawki w
 * `preview.lines[].vatRate` (stawka FaktFlow albo surowe P_12) i liczb jako
 * tekstu (`'123.00'` vs `'123'`) — test porównuje wartości liczbowe i dopuszcza
 * oba zapisy stawki.
 */

// Wyjątek parsera i późniejszego kroku (kwoty) wstrzykujemy przez przepuszczające
// opakowania prawdziwych funkcji — poza testem „łapie każdy wyjątek” działają bez zmian.
const injected = vi.hoisted(() => ({ parseThrows: undefined as { value: unknown } | undefined, amountsThrows: false }));
vi.mock('@/lib/import/fa3-parser', async (orig) => {
  const real = await orig<typeof import('@/lib/import/fa3-parser')>();
  return {
    ...real,
    parseFa3Xml: (...args: Parameters<typeof real.parseFa3Xml>) => {
      if (injected.parseThrows) {
        const { value } = injected.parseThrows;
        injected.parseThrows = undefined;
        throw value;
      }
      return real.parseFa3Xml(...args);
    },
  };
});
vi.mock('@/lib/import/fa3-line-amounts', async (orig) => {
  const real = await orig<typeof import('@/lib/import/fa3-line-amounts')>();
  return {
    ...real,
    fa3ImportLineAmounts: (...args: Parameters<typeof real.fa3ImportLineAmounts>) => {
      if (injected.amountsThrows) throw new Error('kwoty pozycji: awaria');
      return real.fa3ImportLineAmounts(...args);
    },
  };
});

import { parseFa3Xml } from '@/lib/import/fa3-parser';
import { importedInvoiceContent } from '@/lib/import/imported-invoice-row';
import {
  ORIGINAL_GATE_PROBLEMS,
  ORIGINAL_GATE_RULES,
  type KsefDuplicateCheck,
  type OriginalBuyerIdKind,
  type OriginalGateProblem,
} from '@/lib/ksef/duplicate-check';
import { evaluateOriginalGate, type OriginalGateEvaluation, type OriginalGateInput } from '@/lib/ksef/duplicate-original-gate';
import {
  buildOriginalImportProjection,
  originalImportProjectionProblem,
  type OriginalImportProblem,
} from '@/lib/ksef/duplicate-original-projection';
import { summarizeInvoiceXml } from '@/lib/ksef/duplicate-verdict';
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

const replaceOnce = (xml: string, from: string | RegExp, to: string): string => {
  const changed = xml.replace(from, to);
  if (changed === xml) throw new Error(`fikstura nie zawiera ${String(from)}`);
  return changed;
};

/** Nazwa i jednostka jedynej pozycji w plikach z przypadku „stawka 23” (macierz: `single`). */
const LINE_NAME = 'Usługa wdrożeniowa';
const LINE_UNIT = 'usł.';
const withLineName = (name: string) => (xml: string) => replaceOnce(xml, `<P_7>${LINE_NAME}</P_7>`, `<P_7>${name}</P_7>`);
const withLineUnit = (unit: string) => (xml: string) => replaceOnce(xml, `<P_8A>${LINE_UNIT}</P_8A>`, `<P_8A>${unit}</P_8A>`);
const withBuyerNip = (nip: string) => (xml: string) => replaceOnce(xml, `<NIP>${BUYER_NIP}</NIP>`, `<NIP>${nip}</NIP>`);
const withSellerNip = (nip: string) => (xml: string) => replaceOnce(xml, `<NIP>${SELLER_NIP}</NIP>`, `<NIP>${nip}</NIP>`);

// ─── Pomocnicze ──────────────────────────────────────────────────────────────

afterEach(() => {
  vi.useRealTimers();
  injected.parseThrows = undefined;
  injected.amountsThrows = false;
});

/** Ocena pliku z domyślnym kontekstem runnera: numer dokumentu X = P_2 pliku, NIP firmy = NIP sprzedawcy. */
function gateOf(xml: string, b: Built, over: Partial<OriginalGateInput> = {}): OriginalGateEvaluation {
  return evaluateOriginalGate({ xml, ksefNumber: b.ksefNumber, internalNumber: b.number, tenantNip: SELLER_NIP, ...over });
}

const TENANT_ID = '13131313-1313-4313-8313-131313131313';

/** Znacznik `original_check` jak zapisuje runner dla pliku: skrót i rozmiar jego bajtów, `summary` z pliku, ścieżka w archiwum firmy. */
function checkFor(xml: string, b: Built): KsefDuplicateCheck {
  const bytes = Buffer.from(xml, 'utf8');
  return {
    v: 1,
    env: 'test',
    checkedAt: '2026-09-11T08:00:00.000Z',
    reason: 'faktflow-original',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    archivePath: `${TENANT_ID}/ksef-import/${b.ksefNumber}.xml`,
    sizeBytes: bytes.length,
    summary: summarizeInvoiceXml(xml),
    sameContentExceptHeader: false,
    ownHistory: false,
    acquiredAt: '2026-09-10T09:00:00.000Z',
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
  };
}

/**
 * Kod lustra 4.8 dla projekcji zbudowanej z tego, co zwraca brama (też dla `review` — brama zwraca
 * `parsed`, `content` i `amounts`, gdy plik się odczytał). `null` = projekcja przechodzi.
 */
function mirrorProblemOf(xml: string, b: Built, input: Partial<OriginalGateInput> = {}): OriginalImportProblem | null {
  const ev = gateOf(xml, b, input);
  if (!ev.parsed || !ev.content || !ev.amounts) throw new Error(`plik się nie odczytał: ${JSON.stringify(ev.gate.problems)}`);
  const check = checkFor(xml, b);
  const projection = buildOriginalImportProjection(ev.parsed, ev.content, ev.amounts, {
    tenantId: TENANT_ID,
    env: 'test',
    check,
    ksefNumber: b.ksefNumber,
    now: NOW,
  });
  return originalImportProjectionProblem(JSON.parse(JSON.stringify(projection)), {
    internalNumber: input.internalNumber ?? b.number,
    tenantNip: input.tenantNip ?? SELLER_NIP,
    tenantId: TENANT_ID,
    ksefNumber: b.ksefNumber,
    check,
    offer: 'pair',
  });
}

const previewOf = (ev: OriginalGateEvaluation) => {
  if (!ev.gate.preview) throw new Error('brama nie zwróciła preview');
  return ev.gate.preview;
};

const buyerKindOf = (b: BuyerExpect): OriginalBuyerIdKind =>
  b.nip ? 'nip' : b.vatUeNumber ? 'vat-ue' : b.pesel ? 'pesel' : b.nrInny ? 'nr-inny' : b.brakId ? 'brak-id' : 'none';

const annotationsOf = (c: MatrixCase): string[] => [
  ...(c.expectAnnotations?.cashMethod === 1 ? ['cashMethod'] : []),
  ...(c.expectAnnotations?.splitPayment === 1 ? ['splitPayment'] : []),
  ...(c.expectAnnotations?.reverseCharge === 1 ? ['reverseCharge'] : []),
  ...(c.expectAnnotations?.vatExemptionBasis ? ['exemption'] : []),
];

/** `problems` w kolejności reguł 5.2 (`ORIGINAL_GATE_PROBLEMS`), bez powtórzeń. */
const expectOrderedUnique = (problems: readonly OriginalGateProblem[]) => {
  expect(problems).toEqual(ORIGINAL_GATE_PROBLEMS.filter((p) => problems.includes(p)));
};

// ─── INV-10 (a): macierz rundy ───────────────────────────────────────────────

describe('INV-10 (a): plik z generatora FaktFlow dla zwykłej faktury ma bramę importable', () => {
  it.each(EACH)('%s: importable, problems=[], reguły w wersji ORIGINAL_GATE_RULES, bez release', (_name, c) => {
    const b = build(c);

    const ev = gateOf(b.xml, b);

    expect({ v: ev.gate.v, rules: ev.gate.rules, kind: ev.gate.kind, problems: ev.gate.problems }).toEqual({
      v: 1,
      rules: ORIGINAL_GATE_RULES,
      kind: 'importable',
      problems: [],
    });
    expect(ev.gate).not.toHaveProperty('release');
    // Ocena zwraca też to, z czego powstanie projekcja K (bez drugiego odczytu pliku): odczyt z numerem KSeF
    // i treść oraz kwoty pozycji z tych samych funkcji co w Magicznym imporcie (C0).
    const parsed = parseFa3Xml(b.xml, { ksefNumber: b.ksefNumber });
    expect(ev.parsed).toEqual(parsed);
    expect(ev.parsed?.invoiceNumber).toBe(b.number);
    const { content, amounts } = importedInvoiceContent(parsed);
    expect(ev.content).toEqual(content);
    expect(ev.amounts).toEqual(amounts);
    expect(ev.amounts?.rows).toHaveLength(c.lines.length);
  });

  it.each(EACH)('%s: preview zgodny z plikiem', (_name, c) => {
    const b = build(c);

    const ev = gateOf(b.xml, b);
    const preview = previewOf(ev);

    expect(preview.issueDate).toBe(ISSUE);
    expect(preview.saleDate).toBe(c.saleDate === null ? null : (c.saleDate ?? ISSUE));
    expect(preview.period).toBe('09.2026');
    expect(preview.buyerIdKind).toBe(buyerKindOf(c.expectBuyer));
    expect([...preview.annotations].sort()).toEqual(annotationsOf(c).sort());
    expect(preview.exemptionBasis).toBe(c.expectAnnotations?.vatExemptionBasis ?? null);
    expect(preview.lineCount).toBe(c.lines.length);
    expect(preview.lines).toHaveLength(Math.min(20, c.lines.length));
    preview.lines.forEach((line, i) => {
      const spec = c.lines[i]!;
      const parsedLine = ev.parsed!.lines[i]!;
      expect(line.ordinal).toBe(i + 1);
      expect(line.name).toBe(spec.name ?? `Pozycja ${i + 1}`);
      expect(line.unit).toBe(spec.unit ?? 'szt.');
      // Kwoty i ilości jako tekst z pliku — porównujemy wartości (zapis „2” / „2.0000” nie jest pinowany).
      expect(typeof line.quantity).toBe('string');
      expect(Number(line.quantity)).toBe(spec.qty);
      expect(typeof line.unitPriceNet).toBe('string');
      expect(Number(line.unitPriceNet)).toBe(spec.price);
      expect([parsedLine.vatRate, parsedLine.p12]).toContain(line.vatRate);
      expect(typeof line.gross).toBe('string');
      expect(Number(line.gross)).toBeCloseTo(ev.amounts!.rows[i]!.grossAmount, 2);
    });
    expect({ net: Number(preview.totals.net), vat: Number(preview.totals.vat), gross: Number(preview.totals.gross) }).toEqual({
      net: b.invoice.netTotal,
      vat: b.invoice.vatTotal,
      gross: b.invoice.grossTotal,
    });
    expect(typeof preview.totals.net).toBe('string');
    if (c.lines.length <= 20) {
      // Pozycje podglądu sumują się do brutto faktury (INV-2 po stronie podglądu).
      const sum = preview.lines.reduce((acc, line) => acc + Number(line.gross), 0);
      expect(sum).toBeCloseTo(b.invoice.grossTotal, 2);
    }
  });
});

describe('preview: granice (≤ 20 pozycji, nazwa ≤ 120 znaków) i nabywca bez identyfikatora', () => {
  const LONG: MatrixCase = {
    name: 'poza macierzą: 25 pozycji z długimi nazwami',
    lines: Array.from({ length: 25 }, (_, i) => ({
      name: i === 0 ? 'N'.repeat(120) : i === 1 ? 'M'.repeat(121) : `${'Długa nazwa pozycji '.repeat(10)}${i + 1}`,
      unit: 'szt.',
      qty: 1,
      price: 10,
      rate: '23' as const,
    })),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
  };

  it('25 pozycji: preview ma 20 pierwszych, lineCount 25, sumy z całej faktury', () => {
    const b = build(LONG);

    const ev = gateOf(b.xml, b);
    const preview = previewOf(ev);

    expect(ev.gate.kind).toBe('importable');
    expect(preview.lineCount).toBe(25);
    expect(preview.lines.map((l) => l.ordinal)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(Number(preview.totals.net)).toBe(b.invoice.netTotal);
    expect(Number(preview.totals.gross)).toBe(b.invoice.grossTotal);
  });

  it('nazwa pozycji: dokładnie 120 znaków bez zmian, dłuższa skrócona do najwyżej 120 (z zachowanym początkiem)', () => {
    const b = build(LONG);

    const lines = previewOf(gateOf(b.xml, b)).lines;

    expect(lines[0]!.name).toBe('N'.repeat(120));
    expect(lines[1]!.name.length).toBeLessThanOrEqual(120);
    expect(lines[1]!.name.startsWith('M'.repeat(100))).toBe(true);
    expect(lines[2]!.name.length).toBeLessThanOrEqual(120);
    expect(lines[2]!.name.startsWith('Długa nazwa pozycji ')).toBe(true);
  });

  it('nabywca bez żadnego identyfikatora: brama review (buyer-id), ale podgląd jest — buyerIdKind „none”', () => {
    const b = build(byName('nabywca NIP'));
    const xml = replaceOnce(b.xml, `<NIP>${BUYER_NIP}</NIP>`, '');

    const ev = gateOf(xml, b);

    expect(ev.gate.problems).toEqual(['buyer-id']);
    expect(previewOf(ev).buyerIdKind).toBe('none');
  });
});

// ─── 5.2: osobny plik czerwony dla każdej reguły ─────────────────────────────

interface RuleCase {
  /** Numer i kod reguły z tabeli 5.2 + opis wady. */
  title: string;
  /** Przypadek macierzy, z którego pochodzi plik (domyślnie pojedyncza stawka 23). */
  from?: string;
  mutate?: (xml: string, b: Built) => string;
  input?: (b: Built) => Partial<OriginalGateInput>;
  /** Dokładna lista problemów (wada nie ma skutków ubocznych w innych regułach)… */
  exact?: readonly OriginalGateProblem[];
  /** …albo kody, które MUSZĄ w niej być (wada łamie z natury więcej niż jedną regułę). */
  contains?: readonly OriginalGateProblem[];
}

const withCurrency = (code: string) => (xml: string) => replaceOnce(xml, '<KodWaluty>PLN</KodWaluty>', `<KodWaluty>${code}</KodWaluty>`);
const withRodzaj = (code: string) => (xml: string) => replaceOnce(xml, '<RodzajFaktury>VAT</RodzajFaktury>', `<RodzajFaktury>${code}</RodzajFaktury>`);
const inLine = (before: string, insert: string) => (xml: string) => replaceOnce(xml, before, `${insert}${before}`);
const inAnnotations = (from: string, to: string) => (xml: string) => replaceOnce(xml, from, to);
/** Stawka bez podatku w spójnym pliku (nagłówek P_13_x zamiast P_13_1/P_14_1, jak w C0b). */
const zeroRateFile = (p12: string, field: 'P_13_6_2' | 'P_13_6_3') => (xml: string) => {
  let out = replaceOnce(xml, '<P_12>23</P_12>', `<P_12>${p12}</P_12>`);
  out = replaceOnce(out, '<P_13_1>', `<${field}>`);
  out = replaceOnce(out, '</P_13_1>', `</${field}>`);
  return replaceOnce(out, /<P_14_1>[^<]*<\/P_14_1><P_15>123\.00/, '<P_15>100.00');
};

const RULE_CASES: readonly RuleCase[] = [
  // 1 currency — kończy ocenę
  { title: '1 currency: EUR', mutate: withCurrency('EUR'), exact: ['currency'] },
  { title: '1 currency: USD małymi literami i z odstępami (po trim i toUpperCase)', mutate: withCurrency(' usd '), exact: ['currency'] },
  {
    title: '1 currency: waluta obca w pliku, którego i tak nie da się sparsować (reguła 1 przed 2)',
    mutate: () => 'to <KodWaluty>EUR</KodWaluty> nie jest XML',
    exact: ['currency'],
  },
  {
    title: '1 currency: EUR razem z inną wadą (P_23=1) — ocena kończy się na walucie',
    mutate: (xml) => inAnnotations('<P_23>2</P_23>', '<P_23>1</P_23>')(withCurrency('EUR')(xml)),
    exact: ['currency'],
  },
  // 2 parse — kończy ocenę
  { title: '2 parse: tekst, nie XML', mutate: () => 'to nie jest XML', exact: ['parse'] },
  { title: '2 parse: pusty plik', mutate: () => '', exact: ['parse'] },
  { title: '2 parse: XML bez elementu Faktura', mutate: () => '<Inny/>', exact: ['parse'] },
  { title: '2 parse: Faktura bez sekcji Fa', mutate: () => '<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"></Faktura>', exact: ['parse'] },
  // 3 form
  { title: '3 form: FA (2)', mutate: (xml) => replaceOnce(xml, 'kodSystemowy="FA (3)"', 'kodSystemowy="FA (2)"'), exact: ['form'] },
  { title: '3 form: brak KodFormularza', mutate: (xml) => replaceOnce(xml, /<KodFormularza[^>]*>FA<\/KodFormularza>/, ''), exact: ['form'] },
  // 4 kind
  { title: '4 kind: UPR (faktura uproszczona)', mutate: withRodzaj('UPR'), exact: ['kind'] },
  { title: '4 kind: KOR', mutate: withRodzaj('KOR'), contains: ['kind'] },
  { title: '4 kind: ZAL', mutate: withRodzaj('ZAL'), contains: ['kind'] },
  { title: '4 kind: ROZ', mutate: withRodzaj('ROZ'), contains: ['kind'] },
  // 5 number
  { title: '5 number: P_2 inny niż numer dokumentu X', mutate: (xml, b) => replaceOnce(xml, `<P_2>${b.number}</P_2>`, '<P_2>FV/INNY/9</P_2>'), exact: ['number'] },
  { title: '5 number: numer dokumentu X pusty', input: () => ({ internalNumber: '' }), exact: ['number'] },
  { title: '5 number: porównanie dokładne (inna wielkość liter)', input: (b) => ({ internalNumber: b.number.toLowerCase() }), exact: ['number'] },
  // Fix 4 (commit 3): puste po OBU stronach to nie zgodność — 4.8 odmówiłoby (`shape`: numer 1–100 znaków).
  {
    title: '5 number: P_2 pusty i numer dokumentu X pusty (puste po obu stronach nie są zgodne)',
    mutate: (xml, b) => replaceOnce(xml, `<P_2>${b.number}</P_2>`, '<P_2></P_2>'),
    input: () => ({ internalNumber: '' }),
    exact: ['number'],
  },
  {
    title: '5 number: P_2 i numer dokumentu X to same odstępy (po trim puste po obu stronach)',
    mutate: (xml, b) => replaceOnce(xml, `<P_2>${b.number}</P_2>`, '<P_2>   </P_2>'),
    input: () => ({ internalNumber: '  ' }),
    exact: ['number'],
  },
  // 6 seller
  { title: '6 seller: NIP sprzedawcy w pliku ≠ NIP firmy', input: () => ({ tenantNip: BUYER_NIP }), exact: ['seller'] },
  // Fix 4 (commit 3): brak cyfr po OBU stronach to nie zgodność — 4.8 odmówiłoby (`shape`: seller_nip to 10 cyfr).
  {
    title: '6 seller: brak NIP sprzedawcy w pliku i pusty NIP firmy (puste po obu stronach nie są zgodne)',
    mutate: (xml) => replaceOnce(xml, `<NIP>${SELLER_NIP}</NIP>`, ''),
    input: () => ({ tenantNip: '' }),
    exact: ['seller'],
  },
  {
    title: '6 seller: NIP sprzedawcy w pliku i NIP firmy bez cyfr',
    mutate: withSellerNip('BRAK'),
    input: () => ({ tenantNip: '-' }),
    exact: ['seller'],
  },
  // 7 buyer-id
  {
    title: '7 buyer-id: nabywca bez NIP, PESEL, VAT-UE, NrInny i BrakID',
    mutate: (xml) => replaceOnce(xml, `<NIP>${BUYER_NIP}</NIP>`, ''),
    exact: ['buyer-id'],
  },
  // Fix 4 (commit 3): OBECNY NIP nabywcy ma mieć dokładnie 10 cyfr — przy 9 projekcja nie niesie NIP, a plik tak (4.8 `buyer`).
  { title: '7 buyer-id: NIP nabywcy z 9 cyframi', mutate: withBuyerNip('525224158'), exact: ['buyer-id'] },
  { title: '7 buyer-id: NIP nabywcy z 11 cyframi', mutate: withBuyerNip(`${BUYER_NIP}1`), exact: ['buyer-id'] },
  { title: '7 buyer-id: NIP nabywcy bez cyfr', mutate: withBuyerNip('BRAK'), exact: ['buyer-id'] },
  // 8 no-lines (brak pozycji zostawia też sumę stawki bez pozycji → amounts)
  { title: '8 no-lines: faktura bez pozycji', mutate: (xml) => replaceOnce(xml, /<FaWiersz>.*<\/FaWiersz>/, ''), contains: ['no-lines'] },
  // 9 gross-prices
  { title: '9 gross-prices: cena brutto P_9B', mutate: inLine('<P_9A>', '<P_9B>61.5</P_9B>'), exact: ['gross-prices'] },
  { title: '9 gross-prices: wartość brutto P_11A', mutate: inLine('<P_11>', '<P_11A>123.00</P_11A>'), exact: ['gross-prices'] },
  // 10 line-fields
  { title: '10 line-fields: brak P_9A', mutate: (xml) => replaceOnce(xml, /<P_9A>[^<]*<\/P_9A>/, ''), exact: ['line-fields'] },
  { title: '10 line-fields: brak P_11 (z natury także amounts)', mutate: (xml) => replaceOnce(xml, /<P_11>[^<]*<\/P_11>/, ''), contains: ['line-fields'] },
  // M7 (rozstrzygnięcie): reguła 11 (`rates`) dotyczy tylko OBECNEJ stawki P_12 spoza listy; brak P_12 daje wyłącznie
  // `line-fields` (zob. .agents/pr-c-contract.md, „Rozstrzygnięcia (commit 2)”, reguła 11).
  { title: '10 line-fields: brak P_12', mutate: (xml) => replaceOnce(xml, '<P_12>23</P_12>', ''), exact: ['line-fields'] },
  { title: '10 line-fields: rabat P_10', mutate: inLine('<P_11>', '<P_10>5.00</P_10>'), exact: ['line-fields'] },
  { title: '10 line-fields: VAT pozycji P_11Vat', mutate: inLine('<P_12>', '<P_11Vat>23.00</P_11Vat>'), exact: ['line-fields'] },
  // Fix 4 (commit 3): długości, które 4.8 (`lines`) sprawdza na wierszu projekcji — nazwa 1–512, jednostka 1–50 (punkty kodowe).
  { title: '10 line-fields: nazwa pozycji (P_7) pusta', mutate: withLineName(''), exact: ['line-fields'] },
  { title: '10 line-fields: nazwa pozycji (P_7) 513 znaków', mutate: withLineName('n'.repeat(513)), exact: ['line-fields'] },
  { title: '10 line-fields: nazwa pozycji (P_7) 513 znaków spoza BMP (liczą się punkty kodowe)', mutate: withLineName('😀'.repeat(513)), exact: ['line-fields'] },
  { title: '10 line-fields: jednostka (P_8A) pusta', mutate: withLineUnit(''), exact: ['line-fields'] },
  { title: '10 line-fields: jednostka (P_8A) 51 znaków', mutate: withLineUnit('u'.repeat(51)), exact: ['line-fields'] },
  { title: '10 line-fields: jednostka (P_8A) 51 znaków spoza BMP', mutate: withLineUnit('😀'.repeat(51)), exact: ['line-fields'] },
  // 11 rates
  { title: '11 rates: 0 WDT', mutate: zeroRateFile('0 WDT', 'P_13_6_2'), exact: ['rates'] },
  { title: '11 rates: 0 EX', mutate: zeroRateFile('0 EX', 'P_13_6_3'), exact: ['rates'] },
  { title: '11 rates: 22 (stawka sprzed 2011; z natury także amounts)', mutate: (xml) => replaceOnce(xml, '<P_12>23</P_12>', '<P_12>22</P_12>'), contains: ['rates'] },
  // 12 amounts
  { title: '12 amounts: netto pozycji ≠ P_13_1 z nagłówka', mutate: (xml) => replaceOnce(xml, '<P_11>100.00</P_11>', '<P_11>90.00</P_11>'), exact: ['amounts'] },
  {
    title: '12 amounts: suma stawki P_13_2 bez pozycji tej stawki (P_15 spójne z sumami)',
    mutate: (xml) => replaceOnce(xml, '<P_15>123.00</P_15>', '<P_13_2>10.00</P_13_2><P_14_2>0.80</P_14_2><P_15>133.80</P_15>'),
    exact: ['amounts'],
  },
  // 13 totals
  { title: '13 totals: P_15 ≠ suma P_13_x + P_14_x', mutate: (xml) => replaceOnce(xml, '<P_15>123.00</P_15>', '<P_15>130.00</P_15>'), exact: ['totals'] },
  { title: '13 totals: P_15 różni się o 0,02', mutate: (xml) => replaceOnce(xml, '<P_15>123.00</P_15>', '<P_15>123.02</P_15>'), exact: ['totals'] },
  // Rozstrzygnięcie po commicie 3: reguła 13 ścisła co do grosza, jak 4.8 `totals` — inaczej plik
  // „importable” krążyłby w RECHECK bez wyjścia. Generator FaktFlow sumuje P_15 dokładnie.
  { title: '13 totals: P_15 różni się o 0,01 (reguła ścisła co do grosza)', mutate: (xml) => replaceOnce(xml, '<P_15>123.00</P_15>', '<P_15>123.01</P_15>'), exact: ['totals'] },
  { title: '13 totals: brak P_15', mutate: (xml) => replaceOnce(xml, '<P_15>123.00</P_15>', ''), exact: ['totals'] },
  // 14 annotations
  { title: '14 annotations: P_23=1 (procedura trójstronna)', mutate: inAnnotations('<P_23>2</P_23>', '<P_23>1</P_23>'), exact: ['annotations'] },
  { title: '14 annotations: P_17=1 (samofakturowanie)', mutate: inAnnotations('<P_17>2</P_17>', '<P_17>1</P_17>'), exact: ['annotations'] },
  { title: '14 annotations: P_22=1 (nowe środki transportu)', mutate: inAnnotations('<P_22N>1</P_22N>', '<P_22>1</P_22>'), exact: ['annotations'] },
  {
    title: '14 annotations: procedura marży',
    mutate: inAnnotations('<P_PMarzyN>1</P_PMarzyN>', '<P_PMarzy>1</P_PMarzy><P_PMarzy_2>1</P_PMarzy_2>'),
    exact: ['annotations'],
  },
  { title: '14 annotations: P_18=1 bez pozycji oo / np_ii', mutate: inAnnotations('<P_18>2</P_18>', '<P_18>1</P_18>'), exact: ['annotations'] },
  {
    title: '14 annotations: pozycja oo, a P_18=2',
    from: 'stawka oo (P_18=1)',
    mutate: inAnnotations('<P_18>1</P_18>', '<P_18>2</P_18>'),
    exact: ['annotations'],
  },
  {
    title: '14 annotations: pozycja np_ii, a P_18=2',
    from: 'np_ii z nabywcą VAT-UE',
    mutate: inAnnotations('<P_18>1</P_18>', '<P_18>2</P_18>'),
    exact: ['annotations'],
  },
  {
    title: '14 annotations: zw bez P_19 (zwolnienie niezgodne ze stawkami)',
    from: 'stawka zw z podstawą (art. 113)',
    mutate: (xml) => replaceOnce(xml, /<Zwolnienie>.*<\/Zwolnienie>/, '<Zwolnienie><P_19N>1</P_19N></Zwolnienie>'),
    exact: ['annotations'],
  },
  {
    title: '14 annotations: P_19 bez pozycji zw',
    mutate: (xml) => replaceOnce(xml, /<Zwolnienie>.*<\/Zwolnienie>/, `<Zwolnienie><P_19>1</P_19><P_19A>${ART_113}</P_19A></Zwolnienie>`),
    exact: ['annotations'],
  },
  { title: '14 annotations: nieczytelna flaga (P_16=7)', mutate: inAnnotations('<P_16>2</P_16>', '<P_16>7</P_16>'), exact: ['annotations'] },
  // 15 markers
  { title: '15 markers: GTU w pozycji', mutate: inLine('<P_7>', '<GTU>GTU_01</GTU>'), exact: ['markers'] },
  { title: '15 markers: Procedura w pozycji', mutate: (xml) => replaceOnce(xml, '<P_12>23</P_12>', '<P_12>23</P_12><Procedura>WSTO_EE</Procedura>'), exact: ['markers'] },
  { title: '15 markers: FP', mutate: inLine('<RodzajFaktury>', '<FP>1</FP>'), exact: ['markers'] },
  { title: '15 markers: TP', mutate: inLine('<RodzajFaktury>', '<TP>1</TP>'), exact: ['markers'] },
  {
    title: '15 markers: podmiot upoważniony (RolaPU)',
    mutate: (xml) => replaceOnce(xml, '</Podmiot2>', '</Podmiot2><PodmiotUpowazniony><RolaPU>2</RolaPU></PodmiotUpowazniony>'),
    exact: ['markers'],
  },
  // 16 sale-date
  {
    title: '16 sale-date: OkresFa zamiast P_6',
    mutate: (xml) => replaceOnce(xml, '<P_6>2026-09-10</P_6>', '<OkresFa><P_6_Od>2026-09-01</P_6_Od><P_6_Do>2026-09-30</P_6_Do></OkresFa>'),
    exact: ['sale-date'],
  },
  { title: '16 sale-date: P_6A w pozycji', mutate: inLine('<P_12>', '<P_6A>2026-09-10</P_6A>'), exact: ['sale-date'] },
  { title: '16 sale-date: nieczytelna P_6', mutate: (xml) => replaceOnce(xml, '<P_6>2026-09-10</P_6>', '<P_6>jutro</P_6>'), exact: ['sale-date'] },
];

describe('5.2: każda reguła bramy — osobny plik czerwony → właściwy kod', () => {
  it.each(RULE_CASES.map((rc) => [rc.title, rc] as const))('%s', (_title, rc) => {
    const b = build(byName(rc.from ?? 'stawka 23'));
    const xml = rc.mutate ? rc.mutate(b.xml, b) : b.xml;

    const ev = gateOf(xml, b, rc.input?.(b));

    const { problems } = ev.gate;
    if (rc.exact) expect(problems).toEqual(rc.exact);
    for (const code of rc.contains ?? []) expect(problems).toContain(code);
    expect(ev.gate.kind).toBe('review');
    expect(ev.gate.v).toBe(1);
    expect(ev.gate.rules).toBe(ORIGINAL_GATE_RULES);
    expect(ev.gate).not.toHaveProperty('release');
    expectOrderedUnique(problems);
    if (problems.includes('parse') || problems.includes('currency')) {
      // Plik się nie odczytał (parse) albo odrzucono go z walutą — nic do pokazania ani zapisania.
      expect(ev.gate.preview).toBeNull();
      expect(ev.parsed).toBeNull();
      expect(ev.content).toBeNull();
      expect(ev.amounts).toBeNull();
    } else {
      // Reguła 2 przeszła: podgląd liczony także dla pliku do przeglądu.
      expect(ev.gate.preview).not.toBeNull();
      expect(ev.parsed).not.toBeNull();
    }
  });
});

describe('5.2: zbieranie problemów', () => {
  it('reguły 3–16 zbierane naraz, w kolejności ORIGINAL_GATE_PROBLEMS, bez powtórzeń', () => {
    const b = build(byName('stawka 23'));
    let xml = b.xml;
    xml = replaceOnce(xml, 'kodSystemowy="FA (3)"', 'kodSystemowy="FA (2)"');
    xml = replaceOnce(xml, `<P_2>${b.number}</P_2>`, '<P_2>FV/INNY/9</P_2>');
    xml = inLine('<P_9A>', '<P_9B>61.5</P_9B>')(xml);
    xml = inAnnotations('<P_23>2</P_23>', '<P_23>1</P_23>')(xml);
    xml = inLine('<P_7>', '<GTU>GTU_01</GTU>')(xml);
    xml = replaceOnce(xml, '<P_6>2026-09-10</P_6>', '<OkresFa><P_6_Od>2026-09-01</P_6_Od><P_6_Do>2026-09-30</P_6_Do></OkresFa>');

    const ev = gateOf(xml, b, { tenantNip: BUYER_NIP });

    expect(ev.gate.kind).toBe('review');
    expect(ev.gate.problems).toEqual(['form', 'number', 'seller', 'gross-prices', 'annotations', 'markers', 'sale-date']);
  });

  it('reguła 1 (currency) kończy ocenę: żadnych innych problemów, nawet gdy plik ich ma', () => {
    const b = build(byName('stawka 23'));
    const xml = replaceOnce(replaceOnce(b.xml, '<KodWaluty>PLN</KodWaluty>', '<KodWaluty>EUR</KodWaluty>'), '<P_9A>', '<P_9B>61.5</P_9B><P_9A>');

    const ev = gateOf(xml, b, { tenantNip: BUYER_NIP, internalNumber: 'FV/INNY/9' });

    expect(ev.gate.problems).toEqual(['currency']);
  });
});

// ─── Granice reguł: pliki, które nadal są importable ─────────────────────────

describe('granice reguł 5.2: plik nadal importable', () => {
  const OK_CASES: ReadonlyArray<{
    title: string;
    mutate?: (xml: string) => string;
    input?: (b: Built) => Partial<OriginalGateInput>;
    /**
     * ZNANA LUKA (poza zakresem commitu 3): brama przepuszcza plik, a lustro 4.8 odmawia tym kodem.
     * Test pinuje stan obecny — naprawa bramy (np. ścisła równość w regule 13) ma go zmienić świadomie.
     */
    mirrorRefuses?: OriginalImportProblem;
  }> = [
    { title: 'waluta małymi literami z odstępami: „ pln ” (po trim i toUpperCase to PLN)', mutate: withCurrency(' pln ') },
    { title: 'brak KodWaluty (reguła 1: tylko niepusta waluta ≠ PLN)', mutate: (xml) => replaceOnce(xml, '<KodWaluty>PLN</KodWaluty>', '') },
    { title: 'numer dokumentu X z odstępami (porównanie po trim)', input: (b) => ({ internalNumber: `  ${b.number} ` }) },
    { title: 'P_2 z odstępami w pliku (porównanie po trim)', mutate: (xml) => xml.replace(/<P_2>([^<]*)<\/P_2>/, '<P_2>  $1  </P_2>') },
    { title: 'NIP sprzedawcy z myślnikami (porównanie samych cyfr)', mutate: (xml) => replaceOnce(xml, `<NIP>${SELLER_NIP}</NIP>`, '<NIP>526-000-12-46</NIP>') },
    { title: 'nazwa pozycji dokładnie 512 znaków (granica włącznie)', mutate: withLineName('n'.repeat(512)) },
    // 4.8 liczy `char_length` (punkty kodowe), nie jednostki UTF-16: 512 emoji to 1024 jednostki, a plik jest w porządku.
    { title: 'nazwa pozycji 512 znaków spoza BMP (punkty kodowe, nie jednostki UTF-16)', mutate: withLineName('😀'.repeat(512)) },
    { title: 'jednostka dokładnie 50 znaków (granica włącznie)', mutate: withLineUnit('u'.repeat(50)) },
    { title: 'jednostka 50 znaków spoza BMP (punkty kodowe, nie jednostki UTF-16)', mutate: withLineUnit('😀'.repeat(50)) },
    { title: 'NIP nabywcy z przedrostkiem i myślnikami (10 cyfr po odfiltrowaniu nie-cyfr, jak w projekcji)', mutate: withBuyerNip('PL 525-224-15-85') },
  ];

  it.each(OK_CASES.map((oc) => [oc.title, oc] as const))('%s', (_title, oc) => {
    const b = build(byName('stawka 23'));
    const xml = oc.mutate ? oc.mutate(b.xml) : b.xml;

    const ev = gateOf(xml, b, oc.input?.(b));

    expect(ev.gate.problems).toEqual([]);
    expect(ev.gate.kind).toBe('importable');
  });

  it.each(OK_CASES.map((oc) => [oc.title, oc] as const))('%s: importable ⇒ lustro 4.8 przechodzi (poza znaną luką)', (_title, oc) => {
    const b = build(byName('stawka 23'));
    const xml = oc.mutate ? oc.mutate(b.xml) : b.xml;

    expect(mirrorProblemOf(xml, b, oc.input?.(b))).toBe(oc.mirrorRefuses ?? null);
  });
});

// ─── Fix 4 (commit 3): importable ⇒ 4.8 przejdzie ────────────────────────────

describe('importable oznacza, że lustro 4.8 przejdzie (brak pętli „nie do zapisania” bez wyjścia operatora)', () => {
  it.each(EACH)('%s: importable ⇒ lustro 4.8 przechodzi', (_name, c) => {
    const b = build(c);

    expect(gateOf(b.xml, b).gate.kind).toBe('importable');
    expect(mirrorProblemOf(b.xml, b)).toBeNull();
  });

  // Przesłanka każdej nowej reguły: bez niej plik byłby `importable`, a 4.8 odmówiłoby go z podanym kodem
  // (klient: „nie do zapisania”, cron: ta sama ocena `importable`, ta sama odmowa — pętla bez wyjścia).
  const REFUSED_BY_4_8: ReadonlyArray<{
    title: string;
    mutate: (xml: string, b: Built) => string;
    input?: Partial<OriginalGateInput>;
    problem: OriginalGateProblem;
    code: OriginalImportProblem;
  }> = [
    { title: 'nazwa pozycji 513 znaków', mutate: withLineName('n'.repeat(513)), problem: 'line-fields', code: 'lines' },
    { title: 'nazwa pozycji pusta', mutate: withLineName(''), problem: 'line-fields', code: 'lines' },
    { title: 'jednostka 51 znaków', mutate: withLineUnit('u'.repeat(51)), problem: 'line-fields', code: 'lines' },
    { title: 'jednostka pusta', mutate: withLineUnit(''), problem: 'line-fields', code: 'lines' },
    { title: 'NIP nabywcy z 9 cyframi', mutate: withBuyerNip('525224158'), problem: 'buyer-id', code: 'buyer' },
    { title: 'NIP nabywcy z 11 cyframi', mutate: withBuyerNip(`${BUYER_NIP}1`), problem: 'buyer-id', code: 'buyer' },
    {
      title: 'P_2 pusty i numer dokumentu X pusty',
      mutate: (xml, b) => replaceOnce(xml, `<P_2>${b.number}</P_2>`, '<P_2></P_2>'),
      input: { internalNumber: '' },
      problem: 'number',
      code: 'shape',
    },
    {
      title: 'brak NIP sprzedawcy w pliku i pusty NIP firmy',
      mutate: (xml) => replaceOnce(xml, `<NIP>${SELLER_NIP}</NIP>`, ''),
      input: { tenantNip: '' },
      problem: 'seller',
      code: 'shape',
    },
  ];

  it.each(REFUSED_BY_4_8.map((rc) => [rc.title, rc] as const))('%s: brama odrzuca, bo 4.8 odmówiłoby', (_title, rc) => {
    const b = build(byName('stawka 23'));
    const xml = rc.mutate(b.xml, b);

    expect(gateOf(xml, b, rc.input).gate.problems).toEqual([rc.problem]);
    expect(mirrorProblemOf(xml, b, rc.input)).toBe(rc.code);
  });
});

// ─── INV-10 (b): brama nie używa parsed.warnings ─────────────────────────────

describe('INV-10 (b): jawne reguły, nigdy parsed.warnings', () => {
  it('ostrzeżenie parsera (nieczytelny termin płatności), a żadnej reguły nie złamano → nadal importable', () => {
    const b = build(byName('stawka 23'));
    const xml = replaceOnce(b.xml, '<Termin>2026-09-24</Termin>', '<Termin>2026-9-24</Termin>');

    const ev = gateOf(xml, b);

    expect(ev.parsed?.warnings).not.toEqual([]);
    expect(ev.gate.problems).toEqual([]);
    expect(ev.gate.kind).toBe('importable');
  });
});

// ─── Nigdy nie rzuca, jest czysta ────────────────────────────────────────────

describe('wyjątki i czystość', () => {
  it('wyjątek parsera (także wartość, która nie jest Error) → parse, bez podglądu i bez rzucania', () => {
    const b = build(byName('stawka 23'));
    injected.parseThrows = { value: 'awaria parsera' };

    const ev = gateOf(b.xml, b);

    expect(ev.gate.problems).toEqual(['parse']);
    expect(ev.gate.kind).toBe('review');
    expect(ev.gate.preview).toBeNull();
    expect(ev.parsed).toBeNull();
  });

  it('wyjątek w późniejszym kroku (kwoty pozycji) też → parse: funkcja łapie każdy wyjątek', () => {
    const b = build(byName('stawka 23'));
    injected.amountsThrows = true;

    const ev = gateOf(b.xml, b);

    expect(ev.gate.problems).toEqual(['parse']);
    expect(ev.gate.kind).toBe('review');
    expect(ev.gate.preview).toBeNull();
  });

  it.each([
    ['pusty tekst', ''],
    ['sam znak <', '<'],
    ['znaki sterujące', '\u0000\u0001\u0002'],
    ['bardzo długi napis', 'x'.repeat(200_000)],
    ['Faktura z samym P_2', '<Faktura><Fa><P_2>1</P_2></Fa></Faktura>'],
    ['null jako tekst', 'null'],
  ])('%s: nie rzuca, wynik to review z uporządkowanymi problemami', (_name, xml) => {
    const b = build(byName('stawka 23'));

    const ev = gateOf(xml, b);

    expect(ev.gate.kind).toBe('review');
    expect(ev.gate.problems.length).toBeGreaterThan(0);
    expectOrderedUnique(ev.gate.problems);
  });

  it('te same bajty → ta sama brama niezależnie od zegara; wynik serializuje się do jsonb bez strat', () => {
    const b = build(byName('stawka 23'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    const first = gateOf(b.xml, b);
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));

    const second = gateOf(b.xml, b);

    expect(second.gate).toEqual(first.gate);
    expect(JSON.parse(JSON.stringify(first.gate))).toEqual(first.gate);
  });
});
