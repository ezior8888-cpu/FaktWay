import { describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * PR C0b (D-A4-1b-3, specyfikacja v3, 5.10 i 7.2) — CZERWONY TEST ustalenia
 * GEN-RUNDA: „plik z generatora FaktWay czyta się bez strat i bez fałszywych
 * ostrzeżeń”.
 *
 * Runda to: faktura FaktWay → `finalizeInvoice` → `validateInvoice` (bez
 * błędów) → `generateFA3Xml` (z walidacją) → `parseFa3Xml` → wiersz importu
 * (`processImportedInvoices`). „Bez strat” = każda dana, którą plik FA(3) niesie
 * i którą FaktWay zapisuje na wierszu faktury albo pokazuje klientowi/JPK:
 * identyfikator nabywcy i jego rodzaj, `JST`/`GV`, stawki, kwoty, adnotacje,
 * daty, uwagi (`Stopka`), rodzaj faktury. Dziś parser (`lib/import/fa3-parser.ts`)
 * i budowniczy wiersza (`lib/import/imported-invoice-row.ts`) gubią część z tego
 * i dopisują fałszywe ostrzeżenia; PR C (zapis oryginału KSeF po decyzji klienta)
 * potrzebuje rundy bez strat z DWÓCH stron — bramy (plik FaktWay nie może
 * dostać `review` przez fałszywe ostrzeżenie) i projekcji K (zapisany wiersz nie
 * może być uboższy niż plik) — dlatego jedno ustalenie, jeden test, jedna macierz.
 *
 * Inwarianty spisane PRZED zmianą (5.10):
 * - GR-1: dla każdego przypadku macierzy `parseFa3Xml(xml).warnings = []`;
 * - GR-2: nabywca z pliku: NIP → `nip`; PESEL (adres PL) → `pesel`; NrInny →
 *   `nrInny`; VAT-UE → `vatUeNumber`; BrakID → `brakId`; `JST`/`GV` z pliku;
 * - GR-3: `footerNote` = pierwsza `Stopka/Informacje/StopkaFaktury` (przycięta,
 *   bez uwag — `undefined`); `invoiceTypeCode` = surowe `RodzajFaktury`;
 * - GR-4: plik bez `P_14_x`, w którym każda pozycja ma stawkę bez VAT (`0`, `zw`,
 *   `oo`, `np`, `np_ii`), a |P_15 − Σ P_13_x| ≤ 0,01 → `vatTotal = 0`, netto
 *   z nagłówka, bez ostrzeżenia; inaczej jak dziś (zostaje ostrzeżenie);
 * - GR-5: `processImportedInvoices` zapisuje `buyer_id_type='pesel'` +
 *   `buyer_pesel` dla PESEL, `buyer_id_number` = NrInny dla NrInny
 *   (`is_b2c`/`buyer_id_type` jak dziś), `buyer_data.jst`/`gv` z pliku,
 *   `buyer_data.noIdMarker` tylko przy BrakID.
 *
 * Dwa przypadki brzegowe NrID (FA(3) wyraża PESEL i „inny” identyfikator tym
 * samym `KodKraju` + `NrID`, więc parser odróżnia je heurystyką):
 * (1) generator pisze przy PESEL `KodKraju` z adresu nabywcy — PESEL z adresem
 *     zagranicznym wraca jako `nrInny` (wartość bez straty; poprawka generatora
 *     to osobne ustalenie GEN-PESEL-KRAJ);
 * (2) 11-cyfrowy NrInny (paszport, dowód) z poprawną sumą PESEL i `KodKraju` PL
 *     wraca jako `pesel` — FA(3) tego nie rozróżnia; wartość identyfikatora
 *     bez straty.
 *
 * Czerwony na `main` (kod sprzed C0b): ostrzeżenie o VAT przy plikach bez
 * `P_14_x` (`0`/`zw`/`oo`/`np`/`np_ii`), „brak identyfikatora” przy PESEL
 * i NrInny, brak `footerNote` i `invoiceTypeCode`, `JST`/`GV` zawsze 2
 * w wierszu, `buyer_id_number` NULL. Zielone na `main` (strażnik, żeby
 * poprawka nie zepsuła tego, co działa): VAT-UE, BrakID, NIP, kwoty, stawki,
 * adnotacje, daty, płatność, bezpiecznik „inaczej jak dziś”. Migawka C0
 * (`import-wiersze-tozsamosc.test.ts`) zmienia się ŚWIADOMIE w PR C0b — to
 * osobny plik, tu niczego z niego nie importujemy.
 *
 * Pola, których na `main` jeszcze nie ma w typach (`footerNote`,
 * `invoiceTypeCode`, `ParsedParty.jst`/`gv`), czytamy przez lokalny widok typu
 * (`ParsedInvoiceView`, `ParsedPartyView`) — test ma padać na asercjach, nie na
 * typach; po C0b widok jest zgodny z prawdziwymi typami.
 *
 * NIP-y: sprzedawca 5260001246 i nabywca 5252241585 mają poprawną sumę
 * kontrolną (jak w `lib/xml/fa3-generator.test.ts`), to NIP-y testowe, nie
 * prawdziwych firm. PESEL 44051401359 ma poprawną sumę kontrolną.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.client }));
// `recordXmlDocument` (xml_documents) bierze klienta z `@/lib/supabase/admin` — ta sama baza.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => state.client }));
vi.mock('@/lib/storage/r2', () => ({
  uploadToR2IfAbsent: vi.fn(async () => true),
  downloadFromR2: vi.fn(async () => {
    throw new Error('magazyn w teście C0b: odczyt nieoczekiwany');
  }),
  downloadInvoiceXmlUnchecked: vi.fn(async () => {
    throw new Error('magazyn w teście C0b: odczyt nieoczekiwany');
  }),
}));

import { contentHeldReasons } from '@/lib/import/fa3-content';
import { parseFa3Xml, type ParsedInvoice, type ParsedParty } from '@/lib/import/fa3-parser';
import { importedInvoiceContent } from '@/lib/import/imported-invoice-row';
import { processImportedInvoices } from '@/lib/import/import-engine';
import { buildInvoiceAnnotations } from '@/lib/invoices/annotations';
import { buyerPartyFromBuyerData } from '@/lib/invoices/map-buyer-party';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { invoiceAnnotationsFromFa3 } from '@/lib/xml/fa3-annotations';
import { finalizeInvoice, validateInvoice } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { BuyerParty, Invoice, InvoiceAnnotations, PaymentInfo, VatRate } from '@/types/invoice';

// ─── Widoki typów (pola, których `main` jeszcze nie ma) ──────────────────────

type ParsedPartyView = ParsedParty & { jst?: 1 | 2; gv?: 1 | 2 };
type ParsedInvoiceView = ParsedInvoice & { footerNote?: string; invoiceTypeCode?: string };

const invoiceView = (parsed: ParsedInvoice) => parsed as ParsedInvoiceView;
const buyerView = (parsed: ParsedInvoice) => parsed.buyer as ParsedPartyView;

// ─── Stałe ───────────────────────────────────────────────────────────────────

const T = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const SELLER_NIP = '5260001246';
const BUYER_NIP = '5252241585';
const PESEL = '44051401359';
/** 11 cyfr z NIEpoprawną sumą kontrolną PESEL (suma 217 → cyfra kontrolna 3, jest 1). */
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

// ─── Opis macierzy ───────────────────────────────────────────────────────────

/** Identyfikator nabywcy, który plik ma nieść (reszta pól musi być pusta). */
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
  /** Co czytelnik pliku ma odczytać jako identyfikator nabywcy (GR-2, GR-5). */
  expectBuyer: BuyerExpect;
  /** Data sprzedaży (P_6): brak pola = `ISSUE`, `null` = faktura bez P_6. */
  saleDate?: string | null;
  notes?: string;
  payment?: Omit<PaymentInfo, 'amountDue'>;
  /** Etykieta formy płatności, którą parser ma zwrócić (`paymentMethod`). */
  paymentLabel?: RegExp;
  /** Wejście `buildInvoiceAnnotations` (jak formularz faktury). */
  exemptionBasis?: string | null;
  splitPayment?: boolean;
  cashMethod?: boolean;
  /** Adnotacje różne od domyślnych (2 = nie dotyczy), które plik ma nieść. */
  expectAnnotations?: Partial<InvoiceAnnotations>;
}

const NO_VAT_RATES: ReadonlySet<VatRate> = new Set<VatRate>(['0', 'zw', 'oo', 'np', 'np_ii']);

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
    paymentLabel: /^gotówka$/,
  },
  {
    // Przypadek brzegowy 1 (GEN-PESEL-KRAJ): generator pisze KodKraju z adresu.
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
    // Przypadek brzegowy 2: 11 cyfr z poprawną sumą PESEL i KodKraju PL — FA(3) nie rozróżnia.
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
    paymentLabel: /^przelew$/,
  },
  {
    name: 'płatność: gotówka',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'cash' },
    paymentLabel: /^gotówka$/,
  },
  {
    name: 'płatność: karta',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'card' },
    paymentLabel: /^karta$/,
  },
  {
    name: 'płatność: inna',
    lines: single('23'),
    buyer: BUYER_B2B,
    expectBuyer: { nip: BUYER_NIP },
    payment: { currency: 'PLN', dueDate: ISSUE, method: 'other' },
    paymentLabel: /^inna/,
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

/** Para (nazwa, przypadek) dla `it.each` — tytuł testu z pełną nazwą (`$name` przycina długie napisy). */
const EACH = MATRIX.map((c) => [c.name, c] as const);

// ─── Budowa przypadku: faktura → XML → odczyt ────────────────────────────────

interface Built {
  invoice: Invoice;
  xml: string;
  /** Numer KSeF nadany plikowi w teście (jak w imporcie historii). */
  ksefNumber: string;
}

const built = new Map<string, Built>();

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
  // Generator z walidacją (domyślnie `validate: true`) — wyjątek = przypadek nie do wystawienia.
  const xml = generateFA3Xml(invoice, { generatedAt: GENERATED_AT });
  const result: Built = {
    invoice,
    xml,
    ksefNumber: `${SELLER_NIP}-20260910-GR${String(index).padStart(10, '0')}-AF`,
  };
  built.set(c.name, result);
  return result;
}

const parse = (c: MatrixCase): ParsedInvoice => parseFa3Xml(build(c).xml);

// ─── Baza w pamięci z zapisem każdego `insert` (GR-5) ────────────────────────

interface RecordedInsert {
  table: string;
  payload: unknown;
}

/** To, co supabase-js wysyła do PostgREST: JSON (pole `undefined` znika). */
const wire = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function recordingClient(tables: MemoryTables, inserts: RecordedInsert[]) {
  const inner = memoryClient(tables);
  return {
    from(table: string) {
      const query = inner.from(table);
      const insert = query.insert;
      query.insert = (payload: Row | Row[]) => {
        inserts.push({ table, payload: wire(payload) });
        return insert(payload);
      };
      return query;
    },
  };
}

interface Imported {
  imported: number;
  failed: number;
  header: Row;
  lines: Row[];
}

const importedCache = new Map<string, Promise<Imported>>();

/** Plik z numerem KSeF → historia KSeF, sprzedaż przyjęta (TEST) — jak w PR C0. */
function importCase(c: MatrixCase): Promise<Imported> {
  const cached = importedCache.get(c.name);
  if (cached) return cached;
  const run = (async (): Promise<Imported> => {
    const tables: MemoryTables = { invoices: [], invoice_line_items: [], contractors: [], products: [], xml_documents: [] };
    const inserts: RecordedInsert[] = [];
    state.client = recordingClient(tables, inserts);
    try {
      const { ksefNumber, xml } = build(c);
      const result = await processImportedInvoices({
        tenantId: T,
        importJobId: JOB,
        source: 'ksef_history',
        invoiceDirection: 'outgoing',
        invoiceKsefStatus: 'accepted',
        ksefEnvironment: 'test',
        invoices: [parseFa3Xml(xml, { ksefNumber })],
      });
      const header = inserts.find((w) => w.table === 'invoices')?.payload as Row | undefined;
      const lines = inserts.find((w) => w.table === 'invoice_line_items')?.payload as Row[] | undefined;
      if (!header || !lines) throw new Error(`${c.name}: silnik nie zapisał faktury (${result.warnings.join(' | ')})`);
      return { imported: result.invoicesImported, failed: result.invoicesFailed, header, lines };
    } finally {
      state.client = null;
    }
  })();
  importedCache.set(c.name, run);
  return run;
}

/** Kolumny identyfikatora nabywcy, które silnik ma zapisać dla danego identyfikatora z pliku (GR-5). */
function expectedIdentityColumns(buyer: BuyerExpect) {
  if (buyer.nip) {
    return { is_b2c: false, buyer_id_type: 'nip', buyer_nip: buyer.nip, buyer_pesel: null, buyer_id_number: null };
  }
  if (buyer.pesel) {
    return { is_b2c: true, buyer_id_type: 'pesel', buyer_nip: null, buyer_pesel: buyer.pesel, buyer_id_number: null };
  }
  if (buyer.nrInny) {
    // `is_b2c`/`buyer_id_type` jak dziś — FA(3) nie mówi, czy to konsument; zmienia się tylko `buyer_id_number`.
    return { is_b2c: false, buyer_id_type: 'nip', buyer_nip: null, buyer_pesel: null, buyer_id_number: buyer.nrInny };
  }
  if (buyer.vatUeNumber) {
    return { is_b2c: false, buyer_id_type: 'nip', buyer_nip: null, buyer_pesel: null, buyer_id_number: null };
  }
  return { is_b2c: true, buyer_id_type: 'no_id', buyer_nip: null, buyer_pesel: null, buyer_id_number: null };
}

const expectedJst = (c: MatrixCase) => c.buyer.jst ?? 2;
const expectedGv = (c: MatrixCase) => c.buyer.gv ?? 2;

// ─── Testy ───────────────────────────────────────────────────────────────────

describe('GEN-RUNDA (C0b): macierz rundy — przygotowanie', () => {
  it('nazwy przypadków są unikalne, a macierz obejmuje wszystkie stawki, rodzaje nabywcy i adnotacje', () => {
    const names = MATRIX.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const rates = new Set(MATRIX.flatMap((c) => c.lines.map((l) => l.rate)));
    expect([...rates].sort()).toEqual(['0', '23', '5', '8', 'np', 'np_ii', 'oo', 'zw']);
    const kinds = new Set(MATRIX.flatMap((c) => Object.keys(c.expectBuyer)));
    expect([...kinds].sort()).toEqual(['brakId', 'nip', 'nrInny', 'pesel', 'vatUeNumber']);
  });

  it.each(EACH)('%s: validateInvoice bez błędów, generator z walidacją, plik zgodny z XSD FA(3)', async (_name, c) => {
    const { invoice, xml } = build(c);
    expect(validateInvoice(invoice, NOW)).toEqual([]);
    expect((await validateFA3(xml)).errors).toEqual([]);
  });
});

describe('GR-1: plik z generatora nie daje ostrzeżeń parsera', () => {
  it.each(EACH)('%s', (_name, c) => {
    expect(parse(c).warnings).toEqual([]);
  });
});

describe('GR-2: nabywca z pliku — identyfikator, JST i GV', () => {
  it.each(EACH)('%s: identyfikator nabywcy', (_name, c) => {
    const buyer = parse(c).buyer;
    const expected = c.expectBuyer;
    expect({
      nip: buyer.nip,
      pesel: buyer.pesel,
      nrInny: buyer.nrInny,
      vatUeNumber: buyer.vatUeNumber,
      brakId: buyer.brakId,
    }).toEqual({
      nip: expected.nip,
      pesel: expected.pesel,
      nrInny: expected.nrInny,
      vatUeNumber: expected.vatUeNumber,
      brakId: expected.brakId,
    });
  });

  it.each(EACH)('%s: JST i GV z pliku', (_name, c) => {
    const buyer = buyerView(parse(c));
    expect({ jst: buyer.jst, gv: buyer.gv }).toEqual({ jst: expectedJst(c), gv: expectedGv(c) });
  });
});

describe('GR-3: uwagi (Stopka) i rodzaj faktury z pliku', () => {
  it.each(EACH)('%s: footerNote', (_name, c) => {
    // Z uwagami — pierwsza StopkaFaktury, przycięta; bez uwag — brak pola (nie pusty napis).
    expect(invoiceView(parse(c)).footerNote).toBe(c.notes?.trim());
  });

  it.each(EACH)('%s: invoiceTypeCode = surowe RodzajFaktury', (_name, c) => {
    expect(invoiceView(parse(c)).invoiceTypeCode).toBe('VAT');
  });
});

describe('GR-4: plik bez P_14_x ze stawkami bez VAT — VAT = 0 bez ostrzeżenia', () => {
  const noVatCases = MATRIX.filter((c) => c.lines.every((l) => NO_VAT_RATES.has(l.rate)));

  it('macierz zawiera każdą stawkę bez VAT, także jako jedyną w pliku', () => {
    expect(new Set(noVatCases.flatMap((c) => c.lines.map((l) => l.rate)))).toEqual(NO_VAT_RATES);
    for (const c of noVatCases) expect(build(c).xml, c.name).not.toMatch(/<P_14_/);
  });

  it.each(noVatCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { invoice } = build(c);
    const parsed = parse(c);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.totals).toEqual({ netTotal: invoice.netTotal, vatTotal: 0, grossTotal: invoice.grossTotal });
  });

  const zeroRate = MATRIX.find((c) => c.name === 'stawka 0 (0 KR)')!;
  const withP15 = (p15: string) => {
    const xml = build(zeroRate).xml;
    const changed = xml.replace('<P_15>100.00</P_15>', `<P_15>${p15}</P_15>`);
    expect(changed, 'fikstura ma P_15 100.00').not.toBe(xml);
    return parseFa3Xml(changed);
  };

  it('P_15 różni się od sumy P_13_x o 0,01 — mieści się w tolerancji, bez ostrzeżenia', () => {
    // Granica |P_15 − Σ P_13_x| = 0,01 jest włączona; porównanie na groszach (100,01 − 100 w liczbach zmiennoprzecinkowych > 0,01).
    const parsed = withP15('100.01');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.totals).toEqual({ netTotal: 100, vatTotal: 0, grossTotal: 100.01 });
  });

  it('P_15 mniejsze od sumy P_13_x o 0,01 — tolerancja działa w obie strony, bez ostrzeżenia', () => {
    const parsed = withP15('99.99');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.totals).toEqual({ netTotal: 100, vatTotal: 0, grossTotal: 99.99 });
  });

  it('P_15 różni się od sumy P_13_x o 0,50 — „inaczej jak dziś”: ostrzeżenie zostaje', () => {
    expect(withP15('100.50').warnings).not.toEqual([]);
  });

  it('P_15 mniejsze od sumy P_13_x o 0,50 — poza tolerancją także w dół: ostrzeżenie zostaje', () => {
    expect(withP15('99.50').warnings).not.toEqual([]);
  });
});

describe('GR-5: processImportedInvoices — kolumny nabywcy na wierszu faktury', () => {
  it.each(EACH)('%s: faktura zapisana, kolumny identyfikatora nabywcy', async (_name, c) => {
    const out = await importCase(c);
    expect({ imported: out.imported, failed: out.failed }).toEqual({ imported: 1, failed: 0 });
    expect(out.header).toMatchObject(expectedIdentityColumns(c.expectBuyer));
  });

  it.each(EACH)('%s: buyer_data — identyfikator, JST i GV z pliku', async (_name, c) => {
    const buyerData = (await importCase(c)).header.buyer_data as Row;
    const expected = c.expectBuyer;
    expect(buyerData).toMatchObject({
      jst: expectedJst(c),
      gv: expectedGv(c),
      ...(expected.nip ? { nip: expected.nip } : {}),
      ...(expected.pesel ? { pesel: expected.pesel } : {}),
      ...(expected.nrInny ? { nrInny: expected.nrInny } : {}),
      ...(expected.vatUeNumber ? { vatUeNumber: expected.vatUeNumber } : {}),
    });
  });

  it.each(EACH)('%s: buyer_data.noIdMarker tylko przy BrakID', async (_name, c) => {
    const buyerData = (await importCase(c)).header.buyer_data as Row;
    expect(buyerData.noIdMarker).toBe(c.expectBuyer.brakId === true);
  });
});

describe('Przypadki brzegowe NrID (KodKraju + NrID wyraża PESEL i „inny” identyfikator tak samo)', () => {
  const byName = (name: string) => MATRIX.find((c) => c.name === name)!;

  it('(1) PESEL z adresem zagranicznym: generator pisze KodKraju z adresu → plik niesie DE + PESEL, odczyt = nrInny, wartość bez straty', async () => {
    const c = byName('nabywca PESEL z adresem zagranicznym → nrInny');
    expect(build(c).xml).toContain(`<KodKraju>DE</KodKraju><NrID>${PESEL}</NrID>`);
    const buyer = parse(c).buyer;
    expect({ pesel: buyer.pesel, nrInny: buyer.nrInny }).toEqual({ pesel: undefined, nrInny: PESEL });
    expect(parse(c).warnings).toEqual([]);

    const out = await importCase(c);
    expect(out.header).toMatchObject({
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: null,
      buyer_pesel: null,
      buyer_id_number: PESEL,
    });
    expect(out.header.buyer_data).toMatchObject({ nrInny: PESEL, noIdMarker: false });
  });

  it('(2) 11-cyfrowy NrInny z poprawną sumą PESEL i KodKraju PL: FA(3) nie rozróżnia → odczyt = pesel, wartość bez straty', async () => {
    const c = byName('nabywca NrInny 11 cyfr z sumą PESEL i adresem PL → pesel');
    expect(c.buyer.nrInny).toBe(PESEL);
    expect(c.buyer.pesel).toBeUndefined();
    expect(build(c).xml).toContain(`<KodKraju>PL</KodKraju><NrID>${PESEL}</NrID>`);
    const buyer = parse(c).buyer;
    expect({ pesel: buyer.pesel, nrInny: buyer.nrInny }).toEqual({ pesel: PESEL, nrInny: undefined });
    expect(parse(c).warnings).toEqual([]);

    const out = await importCase(c);
    expect(out.header).toMatchObject({
      is_b2c: true,
      buyer_id_type: 'pesel',
      buyer_nip: null,
      buyer_pesel: PESEL,
      buyer_id_number: null,
    });
    expect(out.header.buyer_data).toMatchObject({ pesel: PESEL, noIdMarker: false });
  });

  it('(2b) 11 cyfr BEZ poprawnej sumy PESEL (adres PL) zostaje nrInny — heurystyka nie robi PESEL z każdego numeru', async () => {
    const c = byName('nabywca NrInny 11 cyfr bez sumy PESEL (adres PL) → nrInny');
    const buyer = parse(c).buyer;
    expect({ pesel: buyer.pesel, nrInny: buyer.nrInny }).toEqual({ pesel: undefined, nrInny: ELEVEN_DIGITS_BAD_CHECKSUM });
    const out = await importCase(c);
    expect(out.header).toMatchObject({ buyer_pesel: null, buyer_id_number: ELEVEN_DIGITS_BAD_CHECKSUM });
  });
});

describe('Bez strat: stawki, kwoty, daty, płatność i adnotacje z pliku (strażnik — zielony przed i po C0b)', () => {
  it.each(EACH)('%s: pozycje, sumy, numer i daty', (_name, c) => {
    const { invoice } = build(c);
    const parsed = parse(c);
    expect(parsed.invoiceNumber).toBe(invoice.internalNumber);
    expect(parsed.issueDate).toBe(invoice.issueDate);
    expect(parsed.saleDate).toBe(invoice.saleDate);
    expect(parsed.lines.map((l) => ({
      position: l.position,
      name: l.name,
      unit: l.unit,
      quantity: l.quantity,
      unitPriceNet: l.unitPriceNet,
      vatRate: l.vatRate,
      netAmount: l.netAmount,
    }))).toEqual(invoice.lines.map((l) => ({
      position: l.ordinal,
      name: l.name,
      unit: l.unit,
      quantity: l.quantity,
      unitPriceNet: l.unitPriceNet,
      vatRate: l.vatRate,
      netAmount: l.netAmount,
    })));
    expect(parsed.totals).toEqual({ netTotal: invoice.netTotal, vatTotal: invoice.vatTotal, grossTotal: invoice.grossTotal });
  });

  it.each(EACH)('%s: termin, forma płatności i rachunek', (_name, c) => {
    const { invoice } = build(c);
    const parsed = parse(c);
    expect(parsed.paymentDueDate).toBe(invoice.payment.dueDate);
    expect(parsed.paymentMethod).toMatch(c.paymentLabel ?? /^przelew$/);
    // NrRB bez prefiksu PL; nazwa banku jest poza ustaleniem (C5b-d+), więc nie sprawdzamy jej.
    expect(parsed.bankAccount).toBe(invoice.payment.method === 'transfer' ? BANK_ACCOUNT : undefined);
  });

  it.each(EACH)('%s: adnotacje (P_16, P_17, P_18, P_18A, P_23, zwolnienie)', (_name, c) => {
    const parsed = parse(c);
    expect(parsed.annotationProblems).toBeUndefined();
    expect(invoiceAnnotationsFromFa3(parsed.ksefAnnotations!)).toEqual({
      cashMethod: 2,
      selfInvoicing: 2,
      reverseCharge: 2,
      splitPayment: 2,
      simplifiedProcedure: 2,
      newMeansOfTransport: 2,
      ...c.expectAnnotations,
    });
  });

  it.each(EACH)('%s: nic, co zatrzymałoby JPK (adnotacje, daty, kwoty pozycji)', (_name, c) => {
    const parsed = parse(c);
    const { content, amounts } = importedInvoiceContent(parsed);
    expect(contentHeldReasons(parsed, content)).toEqual([]);
    expect(amounts.problems).toEqual([]);
  });
});


// ─── Pliki obcych programów: odczyt elementów spoza generatora FaktWay ──────────
// Bez nich zła implementacja C0b przeszłaby macierz (stałe invoiceTypeCode,
// NrID bez KodKraju, ostatnia Informacje, 0 WDT/0 EX, NrPESEL/NrInny, noIdMarker).

/** Jak `importCase`, ale z dowolnym XML (ręcznie zmieniony plik obcego programu). */
async function importXml(xml: string): Promise<Row> {
  const tables: MemoryTables = { invoices: [], invoice_line_items: [], contractors: [], products: [], xml_documents: [] };
  const inserts: RecordedInsert[] = [];
  state.client = recordingClient(tables, inserts);
  try {
    await processImportedInvoices({
      tenantId: T,
      importJobId: JOB,
      source: 'ksef_history',
      invoiceDirection: 'outgoing',
      invoiceKsefStatus: 'accepted',
      ksefEnvironment: 'test',
      invoices: [parseFa3Xml(xml, { ksefNumber: `${SELLER_NIP}-20260910-GRXXXXXXXXXX-AF` })],
    });
    const header = inserts.find((w) => w.table === 'invoices')?.payload as Row | undefined;
    if (!header) throw new Error('silnik nie zapisał faktury');
    return header;
  } finally {
    state.client = null;
  }
}

describe('Pliki obcych programów (ręcznie zmieniony XML z generatora)', () => {
  const xmlOf = (name: string) => build(MATRIX.find((c) => c.name === name)!).xml;
  const replaceOnce = (xml: string, from: string, to: string) => {
    expect(xml, `fikstura zawiera ${from}`).toContain(from);
    return xml.replace(from, to);
  };

  it.each(['VAT', 'UPR', 'KOR', 'ZAL', 'ROZ', 'KOR_ZAL', 'KOR_ROZ'])('GR-3: RodzajFaktury %s → invoiceTypeCode surowy i przycięty', (code) => {
    const xml = replaceOnce(xmlOf('nabywca NIP'), '<RodzajFaktury>VAT</RodzajFaktury>', `<RodzajFaktury> ${code} </RodzajFaktury>`);
    expect(invoiceView(parseFa3Xml(xml)).invoiceTypeCode).toBe(code);
  });

  it('GR-3: dwie Informacje/StopkaFaktury → footerNote = pierwsza', () => {
    const xml = replaceOnce(xmlOf('z uwagami (Stopka)'), '</Stopka>', '<Informacje><StopkaFaktury>Druga uwaga</StopkaFaktury></Informacje></Stopka>');
    expect(invoiceView(parseFa3Xml(xml)).footerNote).toBe('Dziękujemy za zakup. Zamówienie nr 42 & "pilne" <3');
  });

  it('NrID z poprawnym PESEL bez KodKraju → pesel, bez ostrzeżeń', () => {
    const xml = replaceOnce(xmlOf('nabywca PESEL z adresem w Polsce'), `<KodKraju>PL</KodKraju><NrID>${PESEL}</NrID>`, `<NrID>${PESEL}</NrID>`);
    const parsed = parseFa3Xml(xml);
    expect({ pesel: parsed.buyer.pesel, nrInny: parsed.buyer.nrInny }).toEqual({ pesel: PESEL, nrInny: undefined });
    expect(parsed.warnings).toEqual([]);
  });

  it('NrPESEL (inne programy) czytany dalej', () => {
    const xml = replaceOnce(xmlOf('nabywca PESEL z adresem w Polsce'), `<KodKraju>PL</KodKraju><NrID>${PESEL}</NrID>`, `<NrPESEL>${PESEL}</NrPESEL>`);
    const parsed = parseFa3Xml(xml);
    expect({ pesel: parsed.buyer.pesel, nrInny: parsed.buyer.nrInny }).toEqual({ pesel: PESEL, nrInny: undefined });
    expect(parsed.warnings).toEqual([]);
  });

  it('NrInny (inne programy) czytany dalej', () => {
    const xml = replaceOnce(xmlOf('nabywca PESEL z adresem w Polsce'), `<KodKraju>PL</KodKraju><NrID>${PESEL}</NrID>`, '<NrInny>XY123456</NrInny>');
    const parsed = parseFa3Xml(xml);
    expect({ pesel: parsed.buyer.pesel, nrInny: parsed.buyer.nrInny }).toEqual({ pesel: undefined, nrInny: 'XY123456' });
    expect(parsed.warnings).toEqual([]);
  });

  it.each([['0 WDT', 'P_13_6_2'], ['0 EX', 'P_13_6_3']])('GR-4: stawka %s bez P_14_x → VAT 0 bez ostrzeżenia', (code, field) => {
    let xml = replaceOnce(xmlOf('stawka 0 (0 KR)'), '<P_12>0 KR</P_12>', `<P_12>${code}</P_12>`);
    xml = xml.replace('<P_13_6_1>', `<${field}>`).replace('</P_13_6_1>', `</${field}>`);
    const parsed = parseFa3Xml(xml);
    expect(parsed.lines[0]!.vatRate).toBe(code);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.totals).toEqual({ netTotal: 100, vatTotal: 0, grossTotal: 100 });
  });

  it('GR-4: pozycja 23% bez P_14_1 i z P_15 = netto → „inaczej jak dziś”: ostrzeżenie o VAT zostaje', () => {
    let xml = replaceOnce(xmlOf('stawka 23'), '<P_14_1>23.00</P_14_1>', '');
    xml = replaceOnce(xml, '<P_15>123.00</P_15>', '<P_15>100.00</P_15>');
    expect(parseFa3Xml(xml).warnings).toContain('VAT przybliżony jako brutto − netto z pozycji');
  });

  it('GR-4: mieszane 23 + zw bez P_14_1, P_15 = Σ P_13_x → „inaczej jak dziś”: ostrzeżenie o VAT zostaje (reguła „każda pozycja bez VAT”)', () => {
    let xml = replaceOnce(xmlOf('mieszane 23 + zw'), '<P_14_1>23.00</P_14_1>', '');
    xml = replaceOnce(xml, '<P_15>323.00</P_15>', '<P_15>300.00</P_15>');
    expect(parseFa3Xml(xml).warnings).toContain('VAT przybliżony jako brutto − netto z pozycji');
  });

  it('GR-4: same pozycje zw, ale z P_14_1 w nagłówku → reguła nie obejmuje pliku, ostrzeżenie o niezgodności nagłówka zostaje', () => {
    const xml = replaceOnce(xmlOf('stawka zw z podstawą (art. 113)'), '<P_15>', '<P_14_1>23.00</P_14_1><P_15>');
    expect(parseFa3Xml(xml).warnings).toContainEqual(expect.stringContaining('Możliwa niezgodność kwot nagłówka'));
  });

  it('GR-4: P_15 różni się od sumy P_13_x o 0,02 — poza tolerancją 0,01, „jak dziś”', () => {
    const xml = replaceOnce(xmlOf('stawka 0 (0 KR)'), '<P_15>100.00</P_15>', '<P_15>100.02</P_15>');
    const parsed = parseFa3Xml(xml);
    expect(parsed.warnings).toContain('VAT przybliżony jako brutto − netto z pozycji');
    expect(parsed.totals.vatTotal).toBe(0.02);
  });

  it('GR-5: nabywca bez żadnego identyfikatora (nawet bez BrakID) → noIdMarker true jak dziś', async () => {
    const xml = replaceOnce(xmlOf('nabywca BrakID'), '<BrakID>1</BrakID>', '');
    const header = await importXml(xml);
    expect(header).toMatchObject({ is_b2c: true, buyer_id_type: 'no_id', buyer_pesel: null, buyer_id_number: null });
    expect((header.buyer_data as Row).noIdMarker).toBe(true);
  });

  it('GR-5: plik bez JST i GV → buyer_data.jst/gv = 2', async () => {
    const xml = replaceOnce(xmlOf('nabywca NIP'), '<JST>2</JST><GV>2</GV>', '');
    const header = await importXml(xml);
    expect(header.buyer_data).toMatchObject({ jst: 2, gv: 2 });
  });

  it('GR-5: Stopka z pliku nie wchodzi do `notes` silnika (notes bez zmian — Stopka trafi do K w PR C)', async () => {
    const out = await importCase(MATRIX.find((c) => c.name === 'z uwagami (Stopka)')!);
    expect(out.header.notes).toBe(`[import] ksef_history job=${JOB}`);
  });
});
