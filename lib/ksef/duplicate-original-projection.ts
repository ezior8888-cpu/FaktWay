/**
 * Projekcja oryginału K do zapisu w FaktWay (D-A4-1b-3 PR C, spec v3 5.3):
 * nagłówek i pozycje faktury z KSeF zbudowane tymi samymi budowniczymi co
 * Magiczny import (`lib/import/imported-invoice-row.ts`, PR C0), przekazywane
 * do `decide_ksef_duplicate_original` jako `p_import` (jsonb). Kolumny stałe
 * (origin, status, środowisko, K, ścieżka pliku, data nadania, waluta, rodzaj)
 * ustawia SQL — projekcja ich nie niesie (`ORIGINAL_IMPORT_SQL_COLUMNS`).
 *
 * `originalImportProjectionProblem` to lustro `ksef_original_import_mismatch`
 * (00156, 4.8): te same kody w tej samej kolejności, wspólna tabela przypadków
 * `originalImportMismatchCases()` (test TS i R-C6 na bazie). Listy kluczy
 * i stawek niżej = listy w SQL 4.8 (pilnuje `tests/unit/zapis-oryginalu-migracja.test.ts`).
 *
 * CZYSTY moduł (importują go testy bazy i testy jednostkowe bez atrap
 * `server-only`): bez bazy, magazynu i zegara — czas podaje wywołujący (`now`).
 */

import type { ImportContent } from '@/lib/import/fa3-content';
import type { ImportLineAmounts } from '@/lib/import/fa3-line-amounts';
import type { ParsedInvoice } from '@/lib/import/fa3-parser';
import {
  buildImportedInvoiceRow,
  buildImportedLineRows,
  type ImportedInvoiceInsert,
  type ImportedLineInsert,
} from '@/lib/import/imported-invoice-row';
import { FA3_ONLY_VAT_RATES, VAT_RATES } from '@/lib/xml/fa3-p12';
import type { Json } from '@/types/database';
import type { KsefEnvironment } from '@/types/ksef';

import {
  ORIGINAL_GATE_RULES,
  ORIGINAL_IMPORT_SOURCE,
  type DuplicateOriginalOffer,
  type KsefDuplicateCheck,
} from './duplicate-check';

/**
 * Kolumny `buildImportedInvoiceRow`, które przy zapisie K ustawia SQL
 * (4.6 krok 11), a nie projekcja.
 */
export const ORIGINAL_IMPORT_SQL_COLUMNS = [
  'tenant_id',
  'direction',
  'origin',
  'ksef_status',
  'ksef_environment',
  'ksef_accepted_at',
  'ksef_number',
  'invoice_kind',
  'currency',
  'xml_storage_path',
] as const satisfies ReadonlyArray<keyof ImportedInvoiceInsert>;
type OriginalImportSqlColumn = (typeof ORIGINAL_IMPORT_SQL_COLUMNS)[number];

/** Klucze nagłówka projekcji: wszystkie kolumny C0 poza SQL-owymi — kompilacja pada, gdy C0 dostanie nową kolumnę. */
export type OriginalImportInvoiceKey = Exclude<keyof ImportedInvoiceInsert, OriginalImportSqlColumn>;
/** Klucze pozycji projekcji: dokładnie `ImportedLineInsert` z C0 (bez `invoice_id`). */
export type OriginalImportLineKey = keyof ImportedLineInsert;

// `Record` po typie kluczy C0 wymusza komplet (brakujący albo nadmiarowy klucz = błąd kompilacji);
// kolejność wpisów = kolejność listy w 4.8.
const INVOICE_KEY_SET: Readonly<Record<OriginalImportInvoiceKey, true>> = {
  internal_number: true,
  invoice_type: true,
  issue_date: true,
  sale_date: true,
  seller_nip: true,
  buyer_nip: true,
  net_total: true,
  vat_total: true,
  gross_total: true,
  payment_due_date: true,
  fa3_data: true,
  seller_data: true,
  buyer_data: true,
  payment_data: true,
  is_b2c: true,
  buyer_id_type: true,
  buyer_pesel: true,
  buyer_id_number: true,
  notes: true,
};

const LINE_KEY_SET: Readonly<Record<OriginalImportLineKey, true>> = {
  ordinal: true,
  name: true,
  unit: true,
  quantity: true,
  unit_price_net: true,
  net_amount: true,
  vat_rate: true,
  vat_amount: true,
  gross_amount: true,
};

/** Klucze `p_import->'invoice'` (4.8 `shape`) — podzbiór `ImportedInvoiceInsert` z C0. */
export const ORIGINAL_IMPORT_INVOICE_KEYS = Object.keys(INVOICE_KEY_SET) as readonly OriginalImportInvoiceKey[];
/** Klucze `p_import->'lines'[]` (4.8 `lines`) = klucze `ImportedLineInsert` z C0. */
export const ORIGINAL_IMPORT_LINE_KEYS = Object.keys(LINE_KEY_SET) as readonly OriginalImportLineKey[];

/** Stawki przyjmowane przez 4.8: FaktWay zawsze, FA(3) spoza FaktWay tylko przy ofercie `review-*` (F42); `nieznana` nigdy. */
export const ORIGINAL_IMPORT_VAT_RATES = { faktflow: VAT_RATES, reviewOnly: FA3_ONLY_VAT_RATES } as const;

/** `buyer_id_type` przyjmowane przez 4.8 `shape` (enum bazy). */
export const ORIGINAL_IMPORT_BUYER_ID_TYPES = ['nip', 'pesel', 'id_card', 'passport', 'no_id'] as const;

/** Granice z tabeli 4.8 (`shape`, `lines`) — wspólne dla lustra TS i SQL. */
export const ORIGINAL_IMPORT_LIMITS = {
  /** Liczba pozycji ∈ [1, 1000]. */
  maxLines: 1000,
  /** `internal_number` — napis 1–100 znaków. */
  internalNumberMax: 100,
  /** `buyer_id_number` — napis ≤ 100. */
  buyerIdNumberMax: 100,
  /** `notes` — napis ≤ 5000. */
  notesMax: 5000,
  /** `name` pozycji — napis 1–512. */
  lineNameMax: 512,
  /** `unit` pozycji — napis 1–50. */
  lineUnitMax: 50,
  /** `ordinal` — liczba całkowita 1–100000, bez powtórzeń. */
  ordinalMax: 100000,
  /** |kwota|, |ilość| < 1e10. */
  amountAbsBelow: 1e10,
  /** Miejsca po przecinku: kwoty (netto, VAT, brutto, sumy) 2; ilość i cena 4. */
  amountScale: 2,
  quantityScale: 4,
} as const;

/** Kody `ksef_original_import_mismatch` w kolejności sprawdzeń 4.8 (pierwszy niezgodny wygrywa). */
export const ORIGINAL_IMPORT_PROBLEMS = [
  'shape',
  'lines',
  'number',
  'seller',
  'kind',
  'issue-date',
  'gross',
  'buyer',
  'currency',
  'xml',
  'totals',
  'fa3',
] as const;
export type OriginalImportProblem = (typeof ORIGINAL_IMPORT_PROBLEMS)[number];

/**
 * Klasa „klient” (4.8): RPC odmawia P0001 `IMPORT_MISMATCH`
 * (`DETAIL = 'import-mismatch:<kod>'`); pozostałe kody — 22023
 * (`DETAIL = 'import-projection:<kod>'`, błąd programu).
 */
export const ORIGINAL_IMPORT_CLIENT_PROBLEMS = ['number', 'seller'] as const satisfies readonly OriginalImportProblem[];

/** `p_import` dla `decide_ksef_duplicate_original` w trybie `import` (5.3). */
export interface KsefOriginalImportProjection {
  v: 1;
  invoice: Pick<ImportedInvoiceInsert, OriginalImportInvoiceKey>;
  lines: Array<Pick<ImportedLineInsert, OriginalImportLineKey>>;
  xml: { storage_path: string; sha256: string; size_bytes: number };
}

export interface OriginalImportProjectionContext {
  tenantId: string;
  env: KsefEnvironment;
  /** `original_check` znacznika (`archivePath`, `sha256`, `sizeBytes`, `acquiredAt`, `checkedAt`). */
  check: KsefDuplicateCheck;
  /** K. */
  ksefNumber: string;
  /** Czas przygotowania (`fa3_data.import.preparedAt`). */
  now: Date;
}

export interface OriginalImportProblemContext {
  /** Numer X (`p_inv.internal_number`); `null` → `number`. */
  internalNumber: string | null;
  /** `tenants.nip` firmy. */
  tenantNip: string;
  tenantId: string;
  /** K. */
  ksefNumber: string;
  /** `original_check` znacznika (`summary`, `archivePath`, `sha256`, `sizeBytes`). */
  check: KsefDuplicateCheck;
  /** Oferta: `pair`/`record` — 8 stawek FaktWay; `review-*` — także `FA3_ONLY_VAT_RATES`. */
  offer: DuplicateOriginalOffer;
}


// ─── Projekcja K ─────────────────────────────────────────────────────────────

/** Zawęża obiekt do wskazanych kluczy (typ wyniku pilnuje kompletu). */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}

/**
 * Projekcja K (5.3): `buildImportedInvoiceRow(parsed, { tenantId, direction:
 * 'outgoing', origin: 'ksef_import', ksefStatus: 'accepted', ksefEnvironment:
 * env, ksefAcceptedAt: check.acquiredAt, ksefNumber: K, xmlStoragePath:
 * check.archivePath, notes: parsed.footerNote ?? null, provenance: { source:
 * ORIGINAL_IMPORT_SOURCE, originalSha256, checkedAt, preparedAt, gateRules } },
 * content, amounts)` zawężone do `ORIGINAL_IMPORT_INVOICE_KEYS`;
 * `lines = buildImportedLineRows(parsed, amounts)`; `xml` z `check`.
 * Bez upsertu kontrahentów i produktów.
 *
 * Warunek wstępny: `check` niesie `archivePath`, `sha256` i `sizeBytes` (plik
 * jest w archiwum i zgadza się ze skrótem — to sprawdza `prepareOriginalImport`
 * PRZED budową). Znacznik bez nich to błąd programu, a nie plik do oceny, więc
 * funkcja rzuca zamiast zgadywać wartości.
 */
export function buildOriginalImportProjection(
  parsed: ParsedInvoice,
  content: ImportContent,
  amounts: ImportLineAmounts,
  ctx: OriginalImportProjectionContext,
): KsefOriginalImportProjection {
  const { check } = ctx;
  if (check.archivePath === null || check.sha256 === null || check.sizeBytes === null) {
    throw new Error('Projekcja oryginału: znacznik bez archivePath, sha256 albo sizeBytes');
  }
  const provenance: Record<string, Json> = {
    source: ORIGINAL_IMPORT_SOURCE,
    originalSha256: check.sha256,
    checkedAt: check.checkedAt,
    preparedAt: ctx.now.toISOString(),
    gateRules: ORIGINAL_GATE_RULES,
  };
  const row = buildImportedInvoiceRow(
    parsed,
    {
      tenantId: ctx.tenantId,
      direction: 'outgoing',
      origin: 'ksef_import',
      ksefStatus: 'accepted',
      ksefEnvironment: ctx.env,
      ksefAcceptedAt: check.acquiredAt,
      ksefNumber: ctx.ksefNumber,
      xmlStoragePath: check.archivePath,
      notes: parsed.footerNote ?? null,
      provenance,
    },
    content,
    amounts,
  );
  return {
    v: 1,
    invoice: pick(row, ORIGINAL_IMPORT_INVOICE_KEYS),
    lines: buildImportedLineRows(parsed, amounts).map((line) => pick(line, ORIGINAL_IMPORT_LINE_KEYS)),
    xml: { storage_path: check.archivePath, sha256: check.sha256, size_bytes: check.sizeBytes },
  };
}

// ─── Lustro 4.8: pomocniki o semantyce PostgreSQL na DOWOLNYM jsonb ──────────
// Każde sprawdzenie typu poprzedza odczyt wartości, więc funkcja nie rzuca na
// żadnym kształcie wejścia (jak SQL: `jsonb_typeof` przed rzutem). Brak klucza
// i JSON `null` to to samo co SQL-owy NULL (`->>` je zlewa, a
// `jsonb_populate_record` wstawia NULL).

type Rec = Readonly<Record<string, unknown>>;

const NO_FIELDS: Rec = {};

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Odczyt własnego klucza (bez łańcucha prototypów); brak klucza = `undefined`. */
const own = (rec: Rec, key: string): unknown => (Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined);

const hasKey = (rec: Rec, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);

const asRecord = (value: unknown): Rec => (isRecord(value) ? value : NO_FIELDS);

const isNil = (value: unknown): value is null | undefined => value === null || value === undefined;

/** `char_length`: znaki Unicode (punkty kodowe), nie jednostki UTF-16. */
const charLength = (text: string): number => Array.from(text).length;

const isTextOfLength = (value: unknown, min: number, max: number): value is string => {
  if (typeof value !== 'string') return false;
  const length = charLength(value);
  return length >= min && length <= max;
};

/** `btrim(x)`: PostgreSQL obcina domyślnie same spacje (nie tabulatory, nie nowe linie). */
function pgBtrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === ' ') start += 1;
  while (end > start && text[end - 1] === ' ') end -= 1;
  return text.slice(start, end);
}

/** `left(x, 10)`: pierwsze 10 znaków (punktów kodowych). */
const left10 = (text: string): string => Array.from(text).slice(0, 10).join('');

/** Liczba bez zapisu wykładniczego (jak tekst `numeric` w PostgreSQL: `1e21` → `1000…0`). */
function plainDecimal(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign = '', integer = '', fraction = '', exponent = '0'] = match;
  const digits = integer + fraction;
  const point = integer.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Liczba miejsc po przecinku w zapisie, który i tak poleci do bazy (najkrótszy zapis JSON liczby). */
function decimalPlaces(value: number): number {
  const text = plainDecimal(Math.abs(value));
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * `->>`: tekst wartości jsonb. NULL dla braku klucza i JSON `null`, napis jak
 * jest, liczba i boolean jako tekst, tablica i obiekt jako ich zapis JSON.
 */
function jsonText(value: unknown): string | null {
  if (isNil(value)) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? plainDecimal(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const NIP_DIGITS = /^\d{10}$/;
const PESEL_DIGITS = /^\d{11}$/;
const GROSS_TEXT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** `x::date` nie rzuca: rok 1–9999, miesiąc 1–12, dzień w miesiącu (kalendarz gregoriański, lata przestępne). */
function isCalendarDate(text: string): boolean {
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= daysInMonth;
}

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DATE.test(value) && isCalendarDate(value);

/** Liczba skończona, |x| < 1e10 i najwyżej `scale` miejsc po przecinku. */
function isBoundedNumber(value: unknown, scale: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) < ORIGINAL_IMPORT_LIMITS.amountAbsBelow &&
    decimalPlaces(value) <= scale
  );
}

/**
 * Kwota w groszach. Wywoływana wyłącznie po `shape`/`lines` (|x| < 1e10,
 * ≤ 2 miejsca), więc `x * 100` < 1e12 i zaokrąglenie jest dokładne; sumy do
 * 1000 pozycji mieszczą się w zakresie całkowitych liczb bez utraty groszy.
 */
const cents = (amount: number): number => Math.round(amount * 100);

/**
 * Tekst kwoty z pliku (`^-?\d+(\.\d{1,2})?$`) w groszach; `null`, gdy tekst nie
 * jest taką kwotą. Wartość spoza zakresu faktury (> 10 cyfr całkowitych) daje
 * ±Infinity — nie równa się żadnej poprawnej sumie, a jest kwotą.
 */
function centsOfText(text: string): number | null {
  const match = GROSS_TEXT.exec(text);
  if (!match) return null;
  const [, sign = '', integer = '', fraction = ''] = match;
  const digits = integer.replace(/^0+(?=\d)/, '');
  const magnitude = digits.length > 10 ? Number.POSITIVE_INFINITY : Number(digits) * 100 + Number(fraction.padEnd(2, '0'));
  return sign === '-' ? -magnitude : magnitude;
}

const FAKTFLOW_RATES: ReadonlySet<string> = new Set<string>(ORIGINAL_IMPORT_VAT_RATES.faktflow);
const REVIEW_RATES: ReadonlySet<string> = new Set<string>([
  ...ORIGINAL_IMPORT_VAT_RATES.faktflow,
  ...ORIGINAL_IMPORT_VAT_RATES.reviewOnly,
]);

/** `pair`/`record` (i każda inna): 8 stawek FaktWay; `review-*`: także FA(3) spoza FaktWay. `nieznana` nigdy. */
const ratesFor = (offer: unknown): ReadonlySet<string> =>
  offer === 'review-pair' || offer === 'review-record' ? REVIEW_RATES : FAKTFLOW_RATES;

const INVOICE_KEY_NAMES: ReadonlySet<string> = new Set<string>(ORIGINAL_IMPORT_INVOICE_KEYS);
const LINE_KEY_NAMES: ReadonlySet<string> = new Set<string>(ORIGINAL_IMPORT_LINE_KEYS);
const BUYER_ID_TYPES: ReadonlySet<string> = new Set<string>(ORIGINAL_IMPORT_BUYER_ID_TYPES);

interface ProjectionShape {
  invoice: Rec;
  lines: unknown[];
  xml: Rec;
}

/** `shape` (4.8): zwraca części projekcji albo `null` przy pierwszym błędzie kształtu, typu lub zakresu. */
function readShape(projection: unknown): ProjectionShape | null {
  if (!isRecord(projection) || own(projection, 'v') !== 1) return null;
  const invoice = own(projection, 'invoice');
  const lines = own(projection, 'lines');
  const xml = own(projection, 'xml');
  if (!isRecord(invoice) || !Array.isArray(lines) || !isRecord(xml)) return null;
  if (lines.length < 1 || lines.length > ORIGINAL_IMPORT_LIMITS.maxLines) return null;
  if (!invoiceShapeOk(invoice)) return null;
  return { invoice, lines, xml };
}

function invoiceShapeOk(invoice: Rec): boolean {
  if (Object.keys(invoice).some((key) => !INVOICE_KEY_NAMES.has(key))) return false;

  const field = (key: string): unknown => own(invoice, key);
  const isOptional = (key: string, ok: (value: unknown) => boolean): boolean => isNil(field(key)) || ok(field(key));
  const isFlatObject = (key: string): boolean => isRecord(field(key));
  const isMoney = (key: string): boolean => isBoundedNumber(field(key), ORIGINAL_IMPORT_LIMITS.amountScale);

  if (!isTextOfLength(field('internal_number'), 1, ORIGINAL_IMPORT_LIMITS.internalNumberMax)) return false;
  if (typeof field('invoice_type') !== 'string') return false;
  if (!isIsoDate(field('issue_date'))) return false;
  if (!isOptional('sale_date', isIsoDate) || !isOptional('payment_due_date', isIsoDate)) return false;
  const sellerNip = field('seller_nip');
  if (typeof sellerNip !== 'string' || !NIP_DIGITS.test(sellerNip)) return false;
  if (!isOptional('buyer_nip', (v) => typeof v === 'string' && NIP_DIGITS.test(v))) return false;
  if (!isMoney('net_total') || !isMoney('vat_total') || !isMoney('gross_total')) return false;
  for (const key of ['fa3_data', 'seller_data', 'buyer_data', 'payment_data']) {
    if (!isFlatObject(key)) return false;
  }
  const isB2c = field('is_b2c');
  const buyerIdType = field('buyer_id_type');
  if (typeof isB2c !== 'boolean') return false;
  if (typeof buyerIdType !== 'string' || !BUYER_ID_TYPES.has(buyerIdType)) return false;
  // Lustro `check_b2c_has_id` (00012:106-111): konsument nie ma NIP.
  if (isB2c && buyerIdType === 'nip') return false;
  if (!isOptional('buyer_pesel', (v) => typeof v === 'string' && PESEL_DIGITS.test(v))) return false;
  if (!isOptional('buyer_id_number', (v) => isTextOfLength(v, 0, ORIGINAL_IMPORT_LIMITS.buyerIdNumberMax))) return false;
  return isOptional('notes', (v) => isTextOfLength(v, 0, ORIGINAL_IMPORT_LIMITS.notesMax));
}

/** `lines` (4.8): pozycje jako obiekty albo `null` przy pierwszej niezgodnej. */
function readLines(lines: readonly unknown[], offer: unknown): Rec[] | null {
  const rates = ratesFor(offer);
  const ordinals = new Set<number>();
  const out: Rec[] = [];
  for (const line of lines) {
    if (!isRecord(line) || Object.keys(line).some((key) => !LINE_KEY_NAMES.has(key))) return null;
    const ordinal = own(line, 'ordinal');
    if (
      typeof ordinal !== 'number' ||
      !Number.isInteger(ordinal) ||
      ordinal < 1 ||
      ordinal > ORIGINAL_IMPORT_LIMITS.ordinalMax ||
      ordinals.has(ordinal)
    ) {
      return null;
    }
    ordinals.add(ordinal);
    if (!isTextOfLength(own(line, 'name'), 1, ORIGINAL_IMPORT_LIMITS.lineNameMax)) return null;
    if (!isTextOfLength(own(line, 'unit'), 1, ORIGINAL_IMPORT_LIMITS.lineUnitMax)) return null;
    if (!isBoundedNumber(own(line, 'quantity'), ORIGINAL_IMPORT_LIMITS.quantityScale)) return null;
    const unitPrice = own(line, 'unit_price_net');
    if (!isNil(unitPrice) && !isBoundedNumber(unitPrice, ORIGINAL_IMPORT_LIMITS.quantityScale)) return null;
    for (const key of ['net_amount', 'vat_amount', 'gross_amount']) {
      if (!isBoundedNumber(own(line, key), ORIGINAL_IMPORT_LIMITS.amountScale)) return null;
    }
    const rate = own(line, 'vat_rate');
    if (typeof rate !== 'string' || !rates.has(rate)) return null;
    out.push(line);
  }
  return out;
}

/** Wartość kwotowa pozycji (po `readLines`: liczba); inaczej 0, czego `readLines` nie dopuszcza. */
const amountOf = (rec: Rec, key: string): number => {
  const value = own(rec, key);
  return typeof value === 'number' ? value : 0;
};

const textOf = (rec: Rec, key: string): string => {
  const value = own(rec, key);
  return typeof value === 'string' ? value : '';
};

/**
 * Lustro `ksef_original_import_mismatch` (4.8): `null` albo PIERWSZY kod
 * niezgodności (`ORIGINAL_IMPORT_PROBLEMS`). Wejście jak jsonb w SQL —
 * dowolny kształt (przypadki `shape` w `originalImportMismatchCases()`);
 * nigdy nie rzuca.
 *
 * Fail-closed jak SQL 4.8: brak wartości w `original_check.summary` (numer,
 * data wystawienia, brutto) albo w znaczniku (ścieżka, skrót, rozmiar) to
 * niezgodność, nie przejście; wyjątek to waluta — brak, pusta i „pln” przechodzą
 * (problem tylko dla niepustej waluty ≠ PLN).
 */
export function originalImportProjectionProblem(
  projection: unknown,
  ctx: OriginalImportProblemContext,
): OriginalImportProblem | null {
  const shape = readShape(projection);
  if (!shape) return 'shape';
  const { invoice, xml } = shape;
  const lines = readLines(shape.lines, ctx.offer);
  if (!lines) return 'lines';

  const check = asRecord(ctx.check);
  const summary = asRecord(own(check, 'summary'));

  // number (klient): numer X istnieje i zgadza się z projekcją oraz z plikiem (btrim po obu stronach).
  const numberX = typeof ctx.internalNumber === 'string' ? pgBtrim(ctx.internalNumber) : null;
  const fileNumber = jsonText(own(summary, 'number'));
  if (
    numberX === null ||
    pgBtrim(textOf(invoice, 'internal_number')) !== numberX ||
    fileNumber === null ||
    pgBtrim(fileNumber) !== numberX
  ) {
    return 'number';
  }

  // seller (klient)
  if (textOf(invoice, 'seller_nip') !== ctx.tenantNip) return 'seller';

  // kind
  if (textOf(invoice, 'invoice_type') !== 'VAT') return 'kind';

  // issue-date: tekst, bez rzutu — `xs:date` może mieć strefę (`2026-10-01+02:00`); brak daty w pliku = niezgodność.
  const fileIssueDate = jsonText(own(summary, 'issueDate'));
  if (
    fileIssueDate === null ||
    !ISO_DATE_PREFIX.test(fileIssueDate) ||
    textOf(invoice, 'issue_date') !== left10(pgBtrim(fileIssueDate))
  ) {
    return 'issue-date';
  }

  // gross: P_15 pliku jest kwotą (`^-?\d+(\.\d{1,2})?$`) równą gross_total co do grosza.
  const fileGross = jsonText(own(summary, 'gross'));
  const fileGrossCents = fileGross === null ? null : centsOfText(fileGross);
  if (fileGrossCents === null || fileGrossCents !== cents(amountOf(invoice, 'gross_total'))) return 'gross';

  // buyer: `IS DISTINCT FROM` — brak NIP po obu stronach to zgodność.
  const fileBuyerNip = jsonText(own(summary, 'buyerNip'));
  const fileBuyerDigits = fileBuyerNip === null ? '' : fileBuyerNip.replace(/\D/g, '');
  const buyerNip = own(invoice, 'buyer_nip');
  if ((isNil(buyerNip) ? null : buyerNip) !== (fileBuyerDigits === '' ? null : fileBuyerDigits)) return 'buyer';

  // currency: jedna reguła w całym torze (reguła 1 bramy, `assertPlnCurrency`, SQL 4.8): problem tylko, gdy
  // `upper(btrim(waluta))` jest niepuste i ≠ 'PLN' — brak, pusta i „pln” przechodzą. SQL:
  // `NULLIF(upper(btrim(summary->>'currency')),'') <> 'PLN'`. `btrim` obcina same spacje, więc tu `pgBtrim`, nie
  // `trim()` (tabulator na brzegu zostaje i daje `currency`); wartość ze znacznika jest i tak po `trim()`
  // z `summarizeInvoiceXml`, więc różnica dotyczy wyłącznie ręcznie złożonego jsonb.
  const fileCurrency = jsonText(own(summary, 'currency'));
  const currency = fileCurrency === null ? '' : pgBtrim(fileCurrency).toUpperCase();
  if (currency !== '' && currency !== 'PLN') return 'currency';

  // xml: plik w archiwum firmy pod numerem K, ze skrótem i rozmiarem ze znacznika.
  const storagePath = own(xml, 'storage_path');
  const sha256 = own(xml, 'sha256');
  const sizeBytes = own(xml, 'size_bytes');
  if (
    typeof storagePath !== 'string' ||
    storagePath !== own(check, 'archivePath') ||
    storagePath !== `${ctx.tenantId}/ksef-import/${ctx.ksefNumber}.xml` ||
    typeof sha256 !== 'string' ||
    sha256 !== own(check, 'sha256') ||
    typeof sizeBytes !== 'number' ||
    sizeBytes !== own(check, 'sizeBytes')
  ) {
    return 'xml';
  }

  // totals: sumy pozycji (w groszach, dokładnie) = nagłówek.
  const sum = (key: string): number => lines.reduce((acc, line) => acc + cents(amountOf(line, key)), 0);
  if (
    sum('net_amount') !== cents(amountOf(invoice, 'net_total')) ||
    sum('vat_amount') !== cents(amountOf(invoice, 'vat_total')) ||
    sum('gross_amount') !== cents(amountOf(invoice, 'gross_total'))
  ) {
    return 'totals';
  }

  // fa3: bez `lines` na górze (szkic z importu dałoby się wysłać), pochodzenie zapisu i skrót pliku ze znacznika.
  const fa3 = asRecord(own(invoice, 'fa3_data'));
  const provenance = asRecord(own(fa3, 'import'));
  const originalSha256 = own(provenance, 'originalSha256');
  if (
    hasKey(fa3, 'lines') ||
    own(provenance, 'source') !== ORIGINAL_IMPORT_SOURCE ||
    typeof originalSha256 !== 'string' ||
    originalSha256 !== own(check, 'sha256')
  ) {
    return 'fa3';
  }

  return null;
}
