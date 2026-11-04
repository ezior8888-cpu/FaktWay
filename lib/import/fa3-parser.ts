/**
 * Parser XML faktur FA(3) — ekstrakcja kontrahentów, pozycji i kwot.
 * Dopasowany do emisji z `lib/xml/fa3-generator.ts` (wersja schemy 2025-06-25).
 *
 * C0b (GEN-RUNDA, spec D-A4-1b-3 v3, 5.10): plik z generatora FaktWay czyta się
 * bez strat i bez fałszywych ostrzeżeń (`tests/unit/import-runda-generator.test.ts`).
 * Dwa przypadki brzegowe identyfikatora nabywcy — FA(3) wyraża PESEL i „inny”
 * identyfikator tym samym `KodKraju` + `NrID`, więc `parseParty` odróżnia je
 * heurystyką (KodKraju brak albo PL, 11 cyfr, poprawna suma kontrolna PESEL → `pesel`;
 * inaczej `nrInny`), a wartość nigdy nie ginie:
 * (1) generator pisze przy PESEL `KodKraju` z adresu nabywcy (F16) — PESEL nabywcy
 *     z adresem zagranicznym wraca jako `nrInny` (ustalenie GEN-PESEL-KRAJ,
 *     poprawka generatora osobno);
 * (2) 11-cyfrowy NrInny (paszport, dowód) z poprawną sumą PESEL i `KodKraju` PL
 *     wraca jako `pesel` — FA(3) tego nie rozróżnia.
 */

import { XMLParser } from 'fast-xml-parser';
import { roundToCents, validatePeselChecksum } from '@/lib/xml/invoice-calculator';
import { FA3_NET_FIELDS, importVatRateFromFa3, type Fa3OnlyVatRate, type Fa3RateHeader } from '@/lib/xml/fa3-p12';
import type { VatRate } from '@/types/invoice';
import {
  displayRaw,
  readFa3Annotations,
  readFa3Markers,
  readTDataT,
  type Fa3Annotations,
  type Fa3Markers,
} from '@/lib/xml/fa3-annotations';
import type { ArchivedKsefXml } from './ksef-xml-archive';

// ============================================================================
// Typy wynikowe
// ============================================================================

export interface ParsedInvoice {
  ksefNumber?: string;
  /** Oryginał XML z KSeF w magazynie firmy (import historii) — do KODU I. */
  xmlArchive?: ArchivedKsefXml;
  invoiceNumber: string;
  issueDate: string;
  invoiceType: 'regular' | 'correction' | 'advance' | 'final';

  seller: ParsedParty;
  buyer: ParsedParty;

  lines: ParsedLine[];

  totals: {
    netTotal: number;
    vatTotal: number;
    grossTotal: number;
  };

  paymentDueDate?: string;
  /**
   * E11: `Platnosc/DataZaplaty` faktury z `Zaplacono = 1` — faktura
   * wystawiona po zapłacie. Trafia do `fa3_data.parsed`, skąd karty wpływów
   * biorą prawdziwy dzień zapłaty. Brak pola = plik nie mówi o zapłacie
   * (albo daty nie dało się odczytać — wtedy ostrzeżenie).
   */
  paidDate?: string;
  /** Zmapowana etykieta (np. przelew / gotówka) albo surowy kod z FormaPlatnosci. */
  paymentMethod?: string;
  bankAccount?: string;

  // ── C5b: treść, którą import dotąd gubił (pola opcjonalne — parsery JPK/CSV ich nie mają) ──
  /** Kod formularza z nagłówka („FA (3)”, „FA (2)”) — dowód; odczyt jest ten sam. */
  formCode?: string;
  /** P_6 — data dostawy / wykonania usługi wspólna dla pozycji. */
  saleDate?: string;
  /** OkresFa — okres, którego dotyczy faktura (P_6_Od, P_6_Do). */
  salePeriod?: { from: string; to: string };
  /** Daty sprzedaży z pliku, których nie dało się odczytać (P_6, OkresFa, P_6A). */
  saleDateProblems?: string[];
  /** Adnotacje z pliku — tylko odczytane pola (`lib/xml/fa3-annotations.ts`). */
  ksefAnnotations?: Fa3Annotations;
  /** Adnotacje i oznaczenia z pliku, których nie dało się odczytać. */
  annotationProblems?: string[];
  /** FP, TP, podmiot upoważniony, GTU, Procedura — JPK FaktWay ich nie wykazuje. */
  ksefMarkers?: Fa3Markers;
  /**
   * C5c: surowy tekst sum nagłówka (P_13_x, P_14_1…P_14_5, P_15) — źródło
   * prawdy dla netto i VAT każdej stawki (art. 106e ust. 7–9). Tylko z pliku XML.
   */
  ksefSums?: Partial<Record<string, string>>;
  /**
   * C0b: uwagi z pliku — pierwsza niepusta `Stopka/Informacje/StopkaFaktury`,
   * przycięta. Brak pola = plik bez uwag (nigdy pusty napis).
   */
  footerNote?: string;
  /** C0b: surowe `Fa/RodzajFaktury` (przycięte, wielkość liter z pliku); `invoiceType` to jego odwzorowanie. */
  invoiceTypeCode?: string;
  /**
   * Chwila nadania numeru w KSeF (`acquisitionDate`, zapasowo
   * `permanentStorageDate` z metadanych) — podaje synchronizacja historii
   * KSeF (decyzja Bartosza 22.10.2026; IMP-ACC). Parser XML jej nie ustawia
   * (plik FA(3) jej nie zawiera). Obecne pole = wywołujący zna ten czas:
   * poprawna data trafia do `ksef_accepted_at`, niepoprawna albo pusta —
   * chwila importu z ostrzeżeniem. Brak pola = zachowanie bez zmian.
   */
  ksefAcceptedAt?: string;

  warnings: string[];
}

export interface ParsedParty {
  nip?: string;
  /**
   * PESEL: `NrPESEL` (inne programy) albo `NrID` z `KodKraju` brak/PL, 11 cyframi
   * i poprawną sumą kontrolną PESEL (C0b, plik z generatora FaktWay).
   */
  pesel?: string;
  /** NrVatUE + KodUE jako „DEXXXXX” (bez spacji). */
  vatUeNumber?: string;
  /**
   * Inny identyfikator nabywcy (dowód, paszport, numer zagraniczny): `NrInny`
   * (inne programy) albo `NrID`, który nie jest PESEL-em (C0b). Zawsze tekst —
   * zera wiodące są częścią numeru.
   */
  nrInny?: string;
  brakId?: boolean;
  name: string;
  addressLine1?: string;
  addressLine2?: string;
  countryCode?: string;
  email?: string;
  /** C0b: `Podmiot2/JST` (1 = jednostka samorządu terytorialnego, 2 = nie dotyczy); brak = nie odczytano. */
  jst?: 1 | 2;
  /** C0b: `Podmiot2/GV` (1 = członek grupy VAT, 2 = nie dotyczy); brak = nie odczytano. */
  gv?: 1 | 2;
}

export interface ParsedLine {
  position: number;
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet: number;
  /**
   * Stawka do zapisu: stawka FaktWay („23”, „0”, „np_ii”…) z P_12, kod FA(3)
   * bez odpowiednika („0 WDT”, „0 EX”, „22”, „7”, „4”, „3”) albo „nieznana”
   * (`lib/xml/fa3-p12.ts`, W9). Nigdy surowe „0 KR” / „np I” / „np II”.
   */
  vatRate: string;
  /** Surowe P_12 z pliku (dowód); brak, gdy pozycja nie miała P_12. */
  p12?: string;
  netAmount: number;
  /** P_6A — data sprzedaży pozycji, gdy pozycje mają różne daty (C5b). */
  saleDate?: string;
  /**
   * C5c: surowy tekst kwot pozycji z pliku (P_8B, P_9A, P_9B, P_10, P_11,
   * P_11A, P_11Vat). Brak klucza = brak elementu. Kwoty liczy
   * `lib/import/fa3-line-amounts.ts` — tu tylko odczyt.
   */
  ksef?: Partial<Record<Fa3LineField, string>>;
}

export const FA3_LINE_FIELDS = ['P_8B', 'P_9A', 'P_9B', 'P_10', 'P_11', 'P_11A', 'P_11Vat'] as const;
export type Fa3LineField = (typeof FA3_LINE_FIELDS)[number];
const FA3_SUM_FIELDS = [...FA3_NET_FIELDS, 'P_14_1', 'P_14_2', 'P_14_3', 'P_14_4', 'P_14_5', 'P_15'] as const;

/** Tekst elementu (liczba z parsera → tekst); element złożony albo powtórzony → „?”, czyli nieczytelny. */
function rawText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '?';
}

function rawFields<K extends string>(node: Record<string, unknown>, fields: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const f of fields) {
    const v = rawText(node[f]);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

// ============================================================================
// Parser XML
// ============================================================================

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  // Wartości jako tekst: numer rachunku (26 cyfr), numer faktury „000123”
  // czy „1e3” nie mogą stać się liczbą (F-079). Kwoty czyta `parseNum`.
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/** Klucze netto wg sekwencji FA(3); brak pola = 0 przy sumowaniu. */
const FA_NET_KEYS = [
  'P_13_1',
  'P_13_2',
  'P_13_3',
  'P_13_4',
  'P_13_5',
  'P_13_6_1',
  'P_13_6_2',
  'P_13_6_3',
  'P_13_7',
  'P_13_8',
  'P_13_9',
  'P_13_10',
  'P_13_11',
] as const;

/** Typowe pola VAT przy stawkach 23 / 8 / 5 (+ ewentualne rozszerzenia). */
const FA_VAT_KEYS = [
  'P_14_1',
  'P_14_2',
  'P_14_3',
  'P_14_4',
  'P_14_5',
  'P_14_6',
  'P_14_7',
  'P_14_8',
  'P_14_9',
  'P_14_10',
  'P_14_11',
] as const;

const FORMA_PLATNOSCI_MAP: Record<string, string> = {
  '1': 'gotówka',
  '2': 'karta',
  '3': 'bon',
  '4': 'czek',
  '5': 'kredyt',
  '6': 'przelew',
  '7': 'przelew mobilny',
};

/**
 * Import przyjmuje tylko faktury w złotych.
 *
 * Kwoty faktury w walucie obcej (P_13_x, P_15, P_11) są w tej walucie, a baza
 * i KPiR trzymają złote — do 01.10.2026 parser czytał je jak złote: faktura na
 * 1 000 EUR wchodziła jako 1 000 zł przychodu. Przeliczenie wymaga kursu NBP
 * z dnia przed przychodem (art. 11a ust. 1 PIT), więc zamiast zgadywać,
 * odmawiamy z powodem — import JPK_FA pokazuje go w ostrzeżeniach.
 */
export function assertPlnCurrency(code: unknown): void {
  const currency = code == null ? 'PLN' : String(code).trim().toUpperCase();
  if (currency !== '' && currency !== 'PLN') {
    throw new Error(
      `faktura w walucie ${currency} — import obsługuje tylko złote; dodaj ją ręcznie z kwotami przeliczonymi kursem NBP`,
    );
  }
}

export function parseFa3Xml(xmlContent: string, options?: { ksefNumber?: string }): ParsedInvoice {
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = xmlParser.parse(xmlContent);
  } catch (e) {
    throw new Error(`XML parse error: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  const root = extractFakturaRoot(parsed);
  if (!root) {
    throw new Error('Brak elementu Faktura w XML — oczekiwany format FA(3)');
  }

  const faRaw = root.Fa;
  if (!faRaw || typeof faRaw !== 'object') {
    throw new Error('Brak sekcji Fa w fakturze');
  }

  const fa = faRaw as Record<string, unknown>;

  assertPlnCurrency(fa.KodWaluty);

  const invoiceType = mapRodzajFaktury(String(fa.RodzajFaktury ?? 'VAT'));

  const invoiceNumber = String(fa.P_2 ?? '');
  const issueDate = String(fa.P_1 ?? '').slice(0, 10);

  if (!invoiceNumber) warnings.push('Brak numeru faktury (P_2)');
  if (!issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    warnings.push(`Niepewna lub brakująca data wystawienia (P_1): ${fa.P_1 ?? ''}`);
  }

  const seller = parseParty(root.Podmiot1, warnings, 'Sprzedawca');
  const buyer = parseParty(root.Podmiot2, warnings, 'Nabywca');

  // C5b: kod formularza tylko jako dowód — FA(2) i FA(3) mają te same nazwy
  // P_6 / OkresFa / P_6A / Adnotacje, a przestrzeń nazw parser pomija.
  const formCode = readFormCode(root.Naglowek);
  if (formCode && formCode !== 'FA (3)' && formCode !== 'FA (2)') {
    warnings.push(`Plik w formacie „${formCode}” — odczytany jak FA(3); sprawdź datę sprzedaży i adnotacje z oryginałem`);
  }

  // C5b: data sprzedaży — nieczytelna nigdy nie przechodzi jako data.
  const saleDateProblems: string[] = [];
  const readDate = (raw: unknown, label: string): string | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const date = readTDataT(raw);
    if (!date) saleDateProblems.push(`${label} ${displayRaw(raw)}`);
    return date ?? undefined;
  };
  const saleDate = readDate(fa.P_6, 'P_6');
  let salePeriod: ParsedInvoice['salePeriod'];
  if (fa.OkresFa !== undefined && fa.OkresFa !== null) {
    const okres = (fa.OkresFa && typeof fa.OkresFa === 'object' && !Array.isArray(fa.OkresFa) ? fa.OkresFa : {}) as Record<string, unknown>;
    const from = readDate(okres.P_6_Od, 'P_6_Od');
    const to = readDate(okres.P_6_Do, 'P_6_Do');
    if (from && to && from <= to) salePeriod = { from, to };
    else if (from && to) saleDateProblems.push(`OkresFa: P_6_Od ${from} po P_6_Do ${to}`);
    else if (okres.P_6_Od === undefined || okres.P_6_Do === undefined) saleDateProblems.push('OkresFa bez P_6_Od albo P_6_Do');
    if (fa.P_6 !== undefined && fa.P_6 !== null) saleDateProblems.push('P_6 i OkresFa naraz');
  }

  const wiersze = ensureArray(fa.FaWiersz as unknown[] | Record<string, unknown> | undefined);
  const wierszeNodes = wiersze.map((wRaw) => (wRaw && typeof wRaw === 'object' ? wRaw : {}) as Record<string, unknown>);
  const rateHeader = rateHeaderFromFa(fa);
  const lines: ParsedLine[] = wierszeNodes.map((w, idx) => {
    const pos = Number(w.NrWierszaFa) || idx + 1;
    const p12 = w.P_12 == null ? undefined : String(w.P_12);
    const lineSaleDate = readDate(w.P_6A, `P_6A (pozycja ${pos})`);
    return {
      position: pos,
      name: String(w.P_7 ?? ''),
      unit: String(w.P_8A ?? 'szt.'),
      quantity: parseNum(w.P_8B),
      unitPriceNet: parseNum(w.P_9A),
      // W9: stawka FaktWay zamiast surowego P_12; bez P_12 — z nagłówka albo
      // „nieznana”, nigdy domyślne 23%.
      vatRate: importVatRateFromFa3(p12, rateHeader),
      ...(p12 !== undefined ? { p12 } : {}),
      netAmount: parseNum(w.P_11),
      ...(lineSaleDate ? { saleDate: lineSaleDate } : {}),
      ksef: rawFields(w, FA3_LINE_FIELDS),
    };
  });
  if (saleDateProblems.length) warnings.push(`Nieczytelna data sprzedaży: ${saleDateProblems.join('; ')}`);

  // C5b: Adnotacje i oznaczenia — każdy problem zatrzyma fakturę w JPK.
  const { annotations: ksefAnnotations, problems: adnotacjeProblems } = readFa3Annotations(fa.Adnotacje);
  const { markers: ksefMarkers, problems: markerProblems } = readFa3Markers(root, fa, wierszeNodes);
  const annotationProblems = [...adnotacjeProblems, ...markerProblems];
  if (annotationProblems.length) warnings.push(`Nieczytelne adnotacje KSeF: ${annotationProblems.join('; ')}`);

  if (lines.length === 0 && invoiceType !== 'correction') {
    warnings.push('Brak pozycji (FaWiersz)');
  }

  // C0b: uwagi i surowy rodzaj faktury — bez nich zapisany wiersz byłby uboższy niż plik.
  const footerNote = readFooterNote(root.Stopka);
  const invoiceTypeCode = readText(fa.RodzajFaktury);

  const totalsHeader = summarizeTotalsFromFa(fa);
  const totalsFromLines = summarizeTotalsFromLines(lines);
  const totals = pickTotals(totalsHeader, totalsFromLines, lines, warnings);

  const platnosc = fa.Platnosc;
  const { paymentDueDate, paidDate, paymentMethod, bankAccount } = parsePlatnosc(platnosc, warnings);

  // Jeden literał wyniku — z numerem KSeF i bez (szkic z pliku) te same pola.
  return {
    ...(options?.ksefNumber ? { ksefNumber: options.ksefNumber } : {}),
    invoiceNumber,
    issueDate,
    invoiceType,
    seller,
    buyer,
    lines,
    totals,
    paymentDueDate,
    ...(paidDate ? { paidDate } : {}),
    paymentMethod,
    bankAccount,
    ...(formCode ? { formCode } : {}),
    ...(saleDate ? { saleDate } : {}),
    ...(salePeriod ? { salePeriod } : {}),
    ...(saleDateProblems.length ? { saleDateProblems } : {}),
    ksefAnnotations,
    ...(annotationProblems.length ? { annotationProblems } : {}),
    ...(ksefMarkers ? { ksefMarkers } : {}),
    ksefSums: rawFields(fa, FA3_SUM_FIELDS),
    ...(footerNote ? { footerNote } : {}),
    ...(invoiceTypeCode ? { invoiceTypeCode } : {}),
    warnings,
  };
}

/** Tekst elementu przycięty; brak, pusty albo element złożony → `undefined`. */
function readText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return text === '' ? undefined : text;
}

/**
 * C0b: uwagi faktury — pierwsza niepusta `Stopka/Informacje/StopkaFaktury`
 * (w kolejności pliku), przycięta. Brak `Stopka`, `Informacje` albo tekstu → `undefined`.
 */
function readFooterNote(stopka: unknown): string | undefined {
  if (!stopka || typeof stopka !== 'object') return undefined;
  const informacje = ensureArray((stopka as Record<string, unknown>).Informacje as unknown[] | Record<string, unknown> | undefined);
  for (const info of informacje) {
    if (!info || typeof info !== 'object') continue;
    for (const note of ensureArray((info as Record<string, unknown>).StopkaFaktury as unknown[] | string | undefined)) {
      const text = readText(note);
      if (text) return text;
    }
  }
  return undefined;
}

/** `Naglowek/KodFormularza/@kodSystemowy` („FA (3)”, „FA (2)”). */
function readFormCode(naglowek: unknown): string | undefined {
  if (!naglowek || typeof naglowek !== 'object') return undefined;
  const kod = (naglowek as Record<string, unknown>).KodFormularza;
  if (!kod || typeof kod !== 'object') return undefined;
  const code = (kod as Record<string, unknown>)['@_kodSystemowy'];
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

// ============================================================================
// Rodzaj faktury
// ============================================================================

function mapRodzajFaktury(rodzajFaktury: string): ParsedInvoice['invoiceType'] {
  const r = rodzajFaktury.trim().toUpperCase();
  switch (r) {
    case 'KOR':
    case 'KOR_ZAL':
    case 'KOR_ROZ':
      return 'correction';
    case 'ZAL':
      return 'advance';
    case 'ROZ':
      return 'final';
    case 'VAT':
    case 'UPR':
    default:
      return 'regular';
  }
}

// ============================================================================
// Podmioty
// ============================================================================

function parseParty(
  podmiot: unknown,
  warnings: string[],
  partyLabel: string,
): ParsedParty {
  if (!podmiot || typeof podmiot !== 'object') {
    warnings.push(`Brak danych: ${partyLabel}`);
    return { name: 'Nieznany' };
  }

  const pm = podmiot as Record<string, unknown>;
  const dane = (pm.DaneIdentyfikacyjne ?? {}) as Record<string, unknown>;
  const adres = (pm.Adres ?? {}) as Record<string, unknown>;
  const isBuyer = partyLabel === 'Nabywca';

  const nip = dane.NIP != null && String(dane.NIP).trim() !== '' ? String(dane.NIP).trim() : undefined;

  let pesel: string | undefined;
  if (dane.NrPESEL != null && String(dane.NrPESEL).trim() !== '') {
    pesel = String(dane.NrPESEL).trim();
  }

  // C0b: FA(3) Podmiot2 nie ma NrPESEL — PESEL i „inny” identyfikator nabywcy to
  // `[KodKraju] + NrID` (tak pisze go `buildBuyerChoice` w generatorze). PESEL to
  // NrID bez KodKraju albo z PL, 11 cyfr i poprawną sumą kontrolną; wszystko inne
  // — `nrInny`. Wartość zostaje tekstem (zera wiodące) i nigdy nie ginie; dwa
  // przypadki, w których heurystyka myli rodzaj, opisuje nagłówek pliku.
  // NrPESEL / NrInny (inne programy) czytane dalej; schemat dopuszcza jeden
  // identyfikator, więc kolejność pierwszeństwa dotyczy tylko plików niezgodnych z XSD.
  let nrIdAsNrInny: string | undefined;
  if (isBuyer && dane.NrID != null && String(dane.NrID).trim() !== '') {
    const nrId = String(dane.NrID).trim();
    const nrIdCountry = dane.KodKraju != null ? String(dane.KodKraju).trim().toUpperCase() : '';
    if ((nrIdCountry === '' || nrIdCountry === 'PL') && validatePeselChecksum(nrId)) pesel ??= nrId;
    else nrIdAsNrInny = nrId;
  }

  let vatUeNumber: string | undefined;
  if (dane.KodUE != null && dane.NrVatUE != null) {
    vatUeNumber = `${String(dane.KodUE).trim()}${String(dane.NrVatUE).trim()}`;
  }

  const nrInny =
    dane.NrInny != null && String(dane.NrInny).trim() !== ''
      ? String(dane.NrInny).trim()
      : nrIdAsNrInny;

  const brakId =
    dane.BrakID != null &&
    (dane.BrakID === 1 ||
      dane.BrakID === '1' ||
      String(dane.BrakID).toLowerCase() === 'true');

  const nazwaRaw = dane.Nazwa ?? dane.ImieINazwisko ?? '';
  const name = String(nazwaRaw ?? '').trim() || 'Nieznany';

  if (
    isBuyer &&
    !nip &&
    !pesel &&
    !vatUeNumber &&
    !nrInny &&
    !brakId
  ) {
    warnings.push(`${partyLabel}: brak identyfikatora (NIP / PESEL / UE / NrInny / BrakID)`);
  }

  // C0b: JST i GV to elementy Podmiot2 (obligatoryjne w XSD); wartość inna niż 1|2 = nieodczytana.
  const jst = isBuyer ? readJstGv(pm.JST) : undefined;
  const gv = isBuyer ? readJstGv(pm.GV) : undefined;

  let email: string | undefined;
  const kontakt = pm.DaneKontaktowe;
  if (kontakt && typeof kontakt === 'object') {
    const k = kontakt as Record<string, unknown>;
    if (k.Email != null && String(k.Email).trim()) {
      email = String(k.Email).trim();
    }
  }

  return {
    nip,
    pesel,
    vatUeNumber,
    nrInny,
    brakId: brakId || undefined,
    name,
    addressLine1: adres.AdresL1 ? String(adres.AdresL1) : undefined,
    addressLine2: adres.AdresL2 ? String(adres.AdresL2) : undefined,
    countryCode: adres.KodKraju ? String(adres.KodKraju) : 'PL',
    email,
    ...(jst ? { jst } : {}),
    ...(gv ? { gv } : {}),
  };
}

/** `JST` / `GV` (TWybor1-2): „1” albo „2”; inaczej `undefined`. */
function readJstGv(raw: unknown): 1 | 2 | undefined {
  const value = readText(raw);
  return value === '1' ? 1 : value === '2' ? 2 : undefined;
}

// ============================================================================
// Pozycje / kwoty
// ============================================================================

/** Sumy nagłówka i zwolnienie (P_19) — do ustalenia stawki pozycji bez P_12 (W9). */
function rateHeaderFromFa(fa: Record<string, unknown>): Fa3RateHeader {
  const nets: Fa3RateHeader['nets'] = {};
  for (const field of FA3_NET_FIELDS) {
    if (fa[field] != null && String(fa[field]).trim() !== '') nets[field] = parseNum(fa[field]);
  }
  const adnotacje = (fa.Adnotacje && typeof fa.Adnotacje === 'object' ? fa.Adnotacje : {}) as Record<string, unknown>;
  const zwolnienie = (adnotacje.Zwolnienie && typeof adnotacje.Zwolnienie === 'object' ? adnotacje.Zwolnienie : {}) as Record<string, unknown>;
  return {
    nets,
    vats: { P_14_1: optionalNum(fa.P_14_1), P_14_2: optionalNum(fa.P_14_2) },
    exempt: String(zwolnienie.P_19 ?? '').trim() === '1',
  };
}

function summarizeTotalsFromFa(fa: Record<string, unknown>): {
  grossTotal?: number;
  netTotal?: number;
  /** C0b: Σ P_13_x w groszach całkowitych (porównania bez błędu zmiennoprzecinkowego); brak P_13_x = `undefined`. */
  netCents?: number;
  vatTotal?: number;
} {
  const grossTotal = optionalNum(fa.P_15);

  let netTotal = 0;
  let netCents = 0;
  let hasNetKey = false;
  for (const k of FA_NET_KEYS) {
    if (fa[k] != null && String(fa[k]).trim() !== '') {
      hasNetKey = true;
      netTotal += parseNum(fa[k]);
      netCents += toCents(parseNum(fa[k]));
    }
  }

  let vatTotal = 0;
  let hasVatKey = false;
  for (const k of FA_VAT_KEYS) {
    if (fa[k] != null && String(fa[k]).trim() !== '') {
      hasVatKey = true;
      vatTotal += parseNum(fa[k]);
    }
  }

  return {
    grossTotal,
    netTotal: hasNetKey ? netTotal : undefined,
    netCents: hasNetKey ? netCents : undefined,
    vatTotal: hasVatKey ? vatTotal : undefined,
  };
}

function summarizeTotalsFromLines(lines: ParsedLine[]): {
  netTotal: number;
  vatTotal: number;
} {
  let netTotal = 0;
  for (const l of lines) netTotal += l.netAmount;
  return {
    netTotal,
    /** Brak pola VAT po linii w FA bez rozbicia — przy sumach z pozycji dajemy 0. */
    vatTotal: 0,
  };
}

/**
 * Stawki pozycji bez podatku: stawki FaktWay (0 KR, zw, oo, np I, np II) i kody FA(3)
 * spoza FaktWay (0 WDT, 0 EX) — plik z samymi takimi pozycjami nie ma `P_14_x`.
 */
const NO_VAT_LINE_RATES: ReadonlySet<string> = new Set<VatRate | Fa3OnlyVatRate>([
  '0',
  '0 WDT',
  '0 EX',
  'zw',
  'oo',
  'np',
  'np_ii',
]);

/** Złote (kwota z pliku, najwyżej 2 miejsca po przecinku) → grosze całkowite. */
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function pickTotals(
  fromFa: { grossTotal?: number; netTotal?: number; netCents?: number; vatTotal?: number },
  fromLines: { netTotal: number; vatTotal: number },
  lines: readonly ParsedLine[],
  warnings: string[],
): ParsedInvoice['totals'] {
  // C0b GR-4: plik bez żadnego `P_14_x`, w którym każda pozycja ma stawkę bez podatku, a P_15
  // różni się od Σ P_13_x najwyżej o grosz (porównanie w groszach całkowitych) — to nie brak
  // danych, tylko faktura bez VAT: VAT 0, netto z nagłówka, bez ostrzeżenia. Pozycja z podatkiem
  // bez `P_14_x`, brak P_15 albo większa różnica — dalej jak przedtem (ostrzeżenie zostaje).
  if (
    fromFa.vatTotal === undefined &&
    fromFa.netTotal !== undefined &&
    fromFa.netCents !== undefined &&
    fromFa.grossTotal !== undefined &&
    lines.length > 0 &&
    lines.every((line) => NO_VAT_LINE_RATES.has(line.vatRate)) &&
    Math.abs(toCents(fromFa.grossTotal) - fromFa.netCents) <= 1
  ) {
    return { netTotal: roundCents(fromFa.netTotal), vatTotal: 0, grossTotal: fromFa.grossTotal };
  }

  let grossTotal = fromFa.grossTotal ?? 0;
  let netTotal = fromFa.netTotal;
  let vatTotal = fromFa.vatTotal;

  if (netTotal === undefined || vatTotal === undefined) {
    if (fromLines.netTotal > 0) {
      if (netTotal === undefined) {
        warnings.push(
          'Brak lub niekompletne sum P_13_*/P_14_* w nagłówku — przyjęto sumę netto z pozycji',
        );
        netTotal = fromLines.netTotal;
      }
      if (vatTotal === undefined && grossTotal > 0 && netTotal != null) {
        vatTotal = Math.max(0, roundCents(grossTotal - netTotal));
        warnings.push('VAT przybliżony jako brutto − netto z pozycji');
      }
    }
  }

  netTotal ??= fromLines.netTotal;
  vatTotal ??= 0;

  if (!grossTotal && netTotal + vatTotal > 0) {
    grossTotal = roundCents(netTotal + vatTotal);
    warnings.push('Brak P_15 — brutto przyjęto jako netto + VAT');
  }

  grossTotal ||= roundCents(netTotal + vatTotal);

  const calcGross = roundCents(netTotal + vatTotal);
  if (grossTotal > 0 && Math.abs(calcGross - grossTotal) > 0.02) {
    warnings.push(
      `Możliwa niezgodność kwot nagłówka: netto+VAT=${calcGross.toFixed(2)} vs brutto(P_15)=${grossTotal.toFixed(2)}`,
    );
  }

  return { netTotal: roundCents(netTotal), vatTotal: roundCents(vatTotal), grossTotal };
}

// ============================================================================
// Płatność
// ============================================================================

function parsePlatnosc(
  platnosc: unknown,
  warnings: string[],
): Pick<ParsedInvoice, 'paymentDueDate' | 'paidDate' | 'paymentMethod' | 'bankAccount'> {
  if (!platnosc || typeof platnosc !== 'object') {
    return {};
  }

  const p = platnosc as Record<string, unknown>;

  let paymentDueDate: string | undefined;
  const blokList = ensureArray(
    p.TerminPlatnosci as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  for (const blok of blokList) {
    if (!blok || typeof blok !== 'object') continue;
    const rawTerm = (blok as Record<string, unknown>).Termin;
    const terms = ensureArray(rawTerm as string | string[] | undefined);
    const head = terms[0];
    if (head != null && String(head).trim() !== '') {
      paymentDueDate = String(head).trim().slice(0, 10);
      break;
    }
  }

  if (paymentDueDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDueDate)) {
    warnings.push(`Nieczytelny termin płatności: ${paymentDueDate}`);
  }

  // E11: „Zaplacono = 1” + „DataZaplaty” — faktura opłacona przed wystawieniem.
  // Daty, której nie da się odczytać, nie zgadujemy: ostrzeżenie i brak pola.
  let paidDate: string | undefined;
  if (String(p.Zaplacono ?? '').trim() === '1' && p.DataZaplaty != null) {
    const raw = String(p.DataZaplaty).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) paidDate = raw;
    else warnings.push(`Nieczytelna data zapłaty: ${raw}`);
  }

  let paymentMethod: string | undefined;
  if (p.PlatnoscInna === 1 || p.PlatnoscInna === '1') {
    paymentMethod =
      typeof p.OpisPlatnosci === 'string' && p.OpisPlatnosci.trim()
        ? `inna: ${String(p.OpisPlatnosci).trim()}`
        : 'inna';
  } else if (p.FormaPlatnosci != null) {
    const code = String(p.FormaPlatnosci).trim();
    paymentMethod = FORMA_PLATNOSCI_MAP[code] ?? `FormaPlatnosci=${code}`;
  }

  let bankAccount: string | undefined;
  const rach = p.RachunekBankowy;
  const rachList = ensureArray(
    rach as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  if (rachList.length) {
    const first = rachList[0] && typeof rachList[0] === 'object' ? rachList[0] : undefined;
    if (first && 'NrRB' in first && first.NrRB != null) {
      bankAccount = String(first.NrRB).replace(/\s+/g, '');
    }
  }

  return {
    paymentDueDate,
    ...(paidDate ? { paidDate } : {}),
    paymentMethod,
    bankAccount,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function extractFakturaRoot(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const o = parsed as Record<string, unknown>;
  if ('Faktura' in o && o.Faktura && typeof o.Faktura === 'object') {
    return o.Faktura as Record<string, unknown>;
  }

  const keys = Object.keys(o);
  const faktKey = keys.find((k) => k === 'Faktura' || k.endsWith(':Faktura') || /\bFaktura$/u.test(k));
  if (faktKey && o[faktKey] && typeof o[faktKey] === 'object') {
    return o[faktKey] as Record<string, unknown>;
  }

  return null;
}

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseNum(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).replace(',', '.').replace(/\s+/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function optionalNum(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || String(raw).trim() === '') return undefined;
  const n = parseNum(raw);
  return n !== 0 || String(raw).trim() === '0' ? n : undefined;
}

function roundCents(n: number): number {
  return roundToCents(n);
}
