import 'server-only';

import { createHash } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { ApiKeyIdentity } from '@/lib/api/v1/auth';
import { toApiInvoice, toApiItem, type ApiInvoiceDetail } from '@/lib/api/v1/invoices';
import { ApiUpstreamError, type ApiErrorCode, type ApiFieldError } from '@/lib/api/v1/responses';
import { addDaysToIsoDate, dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  buildInvoiceFromForm,
  draftInvoiceRow,
  draftLineRows,
  type TenantAddressSnapshot,
  type TenantSnapshot,
} from '@/lib/invoices/build-from-form';
import { readTenantCashMethodForIssuance } from '@/lib/invoices/cash-method';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { KSEF_ALREADY_QUEUED_MESSAGE } from '@/lib/invoices/ksef-send-step';
import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import { nextInvoiceNumberCandidates } from '@/lib/invoices/next-number';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { validateInvoice } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/**
 * Wystawienie faktury przez publiczne API (`POST /api/v1/invoices`, krok 7.1
 * planu kompletnej aplikacji, część 2).
 *
 * Ta sama droga co formularz „Nowa faktura”: wartości formularza
 * (`invoiceFormSchema`), budowa faktury (`buildInvoiceFromForm`, kwoty przez
 * `roundToCents`), `validateInvoice`, podpowiedź numeru, wiersz szkicu
 * (`draftInvoiceRow`) i ta sama kolejka wysyłki do KSeF
 * (`enqueueKsefSubmitAfterDraft`, RPC `enqueue_ksef_send` z 00131).
 *
 * Zapis: rola `api_key_client` niczego nie zapisuje w tabelach. Fakturę,
 * pozycje, klucz idempotencji i wpis audytu zapisuje w jednej transakcji
 * `api_create_invoice()` (00184, SECURITY DEFINER), która sama ustala klucz,
 * zakres i firmę ze skrótu w tokenie. Dane firmy do wystawienia (NIP, nazwa,
 * adres, zwolnienie z VAT, metoda kasowa) czyta ten sam token przez RLS.
 *
 * Na razie tylko zwykła faktura VAT krajowa w złotych: korekty, zaliczki,
 * faktury końcowe, do paragonu, w walucie, dla firmy z UE i dla osoby
 * z PESEL dostają 422 z kodem i opisem (kolejne PR-y).
 */

/** Największa treść żądania: 1000 pozycji z długimi nazwami mieści się z zapasem. */
export const MAX_INVOICE_CREATE_BYTES = 1_000_000;
export const MAX_INVOICE_ITEMS = 1000;
/** Klucz idempotencji: 1-255 widocznych znaków ASCII (jak w CHECK 00184). */
const IDEMPOTENCY_HEADER_PATTERN = /^[\x21-\x7E]{1,255}$/;
/** Ile razy bierzemy kolejny numer, gdy równoległe żądanie zajęło podpowiedziany. */
const AUTO_NUMBER_ATTEMPTS = 3;
/** Termin płatności bez pola: 14 dni, jak w pustym formularzu (`invoice-form.tsx`). */
const DEFAULT_PAYMENT_DAYS = 14;

/** Stawki dla faktury krajowej; „np. II” wymaga nabywcy z UE (poza zakresem tej wersji). */
export const API_VAT_RATES = ['23', '8', '5', '0', 'zw', 'oo', 'np'] as const;
export const API_PAYMENT_METHODS = ['transfer', 'cash', 'card', 'other'] as const;
export const API_BUYER_TYPES = ['company', 'consumer'] as const;

/** Pola treści żądania; opis OpenAPI ma dokładnie te (test dokumentacji). */
export const INVOICE_CREATE_FIELDS = {
  invoice: [
    'kind', 'currency', 'number', 'issue_date', 'sale_date', 'payment_due_date', 'payment_method',
    'bank_account', 'split_payment', 'notes', 'buyer', 'items', 'send',
  ],
  buyer: ['type', 'nip', 'name', 'address_line1', 'address_line2', 'email'],
  item: ['name', 'unit', 'quantity', 'unit_price_net', 'vat_rate'],
} as const;

// ─── Treść żądania ─────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Liczba dodatnia z kropką, najwyżej 4 miejsca po przecinku (NUMERIC(14,4) ilości i ceny). */
const DECIMAL = /^\d{1,10}(\.\d{1,4})?$/;

const isoDate = (label: string) =>
  z
    .string({ error: `${label}: data w formacie RRRR-MM-DD.` })
    .regex(ISO_DATE, `${label}: data w formacie RRRR-MM-DD.`)
    .refine((value) => addDaysToIsoDate(value, 0) !== null, `${label}: taki dzień nie istnieje.`);

/** Kwota albo ilość: liczba JSON albo tekst dziesiętny z kropką (zalecany, bez błędów zaokrągleń po stronie programu). */
const decimal = (label: string) =>
  z
    .union([z.number(), z.string()], { error: `${label}: liczba albo tekst dziesiętny z kropką, np. "100.50".` })
    .transform((value, ctx) => {
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        ctx.addIssue({ code: 'custom', message: `${label}: liczba skończona.` });
        return z.NEVER;
      }
      const trimmed = value.trim();
      if (!DECIMAL.test(trimmed)) {
        ctx.addIssue({ code: 'custom', message: `${label}: liczba dodatnia z kropką i najwyżej 4 miejscami po przecinku, np. "100.50".` });
        return z.NEVER;
      }
      return Number(trimmed);
    });

export const apiInvoiceItemSchema = z.strictObject({
  name: z.string({ error: 'Nazwa pozycji: tekst.' }),
  unit: z.string({ error: 'Jednostka: tekst, np. "szt.".' }),
  quantity: decimal('Ilość'),
  unit_price_net: decimal('Cena netto'),
  vat_rate: z.enum(API_VAT_RATES, { error: `Stawka VAT: jedna z ${API_VAT_RATES.join(', ')}.` }),
});

export const apiInvoiceBuyerSchema = z
  .strictObject({
    type: z.enum(API_BUYER_TYPES, { error: 'Rodzaj nabywcy: company (firma z NIP) albo consumer (osoba prywatna).' }),
    nip: z.string({ error: 'NIP nabywcy: 10 cyfr jako tekst.' }).nullish(),
    name: z.string({ error: 'Nazwa nabywcy: tekst.' }),
    address_line1: z.string({ error: 'Adres nabywcy, linia 1 (ulica i numer): tekst.' }),
    address_line2: z.string({ error: 'Adres nabywcy, linia 2 (kod pocztowy i miasto): tekst.' }),
    email: z.string({ error: 'E-mail nabywcy: tekst.' }).nullish(),
  })
  .superRefine((buyer, ctx) => {
    if (buyer.type === 'company' && !buyer.nip) {
      ctx.addIssue({ code: 'custom', path: ['nip'], message: 'Firma z Polski: podaj NIP nabywcy (10 cyfr).' });
    }
    if (buyer.type === 'consumer' && buyer.nip) {
      ctx.addIssue({ code: 'custom', path: ['nip'], message: 'Osoba prywatna nie ma NIP: pomiń pole nip albo wybierz type "company".' });
    }
  });

export const apiInvoiceCreateSchema = z.strictObject({
  kind: z.literal('vat').nullish(),
  currency: z.literal('PLN').nullish(),
  number: z
    .string({ error: 'Numer faktury: tekst.' })
    .trim()
    .min(1, 'Numer faktury nie może być pusty. Pomiń pole number, żeby FaktWay nadał kolejny numer.')
    .max(50, 'Numer faktury: najwyżej 50 znaków.')
    .nullish(),
  issue_date: isoDate('Data wystawienia').nullish(),
  sale_date: isoDate('Data sprzedaży').nullish(),
  payment_due_date: isoDate('Termin płatności').nullish(),
  payment_method: z
    .enum(API_PAYMENT_METHODS, { error: `Sposób zapłaty: jeden z ${API_PAYMENT_METHODS.join(', ')}.` })
    .nullish(),
  bank_account: z.string({ error: 'Numer rachunku: tekst.' }).trim().max(64, 'Numer rachunku: najwyżej 64 znaki.').nullish(),
  split_payment: z.boolean({ error: 'split_payment: true albo false.' }).nullish(),
  notes: z.string({ error: 'Uwagi: tekst.' }).max(3500, 'Uwagi: najwyżej 3500 znaków.').nullish(),
  buyer: apiInvoiceBuyerSchema,
  items: z
    .array(apiInvoiceItemSchema, { error: 'Pozycje faktury: lista items.' })
    .min(1, 'Dodaj co najmniej jedną pozycję.')
    .max(MAX_INVOICE_ITEMS, `Najwyżej ${MAX_INVOICE_ITEMS} pozycji na fakturze.`),
  send: z.boolean({ error: 'send: true albo false.' }).nullish(),
});

export type ApiInvoiceCreateInput = z.output<typeof apiInvoiceCreateSchema>;

export type ParsedInvoiceCreate =
  | { ok: true; value: ApiInvoiceCreateInput; requestHash: string }
  | { ok: false; status: 400 | 413 | 415 | 422; code: ApiErrorCode; message: string; fields?: ApiFieldError[] };

const UNSUPPORTED_KIND_MESSAGE =
  'Przez API wystawisz na razie tylko zwykłą fakturę VAT (kind: "vat"). Korektę, zaliczkę, fakturę końcową i fakturę do paragonu wystaw w aplikacji FaktWay.';
const UNSUPPORTED_CURRENCY_MESSAGE =
  'Przez API wystawisz na razie fakturę tylko w złotych (currency: "PLN").';
const UNSUPPORTED_BUYER_MESSAGE =
  'Przez API wystawisz na razie fakturę krajową dla firmy z NIP (buyer.type: "company") albo dla osoby prywatnej bez numeru identyfikacyjnego (buyer.type: "consumer"). Fakturę dla firmy z UE i dla osoby z PESEL albo dokumentem wystaw w aplikacji FaktWay.';
/** Pola nabywcy, których ta wersja nie przyjmuje: odpowiedź mówi, że to rodzaj spoza API, a nie literówka. */
const UNSUPPORTED_BUYER_FIELDS = ['pesel', 'id_document', 'vat_ue', 'country_code'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rodzaj faktury spoza tej wersji API: 422 z kodem, zanim sprawdzimy resztę pól. */
function unsupportedFeature(raw: Record<string, unknown>): { code: ApiErrorCode; message: string } | null {
  if ((raw.kind !== undefined && raw.kind !== null && raw.kind !== 'vat') || raw.corrected_invoice_id !== undefined) {
    return { code: 'unsupported_invoice_kind', message: UNSUPPORTED_KIND_MESSAGE };
  }
  if (raw.currency !== undefined && raw.currency !== null && raw.currency !== 'PLN') {
    return { code: 'unsupported_currency', message: UNSUPPORTED_CURRENCY_MESSAGE };
  }
  const buyer = raw.buyer;
  if (isRecord(buyer)) {
    const type = buyer.type;
    if (typeof type === 'string' && !(API_BUYER_TYPES as readonly string[]).includes(type)) {
      return { code: 'unsupported_buyer', message: UNSUPPORTED_BUYER_MESSAGE };
    }
    if (UNSUPPORTED_BUYER_FIELDS.some((field) => buyer[field] !== undefined && buyer[field] !== null)) {
      return { code: 'unsupported_buyer', message: UNSUPPORTED_BUYER_MESSAGE };
    }
  }
  return null;
}

const TYPE_NAMES: Record<string, string> = {
  string: 'tekst',
  number: 'liczba',
  boolean: 'true albo false',
  object: 'obiekt',
  array: 'lista',
};

/** Ścieżka pola jak w JSON żądania: `buyer.nip`, `items[0].quantity`. */
function fieldPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/** Opis po polsku dla błędów bez własnego komunikatu w schemacie. */
function polishMessage(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined
        ? 'To pole jest wymagane.'
        : `Zły typ wartości: oczekiwano ${TYPE_NAMES[String(issue.expected)] ?? String(issue.expected)}.`;
    case 'unrecognized_keys':
      return 'Nieznane pole.';
    case 'invalid_value':
      return `Dozwolone wartości: ${issue.values.map((value) => JSON.stringify(value)).join(', ')}.`;
    case 'too_small':
      return issue.origin === 'array' ? 'Za mało elementów.' : 'Za krótka albo za mała wartość.';
    case 'too_big':
      return issue.origin === 'array' ? 'Za dużo elementów.' : 'Za długa albo za duża wartość.';
    default:
      return 'Nieprawidłowa wartość.';
  }
}

function schemaFields(issues: readonly z.core.$ZodIssue[]): ApiFieldError[] {
  return issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ field: fieldPath([...issue.path, key]), message: `Nieznane pole ${key}.` }))
      : [{ field: fieldPath(issue.path), message: issue.message }],
  );
}

function validationFailed(fields: ApiFieldError[]): Extract<ParsedInvoiceCreate, { ok: false }> {
  const [first] = fields;
  const lead = first ? (first.field ? `${first.field}: ${first.message}` : first.message) : 'Dane faktury mają błędy.';
  return {
    ok: false,
    status: 422,
    code: 'validation_failed',
    message: fields.length > 1 ? `${lead} Wszystkie błędy są w error.fields.` : lead,
    fields,
  };
}

/** Postać kanoniczna (klucze obiektów posortowane): ta sama treść w innej kolejności pól to ten sam skrót. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 (hex) treści żądania: porównanie „ta sama treść” przy powtórzeniu klucza idempotencji. */
export function requestDigest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Treść żądania (obiekt z JSON): rodzaj, schemat i skrót. Bez bazy i bez czasu. */
export function parseInvoiceCreateBody(raw: unknown): ParsedInvoiceCreate {
  if (!isRecord(raw)) return validationFailed([{ field: '', message: 'Treść żądania to obiekt JSON z danymi faktury.' }]);
  const unsupported = unsupportedFeature(raw);
  if (unsupported) return { ok: false, status: 422, ...unsupported };
  const parsed = apiInvoiceCreateSchema.safeParse(raw, { error: polishMessage });
  if (!parsed.success) return validationFailed(schemaFields(parsed.error.issues));
  return { ok: true, value: parsed.data, requestHash: requestDigest(raw) };
}

/** Żądanie HTTP: typ treści, rozmiar i JSON, potem `parseInvoiceCreateBody`. */
export async function readInvoiceCreateRequest(request: Request): Promise<ParsedInvoiceCreate> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    return { ok: false, status: 415, code: 'unsupported_media_type', message: 'Wyślij treść jako JSON z nagłówkiem Content-Type: application/json.' };
  }
  const tooLarge = {
    ok: false as const,
    status: 413 as const,
    code: 'payload_too_large' as const,
    message: `Treść żądania może mieć najwyżej ${MAX_INVOICE_CREATE_BYTES} bajtów.`,
  };
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_INVOICE_CREATE_BYTES) return tooLarge;
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_INVOICE_CREATE_BYTES) return tooLarge;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, code: 'invalid_json', message: 'Treść żądania nie jest poprawnym JSON.' };
  }
  return parseInvoiceCreateBody(raw);
}

export type ParsedIdempotencyHeader =
  | { ok: true; value: string }
  | { ok: false; code: 'missing_idempotency_key' | 'invalid_idempotency_key'; message: string };

/** Nagłówek `Idempotency-Key`: wymagany przy każdym zapisie. */
export function parseIdempotencyHeader(header: string | null): ParsedIdempotencyHeader {
  if (header === null || header.trim() === '') {
    return {
      ok: false,
      code: 'missing_idempotency_key',
      message: 'Brak nagłówka Idempotency-Key. Podaj własny, niepowtarzalny identyfikator tej faktury (np. numer zamówienia), żeby ponowienie nie wystawiło jej drugi raz.',
    };
  }
  if (!IDEMPOTENCY_HEADER_PATTERN.test(header)) {
    return {
      ok: false,
      code: 'invalid_idempotency_key',
      message: 'Idempotency-Key: od 1 do 255 znaków ASCII bez spacji (litery, cyfry i znaki takie jak - _ . :).',
    };
  }
  return { ok: true, value: header };
}

// ─── Wystawienie ───────────────────────────────────────────────────────────

export interface ApiInvoiceCreateContext {
  /** Klient z tokenem klucza (`authenticateApiRequest`): RLS i funkcje 00184 widzą tylko firmę klucza. */
  db: SupabaseClient;
  key: ApiKeyIdentity;
  requestId: string;
}

export interface ApiInvoiceCreateRequest {
  idempotencyKey: string;
  input: ApiInvoiceCreateInput;
  requestHash: string;
}

export type KsefSubmissionStatus = 'not_requested' | 'queued' | 'offline_queued' | 'refused' | 'already_requested';

export interface ApiKsefSubmission {
  requested: boolean;
  status: KsefSubmissionStatus;
  message: string | null;
}

export type ApiInvoiceCreateOutcome =
  | { ok: true; replayed: boolean; invoice: ApiInvoiceDetail; submission: ApiKsefSubmission }
  | { ok: false; status: number; code: ApiErrorCode; message: string; fields?: ApiFieldError[] };

type Failure = Extract<ApiInvoiceCreateOutcome, { ok: false }>;

const IDEMPOTENCY_CONFLICT_MESSAGE =
  'Ten klucz idempotencji był już użyty z inną treścią faktury. Dla nowej faktury użyj nowego klucza; ta sama treść z tym kluczem zwróci utworzoną fakturę.';
const INVOICE_DELETED_MESSAGE =
  'Faktura utworzona z tym kluczem idempotencji została usunięta w FaktWay. Jeśli chcesz wystawić ją ponownie, użyj nowego klucza.';
const NUMBER_REQUIRED_MESSAGE =
  'Podaj numer faktury w polu number: FaktWay nie wyliczy kolejnego numeru (firma nie ma jeszcze faktur albo kolejne numery są zajęte).';
const NUMBER_RACE_MESSAGE =
  'Kolejne numery faktur zajęły w tej chwili inne żądania. Ponów żądanie z tym samym kluczem idempotencji.';
const DRAFT_CHANGED_MESSAGE =
  'Szkic zmienił się w FaktWay od utworzenia przez API, więc nie wysyłamy go automatycznie. Sprawdź go i wyślij w aplikacji FaktWay.';
const SEND_FAILED_MESSAGE =
  'Nie udało się zlecić wysyłki do KSeF. Szkic jest zapisany: ponów to samo żądanie z tym samym kluczem idempotencji albo wyślij szkic w aplikacji FaktWay.';

const KEY_FORBIDDEN: Failure = {
  ok: false,
  status: 401,
  code: 'invalid_api_key',
  message: 'Klucz API jest nieprawidłowy albo został odwołany.',
};

/** Wynik funkcji 00184 (`api_invoice_request_result`): faktura w kształcie odczytu API. */
interface RequestResult {
  status: 'new' | 'created' | 'replayed' | 'conflict';
  sendRequested: boolean;
  sendAllowed: boolean;
  invoice: Record<string, unknown> | null;
  items: Record<string, unknown>[];
  fa3Data: Invoice | null;
}

function parseRequestResult(data: unknown, context: string): RequestResult {
  if (!isRecord(data) || !['new', 'created', 'replayed', 'conflict'].includes(String(data.status))) {
    throw new ApiUpstreamError(`${context}: nieoczekiwany wynik`);
  }
  return {
    status: data.status as RequestResult['status'],
    sendRequested: data.send_requested === true,
    sendAllowed: data.send_allowed === true,
    invoice: isRecord(data.invoice) ? data.invoice : null,
    items: Array.isArray(data.items) ? data.items.filter(isRecord) : [],
    fa3Data: isRecord(data.fa3_data) ? (data.fa3_data as unknown as Invoice) : null,
  };
}

function isKeyForbidden(error: { code?: string; message?: string }): boolean {
  return error.code === '42501' && error.message === 'api_key_forbidden';
}

interface Issuer {
  tenant: TenantSnapshot;
  vatExemptionBasis: string | null;
  cashMethod: boolean;
}

/** Dane firmy do faktury: te same kolumny i te same odczyty co formularz, tokenem klucza (RLS). */
async function readIssuer(db: SupabaseClient, tenantId: string): Promise<Issuer> {
  const { data, error } = await db.from('tenants').select('id, nip, name, address_json').eq('id', tenantId).maybeSingle();
  if (error || !data) throw new ApiUpstreamError('tenants.read');
  try {
    return {
      tenant: {
        id: String(data.id),
        nip: String(data.nip ?? ''),
        name: String(data.name ?? ''),
        address: (data.address_json as TenantAddressSnapshot | null) ?? null,
      },
      // Odpornie jak formularz: bez 00091 brak zwolnienia, bez 00094 odmowa (P_16).
      vatExemptionBasis: await readTenantVatExemption(db, tenantId),
      cashMethod: await readTenantCashMethodForIssuance(db, tenantId),
    };
  } catch {
    throw new ApiUpstreamError('tenants.vat_settings');
  }
}

/**
 * Podpowiedź numeru formularza (`suggestNextInvoiceNumberForTenant`): ostatnia
 * zwykła faktura sprzedaży (najpierw wystawiona w FaktWay), potem pierwszy
 * wolny z kandydatów. Bez odczytu faktur: dwie funkcje 00184 zwracają tylko
 * ostatni numer z datą i zajęte numery.
 */
async function suggestApiInvoiceNumber(db: SupabaseClient, todayIso: string): Promise<string | null> {
  const { data, error } = await db.rpc('api_invoice_number_context');
  if (error) throw new ApiUpstreamError('invoices.number_context');
  const pick = (value: unknown) =>
    isRecord(value) && typeof value.internal_number === 'string' && value.internal_number && typeof value.issue_date === 'string'
      ? { number: value.internal_number, issueDate: value.issue_date }
      : null;
  const context = isRecord(data) ? data : {};
  const last = pick(context.last_app) ?? pick(context.last_any);
  if (!last) return null;

  const candidates = nextInvoiceNumberCandidates(last, todayIso);
  if (candidates.length === 0) return null;
  const { data: taken, error: takenError } = await db.rpc('api_invoice_numbers_taken', { p_numbers: candidates });
  if (takenError) throw new ApiUpstreamError('invoices.numbers_taken');
  const busy = new Set(Array.isArray(taken) ? taken.map(String) : []);
  return candidates.find((candidate) => !busy.has(candidate)) ?? null;
}

/** Wartości formularza z treści API; domyślne jak w pustym formularzu (dziś, przelew, 14 dni). */
function toFormValues(input: ApiInvoiceCreateInput, number: string, todayIso: string): InvoiceFormValues {
  const issueDate = input.issue_date ?? todayIso;
  const buyer = input.buyer;
  const consumer = buyer.type === 'consumer';
  return {
    internalNumber: number,
    issueDate,
    saleDate: input.sale_date ?? '',
    buyerNip: consumer ? '' : buyer.nip ?? '',
    buyerName: buyer.name,
    buyerAddressLine1: buyer.address_line1,
    buyerAddressLine2: buyer.address_line2,
    buyerEmail: buyer.email ?? '',
    buyerIsConsumer: consumer,
    buyerConsumerIdType: consumer ? 'no_id' : undefined,
    buyerPesel: '',
    buyerIdDocument: '',
    buyerIsEu: false,
    lines: input.items.map((item) => ({
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      unitPriceNet: item.unit_price_net,
      vatRate: item.vat_rate,
    })),
    paymentMethod: input.payment_method ?? 'transfer',
    paymentDueDate: input.payment_due_date ?? dueDateFrom(issueDate, DEFAULT_PAYMENT_DAYS),
    bankAccount: input.bank_account ?? '',
    notes: input.notes ?? '',
    splitPayment: input.split_payment ?? false,
  };
}

const FORM_FIELDS: Record<string, string> = {
  internalNumber: 'number',
  issueDate: 'issue_date',
  saleDate: 'sale_date',
  buyerNip: 'buyer.nip',
  buyerName: 'buyer.name',
  buyerAddressLine1: 'buyer.address_line1',
  buyerAddressLine2: 'buyer.address_line2',
  buyerEmail: 'buyer.email',
  lines: 'items',
  paymentMethod: 'payment_method',
  paymentDueDate: 'payment_due_date',
  bankAccount: 'bank_account',
  notes: 'notes',
  splitPayment: 'split_payment',
};
const LINE_FIELDS: Record<string, string> = {
  name: 'name',
  unit: 'unit',
  quantity: 'quantity',
  unitPriceNet: 'unit_price_net',
  vatRate: 'vat_rate',
};

/** Ścieżka błędu schematu formularza w nazwach pól API. */
function formField(path: ReadonlyArray<PropertyKey>): string {
  const [head, index, leaf] = path;
  if (head === 'lines' && typeof index === 'number') {
    return leaf === undefined ? `items[${index}]` : `items[${index}].${LINE_FIELDS[String(leaf)] ?? String(leaf)}`;
  }
  if (head === undefined) return '';
  return FORM_FIELDS[String(head)] ?? 'buyer.type';
}

type Built = { ok: true; values: InvoiceFormValues; invoice: Invoice } | Failure;

/** Ta sama walidacja co formularz i wysyłka: `invoiceFormSchema`, `validateInvoice`, dzień wysyłki. */
function buildApiInvoice(input: ApiInvoiceCreateInput, number: string, issuer: Issuer, now: Date): Built {
  const todayIso = todayInWarsaw(now);
  const values = toFormValues(input, number, todayIso);
  const parsed = invoiceFormSchema.safeParse(values);
  if (!parsed.success) {
    return validationFailed(parsed.error.issues.map((issue) => ({ field: formField(issue.path), message: issue.message })));
  }
  if (input.send === true && issueDateNotTodayError(values.issueDate, 'form', now)) {
    return validationFailed([{
      field: 'issue_date',
      message: `Do KSeF wysyłamy fakturę z dzisiejszą datą wystawienia (${todayIso}). Podaj issue_date ${todayIso} albo pomiń send, żeby zapisać szkic.`,
    }]);
  }
  const invoice = buildInvoiceFromForm(values, issuer.tenant, issuer.vatExemptionBasis, issuer.cashMethod);
  const problems = validateInvoice(invoice, now);
  if (problems.length > 0) {
    return { ok: false, status: 422, code: 'validation_failed', message: problems.join(' ') };
  }
  return { ok: true, values, invoice };
}

type CreateCall =
  | { kind: 'result'; result: RequestResult }
  | { kind: 'number_taken' }
  | { kind: 'forbidden' };

async function callCreate(
  ctx: ApiInvoiceCreateContext,
  request: ApiInvoiceCreateRequest,
  built: { values: InvoiceFormValues; invoice: Invoice },
): Promise<CreateCall> {
  // Bez `tenant_id`: firmę bierze funkcja z klucza, nie z wiersza aplikacji.
  const { tenant_id: _tenantFromApp, ...row } = draftInvoiceRow(ctx.key.tenantId, built.invoice, built.values);
  const { data, error } = await ctx.db.rpc('api_create_invoice', {
    p_idempotency_key: request.idempotencyKey,
    p_request_hash: request.requestHash,
    p_request_id: ctx.requestId,
    p_send: request.input.send === true,
    p_invoice: row,
    p_lines: draftLineRows(built.invoice),
  });
  if (error) {
    if (error.code === 'P0001' && error.message === 'api_invoice_number_taken') return { kind: 'number_taken' };
    if (isKeyForbidden(error)) return { kind: 'forbidden' };
    if (error.code === 'P0001') {
      // Sprzedawca albo rodzaj niezgodny z firmą: błąd programu, nie klienta (500 i zgłoszenie).
      throw new Error(`api_create_invoice: ${error.message}`);
    }
    throw new ApiUpstreamError(`api_create_invoice ${error.code ?? ''}`.trim());
  }
  return { kind: 'result', result: parseRequestResult(data, 'api_create_invoice') };
}

function refused(message: string): ApiKsefSubmission {
  return { requested: true, status: 'refused', message };
}

/**
 * Wysyłka szkicu jak „Wyślij do KSeF” przy szkicu (`sendDraftAction`): dzień
 * wysyłki, `validateInvoice`, NIP firmy, potem ta sama kolejka co interfejs.
 * Drugie zlecenie blokuje `enqueue_ksef_send` (tylko z `draft`).
 */
async function sendDraft(
  ctx: ApiInvoiceCreateContext,
  invoiceId: string,
  invoice: Invoice,
  now: Date,
): Promise<ApiKsefSubmission> {
  const todayIso = todayInWarsaw(now);
  if (issueDateNotTodayError(invoice.issueDate, 'draft', now)) {
    return refused(
      `Szkic ma datę wystawienia ${String(invoice.issueDate)}, a fakturę w KSeF wystawia się w dniu wysyłki (${todayIso}). Szkic został w FaktWay: usuń go w aplikacji i wystaw fakturę ponownie z dzisiejszą datą i nowym kluczem idempotencji.`,
    );
  }
  const problems = validateInvoice(invoice, now);
  if (problems.length > 0) return refused(problems[0]!);

  // Faktura już jest zapisana: każdy błąd od tego miejsca to odmowa wysyłki
  // (201, szkic zostaje), a ponowienie z tym samym kluczem spróbuje jeszcze raz.
  try {
    const { data: tenant, error } = await ctx.db.from('tenants').select('nip').eq('id', ctx.key.tenantId).maybeSingle();
    if (error) throw new ApiUpstreamError('tenants.nip');
    const nip = (tenant?.nip as string | null | undefined) ?? invoice.seller?.nip;
    if (!nip) return refused('Brak NIP firmy w ustawieniach FaktWay.');

    const enqueued = await enqueueKsefSubmitAfterDraft({
      supabase: ctx.db,
      tenantId: ctx.key.tenantId,
      userId: null,
      invoiceId,
      nip,
      invoice,
      auditKind: 'regular',
      internalNumberForAudit: invoice.internalNumber,
      companyKey: { id: ctx.key.id, prefix: ctx.key.prefix, requestId: ctx.requestId },
    });
    if (enqueued.ok) {
      return { requested: true, status: enqueued.mode === 'offline_queued' ? 'offline_queued' : 'queued', message: null };
    }
    if (enqueued.error === KSEF_ALREADY_QUEUED_MESSAGE) return { requested: true, status: 'already_requested', message: null };
    return refused(enqueued.error);
  } catch (sendError) {
    Sentry.captureException(sendError, {
      tags: { area: 'api.v1.invoices.send' },
      extra: { requestId: ctx.requestId, invoiceId },
    });
    return refused(SEND_FAILED_MESSAGE);
  }
}

async function finish(
  ctx: ApiInvoiceCreateContext,
  result: RequestResult,
  replayed: boolean,
  now: Date,
): Promise<ApiInvoiceCreateOutcome> {
  if (!result.invoice) {
    return { ok: false, status: 409, code: 'idempotency_conflict', message: INVOICE_DELETED_MESSAGE };
  }
  const invoice: ApiInvoiceDetail = { ...toApiInvoice(result.invoice), items: result.items.map(toApiItem) };

  let submission: ApiKsefSubmission;
  if (!result.sendRequested) {
    submission = { requested: false, status: 'not_requested', message: null };
  } else if (result.sendAllowed && result.fa3Data) {
    submission = await sendDraft(ctx, invoice.id, result.fa3Data, now);
  } else if (invoice.ksef_status !== 'draft') {
    // Wysyłkę zlecono wcześniej (to żądanie albo człowiek w aplikacji): stan w ksef_status.
    submission = { requested: true, status: 'already_requested', message: null };
  } else {
    submission = refused(DRAFT_CHANGED_MESSAGE);
  }
  if (submission.status === 'queued' || submission.status === 'offline_queued') invoice.ksef_status = submission.status;
  return { ok: true, replayed, invoice, submission };
}

/**
 * Wystawienie faktury kluczem API. Kolejność:
 *  1. powtórzenie po kluczu idempotencji (przed walidacją zależną od czasu
 *     i ustawień: ponowienie jutro zwraca tę samą fakturę, nie 422);
 *  2. dane firmy, numer (podany albo podpowiedź formularza), walidacja;
 *  3. `api_create_invoice()`: klucz idempotencji, szkic, pozycje i audyt
 *     w jednej transakcji (równoległe żądanie z tym samym kluczem dostaje
 *     tę samą fakturę);
 *  4. przy `send: true` kolejka wysyłki, tylko dla niezmienionego szkicu.
 */
export async function createInvoiceFromApi(
  ctx: ApiInvoiceCreateContext,
  request: ApiInvoiceCreateRequest,
  now: Date = new Date(),
): Promise<ApiInvoiceCreateOutcome> {
  const { data, error } = await ctx.db.rpc('api_invoice_idempotent_result', {
    p_idempotency_key: request.idempotencyKey,
    p_request_hash: request.requestHash,
  });
  if (error) {
    if (isKeyForbidden(error)) return KEY_FORBIDDEN;
    throw new ApiUpstreamError('api_invoice_idempotent_result');
  }
  const earlier = parseRequestResult(data, 'api_invoice_idempotent_result');
  if (earlier.status === 'conflict') return { ok: false, status: 409, code: 'idempotency_conflict', message: IDEMPOTENCY_CONFLICT_MESSAGE };
  if (earlier.status === 'replayed' || earlier.status === 'created') return finish(ctx, earlier, true, now);

  const issuer = await readIssuer(ctx.db, ctx.key.tenantId);
  const autoNumber = request.input.number === undefined || request.input.number === null;

  for (let attempt = 1; ; attempt += 1) {
    const number = request.input.number ?? (await suggestApiInvoiceNumber(ctx.db, todayInWarsaw(now)));
    if (!number) return { ok: false, status: 422, code: 'number_required', message: NUMBER_REQUIRED_MESSAGE };

    const built = buildApiInvoice(request.input, number, issuer, now);
    if (!built.ok) return built;

    const created = await callCreate(ctx, request, built);
    if (created.kind === 'forbidden') return KEY_FORBIDDEN;
    if (created.kind === 'number_taken') {
      if (autoNumber && attempt < AUTO_NUMBER_ATTEMPTS) continue;
      return {
        ok: false,
        status: 409,
        code: 'number_taken',
        message: autoNumber
          ? NUMBER_RACE_MESSAGE
          : `Faktura o numerze "${number}" już istnieje w tej firmie. Podaj inny numer albo pomiń pole number, żeby FaktWay nadał kolejny.`,
      };
    }
    const { result } = created;
    if (result.status === 'conflict') return { ok: false, status: 409, code: 'idempotency_conflict', message: IDEMPOTENCY_CONFLICT_MESSAGE };
    if (result.status === 'new') throw new ApiUpstreamError('api_create_invoice: brak zapisu');
    return finish(ctx, result, result.status === 'replayed', now);
  }
}
