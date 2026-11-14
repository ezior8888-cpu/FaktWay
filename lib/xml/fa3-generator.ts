import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces';

import type { Invoice, InvoiceLineItem, VatRate, BuyerParty } from '@/types/invoice';
import {
  calculateInvoiceTotals,
  normalizeIban,
  summarizeVatPerRate,
  validateInvoice,
  ZW_WITHOUT_BASIS_MESSAGE,
} from './invoice-calculator';
import { RECEIPT_ONLY_REGULAR_MESSAGE, RECEIPT_XML_KEYS } from '@/lib/invoices/receipt-invoice';
import { parseVatUe } from '@/lib/invoices/vat-ue';

// ═══════════════════════════════════════════════════════════════
// STAŁE SCHEMATU FA(3)
// ═══════════════════════════════════════════════════════════════

/**
 * Namespace FA(3) – publikacja 2025-06-25, obowiązuje od 2026-02-01.
 * Źródło: https://crd.gov.pl/wzor/2025/06/25/13775/
 */
const FA3_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';
const ETD_NAMESPACE =
  'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/';

const FORM_SYSTEM_CODE = 'FA (3)';
const FORM_VERSION = '1-0E';
const FORM_VALUE = 'FA';

// Domyślny System Info wstawiany do <Naglowek>.
const DEFAULT_SYSTEM_INFO = 'KSeF SaaS v1.0';

// ═══════════════════════════════════════════════════════════════
// Formatery
// ═══════════════════════════════════════════════════════════════

function formatDecimal(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

function formatDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`Invalid date format: "${isoDate}". Expected YYYY-MM-DD.`);
  }
  return isoDate;
}

function formatTimestamp(date: Date = new Date()): string {
  // TDataCzas wymaga sekundowej precyzji bez milisekund, z literałem Z.
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ═══════════════════════════════════════════════════════════════
// Mapy enum-ów: VatRate → element P_13_x (sumy)
// ═══════════════════════════════════════════════════════════════

/**
 * Mapa VatRate domenowej → triplet (elementy XSD dla netSum/vatSum, etykieta P_12).
 *
 * MVP krajowe B2B: zawsze interpretujemy:
 *  - '0'     → 0% krajowa (P_13_6_1, P_12='0 KR')
 *  - 'np'    → 'np I' (dostawy poza krajem, P_13_8)
 *  - 'np_ii' → 'np II' (usługi z art. 100 ust. 1 pkt 4, P_13_9; AUD-70)
 *
 * Obsługa WDT ('0 WDT' → P_13_6_2), eksportu ('0 EX' → P_13_6_3) itd.
 * będzie wymagała rozszerzenia VatRate o rozróżnianie wariantów.
 */
interface VatRateMapping {
  /** Element XSD dla sumy netto tej stawki (np. 'P_13_1', 'P_13_6_1'). */
  netElement: string;
  /** Element XSD dla sumy VAT, jeśli stawka ma VAT > 0 (np. 'P_14_1'). */
  vatElement?: string;
  /** Wartość enum TStawkaPodatku wstawiana w <P_12>. */
  p12Value: string;
}

const VAT_RATE_MAP: Record<VatRate, VatRateMapping> = {
  '23': { netElement: 'P_13_1', vatElement: 'P_14_1', p12Value: '23' },
  '8': { netElement: 'P_13_2', vatElement: 'P_14_2', p12Value: '8' },
  '5': { netElement: 'P_13_3', vatElement: 'P_14_3', p12Value: '5' },
  '0': { netElement: 'P_13_6_1', p12Value: '0 KR' },
  zw: { netElement: 'P_13_7', p12Value: 'zw' },
  oo: { netElement: 'P_13_10', p12Value: 'oo' },
  np: { netElement: 'P_13_8', p12Value: 'np I' },
  // AUD-70: usługi z art. 100 ust. 1 pkt 4 (nabywca z UE rozlicza VAT).
  np_ii: { netElement: 'P_13_9', p12Value: 'np II' },
};

/**
 * Kolejność elementów P_13_* w sekwencji XSD (patrz schemat.xsd linie 2500-2630).
 * Używana do emitowania sum w poprawnym porządku.
 */
const P_13_ORDER: readonly string[] = [
  'P_13_1',
  'P_13_2',
  'P_13_3',
  'P_13_4', // ryczałt taksówkowy – nieużywane w MVP
  'P_13_5', // procedura szczególna OSS – nieużywane w MVP
  'P_13_6_1',
  'P_13_6_2',
  'P_13_6_3',
  'P_13_7',
  'P_13_8',
  'P_13_9',
  'P_13_10',
  'P_13_11',
];

// Mapa FormaPlatnosci → enum TFormaPlatnosci (xsd linie 1324-1365).
// UWAGA: XSD wartości to 1..7, nie 1..10. 'other' nie ma reprezentacji
// w enum-ie – emitujemy alternatywnie <PlatnoscInna>1</PlatnoscInna>.
const PAYMENT_METHOD_MAP: Record<'transfer' | 'cash' | 'card' | 'mobile', string> = {
  cash: '1', // gotówka
  card: '2', // karta
  transfer: '6', // przelew
  mobile: '7', // mobilna (BLIK)
};

// ═══════════════════════════════════════════════════════════════
// Interfejsy i błędy eksportowane
// ═══════════════════════════════════════════════════════════════

export interface GenerateXmlOptions {
  /** Data wytworzenia faktury – default: now() */
  generatedAt?: Date;
  /** Czy uruchomić validateInvoice() przed generowaniem – default: true */
  validate?: boolean;
  /** Czy sformatować XML z wcięciami – default: false */
  prettyPrint?: boolean;
  /** Nadpisywane <SystemInfo> – default: 'KSeF SaaS v1.0' */
  systemInfo?: string;
}

export class InvoiceValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(
      `Faktura zawiera ${errors.length} ${
        errors.length === 1 ? 'błąd' : 'błędów'
      } walidacji:\n${errors.join('\n')}`,
    );
    this.name = 'InvoiceValidationError';
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpery buildera
// ═══════════════════════════════════════════════════════════════

/**
 * xmlbuilder2 wymaga niepustego stringa – rzucamy wcześniej
 * komunikatem diagnostycznym niż generować pustą treść elementu.
 */
function requireText(value: string | undefined | null, field: string): string {
  if (value === undefined || value === null || value === '') {
    throw new Error(`FA(3): wymagane pole "${field}" jest puste.`);
  }
  return value;
}

/**
 * Rozbija numer VAT UE w formacie "DE123456789" na parę (KodUE, NrVatUE).
 * XSD TPodmiot2/choice wymaga rozdzielenia prefiksu od numeru.
 *
 * Bezpiecznik (AUD-70): prefiks spoza `TKodyKrajowUE` (np. „GR” zamiast „EL”)
 * albo numer niezgodny z `TNrVatUE` przerywa generowanie — wcześniej taki XML
 * powstawał i odpadał dopiero w KSeF. Komunikat dla człowieka daje
 * `validateInvoice`; tu tylko ostatnia linia obrony przy `validate: false`.
 */
function splitVatUe(vatUeNumber: string): { kodUE: string; numer: string } {
  const parsed = parseVatUe(vatUeNumber);
  if (!parsed) {
    throw new Error(
      `FA(3): numer VAT-UE nabywcy "${vatUeNumber}" jest nieprawidłowy — oczekiwano prefiksu kraju UE ` +
        '(Grecja: „EL”, nie „GR”) i 1–12 znaków [0-9A-Z+*], np. „DE123456789”.',
    );
  }
  return { kodUE: parsed.kodUE, numer: parsed.numer };
}

// ═══════════════════════════════════════════════════════════════
// Główna funkcja
// ═══════════════════════════════════════════════════════════════

export function generateFA3Xml(
  invoice: Invoice,
  options: GenerateXmlOptions = {},
): string {
  const {
    generatedAt = new Date(),
    validate = true,
    prettyPrint = false,
    systemInfo = DEFAULT_SYSTEM_INFO,
  } = options;

  if (validate) {
    const errors = validateInvoice(invoice);
    if (errors.length > 0) {
      throw new InvoiceValidationError(errors);
    }
  }

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('Faktura', {
    xmlns: FA3_NAMESPACE,
    'xmlns:etd': ETD_NAMESPACE,
  });

  buildNaglowek(root, generatedAt, systemInfo);
  buildPodmiot1(root, invoice);
  buildPodmiot2(root, invoice);
  buildFa(root, invoice);
  buildStopka(root, invoice);

  return root.end({ prettyPrint, headless: false });
}

// ═══════════════════════════════════════════════════════════════
// <Naglowek>
// ═══════════════════════════════════════════════════════════════

function buildNaglowek(
  root: XMLBuilder,
  generatedAt: Date,
  systemInfo: string,
): void {
  const naglowek = root.ele('Naglowek');
  naglowek
    .ele('KodFormularza', {
      kodSystemowy: FORM_SYSTEM_CODE,
      wersjaSchemy: FORM_VERSION,
    })
    .txt(FORM_VALUE);
  naglowek.ele('WariantFormularza').txt('3');
  naglowek.ele('DataWytworzeniaFa').txt(formatTimestamp(generatedAt));
  if (systemInfo) {
    naglowek.ele('SystemInfo').txt(systemInfo);
  }
}

// ═══════════════════════════════════════════════════════════════
// <Podmiot1> – sprzedawca
// ═══════════════════════════════════════════════════════════════

function buildPodmiot1(
  root: XMLBuilder,
  invoice: Invoice,
): void {
  const podmiot1 = root.ele('Podmiot1');

  const daneId = podmiot1.ele('DaneIdentyfikacyjne');
  daneId.ele('NIP').txt(requireText(invoice.seller.nip, 'seller.nip'));
  daneId.ele('Nazwa').txt(requireText(invoice.seller.name, 'seller.name'));

  const adres = podmiot1.ele('Adres');
  adres.ele('KodKraju').txt(requireText(invoice.seller.address.countryCode, 'seller.address.countryCode'));
  adres.ele('AdresL1').txt(requireText(invoice.seller.address.addressLine1, 'seller.address.addressLine1'));
  if (invoice.seller.address.addressLine2) {
    adres.ele('AdresL2').txt(invoice.seller.address.addressLine2);
  }
  if (invoice.seller.address.gln) {
    adres.ele('GLN').txt(invoice.seller.address.gln);
  }

  if (invoice.seller.email || invoice.seller.phone) {
    const kontakt = podmiot1.ele('DaneKontaktowe');
    if (invoice.seller.email) kontakt.ele('Email').txt(invoice.seller.email);
    if (invoice.seller.phone) kontakt.ele('Telefon').txt(invoice.seller.phone);
  }
}

// ═══════════════════════════════════════════════════════════════
// <Podmiot2> – nabywca
// ═══════════════════════════════════════════════════════════════

function buildPodmiot2(
  root: XMLBuilder,
  invoice: Invoice,
): void {
  const podmiot2 = root.ele('Podmiot2');

  const daneId = podmiot2.ele('DaneIdentyfikacyjne');
  buildBuyerChoice(daneId, invoice.buyer);
  // Nazwa jest obowiązkowa dla B2B; dla faktur "uproszczonych" (art. 106e ust. 5 pkt 3)
  // można ją pominąć, ale MVP wymaga jej zawsze – validateInvoice to egzekwuje.
  daneId.ele('Nazwa').txt(requireText(invoice.buyer.name, 'buyer.name'));

  const adres = podmiot2.ele('Adres');
  adres.ele('KodKraju').txt(requireText(invoice.buyer.address.countryCode, 'buyer.address.countryCode'));
  adres.ele('AdresL1').txt(requireText(invoice.buyer.address.addressLine1, 'buyer.address.addressLine1'));
  if (invoice.buyer.address.addressLine2) {
    adres.ele('AdresL2').txt(invoice.buyer.address.addressLine2);
  }
  if (invoice.buyer.address.gln) {
    adres.ele('GLN').txt(invoice.buyer.address.gln);
  }

  if (invoice.buyer.email) {
    podmiot2.ele('DaneKontaktowe').ele('Email').txt(invoice.buyer.email);
  }

  // JST i GV są OBLIGATORYJNE w XSD Podmiot2 (brak minOccurs=0) – domyślnie 2.
  podmiot2.ele('JST').txt(String(invoice.buyer.jst ?? 2));
  podmiot2.ele('GV').txt(String(invoice.buyer.gv ?? 2));
}

function buildBuyerChoice(daneId: XMLBuilder, buyer: BuyerParty): void {
  if (buyer.nip) {
    daneId.ele('NIP').txt(buyer.nip);
  } else if (buyer.vatUeNumber) {
    const { kodUE, numer } = splitVatUe(buyer.vatUeNumber);
    daneId.ele('KodUE').txt(kodUE);
    daneId.ele('NrVatUE').txt(numer);
  } else if (buyer.pesel?.trim()) {
    // FA(3) Podmiot2 NIE ma elementu NrPESEL (bug naprawiony w audycie
    // przedlaunchowym). Schemat dopuszcza tylko: NIP / KodUE+NrVatUE /
    // KodKraju+NrID / BrakID. PESEL jest poprawnym identyfikatorem podatkowym,
    // który wstawiamy do <NrID> z <KodKraju>PL.
    daneId.ele('KodKraju').txt(buyer.address?.countryCode || 'PL');
    daneId.ele('NrID').txt(buyer.pesel.trim());
  } else if (buyer.nrInny?.trim()) {
    // „Inny" identyfikator (nr dokumentu / zagraniczny ID) → KodKraju + NrID.
    daneId.ele('KodKraju').txt(buyer.address?.countryCode || 'PL');
    daneId.ele('NrID').txt(buyer.nrInny.trim());
  } else if (buyer.noIdMarker) {
    daneId.ele('BrakID').txt('1');
  } else {
    // validateInvoice powinno to złapać wcześniej, ale to safety-net.
    throw new Error(
      'FA(3): nabywca musi mieć dokładnie jeden identyfikator (nip / vatUeNumber / PESEL / NrInny / noIdMarker).',
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// <Fa> – właściwa treść faktury
// ═══════════════════════════════════════════════════════════════

function buildFa(
  root: XMLBuilder,
  invoice: Invoice,
): void {
  const fa = root.ele('Fa');

  fa.ele('KodWaluty').txt(invoice.payment.currency);
  fa.ele('P_1').txt(formatDate(invoice.issueDate));
  // P_1M (miejsce wystawienia) – pomijamy w MVP.
  fa.ele('P_2').txt(requireText(invoice.internalNumber, 'internalNumber'));

  // P_6 jest w XSD <choice> z OkresFa – wrzucamy P_6 tylko jeśli podane.
  if (invoice.saleDate) {
    fa.ele('P_6').txt(formatDate(invoice.saleDate));
  }

  // Sumy per stawka w kolejności XSD-sequence.
  buildVatSummaries(fa, invoice.lines);

  // Suma brutto faktury (P_15 jest obowiązkowe).
  const totals = calculateInvoiceTotals(invoice.lines);
  fa.ele('P_15').txt(formatDecimal(totals.grossTotal));

  // Adnotacje są obowiązkowe w XSD <Fa> (brak minOccurs=0).
  buildAdnotacje(fa, invoice);

  fa.ele('RodzajFaktury').txt(invoice.type);

  buildFakturaDoParagonu(fa, invoice);

  for (const line of invoice.lines) {
    buildFaWiersz(fa, line);
  }

  buildPlatnosc(fa, invoice);
}

function buildVatSummaries(fa: XMLBuilder, lines: InvoiceLineItem[]): void {
  const summaries = summarizeVatPerRate(lines);

  // Zbieramy wszystkie emisje, a potem iterujemy w kolejności XSD.
  const emissions = new Map<string, { netElement: string; vatElement?: string; netSum: number; vatSum: number }>();

  for (const s of summaries) {
    const mapping = VAT_RATE_MAP[s.rate];
    if (!mapping) {
      throw new Error(`FA(3): brak mapowania XSD dla stawki VAT "${s.rate}".`);
    }
    emissions.set(mapping.netElement, {
      netElement: mapping.netElement,
      vatElement: mapping.vatElement,
      netSum: s.netSum,
      vatSum: s.vatSum,
    });
  }

  for (const elementName of P_13_ORDER) {
    const em = emissions.get(elementName);
    if (!em) continue;
    fa.ele(em.netElement).txt(formatDecimal(em.netSum));
    if (em.vatElement) {
      fa.ele(em.vatElement).txt(formatDecimal(em.vatSum));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// <Adnotacje>
// ═══════════════════════════════════════════════════════════════

function buildAdnotacje(
  fa: XMLBuilder,
  invoice: Invoice,
): void {
  const adn = fa.ele('Adnotacje');
  const a = invoice.annotations ?? {};

  // P_16 - metoda kasowa
  adn.ele('P_16').txt(String(a.cashMethod ?? 2));
  // P_17 - samofakturowanie
  adn.ele('P_17').txt(String(a.selfInvoicing ?? 2));

  // P_18 - odwrotne obciążenie. Jeśli którakolwiek pozycja ma vatRate='oo'
  // albo 'np_ii' (usługa z art. 28b — VAT rozlicza nabywca z UE; XSD P_18:
  // „obowiązanym do rozliczenia podatku … jest nabywca”, AUD-70), wymuszamy 1
  // niezależnie od tego co user podał (spójność z liniami faktury).
  const hasReverseChargeLine = invoice.lines.some(
    (l) => l.vatRate === 'oo' || l.vatRate === 'np_ii',
  );
  const p18 = hasReverseChargeLine ? 1 : (a.reverseCharge ?? 2);
  adn.ele('P_18').txt(String(p18));

  // P_18A - MPP
  adn.ele('P_18A').txt(String(a.splitPayment ?? 2));

  // Zwolnienie – choice (XSD): (P_19=1 + jedno z P_19A|B|C) LUB P_19N=1.
  // Stawka 'zw' → P_19 + P_19A (przepis ustawy) z ustawień firmy.
  // Brak podstawy odrzuca validateInvoice wcześniej, z komunikatem dla
  // człowieka; tu tylko bezpiecznik.
  const hasZwLine = invoice.lines.some((l) => l.vatRate === 'zw');
  const zwolnienie = adn.ele('Zwolnienie');
  if (hasZwLine) {
    const basis = a.vatExemptionBasis?.trim();
    if (!basis) {
      throw new InvoiceValidationError([ZW_WITHOUT_BASIS_MESSAGE]);
    }
    zwolnienie.ele('P_19').txt('1');
    // C5b: rodzaj podstawy z importu KSeF (P_19B dyrektywa, P_19C inna); brak = P_19A.
    zwolnienie.ele(a.vatExemptionBasisKind ?? 'P_19A').txt(basis);
  } else {
    zwolnienie.ele('P_19N').txt('1');
  }

  // NoweSrodkiTransportu – choice: (P_22 + P_42_5 + NowySrodekTransportu) LUB P_22N
  // MVP zawsze P_22N=1. Faktura z importu KSeF z P_22 (C5b) nie może wyjść
  // jako „nie dotyczy” — FaktWay nie wystawia dostaw nowych środków transportu.
  if (a.newMeansOfTransport === 1) {
    throw new InvoiceValidationError([
      'FaktWay nie wystawia faktur dostawy nowych środków transportu (P_22) — tej faktury nie da się utworzyć w FaktWay z oryginału KSeF.',
    ]);
  }
  adn.ele('NoweSrodkiTransportu').ele('P_22N').txt('1');

  // P_23 - procedura uproszczona
  adn.ele('P_23').txt(String(a.simplifiedProcedure ?? 2));

  // PMarzy – choice: (P_PMarzy + P_PMarzy_*) LUB P_PMarzyN. Procedura marży
  // z importu KSeF (C5b) — FaktWay jej nie wystawia, więc odmowa, nie P_PMarzyN.
  if (a.marginScheme) {
    throw new InvoiceValidationError([
      `FaktWay nie wystawia faktur w procedurze marży (${a.marginScheme}) — tej faktury nie da się utworzyć w FaktWay z oryginału KSeF.`,
    ]);
  }
  adn.ele('PMarzy').ele('P_PMarzyN').txt('1');
}

// ═══════════════════════════════════════════════════════════════
// <FP> i <DodatkowyOpis>: faktura do paragonu (krok 1.2)
// ═══════════════════════════════════════════════════════════════

/**
 * Faktura do paragonu. XSD `Fa`: po `RodzajFaktury` (i danych korekty, których
 * zwykła faktura nie ma) idą kolejno `FP`, `TP`, `DodatkowyOpis`, potem
 * `FaWiersz`. `FP` (etd:TWybor1) = „Faktura, o której mowa w art. 109 ust. 3d
 * ustawy”, wartość „1”. Dane paragonu z art. 106h ust. 1 (numer dokumentu
 * i numer unikatowy kasy) oraz data paragonu w `DodatkowyOpis` (klucz-wartość,
 * po 256 znaków), żeby zostały w KSeF razem z fakturą.
 *
 * Reguły FP sprawdza `validateInvoice` (`lib/invoices/receipt-invoice.ts`);
 * tu tylko bezpiecznik przy `validate: false`: paragon wyłącznie przy VAT.
 */
function buildFakturaDoParagonu(fa: XMLBuilder, invoice: Invoice): void {
  const receipt = invoice.receipt;
  if (!receipt) return;
  if (invoice.type !== 'VAT') {
    throw new InvoiceValidationError([RECEIPT_ONLY_REGULAR_MESSAGE]);
  }
  fa.ele('FP').txt('1');
  const entries: Array<[string, string]> = [
    [RECEIPT_XML_KEYS.receiptNumber, requireText(receipt.receiptNumber?.trim(), 'receipt.receiptNumber')],
    [RECEIPT_XML_KEYS.receiptDate, formatDate(receipt.receiptDate)],
    [RECEIPT_XML_KEYS.cashRegisterNumber, requireText(receipt.cashRegisterNumber, 'receipt.cashRegisterNumber')],
  ];
  for (const [klucz, wartosc] of entries) {
    const opis = fa.ele('DodatkowyOpis');
    opis.ele('Klucz').txt(klucz);
    opis.ele('Wartosc').txt(wartosc);
  }
}

// ═══════════════════════════════════════════════════════════════
// <FaWiersz>
// ═══════════════════════════════════════════════════════════════

function buildFaWiersz(
  fa: XMLBuilder,
  line: InvoiceLineItem,
): void {
  const wiersz = fa.ele('FaWiersz');

  wiersz.ele('NrWierszaFa').txt(String(line.ordinal));

  // Kolejność z XSD (typ FaWiersz): NrWierszaFa, UU_ID, P_6A, P_7, Indeks,
  // GTIN, PKWiU, CN, PKOB, P_8A… Klasyfikacja stoi więc po nazwie (P_7),
  // a przed jednostką (P_8A); przed P_7 plik nie przechodził XSD.
  wiersz.ele('P_7').txt(requireText(line.name, `line[${line.ordinal}].name`));

  // Klasyfikacja – GTIN dla 8-14 cyfr, CN dla 8-10 cyfr z literami,
  // PKWiU dla innych. MVP: ograniczamy do GTIN vs PKWiU (fallback).
  if (line.classificationCode) {
    if (/^\d{8,14}$/.test(line.classificationCode)) {
      wiersz.ele('GTIN').txt(line.classificationCode);
    } else if (/^\d{4,10}$/.test(line.classificationCode)) {
      // CN jest numeryczny, 8 cyfr – ale XSD akceptuje tns:TZnakowy50.
      wiersz.ele('CN').txt(line.classificationCode);
    } else {
      wiersz.ele('PKWiU').txt(line.classificationCode);
    }
  }

  // P_8A (jednostka) i P_8B (ilość) muszą być po klasyfikacji.
  wiersz.ele('P_8A').txt(requireText(line.unit, `line[${line.ordinal}].unit`));
  wiersz.ele('P_8B').txt(formatDecimal(line.quantity, 4));

  wiersz.ele('P_9A').txt(formatDecimal(line.unitPriceNet, 4));
  wiersz.ele('P_11').txt(formatDecimal(line.netAmount));

  const mapping = VAT_RATE_MAP[line.vatRate];
  if (!mapping) {
    throw new Error(
      `FA(3): brak mapowania P_12 dla vatRate "${line.vatRate}" w linii ${line.ordinal}.`,
    );
  }
  wiersz.ele('P_12').txt(mapping.p12Value);
}

// ═══════════════════════════════════════════════════════════════
// <Platnosc>
// ═══════════════════════════════════════════════════════════════

function buildPlatnosc(
  fa: XMLBuilder,
  invoice: Invoice,
): void {
  const platnosc = fa.ele('Platnosc');

  // XSD sequence: (Zaplacono|ZaplataCzesciowa)? → TerminPlatnosci* → FormaPlatnosci? → RachunekBankowy*
  // MVP: TerminPlatnosci zawsze, FormaPlatnosci według payment.method, RachunekBankowy dla transfer.

  platnosc.ele('TerminPlatnosci').ele('Termin').txt(formatDate(invoice.payment.dueDate));

  if (invoice.payment.method === 'other') {
    platnosc.ele('PlatnoscInna').txt('1');
    platnosc.ele('OpisPlatnosci').txt('inna');
  } else {
    const code = PAYMENT_METHOD_MAP[invoice.payment.method];
    platnosc.ele('FormaPlatnosci').txt(code);
  }

  if (invoice.payment.bankAccount) {
    // XSD TRachunekBankowy zawiera m.in. NrRB (wymagane) i opcjonalne inne pola;
    // MVP emituje tylko NrRB i NazwaBanku.
    // NrRB jest typu tns:TNrRB – KSeF oczekuje 26 cyfr (IBAN bez prefiksu PL),
    // ale akceptuje też format IBAN. Normalizujemy spacje.
    const iban = normalizeIban(invoice.payment.bankAccount);
    const nrRb = iban.startsWith('PL') ? iban.slice(2) : iban;
    const rachunek = platnosc.ele('RachunekBankowy');
    rachunek.ele('NrRB').txt(nrRb);
    if (invoice.payment.bankName) {
      rachunek.ele('NazwaBanku').txt(invoice.payment.bankName);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// <Stopka>
// ═══════════════════════════════════════════════════════════════

function buildStopka(
  root: XMLBuilder,
  invoice: Invoice,
): void {
  if (!invoice.notes) return;
  const stopka = root.ele('Stopka');
  stopka.ele('Informacje').ele('StopkaFaktury').txt(invoice.notes);
}
