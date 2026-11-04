/**
 * Wiersz faktury z importu: nagłówek `invoices`, pozycje `invoice_line_items`
 * i `fa3_data` zbudowane z odczytanego pliku (`ParsedInvoice`). Jedno źródło
 * dla silnika importu (`import-engine.ts`) i dla zapisu oryginału KSeF po
 * decyzji klienta (D-A4-1b-3 PR C: projekcja K przekazywana do RPC jako jsonb).
 *
 * Moduł czysty — wydzielony z silnika w PR C0 (refaktor bez zmiany zachowania).
 * Inwarianty spisane PRZED przeniesieniem (spec D-A4-1b-3 v3, 5.9):
 * - C0-1: `processImportedInvoices` dla tych samych wejść wysyła do bazy
 *   identyczne obiekty `insert` (nagłówek i pozycje) w tej samej kolejności.
 *   Kolejność kluczy w obiekcie zachowana jak w silniku sprzed PR C0 (PostgREST
 *   jej nie czyta); pilnuje jej wpis strażnika „zapisy jako JSON w kolejności
 *   kluczy” (surowy JSON partii) — migawki obiektów sortują klucze.
 * - C0-2: `warnings` i ostrzeżenia JPK (`noteHeld`) identyczne (treść
 *   i kolejność); moduł nie dopisuje do żadnej listy — zwraca tekst, silnik
 *   dopisuje go w tym samym miejscu co dotąd.
 * - C0-3: `buildImportFa3Json` daje ten sam JSON przy wstrzykniętym
 *   `importedAt` (czas podaje wywołujący w `provenance`).
 * - C0-4: upserty kontrahentów i produktów bez zmian — moduł ich nie dotyka
 *   (zostają w silniku razem z odczytem duplikatów i kolejnością zapisów).
 * - C0-5: eksportowane funkcje są czyste: bez bazy, magazynu, `Date.now()`
 *   i `new Date()`; znaczniki czasu (`ksefAcceptedAt`, `importedAt`) podaje
 *   wywołujący.
 * Strażnik: `tests/unit/import-wiersze-tozsamosc.test.ts` (migawka zapisów
 * sprzed refaktoru). Świadoma zmiana mapowania (np. PR C0b, GEN-RUNDA) zmienia
 * tę migawkę i opisuje to w teście.
 */

import type { Json } from '@/types/database';
import type { KsefEnvironment } from '@/types/ksef';
import type { BuyerParty, PaymentInfo, SellerParty } from '@/types/invoice';
import type { InvoiceOrigin } from '@/lib/flo/functions/import-history';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import { importedVatRateLabel, isVatRate } from '@/lib/xml/fa3-p12';
import type { ParsedInvoice, ParsedParty } from './fa3-parser';
import { contentHeldReasons, fa3ImportContent, type ImportContent } from './fa3-content';
import { fa3ImportLineAmounts, type ImportLineAmounts } from './fa3-line-amounts';

/** Rodzaj faktury FA(3) (`RodzajFaktury`) zapisywany w `invoices.invoice_type`. */
export type ImportedFaVatType = 'VAT' | 'KOR' | 'ZAL' | 'ROZ';

/**
 * Kolumny identyfikatora nabywcy na wierszu `invoices`. `buyer_id_number` niesie
 * `NrInny` z pliku (dowód, paszport, numer zagraniczny); PESEL ma własną kolumnę.
 */
export interface ImportedBuyerIdentity {
  is_b2c: boolean;
  buyer_id_type: 'nip' | 'pesel' | 'no_id';
  buyer_nip: string | null;
  buyer_pesel: string | null;
  buyer_id_number: string | null;
}

/** To, czego nie ma w pliku: kontekst zapisu podawany przez wywołującego. */
export interface ImportedInvoiceRowInput {
  tenantId: string;
  direction: 'outgoing' | 'incoming';
  origin: InvoiceOrigin;
  ksefStatus: string;
  ksefEnvironment: KsefEnvironment | null;
  /** Znacznik czasu przyjęcia w KSeF — podaje wywołujący (moduł nie czyta zegara). */
  ksefAcceptedAt: string | null;
  ksefNumber: string | null;
  /** Ścieżka oryginału XML w magazynie firmy; `undefined` albo `null` = kolumny nie ma w obiekcie `insert`. */
  xmlStoragePath?: string | null;
  notes: string | null;
  /** Trafia do `fa3_data.import` (silnik: {source, importJobId, importedAt}); wartości muszą być JSON-owe. */
  provenance: Record<string, Json>;
}

/** Obiekt `insert` nagłówka `invoices` z importu (kolumny, które ustawia import). */
export interface ImportedInvoiceInsert extends ImportedBuyerIdentity {
  tenant_id: string;
  direction: 'outgoing' | 'incoming';
  origin: InvoiceOrigin;
  internal_number: string;
  ksef_status: string;
  ksef_environment: KsefEnvironment | null;
  ksef_accepted_at: string | null;
  ksef_number: string | null;
  invoice_kind: 'regular';
  invoice_type: ImportedFaVatType;
  issue_date: string;
  sale_date: string | null;
  seller_nip: string | null;
  currency: 'PLN';
  net_total: number;
  vat_total: number;
  gross_total: number;
  payment_due_date: string | null;
  fa3_data: Json;
  seller_data: Json;
  buyer_data: Json;
  payment_data: Json;
  notes: string | null;
  xml_storage_path?: string;
}

/** Pozycja `invoice_line_items` z importu — bez `invoice_id` (dopisuje go zapis). */
export interface ImportedLineInsert {
  ordinal: number;
  name: string;
  unit: string;
  quantity: number;
  unit_price_net: number | null;
  net_amount: number;
  vat_rate: string;
  vat_amount: number;
  gross_amount: number;
}

/** Treść z pliku (C5b) i kwoty pozycji (C5c) — wejście wszystkich budowniczych. */
export function importedInvoiceContent(inv: ParsedInvoice): {
  content: ImportContent;
  amounts: ImportLineAmounts;
} {
  return { content: fa3ImportContent(inv), amounts: fa3ImportLineAmounts(inv) };
}

/** Nagłówek faktury z importu (obiekt `insert` tabeli `invoices`). */
export function buildImportedInvoiceRow(
  inv: ParsedInvoice,
  input: ImportedInvoiceRowInput,
  content: ImportContent,
  amounts: ImportLineAmounts,
): ImportedInvoiceInsert {
  const idCols = buyerIdentityFromParsed(inv.buyer);
  return {
    tenant_id: input.tenantId,
    direction: input.direction,
    origin: input.origin,
    internal_number: inv.invoiceNumber.trim(),
    ksef_status: input.ksefStatus,
    ksef_environment: input.ksefEnvironment,
    ksef_accepted_at: input.ksefAcceptedAt,
    ksef_number: input.ksefNumber,
    invoice_kind: normalizeInvoiceKindForInsert(inv).kind,
    invoice_type: mapParsedKindToFaVatType(inv.invoiceType),
    issue_date: inv.issueDate,
    sale_date: content.saleDate,
    seller_nip: inv.seller.nip?.replace(/\D/g, '').slice(0, 10) || null,
    buyer_nip: idCols.buyer_nip,
    currency: 'PLN',
    // C5c: faktura bez sum stawek — netto i VAT z pozycji (sprawdzone z P_15), inaczej z nagłówka.
    net_total: amounts.totals?.netTotal ?? inv.totals.netTotal,
    vat_total: amounts.totals?.vatTotal ?? inv.totals.vatTotal,
    gross_total: inv.totals.grossTotal,
    payment_due_date: inv.paymentDueDate ?? null,
    fa3_data: buildImportFa3Json(inv, input.provenance, content, amounts),
    seller_data: sellerPartyFromParsed(inv.seller) as unknown as Json,
    buyer_data: buyerPartyFromParsed(inv.buyer) as unknown as Json,
    payment_data: paymentInfoFromParsed(inv) as unknown as Json,
    is_b2c: idCols.is_b2c,
    buyer_id_type: idCols.buyer_id_type,
    buyer_pesel: idCols.buyer_pesel,
    buyer_id_number: idCols.buyer_id_number,
    notes: input.notes,
    ...(input.xmlStoragePath != null ? { xml_storage_path: input.xmlStoragePath } : {}),
  };
}

/** Pozycje faktury z importu w kolejności pliku; kwoty z `fa3ImportLineAmounts` (C5c). */
export function buildImportedLineRows(inv: ParsedInvoice, amounts: ImportLineAmounts): ImportedLineInsert[] {
  return inv.lines.map((line, idx) => {
    const row = amounts.rows[idx]!;
    return {
      ordinal: line.position ?? idx + 1,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unit_price_net: row.unitPriceNet,
      net_amount: row.netAmount,
      vat_rate: line.vatRate,
      vat_amount: row.vatAmount,
      gross_amount: row.grossAmount,
    };
  });
}

const IMPORTED_TYPE_LABEL: Record<'KOR' | 'ZAL' | 'ROZ', string> = {
  KOR: 'korygująca',
  ZAL: 'zaliczkowa',
  ROZ: 'rozliczeniowa',
};

/**
 * W9 (C5a): ostrzeżenie dla klienta o zapisanym dokumencie, którego JPK nie
 * wykaże — stawka spoza FaktWay („0 WDT”, „0 EX”, „22”…, „nieznana”) albo
 * zaimportowana korekta / zaliczka / ROZ. `null`, gdy dokument jest zwykły.
 */
export function heldDocumentWarning(
  inv: ParsedInvoice,
  num: string,
  ksefNumber: string | undefined,
  direction: 'outgoing' | 'incoming',
  status: string,
  content: ImportContent,
  amounts: ImportLineAmounts,
): string | null {
  const doc = `${num}${ksefNumber ? ` (KSeF ${ksefNumber})` : ''}`;
  const codes = [...new Set(inv.lines.map((l) => l.vatRate.trim()).filter((r) => !isVatRate(r)))];
  const rates = codes
    .map((c) => {
      const label = importedVatRateLabel(c);
      return `„${c}”${label ? ` (${label})` : ''}`;
    })
    .join(', ');
  const type = mapParsedKindToFaVatType(inv.invoiceType);
  const special = type === 'VAT' ? null : IMPORTED_TYPE_LABEL[type];
  const sale = status === 'accepted' && direction === 'outgoing';
  // C5b: data sprzedaży, adnotacje i oznaczenia, których JPK nie wykaże — tylko sprzedaż przyjęta w KSeF.
  const contentReasons = sale ? contentHeldReasons(inv, content) : [];
  // C5c: kwoty pozycji, których nie da się wiernie przenieść z pliku (ceny brutto, VAT od sumy stawki).
  const amountReason = sale && amounts.problems.length
    ? `kwot pozycji nie da się wiernie przenieść z pliku KSeF (${amounts.problems.join('; ')})`
    : null;
  // Bezpiecznik: pozycje nie sumują się do netto albo VAT nagłówka — tylko gdy nie ma powodu dokładniejszego.
  const linesNet = amounts.rows.reduce((sum, r) => sum + (Number.isFinite(r.netAmount) ? r.netAmount : 0), 0);
  const linesVat = amounts.rows.reduce((sum, r) => sum + (Number.isFinite(r.vatAmount) ? r.vatAmount : 0), 0);
  const mismatch = sale && !codes.length && !amountReason && !special && (
    Math.abs(roundToCents(linesNet) - roundToCents(amounts.totals?.netTotal ?? inv.totals.netTotal)) > 0.01 * Math.max(1, inv.lines.length) + 0.01 ||
    Math.abs(roundToCents(linesVat) - roundToCents(amounts.totals?.vatTotal ?? inv.totals.vatTotal)) >= 0.005);
  if (codes.length === 0 && !special && !mismatch && contentReasons.length === 0 && !amountReason) return null;

  if (status !== 'accepted') {
    return codes.length ? `${doc}: stawka ${rates} nie ma odpowiednika w FaktWay — szkic zapisany z tą stawką.` : null;
  }
  if (direction === 'incoming') {
    return codes.length
      ? `${doc}: stawka ${rates} — FaktWay jej nie rozlicza; faktura jest zapisana z kwotami z KSeF, sprawdź ją z księgową.`
      : null;
  }
  // Wszystkie powody naraz (C5b) — JPK odmówi z pierwszym, klient widzi komplet.
  const what = [
    special ? `zaimportowana faktura ${special} — FaktWay nie zna jej powiązań (faktura pierwotna, zaliczki)` : null,
    codes.length ? `stawka VAT ${rates} — FaktWay jej jeszcze nie wykazuje w JPK` : null,
    ...contentReasons,
    amountReason,
    mismatch ? 'netto albo VAT pozycji nie sumuje się do sum faktury z KSeF' : null,
  ].filter(Boolean).join('; ');
  // C5c: bez sum stawek w pliku netto i VAT faktury są nieznane — KPiR i CSV też ich nie pokażą.
  const exit = sale && amounts.totalsUnknown
    ? 'przygotuj je z księgową — KPiR i CSV też nie pokażą poprawnych kwot tej faktury, wprowadźcie je ręcznie'
    : 'przygotuj je z księgową (KPiR i CSV działają)';
  return (
    `${doc}: ${what}. Faktura jest zapisana, ale JPK_FA i JPK_V7M za ${inv.issueDate.slice(0, 7)} nie powstaną ` +
    `w FaktWay, dopóki ta faktura jest w okresie — ${exit}.`
  );
}

/**
 * Korekty / zaliczki / final wymagają powiązań w DB — przy imporcie zapis jako
 * `regular`. `warning` (albo `null`) dopisuje do raportu wywołujący.
 */
export function normalizeInvoiceKindForInsert(inv: ParsedInvoice): { kind: 'regular'; warning: string | null } {
  return {
    kind: 'regular',
    warning: inv.invoiceType !== 'regular'
      ? `${inv.invoiceNumber}: invoice_kind ustawiono na „regular” (typ źródłowy „${inv.invoiceType}” wymaga pól powiązanych nieobecnych w imporcie)`
      : null,
  };
}

/** Rodzaj z parsera na `invoice_type`: korekta → KOR, zaliczka → ZAL, rozliczeniowa → ROZ; `regular` (parser mapuje na nią też UPR) → VAT. */
export function mapParsedKindToFaVatType(kind: ParsedInvoice['invoiceType']): ImportedFaVatType {
  switch (kind) {
    case 'correction':
      return 'KOR';
    case 'advance':
      return 'ZAL';
    case 'final':
      return 'ROZ';
    default:
      return 'VAT';
  }
}

/**
 * Kolumny identyfikatora nabywcy (C0b, GR-5): NIP (10 cyfr) → `nip`; PESEL (11 cyfr) →
 * `pesel` + `buyer_pesel`; NrInny → `buyer_id_number` = NrInny, a `is_b2c` i `buyer_id_type`
 * jak dla VAT-UE (`false`, `'nip'` — FA(3) nie mówi, czy to konsument); sam VAT-UE →
 * `buyer_id_type: 'nip'` bez numeru; brak identyfikatora → `no_id`.
 */
export function buyerIdentityFromParsed(buyer: ParsedParty): ImportedBuyerIdentity {
  const nip = buyer.nip?.replace(/\D/g, '') ?? '';
  if (nip.length === 10) {
    return {
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: nip,
      buyer_pesel: null,
      buyer_id_number: null,
    };
  }

  const pesel = buyer.pesel?.replace(/\D/g, '') ?? '';
  if (pesel.length === 11) {
    return {
      is_b2c: true,
      buyer_id_type: 'pesel',
      buyer_nip: null,
      buyer_pesel: pesel,
      buyer_id_number: null,
    };
  }

  const nrInny = buyer.nrInny?.trim() ?? '';
  if ((buyer.vatUeNumber && buyer.vatUeNumber.trim()) || nrInny) {
    return {
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: null,
      buyer_pesel: null,
      // C0b GR-5: numer z pliku zostaje na wierszu (dotąd ginął); VAT-UE ma go w `buyer_data`.
      buyer_id_number: nrInny || null,
    };
  }

  return {
    is_b2c: true,
    buyer_id_type: 'no_id',
    buyer_nip: null,
    buyer_pesel: null,
    buyer_id_number: null,
  };
}

/** `seller_data`: NIP bez nie-cyfr, obcięty do 10 znaków, a gdy pusty — `'0000000000'`; pusta nazwa i brak `AdresL1` → `'—'`. */
export function sellerPartyFromParsed(seller: ParsedParty): SellerParty {
  const nip = seller.nip?.replace(/\D/g, '').slice(0, 10) ?? '';
  return {
    nip: nip || '0000000000',
    name: seller.name || '—',
    address: {
      countryCode: (seller.countryCode as 'PL') ?? 'PL',
      addressLine1: seller.addressLine1 ?? '—',
      addressLine2: seller.addressLine2 ?? '',
    },
    email: seller.email,
    phone: undefined,
  };
}

/**
 * `buyer_data` (C0b, GR-5): NIP tylko gdy ma 10 cyfr; `jst` i `gv` z pliku (2, gdy pliku nie
 * niósł tych pól — CSV, JPK); `noIdMarker` z `brakId`, a gdy go brak — tylko wtedy, gdy nabywca
 * nie ma żadnego identyfikatora (NIP, PESEL, VAT-UE ani NrInny), bo marker obok identyfikatora
 * łamałby „dokładnie jeden identyfikator nabywcy” (`validateInvoice`).
 */
export function buyerPartyFromParsed(buyer: ParsedParty): BuyerParty {
  const hasNip = !!buyer.nip && buyer.nip.replace(/\D/g, '').length === 10;

  return {
    name: buyer.name || 'Nieznany',
    nip: hasNip ? buyer.nip!.replace(/\D/g, '').slice(0, 10) : undefined,
    pesel: buyer.pesel,
    vatUeNumber: buyer.vatUeNumber,
    nrInny: buyer.nrInny,
    noIdMarker: !!(buyer.brakId ?? (!buyer.nip && !buyer.pesel && !buyer.vatUeNumber && !buyer.nrInny)),
    address: {
      countryCode: (buyer.countryCode as 'PL') ?? 'PL',
      addressLine1: buyer.addressLine1 ?? '',
      addressLine2: buyer.addressLine2 ?? '',
    },
    email: buyer.email,
    jst: buyer.jst ?? 2,
    gv: buyer.gv ?? 2,
  };
}

function mapPaymentMethodLabel(raw?: string): PaymentInfo['method'] {
  if (!raw) return 'transfer';
  const x = raw.toLowerCase();
  if (x.includes('gotów') || x === 'cash') return 'cash';
  if (x.includes('kart')) return 'card';
  if (x.includes('przelew')) return 'transfer';
  return 'other';
}

/**
 * `payment_data`: kwota do zapłaty = brutto faktury, waluta PLN, termin z pliku albo
 * data wystawienia, rachunek z pliku; forma z opisu parsera — brak albo „przelew…” →
 * `transfer`, „gotów…” → `cash`, „kart…” → `card`, reszta (bon, czek, kredyt, inna) → `other`.
 */
export function paymentInfoFromParsed(inv: ParsedInvoice): PaymentInfo {
  return {
    amountDue: inv.totals.grossTotal,
    currency: 'PLN',
    dueDate: inv.paymentDueDate ?? inv.issueDate,
    method: mapPaymentMethodLabel(inv.paymentMethod),
    bankAccount: inv.bankAccount,
  };
}

/**
 * C5b: treść z pliku na górnym poziomie `fa3_data` — tam czytają ją JPK
 * (`data-fetcher`), PDF (`invoice-data`) i korekta (`correction-annotations`).
 * Bez `lines` na górze: z nimi szkic z importu dałoby się wysłać, a JPK
 * brałby pozycje z parsera zamiast z tabeli.
 */
export function contentFa3Fields(content: ImportContent): Record<string, unknown> {
  return {
    ...(content.annotations ? { annotations: content.annotations } : {}),
    ...(content.annotationProblems.length ? { annotationProblems: content.annotationProblems } : {}),
    ...(content.saleDates ? { saleDates: content.saleDates } : {}),
    ...(content.markers ? { ksefMarkers: content.markers } : {}),
  };
}

/**
 * `fa3_data` faktury z importu. `provenance` (pochodzenie zapisu, z czasem
 * podanym przez wywołującego) trafia do `fa3_data.import` bez zmian.
 */
export function buildImportFa3Json(
  inv: ParsedInvoice,
  provenance: Record<string, Json>,
  content: ImportContent,
  amounts: ImportLineAmounts,
): Json {
  return {
    import: provenance,
    parsed: inv,
    ...contentFa3Fields(content),
    // C5c: pola pozycji z pliku dla JPK_FA (P_9B, P_11A…) i powody zatrzymania kwot.
    // Nie w `contentFa3Fields` — uzupełnienie sprzed C5b nie przepisuje pozycji.
    ...(amounts.ksefLineFields ? { ksefLineFields: amounts.ksefLineFields } : {}),
    ...(amounts.problems.length ? { lineAmountProblems: amounts.problems } : {}),
    ...(amounts.totalsUnknown ? { lineAmountTotalsUnknown: true } : {}),
  } as unknown as Json;
}
