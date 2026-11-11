// lib/exports/csv-generators.ts
// Generatory CSV dla: Insert Subiekt (Win-1250), Symfonia (UTF-8), Wapro Mag (UTF-8)

import Papa from 'papaparse';
import iconv from 'iconv-lite';
import { amountsOf, counterpartyOf, type ExportParty, type JpkInvoice } from './jpk-fa-generator';

export interface CsvExportInput {
  issuer: { nip: string; name: string };
  periodStart: string;
  periodEnd: string;
  issuedInvoices: JpkInvoice[];
  receivedInvoices: JpkInvoice[];
}

/**
 * Tekst, który Excel wykonałby jak formułę (AUD-60): `=`, `+`, `@`, tabulator,
 * CR albo `-`, za którym nie stoi sama liczba. PapaParse poprzedza taki tekst
 * apostrofem. Kwoty ujemne („-200,00” z korekt) zostają liczbami — domyślny
 * wzorzec PapaParse zamieniłby je w tekst i zepsuł import.
 */
const FORMULA_START = /^[=+@\t\r]|^-(?![\d\s.,]*$)/;

/**
 * Początek każdej odmowy CSV. Job eksportu pokazuje klientowi odmowę po tym
 * początku (F12-E2b), a Centrum eksportu wyciąga z niej numer faktury
 * (`components/exports/export-fixes.ts`, ten sam napis pilnuje test).
 */
export const CSV_REFUSAL_PREFIX = 'Eksport CSV wstrzymany:';

/** Wyjście z odmowy: plik bez dnia tej faktury, a sama faktura ręcznie. */
const WYJSCIE_ODMOWY =
  'Wyeksportuj zakresy dat bez dnia tej faktury, a samą fakturę wpisz w programie księgowym ręcznie. W razie pytań napisz do nas przez Pomoc.';

/**
 * Faktura, której waluta nie jest PLN. Z numerem (F12-E6), bo jedna taka
 * faktura wstrzymuje cały plik; bez numeru zostaje treść ogólna.
 */
export class CsvForeignCurrencyNotSupportedError extends Error {
  constructor(invoiceNumber?: string, currency?: string | null) {
    const waluta = currency?.trim().toUpperCase();
    super(
      invoiceNumber
        ? `${CSV_REFUSAL_PREFIX} faktura ${invoiceNumber} ${waluta ? `jest w walucie ${waluta}` : 'jest bez podanej waluty'}, ` +
            'a plik CSV ma kwoty tylko w złotych. Kwot tej faktury w złotych FaktWay nie wylicza bez jej pliku XML. ' +
            WYJSCIE_ODMOWY
        : `${CSV_REFUSAL_PREFIX} faktura walutowa wymaga uzgodnienia kwot PLN z XML.`,
    );
    this.name = 'CsvForeignCurrencyNotSupportedError';
  }
}

/**
 * F12-E2: faktura, której CSV nie może uczciwie wykazać (FP albo kwoty
 * nieznane z importu). Rozszerza błąd walutowy, żeby job traktował ją tak samo
 * (bez ponowień).
 */
export class CsvDocumentNotSupportedError extends CsvForeignCurrencyNotSupportedError {
  constructor(invoiceNumber: string, reason: string) {
    super();
    this.message = `${CSV_REFUSAL_PREFIX} faktura ${invoiceNumber} ${reason}`;
    this.name = 'CsvDocumentNotSupportedError';
  }
}

// ============================================================================
// Insert Subiekt GT
// Separator: ;   Encoding: Windows-1250   Bez BOM
// Kolumny: Numer;Data;Klient;NIP;Netto;VAT;Brutto;Typ
// ============================================================================

export function generateInsertSubiektCsv(data: CsvExportInput): Buffer {
  const invoices = allInvoices(data);

  const rows = invoices.map(({ inv, party, totals }) => ({
    Numer: inv.invoiceNumber,
    Data: formatPlDate(inv.issueDate),
    Klient: party.name,
    NIP: partyTaxId(party),
    Netto: totals.net.toFixed(2).replace('.', ','),
    VAT: totals.vat.toFixed(2).replace('.', ','),
    Brutto: totals.gross.toFixed(2).replace('.', ','),
    Typ: mapInvoiceTypeSubiekt(inv.invoiceType),
    ...(inv.ksefNumber ? { KSeF: inv.ksefNumber } : {}),
  }));

  const csv = Papa.unparse(rows, { delimiter: ';', newline: '\r\n', escapeFormulae: FORMULA_START });

  // Insert Subiekt wymaga Windows-1250 dla polskich znaków
  return iconv.encode(csv, 'win1250');
}

// ============================================================================
// Symfonia Handel / Faktura
// Separator: ;   Encoding: UTF-8 + BOM   Linia nagłówkowa po polsku
// ============================================================================

export function generateSymfoniaCsv(data: CsvExportInput): Buffer {
  const invoices = allInvoices(data);

  const rows = invoices.map(({ inv, party, totals }, idx) => ({
    'Lp.': idx + 1,
    NumerDokumentu: inv.invoiceNumber,
    DataWystawienia: formatPlDate(inv.issueDate),
    DataSprzedazy: formatPlDate(inv.saleDate ?? inv.issueDate),
    Kontrahent: party.name,
    NIP: partyTaxId(party),
    Adres: party.address ?? '',
    WartoscNetto: totals.net.toFixed(2).replace('.', ','),
    WartoscVAT: totals.vat.toFixed(2).replace('.', ','),
    WartoscBrutto: totals.gross.toFixed(2).replace('.', ','),
    Waluta: 'PLN',
    TerminPlatnosci: inv.paymentDueDate
      ? formatPlDate(inv.paymentDueDate)
      : '',
    RodzajDokumentu: mapInvoiceTypeSymfonia(inv.invoiceType),
    NumerKSeF: inv.ksefNumber ?? '',
    FakturaKorygowana: inv.correctedInvoiceNumber ?? '',
  }));

  const csv = Papa.unparse(rows, { delimiter: ';', newline: '\r\n', escapeFormulae: FORMULA_START });

  // UTF-8 BOM (Symfonia rozpoznaje BOM jako marker UTF-8)
  const bom = Buffer.from('\ufeff', 'utf8');
  return Buffer.concat([bom, Buffer.from(csv, 'utf8')]);
}

// ============================================================================
// Wapro Mag / Fakturowanie
// Separator: \t   Encoding: UTF-8 + BOM
// ============================================================================

export function generateWaproCsv(data: CsvExportInput): Buffer {
  const invoices = allInvoices(data);

  const rows = invoices.map(({ inv, party, totals }, idx) => ({
    lp: idx + 1,
    numer: inv.invoiceNumber,
    data: formatPlDate(inv.issueDate),
    data_sprzedazy: formatPlDate(inv.saleDate ?? inv.issueDate),
    nabywca: party.name,
    nip: partyTaxId(party),
    adres: party.address ?? '',
    netto: totals.net.toFixed(2).replace('.', ','),
    vat: totals.vat.toFixed(2).replace('.', ','),
    brutto: totals.gross.toFixed(2).replace('.', ','),
    waluta: 'PLN',
    termin_platnosci: inv.paymentDueDate
      ? formatPlDate(inv.paymentDueDate)
      : '',
    rodzaj: mapInvoiceTypeWapro(inv.invoiceType),
    ksef: inv.ksefNumber ?? '',
  }));

  const csv = Papa.unparse(rows, { delimiter: '\t', newline: '\r\n', escapeFormulae: FORMULA_START });

  const bom = Buffer.from('\ufeff', 'utf8');
  return Buffer.concat([bom, Buffer.from(csv, 'utf8')]);
}

// ============================================================================
// CSV uniwersalny (rozdzielnik `;`, UTF-8 z BOM)

export function generateUniversalCsv(data: CsvExportInput): Buffer {
  const invoices = allInvoices(data);

  const rows = invoices.map(({ inv, party, totals }, idx) => ({
    Lp: idx + 1,
    Numer: inv.invoiceNumber,
    DataWystawienia: formatPlDate(inv.issueDate),
    Kontrahent: party.name,
    NIP: partyTaxId(party),
    Netto: totals.net.toFixed(2).replace('.', ','),
    VAT: totals.vat.toFixed(2).replace('.', ','),
    Brutto: totals.gross.toFixed(2).replace('.', ','),
    Waluta: 'PLN',
    Rodzaj: mapInvoiceTypeSubiekt(inv.invoiceType),
    KSeF: inv.ksefNumber ?? '',
  }));

  const csv = Papa.unparse(rows, { delimiter: ';', newline: '\r\n', escapeFormulae: FORMULA_START });
  const bom = Buffer.from('\ufeff', 'utf8');
  return Buffer.concat([bom, Buffer.from(csv, 'utf8')]);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Faktury z KONTRAHENTEM wg kierunku: sprzedaż → nabywca, zakup → sprzedawca.
 * Do 26.09 zakupy miały tu nabywcę, czyli naszą firmę.
 */
function allInvoices(
  data: CsvExportInput,
): Array<{ inv: JpkInvoice; party: ExportParty; totals: DocumentTotals }> {
  const invoices = [
    ...data.issuedInvoices.map((inv) => ({ inv, party: counterpartyOf(inv, 'issued'), totals: issuedTotals(inv) })),
    ...data.receivedInvoices.map((inv) => ({
      inv,
      party: counterpartyOf(inv, 'received'),
      totals: { net: inv.netTotal, vat: inv.vatTotal, gross: inv.grossTotal },
    })),
  ];
  // Każdy format CSV poniżej zakłada PLN; metadane KSeF mają przy obcej
  // walucie netto/brutto w walucie dokumentu, ale VAT w PLN. Nie wolno
  // oznaczyć takiego wiersza jako PLN ani wyeksportować mieszanych jednostek.
  const walutowa = invoices.find(({ inv }) => inv.currency?.trim().toUpperCase() !== 'PLN');
  if (walutowa) {
    throw new CsvForeignCurrencyNotSupportedError(walutowa.inv.invoiceNumber, walutowa.inv.currency);
  }
  // F12-E2: sprzedaż z faktury do paragonu (art. 109 ust. 3d ustawy o VAT)
  // weszła już raportem z kasy, a formaty CSV nie mają oznaczenia FP: zwykły
  // wiersz policzyłby ją drugi raz. KPiR i ewidencja ryczałtu pomijają FP
  // z adnotacją, JPK_FA odmawia. FP po stronie zakupu to zwykły koszt.
  for (const inv of data.issuedInvoices) {
    if (inv.ksefMarkers?.fp) {
      throw new CsvDocumentNotSupportedError(
        inv.invoiceNumber,
        'jest fakturą do paragonu (FP). Jej sprzedaż weszła już raportem z kasy, więc w pliku CSV policzyłaby się drugi raz razem z VAT. ' +
          `${WYJSCIE_ODMOWY} Fakturę do paragonu wpisuje się z oznaczeniem FP.`,
      );
    }
  }
  // Kwoty nieznane z importu to nie 0,00 (FaktWay nie wpisze za nie zer).
  for (const { inv } of invoices) {
    if (inv.importedTotalsUnknown) {
      throw new CsvDocumentNotSupportedError(
        inv.invoiceNumber,
        `została zaimportowana z KSeF bez sum netto i VAT, więc FaktWay nie zna jej kwot. Kwoty weź z oryginału w KSeF. ${WYJSCIE_ODMOWY}`,
      );
    }
  }
  return invoices.sort((a, b) => a.inv.issueDate.localeCompare(b.inv.issueDate));
}

interface DocumentTotals {
  net: number;
  vat: number;
  gross: number;
}

/**
 * Identyfikator kontrahenta w kolumnie „NIP”: NIP, a nabywca z UE bez NIP-u
 * (AUD-70) — numer VAT-UE z prefiksem kraju, zamiast pustej komórki.
 */
function partyTaxId(party: ExportParty): string {
  return party.nip?.trim() || party.vatUe?.trim() || '';
}

/**
 * Kwoty wystawionej faktury tak, jak są na fakturze w KSeF. Faktura
 * rozliczeniowa (ROZ, art. 106f ust. 3): wartość i VAT po odjęciu zaliczek,
 * brutto = kwota pozostała do zapłaty (`amountsOf` — to samo co JPK_FA).
 * Do 29.09 CSV podawał pełną wartość zamówienia, więc po imporcie VAT zaliczek
 * był w rejestrze drugi raz.
 */
function issuedTotals(inv: JpkInvoice): DocumentTotals {
  if (inv.invoiceType !== 'final') return { net: inv.netTotal, vat: inv.vatTotal, gross: inv.grossTotal };
  const { rates, p15 } = amountsOf(inv);
  return {
    net: rates.reduce((s, r) => s + r.net, 0),
    vat: rates.reduce((s, r) => s + r.vat, 0),
    gross: p15,
  };
}

function formatPlDate(iso: string): string {
  if (!iso) return '';
  const day = iso.trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function mapInvoiceTypeSubiekt(type: JpkInvoice['invoiceType']): string {
  switch (type) {
    case 'correction':
      return 'KOREKTA';
    case 'advance':
      return 'ZALICZKOWA';
    case 'final':
      return 'ROZLICZENIOWA';
    default:
      return 'FAKTURA';
  }
}

function mapInvoiceTypeSymfonia(type: JpkInvoice['invoiceType']): string {
  switch (type) {
    case 'correction':
      return 'FK';
    case 'advance':
      return 'FZ';
    case 'final':
      return 'FR';
    default:
      return 'FS';
  }
}

function mapInvoiceTypeWapro(type: JpkInvoice['invoiceType']): string {
  switch (type) {
    case 'correction':
      return 'korekta';
    case 'advance':
      return 'zaliczka';
    case 'final':
      return 'rozliczenie';
    default:
      return 'faktura';
  }
}
