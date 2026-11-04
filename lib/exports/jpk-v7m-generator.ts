// lib/exports/jpk-v7m-generator.ts
// Generator JPK_V7M(3) — Jednolity Plik Kontrolny: ewidencja VAT + deklaracja VAT-7(23).
//
// Wzór CRWDE 2025/12/19/14090 — obowiązuje od rozliczenia za luty 2026.
// Zgodność pilnuje test na OFICJALNYM XSD (`lib/exports/schemas/jpk-v7m3/`,
// `validateJpkV7m`). Do 27.09.2026 generator tworzył JPK_V7M(2) — plik nie
// przechodził bramki MF (eksport wstrzymany, #66).

import { create } from 'xmlbuilder2';

import { MissingTaxOfficeError } from '@/lib/exports/tax-office';
import { isKnownTaxOffice } from '@/lib/exports/tax-offices';
import { assertOutgoingInvoicesInPln } from '@/lib/exports/currency-guard';
import { parseVatUe } from '@/lib/invoices/vat-ue';

import type { ExportExpense } from './data-fetcher';
import { amountsOf, type JpkInvoice } from './jpk-fa-generator';
import { roundToCents } from '@/lib/xml/invoice-calculator';

const JPK_V7M_NAMESPACE = 'http://crd.gov.pl/wzor/2025/12/19/14090/';
const ETD_NAMESPACE = 'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/09/13/eD/DefinicjeTypy/';

export interface JpkV7mInputData {
  issuer: {
    nip: string;
    name: string;
    /** Wymagany przez schemat (Podmiot1/…/Email). */
    email?: string;
    /** KodUrzedu — urząd skarbowy firmy (#67). */
    taxOfficeCode?: string;
  };
  /** Okres — z period wyciągamy rok i miesiąc. */
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  issuedInvoices: JpkInvoice[];
  /** Koszty z `expenses` — źródło zakupów (ewidencja + P_42/P_43). */
  expenses?: ExportExpense[];
  /**
   * P_39 — nadwyżka z poprzedniej deklaracji. Aplikacja jej nie śledzi;
   * bez niej P_51 może być zawyżone (do sprawdzenia przez księgową).
   */
  previousSurplus?: number;
  /** 1 = złożenie, 2 = korekta. */
  goal?: '1' | '2';
  systemName?: string;
  /** Do testów — w pliku czas wytworzenia. */
  generatedAt?: Date;
}

/** Plik JPK bez e-maila podatnika — schemat go wymaga. */
export class MissingTaxpayerEmailError extends Error {
  constructor() {
    super('Brak adresu e-mail podatnika — wymagany w pliku JPK_V7M.');
    this.name = 'MissingTaxpayerEmailError';
  }
}

/**
 * Sprzedaż w odwrotnym obciążeniu (stawka „oo”, FA(3) P_13_10). W JPK_V7M(3)
 * K_31/P_31 to podstawa NABYWCY (art. 17 ust. 1 pkt 5), a pola dla sprzedawcy
 * nie ustaliliśmy — do decyzji księgowej. Do 01.10.2026 taka sprzedaż po
 * cichu wypadała z pliku: ewidencja bez faktury, która jest w KSeF.
 */
export class JpkV7mReverseChargeNotSupportedError extends Error {
  constructor() {
    super(
      'W okresie jest faktura z odwrotnym obciążeniem („oo”) — JPK_V7M jeszcze jej nie obsługuje. ' +
        'Plik nie powstał, żeby nie pominąć tej sprzedaży; przygotuj ewidencję z księgową.',
    );
    this.name = 'JpkV7mReverseChargeNotSupportedError';
  }
}

/** Sumy netto/VAT wg stawki — w groszach, bez zaokrągleń pośrednich. */
interface RateBucket {
  net23: number;
  vat23: number;
  net8: number;
  vat8: number;
  net5: number;
  vat5: number;
  net0: number;
  netZw: number;
  /**
   * Poza terytorium kraju → K_11/P_11: „np” (FA(3) P_13_8) RAZEM z „np_ii”
   * (P_13_9) — usługi z art. 100 ust. 1 pkt 4 też są świadczone poza krajem.
   */
  netNp: number;
  /**
   * „np_ii” (AUD-70) — usługi z art. 100 ust. 1 pkt 4 → K_12/P_12. To część
   * K_11/P_11 („w tym”): w XSD P_12 stoi w sekwencji za obowiązkowym P_11,
   * a P_37 sumuje P_11 bez P_12.
   */
  netNpII: number;
}

function emptyBucket(): RateBucket {
  return { net23: 0, vat23: 0, net8: 0, vat8: 0, net5: 0, vat5: 0, net0: 0, netZw: 0, netNp: 0, netNpII: 0 };
}

function round2(n: number): number {
  return roundToCents(n);
}

/** Kwota ewidencji (TKwotowy) — z groszami. */
function money(n: number): string {
  return round2(n).toFixed(2);
}

/**
 * Kwota deklaracji (TKwotaC) — pełne złote: końcówki poniżej 50 gr pomija się,
 * od 50 gr zaokrągla w górę (art. 63 § 1 Ordynacji podatkowej).
 */
export function wholeZloty(n: number): number {
  const cents = Math.round(Math.abs(n) * 100);
  return Math.sign(n) * Math.floor((cents + 50) / 100);
}

/**
 * Sumuje sprzedaż wg stawek VAT — kwoty z faktury tak, jak są w KSeF
 * (`amountsOf`, to samo co JPK_FA). Faktura rozliczeniowa (ROZ) wchodzi
 * po odjęciu zaliczek (art. 106f ust. 3): zaliczki są już w ewidencji
 * z własnych faktur, a do 01.10.2026 ROZ dokładała je drugi raz. VAT
 * pozycji jest ten z faktury, a nie przeliczany od nowa z netto.
 */
function aggregateSales(invoices: readonly JpkInvoice[]): RateBucket {
  assertOutgoingInvoicesInPln(invoices);
  const b = emptyBucket();
  for (const inv of invoices) {
    for (const { rate, net, vat } of amountsOf(inv).rates) {
      switch (rate) {
        case '23':
          b.net23 += net;
          b.vat23 += vat;
          break;
        case '8':
          b.net8 += net;
          b.vat8 += vat;
          break;
        case '5':
          b.net5 += net;
          b.vat5 += vat;
          break;
        case '0':
          b.net0 += net;
          break;
        case 'zw':
          b.netZw += net;
          break;
        case 'np':
          b.netNp += net;
          break;
        case 'np_ii':
          b.netNp += net;
          b.netNpII += net;
          break;
        case 'oo':
          throw new JpkV7mReverseChargeNotSupportedError();
        default:
          // `amountsOf` przepuszcza tylko stawki z pól JPK_FA — tu nie dochodzi.
          throw new Error(`JPK_V7M: stawka "${rate}" nie ma pola w ewidencji.`);
      }
    }
  }
  return b;
}

/**
 * Dokumenty dające prawo do odliczenia VAT: faktura i faktura uproszczona.
 * Paragon bez NIP i „inne” — nie.
 */
const VAT_DEDUCTIBLE_DOCUMENTS: ReadonlySet<string> = new Set(['invoice', 'simplified_invoice']);

/**
 * Zakupy do ewidencji VAT: koszty uznane przez klienta, na dokumencie z prawem
 * do odliczenia, z niezerowym VAT do odliczenia (`vatDeductibleAmount`).
 */
export function vatPurchases(expenses: readonly ExportExpense[]): ExportExpense[] {
  return expenses.filter(
    // `!== 0`, nie `> 0`: korekta zakupu „in minus” zmniejsza odliczenie (#68).
    (e) => VAT_DEDUCTIBLE_DOCUMENTS.has(e.documentType) && e.vatDeductibleAmount !== 0,
  );
}

/**
 * Rozliczenie okresu — te same liczby, które trafiają do deklaracji.
 * Jedno źródło dla pliku i dla agenta FLO (T-01).
 */
export interface JpkV7mSummary {
  /** Podatek należny — P_38 (pełne złote). */
  vatDue: number;
  /** Podatek naliczony do odliczenia — P_48 (pełne złote). */
  vatDeductible: number;
  /** Netto zakupów — P_42 (pełne złote). */
  purchaseNet: number;
  /** Dodatnie = do zapłaty (P_51); ujemne = nadwyżka (P_53). */
  balance: number;
  salesCount: number;
  purchaseCount: number;
}

interface Declaration {
  P_10: number;
  P_11: number;
  P_12: number;
  P_13: number;
  P_15: number;
  P_16: number;
  P_17: number;
  P_18: number;
  P_19: number;
  P_20: number;
  P_37: number;
  P_38: number;
  P_39: number;
  P_42: number;
  P_43: number;
  P_48: number;
  P_51: number;
  P_53: number;
  P_62: number;
}

function declaration(data: JpkV7mInputData): Declaration {
  const s = aggregateSales(data.issuedInvoices);
  const purchases = vatPurchases(data.expenses ?? []);
  const P_10 = wholeZloty(s.netZw);
  const P_11 = wholeZloty(s.netNp);
  const P_12 = wholeZloty(s.netNpII);
  const P_13 = wholeZloty(s.net0);
  const P_15 = wholeZloty(s.net5);
  const P_16 = wholeZloty(s.vat5);
  const P_17 = wholeZloty(s.net8);
  const P_18 = wholeZloty(s.vat8);
  const P_19 = wholeZloty(s.net23);
  const P_20 = wholeZloty(s.vat23);
  // P_37 = suma podstaw; P_38 = suma podatku należnego (z pól już zaokrąglonych).
  // Bez P_12 — to część P_11 (opis P_37 w XSD: P_10, P_11, P_13, P_15, …).
  const P_37 = P_10 + P_11 + P_13 + P_15 + P_17 + P_19;
  const P_38 = P_16 + P_18 + P_20;
  const P_39 = wholeZloty(Math.max(0, data.previousSurplus ?? 0));
  const P_42 = wholeZloty(purchases.reduce((sum, e) => sum + e.netAmount, 0));
  const P_43 = wholeZloty(purchases.reduce((sum, e) => sum + e.vatDeductibleAmount, 0));
  // P_48 = P_39 + P_41 + P_43 + P_44 + P_45 + P_46 + P_47 (środki trwałe i korekty — do rozszerzenia).
  const P_48 = P_39 + P_43;
  const P_51 = Math.max(0, P_38 - P_48);
  const P_53 = P_51 > 0 ? 0 : Math.max(0, P_48 - P_38);
  // Bez zwrotu na rachunek (P_54) cała nadwyżka przechodzi na następny okres.
  const P_62 = P_53;
  return { P_10, P_11, P_12, P_13, P_15, P_16, P_17, P_18, P_19, P_20, P_37, P_38, P_39, P_42, P_43, P_48, P_51, P_53, P_62 };
}

export function summarizeJpkV7m(data: JpkV7mInputData): JpkV7mSummary {
  const d = declaration(data);
  return {
    vatDue: d.P_38,
    vatDeductible: d.P_48,
    purchaseNet: d.P_42,
    balance: d.P_38 - d.P_48,
    salesCount: data.issuedInvoices.length,
    purchaseCount: vatPurchases(data.expenses ?? []).length,
  };
}

/** Numer KSeF albo oznaczenie dokumentu spoza KSeF (JPK_V7(3)). */
function ksefMarker(row: ReturnType<typeof create>, ksefNumber: string | null | undefined): void {
  const nr = ksefNumber?.trim();
  if (nr) {
    row.ele('NrKSeF').txt(nr).up();
  } else {
    // Faktura elektroniczna lub papierowa poza KSeF (import, OCR papieru).
    // OFF (tryb offline bez numeru na dzień złożenia) — do rozróżnienia,
    // gdy eksport pozna fakturę w kolejce offline.
    row.ele('BFK').txt('1').up();
  }
}

/**
 * Kontrahent w wierszu sprzedaży: NIP, a nabywca z UE bez NIP-u (AUD-70) —
 * KodKrajuNadaniaTIN + numer bez prefiksu. Typ TKodKrajuJPK to słownik
 * krajów z dodanym „EL” i wykluczonym „GR”, więc dla Grecji prefiks VAT-UE
 * („EL”) jest wprost właściwym kodem.
 */
function counterpartyId(inv: JpkInvoice): { country?: string; number: string } {
  const nip = inv.buyerNip?.trim();
  if (nip) return { number: nip };
  const vatUe = parseVatUe(inv.buyerVatUe);
  if (vatUe) return { country: vatUe.kodUE, number: vatUe.numer };
  return { number: 'BRAK' };
}

/**
 * Generuje XML JPK_V7M(3). Deklaracja obejmuje sprzedaż krajową wg stawek
 * (23/8/5/0/zw), sprzedaż poza krajem („np” i „np_ii”, K_11/P_11; „np_ii”
 * także w K_12/P_12 — usługi z art. 100 ust. 1 pkt 4) i nabycia pozostałe
 * (P_42/P_43). Odwrotne obciążenie („oo”) — odmowa
 * (`JpkV7mReverseChargeNotSupportedError`). Pola specjalne (WDT, eksport,
 * import usług, środki trwałe, ulgi) — do rozszerzenia.
 */
export function generateJpkV7m(data: JpkV7mInputData): string {
  const taxOffice = (data.issuer.taxOfficeCode ?? '').trim();
  if (!isKnownTaxOffice(taxOffice)) throw new MissingTaxOfficeError();
  const email = data.issuer.email?.trim();
  if (!email) throw new MissingTaxpayerEmailError();

  const issued = data.issuedInvoices;
  const purchases = vatPurchases(data.expenses ?? []);
  const d = declaration(data);

  const year = data.periodStart.slice(0, 4);
  const month = String(Number(data.periodStart.slice(5, 7)));

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('JPK', {
    xmlns: JPK_V7M_NAMESPACE,
    'xmlns:etd': ETD_NAMESPACE,
  });

  // ── Nagłówek ──────────────────────────────────────────────
  const header = root.ele('Naglowek');
  header.ele('KodFormularza', { kodSystemowy: 'JPK_V7M (3)', wersjaSchemy: '1-0E' }).txt('JPK_VAT').up();
  header.ele('WariantFormularza').txt('3').up();
  header.ele('DataWytworzeniaJPK').txt((data.generatedAt ?? new Date()).toISOString()).up();
  header.ele('NazwaSystemu').txt(data.systemName ?? 'FaktWay').up();
  header.ele('CelZlozenia', { poz: 'P_7' }).txt(data.goal ?? '1').up();
  header.ele('KodUrzedu').txt(taxOffice).up();
  header.ele('Rok').txt(year).up();
  header.ele('Miesiac').txt(month).up();

  // ── Podmiot1 ──────────────────────────────────────────────
  const osoba = root.ele('Podmiot1', { rola: 'Podatnik' }).ele('OsobaNiefizyczna');
  osoba.ele('NIP').txt(data.issuer.nip).up();
  osoba.ele('PelnaNazwa').txt(data.issuer.name).up();
  osoba.ele('Email').txt(email).up();

  // ── Deklaracja VAT-7(23) ──────────────────────────────────
  const dekl = root.ele('Deklaracja');
  const dHeader = dekl.ele('Naglowek');
  dHeader
    .ele('KodFormularzaDekl', { kodSystemowy: 'VAT-7 (23)', kodPodatku: 'VAT', rodzajZobowiazania: 'Z', wersjaSchemy: '1-0E' })
    .txt('VAT-7')
    .up();
  dHeader.ele('WariantFormularzaDekl').txt('23').up();

  const poz = dekl.ele('PozycjeSzczegolowe');
  const put = (name: string, value: number) => poz.ele(name).txt(String(value)).up();
  if (d.P_10) put('P_10', d.P_10);
  // P_12 tylko w sekwencji z P_11 (P_11 w niej obowiązkowe).
  if (d.P_11 || d.P_12) {
    put('P_11', d.P_11);
    if (d.P_12) put('P_12', d.P_12);
  }
  if (d.P_13) put('P_13', d.P_13);
  if (d.P_15 || d.P_16) {
    put('P_15', d.P_15);
    put('P_16', d.P_16);
  }
  if (d.P_17 || d.P_18) {
    put('P_17', d.P_17);
    put('P_18', d.P_18);
  }
  if (d.P_19 || d.P_20) {
    put('P_19', d.P_19);
    put('P_20', d.P_20);
  }
  put('P_37', d.P_37);
  put('P_38', d.P_38);
  if (d.P_39) put('P_39', d.P_39);
  if (d.P_42 || d.P_43) {
    put('P_42', d.P_42);
    put('P_43', d.P_43);
  }
  put('P_48', d.P_48);
  put('P_51', d.P_51);
  if (d.P_53) put('P_53', d.P_53);
  if (d.P_62) put('P_62', d.P_62);
  dekl.ele('Pouczenia').txt('1').up();

  // ── Ewidencja ─────────────────────────────────────────────
  const ewid = root.ele('Ewidencja');
  let podatekNalezny = 0;

  issued.forEach((inv, idx) => {
    const s = ewid.ele('SprzedazWiersz');
    s.ele('LpSprzedazy').txt(String(idx + 1)).up();
    const kontrahent = counterpartyId(inv);
    if (kontrahent.country) s.ele('KodKrajuNadaniaTIN').txt(kontrahent.country).up();
    s.ele('NrKontrahenta').txt(kontrahent.number).up();
    s.ele('NazwaKontrahenta').txt(inv.buyerName || 'BRAK').up();
    s.ele('DowodSprzedazy').txt(inv.invoiceNumber).up();
    s.ele('DataWystawienia').txt(inv.issueDate).up();
    // Tylko gdy data sprzedaży różni się od daty wystawienia (opis pola MF).
    if (inv.saleDate && inv.saleDate !== inv.issueDate) s.ele('DataSprzedazy').txt(inv.saleDate).up();
    ksefMarker(s, inv.ksefNumber);

    const b = aggregateSales([inv]);
    if (b.netZw) s.ele('K_10').txt(money(b.netZw)).up();
    if (b.netNp) s.ele('K_11').txt(money(b.netNp)).up();
    if (b.netNpII) s.ele('K_12').txt(money(b.netNpII)).up();
    if (b.net0) s.ele('K_13').txt(money(b.net0)).up();
    if (b.net5 || b.vat5) {
      s.ele('K_15').txt(money(b.net5)).up();
      s.ele('K_16').txt(money(b.vat5)).up();
    }
    if (b.net8 || b.vat8) {
      s.ele('K_17').txt(money(b.net8)).up();
      s.ele('K_18').txt(money(b.vat8)).up();
    }
    if (b.net23 || b.vat23) {
      s.ele('K_19').txt(money(b.net23)).up();
      s.ele('K_20').txt(money(b.vat23)).up();
    }
    podatekNalezny += b.vat5 + b.vat8 + b.vat23;
  });

  ewid
    .ele('SprzedazCtrl')
    .ele('LiczbaWierszySprzedazy').txt(String(issued.length)).up()
    .ele('PodatekNalezny').txt(money(podatekNalezny)).up();

  let podatekNaliczony = 0;
  purchases.forEach((exp, idx) => {
    const z = ewid.ele('ZakupWiersz');
    z.ele('LpZakupu').txt(String(idx + 1)).up();
    // Dostawca to SPRZEDAWCA (#58).
    z.ele('NrDostawcy').txt(exp.sellerNip ?? 'BRAK').up();
    z.ele('NazwaDostawcy').txt(exp.sellerName || 'BRAK').up();
    z.ele('DowodZakupu').txt(exp.documentNumber || 'BRAK').up();
    z.ele('DataZakupu').txt(exp.issueDate).up();
    ksefMarker(z, exp.ksefNumber);
    z.ele('K_42').txt(money(exp.netAmount)).up();
    z.ele('K_43').txt(money(exp.vatDeductibleAmount)).up();
    podatekNaliczony += exp.vatDeductibleAmount;
  });

  ewid
    .ele('ZakupCtrl')
    .ele('LiczbaWierszyZakupow').txt(String(purchases.length)).up()
    .ele('PodatekNaliczony').txt(money(podatekNaliczony)).up();

  return root.end({ prettyPrint: true });
}
