// lib/exports/jpk-fa-generator.ts
// Generator JPK_FA(4) — zgodny z oficjalnym XSD MF (wzór
// http://jpk.mf.gov.pl/wzor/2022/02/17/02171/, pliki w lib/exports/schemas/jpk-fa4/,
// walidacja: lib/exports/jpk-fa-validator.ts). Plik trzyma też wspólne typy
// eksportów (JpkInvoice, counterpartyOf) — importuje je siedem modułów.
//
// Do 28.09 generator nie przechodził schematu: brak obowiązkowych P_16–P_23
// i P_106E_2/3, wszystkie stawki w jednym P_13_1, elementy i atrybuty spoza
// wzoru (Adnotacje/NumerKSeF, NazwaSystemu, rola, poz, typ), zła przestrzeń
// nazw typów wspólnych, adres bez województwa/powiatu/gminy i faktury zakupu
// w pliku, który obejmuje faktury WYSTAWIONE przez podatnika.

import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces';

import { MissingIssuerAddressError, type RegisteredAddress } from '@/lib/exports/issuer-address';
import { MissingTaxOfficeError } from '@/lib/exports/tax-office';
import { isKnownTaxOffice } from '@/lib/exports/tax-offices';
import { REVERSE_CHARGE_RATES } from '@/lib/invoices/annotations';
import { parseVatUe } from '@/lib/invoices/vat-ue';
import {
  settlementVatSummaries,
  type AdvanceInvoiceSettlementRow,
} from '@/lib/ksef/fa3-advance-generator';
import { importedVatRateLabel } from '@/lib/xml/fa3-p12';
import type { KsefLineFields } from '@/lib/import/fa3-line-amounts';
import {
  annotationsJpkCannotExpress,
  exemptionMismatch,
  markersJpkCannotExpress,
  type ExemptionBasisKind,
  type Fa3Markers,
  type MarginScheme,
} from '@/lib/xml/fa3-annotations';
import { roundToCents, summarizeVatPerRate } from '@/lib/xml/invoice-calculator';
import { SUPPORT_EMAIL } from '@/lib/site';
import type { InvoiceLineItem, VatRate } from '@/types/invoice';

const TNS = 'http://jpk.mf.gov.pl/wzor/2022/02/17/02171/';
/** Typy wspólne, które importuje JPK_FA(4) — wersja 2018/08/24, nie nowsza. */
const ETD = 'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2018/08/24/eD/DefinicjeTypy/';

export interface JpkFaInputData {
  // Wystawca (tenant)
  issuer: {
    nip: string;
    name: string;
    /**
     * Kod Urzędu Skarbowego (KodUrzedu w JPK_FA) — `tenants.tax_office_code`
     * (Ustawienia → Księgowa). Brak albo kod spoza słownika MF → błąd
     * `MissingTaxOfficeError` (zob. `resolveTaxOfficeCode`).
     */
    taxOfficeCode?: string;
    /** Adres z danych firmy (dwie linie) — P_3D, gdy faktura nie zapisała adresu sprzedawcy. */
    address?: {
      country?: string;
      city?: string;
      postCode?: string;
      street?: string;
      buildingNumber?: string;
      apartmentNumber?: string;
    };
    /**
     * Adres z rejestru GUS — `Podmiot1/AdresPodmiotu` (`readIssuerRegisteredAddress`).
     * Brak → `MissingIssuerAddressError`: schemat wymaga województwa, powiatu i gminy.
     */
    registeredAddress?: RegisteredAddress;
  };

  // Okres
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;

  /** Faktury WYSTAWIONE przez podatnika — tylko one wchodzą do JPK_FA. */
  issuedInvoices: JpkInvoice[];

  /** Chwila wytworzenia pliku — do testów; domyślnie teraz. */
  generatedAt?: Date;
}

export interface JpkInvoice {
  invoiceNumber: string;
  /** Waluta kwot dokumentu; brak w starych ręcznie budowanych danych oznacza PLN. */
  currency?: string | null;
  invoiceType: 'regular' | 'correction' | 'advance' | 'final';
  /**
   * Rodzaj z pliku KSeF dokumentu z importu zapisanego jako zwykły (import nie
   * zna powiązań korekty, zaliczek, ROZ — W9). JPK go nie wykaże poprawnie.
   */
  importedDocumentType?: 'KOR' | 'ZAL' | 'ROZ';
  /** Faktura z importu historii KSeF (`origin = ksef_import`) — pozycje z parsera, nie z FaktWay. */
  importedFromKsef?: boolean;
  /**
   * C5b: faktura z importu historii bez odczytanych adnotacji (`fa3_data.annotations`
   * brak — import sprzed C5b). Ponowny import uzupełnia je z oryginału.
   */
  importedAnnotationsMissing?: boolean;
  /** C5b: adnotacje / oznaczenia z pliku KSeF, których import nie odczytał. */
  importedAnnotationProblems?: string[];
  /** C5b: pozycje z różnymi datami sprzedaży (P_6A) albo data nieczytelna — JPK ma jedną datę dokumentu. */
  importedSaleDateUnclear?: boolean;
  /** C5c: kwoty pozycji z pliku KSeF, których import nie przeniósł wiernie (`fa3_data.lineAmountProblems`). */
  importedLineAmountProblems?: string[];
  /** C5c: plik nie podaje sum stawek — netto i VAT faktury nieznane (KPiR i CSV też ich nie znają). */
  importedTotalsUnknown?: boolean;
  /** C5b: FP, TP, podmiot upoważniony, GTU, Procedura z pliku KSeF (`fa3_data.ksefMarkers`). */
  ksefMarkers?: Fa3Markers;
  issueDate: string;
  saleDate?: string;
  paymentDueDate?: string;

  // Strony — OBIE. Kontrahentem sprzedaży jest nabywca, zakupu — sprzedawca
  // (`counterpartyOf`). Do 26.09 była tylko strona nabywcy, więc przy
  // zakupach „kontrahentem” wychodziła nasza firma.
  buyerNip?: string;
  /**
   * Numer VAT-UE nabywcy z innego państwa UE z prefiksem kraju (np.
   * `DE123456789`) — gdy nabywca nie ma NIP-u (AUD-70). JPK_FA: P_5A + P_5B,
   * JPK_V7M: KodKrajuNadaniaTIN + NrKontrahenta, CSV: kolumna identyfikatora.
   */
  buyerVatUe?: string;
  buyerName: string;
  buyerAddress?: string;
  sellerNip?: string;
  /** Pusty przy sprzedaży bez `seller_data` — wtedy sprzedawcą jest wystawca pliku. */
  sellerName?: string;
  sellerAddress?: string;

  // Kwoty (sumaryczne)
  netTotal: number;
  vatTotal: number;
  grossTotal: number;

  // Pozycje
  lines: JpkInvoiceLine[];

  // Korekty
  correctedInvoiceNumber?: string;
  correctionReason?: string;

  // Numer KSeF (informacyjnie)
  ksefNumber?: string;

  /** ROZ: suma netto rozliczonych zaliczek, które KPiR już liczy (`kpirRevenueNet`). */
  settledAdvancesNet?: number;

  /** Adnotacje z `fa3_data.annotations` — P_16 (metoda kasowa), P_18A (MPP), P_19A (podstawa zwolnienia). */
  annotations?: JpkInvoiceAnnotations;

  /** ROZ: zaliczki ze stawką i rozbiciem — P_13/P_14/P_15 po ich odjęciu i NrFaZaliczkowej. */
  advanceSettlement?: AdvanceInvoiceSettlementRow[];
}

export class JpkFaForeignCurrencyNotSupportedError extends Error {
  constructor() {
    super('JPK_FA wstrzymany: faktura walutowa wymaga poprawnego wykazania waluty dokumentu i VAT w PLN. Przekaż ją księgowej do uzgodnienia.');
    this.name = 'JpkFaForeignCurrencyNotSupportedError';
  }
}

export interface JpkInvoiceAnnotations {
  splitPayment?: boolean;
  cashMethod?: boolean;
  vatExemptionBasis?: string;
  /** C5b: rodzaj podstawy z pliku KSeF — JPK_FA(4) ma P_19A, P_19B i P_19C. Brak = P_19A. */
  vatExemptionBasisKind?: ExemptionBasisKind;
  /** C5b: P_17 z pliku KSeF (FaktWay sam nie wystawia samofaktur). */
  selfInvoicing?: boolean;
  /** C5b: jawne P_18 z pliku KSeF; brak = z pozycji „oo” / „np_ii”. */
  reverseCharge?: boolean;
  /** C5b: P_23 z pliku KSeF — JPK odmawia (V7M bez TT_D). */
  simplifiedProcedure?: boolean;
  /** C5b: P_22 z pliku KSeF — JPK odmawia. */
  newMeansOfTransport?: boolean;
  /** C5b: procedura marży z pliku KSeF — JPK odmawia (V7M bez MR_T / MR_UZ). */
  marginScheme?: MarginScheme;
}

export interface ExportParty {
  name: string;
  nip?: string;
  /** Numer VAT-UE (z prefiksem kraju) kontrahenta z UE bez NIP-u — AUD-70. */
  vatUe?: string;
  address?: string;
}

/**
 * Druga strona dokumentu z perspektywy podatnika: przy sprzedaży nabywca,
 * przy zakupie sprzedawca. Wszystkie eksporty „z kontrahentem” (CSV, Optima)
 * idą przez tę funkcję.
 */
export function counterpartyOf(inv: JpkInvoice, direction: 'issued' | 'received'): ExportParty {
  if (direction === 'received') {
    return { name: inv.sellerName ?? '', nip: inv.sellerNip, address: inv.sellerAddress };
  }
  return { name: inv.buyerName, nip: inv.buyerNip, vatUe: inv.buyerVatUe, address: inv.buyerAddress };
}

export interface JpkInvoiceLine {
  position: number;
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet: number;
  netAmount: number;
  vatRate: string; // '23', '8', '5', '0', 'zw', 'oo', 'np', 'np_ii'
  /** VAT pozycji z faktury — P_14_x musi się zgadzać z fakturą co do grosza. */
  vatAmount?: number;
  /**
   * C5c: pola pozycji z pliku KSeF (import historii). FakturaWiersz zapisuje
   * je zamiast wyliczonych — przy cenach brutto P_9B/P_11A, nie nasze netto.
   */
  ksefFields?: Omit<KsefLineFields, 'ordinal'>;
}

/**
 * Korekta w JPK_FA to „kwota różnicy” (P_13_x/P_14_x/P_15), a korekta w bazie
 * zapisuje wartość PO korekcie, nie różnicę (C-01 w
 * `docs/koordynacja/CLAUDE-DO-CODEXA.md`). Zamiast pliku ze złymi kwotami —
 * odmowa, dopóki konwencja kwot korekty nie jest ustalona.
 */
export class JpkFaCorrectionNotSupportedError extends Error {
  constructor() {
    super(
      'W okresie jest faktura korygująca — JPK_FA z korektami jeszcze nie działa (kwoty korekty w bazie nie pozwalają policzyć różnicy wymaganej w pliku). Wygeneruj KPiR albo CSV, a korekty przekaż księgowej osobno.',
    );
    this.name = 'JpkFaCorrectionNotSupportedError';
  }
}

/** Początek każdej odmowy dokumentu — po nim job rozpoznaje powód dla człowieka. */
export const JPK_DOCUMENT_REFUSAL_PREFIX = 'JPK wstrzymany:';

const IMPORTED_TYPE_LABEL: Record<NonNullable<JpkInvoice['importedDocumentType']>, string> = {
  KOR: 'korygująca',
  ZAL: 'zaliczkowa',
  ROZ: 'rozliczeniowa',
};

/**
 * W9 (C5a): dokument, którego JPK (FA i V7M) nie wykaże poprawnie — faktura
 * z importu historii KSeF ze stawką bez odpowiednika w FaktWay („0 WDT”,
 * „0 EX”, „22”…, „nieznana”) albo zaimportowana korekta / zaliczka / ROZ.
 * Plik nie powstaje (lepiej niż sprzedaż pominięta albo w złym polu),
 * a komunikat nazywa dokument i mówi, co zrobić.
 */
export class JpkDocumentNotSupportedError extends Error {
  constructor(
    readonly invoiceNumber: string,
    readonly ksefNumber: string | undefined,
    reason: string,
    /** C5c: `false`, gdy KPiR i CSV też nie znają kwot tej faktury (plik bez sum stawek). */
    kpirCsvWork = true,
  ) {
    super(
      `${JPK_DOCUMENT_REFUSAL_PREFIX} faktura ${invoiceNumber}${ksefNumber ? ` (KSeF ${ksefNumber})` : ''} ${reason} ` +
        'Plik nie powstał, żeby nie pominąć ani nie pomylić tej sprzedaży — JPK za ten okres trzeba przygotować poza FaktWay ' +
        (kpirCsvWork
          ? '(KPiR i CSV z FaktWay działają).'
          : '— KPiR i CSV też nie pokażą poprawnych kwot tej faktury, wprowadźcie je ręcznie z księgową.'),
    );
    this.name = 'JpkDocumentNotSupportedError';
  }
}

function unsupportedRate(inv: JpkInvoice, rate: string): JpkDocumentNotSupportedError {
  const label = importedVatRateLabel(rate);
  return new JpkDocumentNotSupportedError(
    inv.invoiceNumber,
    inv.ksefNumber,
    `ma stawkę VAT „${rate}”${label ? ` (${label})` : ''}, której FaktWay jeszcze nie wykazuje w JPK.`,
  );
}

function unsupportedImportedType(inv: JpkInvoice, type: NonNullable<JpkInvoice['importedDocumentType']>): JpkDocumentNotSupportedError {
  return new JpkDocumentNotSupportedError(
    inv.invoiceNumber,
    inv.ksefNumber,
    `to zaimportowana z KSeF faktura ${IMPORTED_TYPE_LABEL[type]} — FaktWay nie zna jej powiązań (faktura pierwotna, zaliczki), więc nie wykaże jej poprawnie w JPK.`,
  );
}

// ============================================================================
// MAIN: generuje XML JPK_FA(4)
// ============================================================================

export function generateJpkFa(data: JpkFaInputData): string {
  // Najpierw to, co ustawia człowiek (urząd w ustawieniach), potem adres z GUS.
  const taxOffice = resolveTaxOfficeCode(data.issuer.taxOfficeCode);
  const address = data.issuer.registeredAddress;
  if (!address) throw new MissingIssuerAddressError();
  if (data.issuedInvoices.some((inv) => inv.invoiceType === 'correction')) {
    throw new JpkFaCorrectionNotSupportedError();
  }
  // Generator zapisuje KodWaluty=PLN i nie emituje P_14_*W dla VAT w PLN
  // na obcowalutowej fakturze. Do czasu pełnego mapowania odmawia pliku.
  if (data.issuedInvoices.some((inv) => inv.currency?.trim().toUpperCase() !== 'PLN')) {
    throw new JpkFaForeignCurrencyNotSupportedError();
  }
  if (data.issuedInvoices.length === 0) {
    // Schemat wymaga co najmniej jednej faktury — pusty okres job oznacza
    // jako „brak faktur”, zanim dojdzie tutaj.
    throw new Error('JPK_FA: brak faktur wystawionych w okresie.');
  }

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('JPK', {
    xmlns: TNS,
    'xmlns:etd': ETD,
  });

  buildHeader(root, data, taxOffice);
  buildIssuer(root, data.issuer.nip, data.issuer.name, address);

  const invoices = data.issuedInvoices.map((inv) => ({ inv, amounts: amountsOf(inv) }));
  for (const { inv, amounts } of invoices) buildFaktura(root, inv, amounts, data.issuer);

  const ctrl = root.ele('FakturaCtrl');
  ctrl.ele('LiczbaFaktur').txt(String(invoices.length));
  ctrl.ele('WartoscFaktur').txt(kwota(invoices.reduce((s, { amounts }) => s + amounts.p15, 0)));

  let lineCount = 0;
  let lineValue = 0;
  for (const inv of data.issuedInvoices) {
    for (const line of inv.lines) {
      buildFakturaWiersz(root, inv.invoiceNumber, line);
      lineCount += 1;
      // „Łączna wartość kolumny P_11” — przy polach z pliku KSeF tylko zapisane P_11 (C5c).
      lineValue += line.ksefFields ? (line.ksefFields.P_11 ?? 0) : line.netAmount;
    }
  }

  const wCtrl = root.ele('FakturaWierszCtrl');
  wCtrl.ele('LiczbaWierszyFaktur').txt(String(lineCount));
  wCtrl.ele('WartoscWierszyFaktur').txt(kwota(lineValue));

  return root.end({ prettyPrint: true });
}

// ============================================================================
// Nagłówek i podmiot
// ============================================================================

function buildHeader(root: XMLBuilder, data: JpkFaInputData, taxOffice: string): void {
  const n = root.ele('Naglowek');
  n.ele('KodFormularza', { kodSystemowy: 'JPK_FA (4)', wersjaSchemy: '1-0' }).txt('JPK_FA');
  n.ele('WariantFormularza').txt('4');
  // Schemat zna tylko cel „1” (złożenie na żądanie organu).
  n.ele('CelZlozenia').txt('1');
  n.ele('DataWytworzeniaJPK').txt((data.generatedAt ?? new Date()).toISOString());
  n.ele('DataOd').txt(data.periodStart);
  n.ele('DataDo').txt(data.periodEnd);
  n.ele('KodUrzedu').txt(taxOffice);
}

function buildIssuer(root: XMLBuilder, nip: string, name: string, a: RegisteredAddress): void {
  const p = root.ele('Podmiot1');
  const id = p.ele('IdentyfikatorPodmiotu');
  id.ele('NIP').txt(nip);
  id.ele('PelnaNazwa').txt(znaki(name));

  // Typ z typów wspólnych MF — elementy w przestrzeni `etd`.
  const adres = p.ele('AdresPodmiotu');
  adres.ele('etd:KodKraju').txt('PL');
  adres.ele('etd:Wojewodztwo').txt(a.voivodeship);
  adres.ele('etd:Powiat').txt(a.county);
  adres.ele('etd:Gmina').txt(a.commune);
  if (a.street) adres.ele('etd:Ulica').txt(a.street);
  adres.ele('etd:NrDomu').txt(a.buildingNumber);
  if (a.apartmentNumber) adres.ele('etd:NrLokalu').txt(a.apartmentNumber);
  adres.ele('etd:Miejscowosc').txt(a.city);
  adres.ele('etd:KodPocztowy').txt(a.postCode);
}

// ============================================================================
// Kwoty faktury
// ============================================================================

interface RateAmount {
  rate: string;
  net: number;
  vat: number;
}

interface InvoiceAmounts {
  rates: RateAmount[];
  p15: number;
}

interface RateField {
  net: string;
  vat?: string;
}

const RATE_FIELDS: Record<string, RateField> = {
  '23': { net: 'P_13_1', vat: 'P_14_1' },
  '8': { net: 'P_13_2', vat: 'P_14_2' },
  '5': { net: 'P_13_3', vat: 'P_14_3' },
  // Odwrotne obciążenie (art. 17 ust. 1 pkt 7 i 8) — P_14_4 jest w sekwencji
  // obowiązkowe, podatek rozlicza nabywca, więc 0.
  oo: { net: 'P_13_4', vat: 'P_14_4' },
  // Dostawa/usługa poza terytorium kraju — P_14_5 opcjonalne.
  np: { net: 'P_13_5' },
  // AUD-70: usługa z art. 100 ust. 1 pkt 4 to też „poza terytorium kraju”
  // (JPK_FA(4) nie ma osobnego pola jak FA(3) P_13_9). Netto sumowane z „np”
  // w jednym P_13_5 (`buildFaktura`), P_18 = true (`REVERSE_CHARGE_RATES`).
  np_ii: { net: 'P_13_5' },
  '0': { net: 'P_13_6' },
  zw: { net: 'P_13_7' },
};
const RATE_ORDER = ['23', '8', '5', 'oo', 'np', 'np_ii', '0', 'zw'];

/**
 * P_12 pozycji: enum JPK_FA(4) zna tylko „np” (maxLength 2, bez „np I”/„np II”
 * z FA(3)), więc „np_ii” idzie jako „np”.
 */
const P12_VALUE: Readonly<Record<string, string>> = { np_ii: 'np' };

/** Kwoty w stawkach i P_15 — jak na fakturze w KSeF (ROZ po odjęciu zaliczek). */
/**
 * W9: pozycje faktury z importu muszą sumować się do jej netto z KSeF —
 * inaczej (np. ceny brutto: P_11A bez P_11, netto pozycji = 0) sprzedaż po
 * cichu wypadłaby z pól stawek.
 */
export function importedLinesMismatch(inv: Pick<JpkInvoice, 'importedFromKsef' | 'netTotal' | 'vatTotal' | 'lines'>): boolean {
  if (!inv.importedFromKsef) return false;
  const sum = inv.lines.reduce((s, l) => s + (Number.isFinite(l.netAmount) ? l.netAmount : 0), 0);
  if (Math.abs(roundToCents(sum) - roundToCents(inv.netTotal)) > 0.01 * Math.max(1, inv.lines.length) + 0.01) return true;
  // C5c: VAT pozycji = VAT faktury co do grosza (JPK P_14_x i V7M K_20 z pozycji), liczony jak w `toLineItem`.
  const vat = inv.lines.reduce((s, l) => s + (l.vatAmount ?? roundToCents(l.netAmount * linePct(l.vatRate))), 0);
  return Math.abs(roundToCents(vat) - roundToCents(inv.vatTotal)) >= 0.005;
}

function linePct(vatRate: string): number {
  const rate = vatRate.trim().toLowerCase();
  return rate === '23' || rate === '8' || rate === '5' ? Number(rate) / 100 : 0;
}

/**
 * C5b: treść z pliku KSeF, której JPK FaktWay nie wykaże albo nie zna —
 * `null`, gdy nic nie stoi na przeszkodzie. Oznaczenia i procedury czytane
 * z faktów (każde pochodzenie wiersza); spójność zwolnienia — tylko import
 * (faktury FaktWay sprzed #60 nie mają podstawy w adnotacjach).
 */
function importedContentRefusal(inv: JpkInvoice): string | null {
  if (inv.importedAnnotationsMissing) {
    // Magiczny import wycofany (decyzja Bartosza 22.10.2026): uzupełnia to
    // synchronizacja historii KSeF (pozycja `repair_content`), bez akcji klienta.
    return `jest zaimportowana przed odczytem daty sprzedaży i adnotacji z pliku KSeF (metoda kasowa, MPP, zwolnienie, procedury). FaktWay uzupełnia te dane automatycznie z oryginału w KSeF (postęp: Import danych → Historia z KSeF). Jeśli faktura jest tam na liście faktur, których nie pobraliśmy, albo komunikat zostaje dłużej niż dobę, napisz na ${SUPPORT_EMAIL}.`;
  }
  if (inv.importedAnnotationProblems?.length) {
    return `ma w KSeF adnotacje, których import nie udało się odczytać (${inv.importedAnnotationProblems.join('; ')}) — FaktWay nie wie, czy dotyczy jej metoda kasowa, MPP albo procedura szczególna.`;
  }
  const cannot = [...annotationsJpkCannotExpress(inv.annotations), ...markersJpkCannotExpress(inv.ksefMarkers)];
  if (cannot.length) return `ma w KSeF oznaczenie, którego FaktWay nie wykazuje w JPK: ${cannot.join(', ')}.`;
  if (inv.importedFromKsef && inv.annotations !== undefined &&
      exemptionMismatch(inv.annotations, inv.lines.map((l) => l.vatRate))) {
    return 'ma zwolnienie z VAT (P_19) niezgodne ze stawkami pozycji, więc FaktWay nie wykaże jej poprawnie w JPK.';
  }
  if (inv.importedSaleDateUnclear) {
    return 'ma pozycje z różnymi datami sprzedaży (P_6A) albo nieczytelną datę sprzedaży, a JPK przyjmuje jedną datę sprzedaży dla dokumentu.';
  }
  return null;
}

export function amountsOf(inv: JpkInvoice): InvoiceAmounts {
  if (inv.importedDocumentType) throw unsupportedImportedType(inv, inv.importedDocumentType);
  const contentRefusal = importedContentRefusal(inv);
  if (contentRefusal) throw new JpkDocumentNotSupportedError(inv.invoiceNumber, inv.ksefNumber, contentRefusal);
  // Stawka przed kwotami (C5c): dokument ze stawką spoza FaktWay dostaje dokładny powód.
  const items = inv.lines.map((line) => toLineItem(line, inv));
  if (inv.importedFromKsef && inv.importedLineAmountProblems?.length) {
    throw new JpkDocumentNotSupportedError(
      inv.invoiceNumber,
      inv.ksefNumber,
      `ma kwoty pozycji, których FaktWay nie przeniesie wiernie z pliku KSeF (${inv.importedLineAmountProblems.join('; ')}), więc nie wykaże jej poprawnie w JPK.`,
      !inv.importedTotalsUnknown,
    );
  }
  if (importedLinesMismatch(inv)) {
    throw new JpkDocumentNotSupportedError(
      inv.invoiceNumber,
      inv.ksefNumber,
      'ma pozycje, których netto albo VAT nie sumuje się do sum faktury z KSeF, więc FaktWay nie wykaże jej poprawnie w JPK.',
      !inv.importedTotalsUnknown,
    );
  }
  const byRate =
    inv.invoiceType === 'final'
      ? settlementVatSummaries(items, inv.advanceSettlement ?? [])
      : summarizeVatPerRate(items);

  const rates = byRate
    .map((s) => ({ rate: String(s.rate), net: s.netSum, vat: s.vatSum }))
    .sort((a, b) => RATE_ORDER.indexOf(a.rate) - RATE_ORDER.indexOf(b.rate));

  const advancesGross = (inv.advanceSettlement ?? []).reduce((s, a) => s + roundToCents(a.advance_amount), 0);
  const p15 =
    inv.invoiceType === 'final'
      ? roundToCents(inv.grossTotal - advancesGross) // art. 106f ust. 3: kwota pozostała do zapłaty
      : roundToCents(inv.grossTotal);
  return { rates, p15 };
}

function toLineItem(line: JpkInvoiceLine, inv: JpkInvoice): InvoiceLineItem {
  const rate = line.vatRate.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RATE_FIELDS, rate)) throw unsupportedRate(inv, line.vatRate.trim());
  const pct = rate === '23' || rate === '8' || rate === '5' ? Number(rate) / 100 : 0;
  const vat = line.vatAmount ?? roundToCents(line.netAmount * pct);
  return {
    ordinal: line.position,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    unitPriceNet: line.unitPriceNet,
    netAmount: line.netAmount,
    vatRate: rate as VatRate,
    vatAmount: vat,
    grossAmount: roundToCents(line.netAmount + vat),
  };
}

// ============================================================================
// Faktura
// ============================================================================

function buildFaktura(
  root: XMLBuilder,
  inv: JpkInvoice,
  amounts: InvoiceAmounts,
  issuer: JpkFaInputData['issuer'],
): void {
  const f = root.ele('Faktura');
  f.ele('KodWaluty').txt('PLN');
  f.ele('P_1').txt(inv.issueDate);
  f.ele('P_2A').txt(znaki(inv.invoiceNumber));

  // Strony wg broszury MF do JPK_FA(4): P_3A/P_3B nabywca, P_3C/P_3D
  // sprzedawca, P_4B NIP sprzedawcy, P_5B NIP nabywcy. Sprzedawcą faktury
  // wystawionej jest podatnik — gdy faktura nie zapisała jego danych,
  // bierzemy je z firmy (adres: dane firmy, a gdy ich brak — rejestr GUS).
  const sellerAddress =
    inv.sellerAddress || formatIssuerAddress(issuer.address) || formatRegistered(issuer.registeredAddress);
  if (inv.buyerName?.trim()) f.ele('P_3A').txt(znaki(inv.buyerName));
  if (inv.buyerAddress?.trim()) f.ele('P_3B').txt(znaki(inv.buyerAddress));
  f.ele('P_3C').txt(znaki(inv.sellerName || issuer.name));
  f.ele('P_3D').txt(znaki(sellerAddress ?? ''));
  f.ele('P_4B').txt(inv.sellerNip || issuer.nip);
  // Nabywca z UE bez NIP-u (AUD-70): P_5A = prefiks (TKodyKrajowUE, Grecja
  // „EL”), P_5B = numer bez prefiksu. Numer spoza listy krajów UE — bez obu
  // pól, jak dotąd przy braku identyfikatora.
  const buyerNip = inv.buyerNip?.trim();
  const buyerVatUe = buyerNip ? null : parseVatUe(inv.buyerVatUe);
  if (buyerNip) {
    f.ele('P_5B').txt(buyerNip);
  } else if (buyerVatUe) {
    f.ele('P_5A').txt(buyerVatUe.kodUE);
    f.ele('P_5B').txt(buyerVatUe.numer);
  }

  if (inv.saleDate && inv.saleDate !== inv.issueDate) f.ele('P_6').txt(inv.saleDate);

  // Kilka stawek może mieć jedno pole („np” i „np_ii” → P_13_5), a schemat
  // nie dopuszcza dwóch takich samych elementów — sumujemy po polu. Kolejność
  // pól zostaje z RATE_ORDER (Map trzyma kolejność wstawiania).
  const byField = new Map<string, { fields: RateField; net: number; vat: number }>();
  for (const a of amounts.rates) {
    const fields = RATE_FIELDS[a.rate];
    const sum = byField.get(fields.net) ?? { fields, net: 0, vat: 0 };
    sum.net += a.net;
    sum.vat += a.vat;
    byField.set(fields.net, sum);
  }
  for (const { fields, net, vat } of byField.values()) {
    f.ele(fields.net).txt(kwota(net));
    if (fields.vat) f.ele(fields.vat).txt(kwota(vat));
  }
  f.ele('P_15').txt(kwota(amounts.p15));

  const rates = new Set(amounts.rates.map((a) => a.rate));
  const exempt = rates.has('zw');
  const basis = inv.annotations?.vatExemptionBasis?.trim();
  f.ele('P_16').txt(bool(inv.annotations?.cashMethod === true));
  // Samofakturowanie — FaktWay nie wystawia; z importu KSeF wartość z pliku (C5b).
  f.ele('P_17').txt(bool(inv.annotations?.selfInvoicing === true));
  // Podatek rozlicza nabywca: „oo” i „np_ii” (AUD-70) — opis P_18 jak w FA(3).
  // Jawne P_18 z pliku KSeF (C5b) ma pierwszeństwo — JPK mówi to, co oryginał.
  f.ele('P_18').txt(bool(inv.annotations?.reverseCharge ?? [...rates].some((r) => REVERSE_CHARGE_RATES.has(r))));
  f.ele('P_18A').txt(bool(inv.annotations?.splitPayment === true));
  f.ele('P_19').txt(bool(exempt));
  // P_19A przepis ustawy, P_19B dyrektywy, P_19C inna podstawa (C5b: rodzaj z pliku KSeF).
  if (exempt && basis) f.ele(inv.annotations?.vatExemptionBasisKind ?? 'P_19A').txt(znaki(basis));
  f.ele('P_20').txt('false'); // egzekucja
  f.ele('P_21').txt('false'); // przedstawiciel podatkowy
  f.ele('P_22').txt('false'); // nowe środki transportu
  f.ele('P_23').txt('false'); // procedura trójstronna
  f.ele('P_106E_2').txt('false'); // marża biur podróży
  f.ele('P_106E_3').txt('false'); // marża — towary używane

  // ROZ (art. 106f ust. 3) to w JPK_FA(4) „VAT” z numerami zaliczek.
  f.ele('RodzajFaktury').txt(inv.invoiceType === 'advance' ? 'ZAL' : 'VAT');
  if (inv.invoiceType === 'final') {
    const numbers = (inv.advanceSettlement ?? []).map((a) => a.internal_number).filter(Boolean);
    if (numbers.length > 0) f.ele('NrFaZaliczkowej').txt(znaki(numbers.join(', ')));
  }
}

function buildFakturaWiersz(root: XMLBuilder, invoiceNumber: string, line: JpkInvoiceLine): void {
  const w = root.ele('FakturaWiersz');
  w.ele('P_2B').txt(znaki(invoiceNumber));
  if (line.name.trim()) w.ele('P_7').txt(znaki(line.name));
  if (line.unit.trim()) w.ele('P_8A').txt(znaki(line.unit));
  const k = line.ksefFields;
  if (k) {
    // C5c: faktura z importu KSeF — pola pozycji z pliku, w kolejności XSD; przy
    // cenach brutto P_9B/P_11A zamiast netto (art. 106e ust. 8), nic wyliczonego.
    if (k.P_8B !== undefined) w.ele('P_8B').txt(ilosc(k.P_8B));
    if (k.P_9A !== undefined) w.ele('P_9A').txt(kwota(k.P_9A));
    if (k.P_9B !== undefined) w.ele('P_9B').txt(kwota(k.P_9B));
    if (k.P_10 !== undefined) w.ele('P_10').txt(kwota(k.P_10));
    if (k.P_11 !== undefined) w.ele('P_11').txt(kwota(k.P_11));
    if (k.P_11A !== undefined) w.ele('P_11A').txt(kwota(k.P_11A));
  } else {
    w.ele('P_8B').txt(ilosc(line.quantity));
    w.ele('P_9A').txt(kwota(line.unitPriceNet));
    w.ele('P_11').txt(kwota(line.netAmount));
  }
  const rate = line.vatRate.trim().toLowerCase();
  w.ele('P_12').txt(P12_VALUE[rate] ?? rate);
}

// ============================================================================
// HELPERS
// ============================================================================

/** TKwotowy: dwa miejsca po przecinku. */
function kwota(n: number): string {
  return roundToCents(n).toFixed(2);
}

/** TIlosciJPK: do sześciu miejsc po przecinku. */
function ilosc(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

function bool(b: boolean): string {
  return b ? 'true' : 'false';
}

/** TZnakowyJPK: 1–256 znaków, bez zbędnych spacji. */
function znaki(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 256);
}

/**
 * Kod Urzędu Skarbowego do KodUrzedu — tylko ze słownika MF.
 *
 * Do 27.09 brak kodu zamieniał się w „1408”, opisany jako Warszawa-Mokotów,
 * a według słownika MF to Urząd Skarbowy w KOZIENICACH — każdy plik wskazywał
 * ten urząd. Plik przechodził walidację, więc nikt tego nie widział. Teraz
 * brak urzędu to błąd z komunikatem, nie cichy zamiennik.
 */
export function resolveTaxOfficeCode(code: string | null | undefined): string {
  const trimmed = (code ?? '').trim();
  if (!isKnownTaxOffice(trimmed)) throw new MissingTaxOfficeError();
  return trimmed;
}

/** Adres wystawcy z pól tenanta — do P_3D, gdy dokument go nie zapisał. */
function formatIssuerAddress(address: JpkFaInputData['issuer']['address']): string | undefined {
  if (!address) return undefined;
  const street = [address.street, address.buildingNumber].filter(Boolean).join(' ');
  const streetFull = address.apartmentNumber ? `${street}/${address.apartmentNumber}` : street;
  const city = [address.postCode, address.city].filter(Boolean).join(' ');
  return [streetFull, city].filter(Boolean).join(', ') || undefined;
}

function formatRegistered(a: RegisteredAddress | undefined): string | undefined {
  if (!a) return undefined;
  const house = a.apartmentNumber ? `${a.buildingNumber}/${a.apartmentNumber}` : a.buildingNumber;
  const street = a.street ? `${a.street} ${house}` : `${a.city} ${house}`;
  return `${street}, ${a.postCode} ${a.city}`;
}
