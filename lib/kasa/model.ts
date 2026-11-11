/**
 * Kasa (plan kompletnej aplikacji, krok 3.7, migracja 00194): dowody wpłaty
 * (KP) i wypłaty (KW) gotówki oraz raport kasowy za okres. Moduł bez
 * importów serwerowych: biorą go akcje, strony, trasy PDF i komponenty
 * klienckie.
 *
 * Urzędowego wzoru KP i KW nie ma. Dowód ma elementy z § 6 ust. 3 pkt 3
 * rozporządzenia w sprawie prowadzenia PKPiR (Dz.U. 2025 poz. 1299): wystawca
 * i strona operacji (nazwy, adresy), data wystawienia i data operacji,
 * przedmiot i wartość, podpisy osób uprawnionych i numer, który wiąże dowód
 * z zapisami. Numer, stan kasy i niezmienność pilnuje baza; tu są typy,
 * odczyt wyników RPC i raport liczony przez `roundToCents`, jak kwoty faktury.
 */

import { parsePaymentAmount } from '@/lib/invoices/invoice-payments';
import { roundToCents } from '@/lib/xml/invoice-calculator';

export type CashKind = 'KP' | 'KW';

export function isCashKind(value: unknown): value is CashKind {
  return value === 'KP' || value === 'KW';
}

/** Kto wystawia dowody i otwiera kasę; księgowa ma wgląd (jak wpłaty w 00158 i 00176). */
const CASH_WRITE_ROLES = ['owner', 'admin', 'member'] as const;

export function canWriteCash(role: unknown): boolean {
  return typeof role === 'string' && (CASH_WRITE_ROLES as readonly string[]).includes(role);
}

/** Te same granice co CHECK-i i RPC w 00194. */
export const CASH_LIMITS = {
  title: 200,
  partyName: 512,
  partyNip: 32,
  partyAddress: 512,
  relatedDocument: 120,
  reason: 300,
  maxAmount: 999_999_999.99,
  /** Najdłuższy okres raportu w dniach. */
  reportDays: 366,
} as const;

const KIND_NAMES: Record<CashKind, string> = { KP: 'Dowód wpłaty', KW: 'Dowód wypłaty' };

/** „KP Dowód wpłaty”, „KW Dowód wypłaty”: pełna nazwa rodzaju na dowodzie i ekranach. */
export function cashKindTitle(kind: CashKind): string {
  return `${kind} ${KIND_NAMES[kind]}`;
}

/** Strona operacji: przy KP ten, kto wpłaca gotówkę, przy KW ten, kto ją dostaje. */
export const CASH_PARTY_LABELS: Record<CashKind, string> = { KP: 'Wpłacający', KW: 'Odbiorca' };

/** Numer z serii: „KP/3/2026”. Nadaje go tylko baza; tu do testów i opisu. */
export function cashDocumentNumber(kind: CashKind, seq: number, year: number): string {
  return `${kind}/${seq}/${year}`;
}

/** Jak dowód zmienia stan kasy: KP dodaje, KW zabiera; korekta ma kwotę ujemną, więc znosi swój dowód. */
export function cashDelta(kind: CashKind, amount: number): number {
  return roundToCents(kind === 'KP' ? amount : -amount);
}

export interface CashParty {
  name: string;
  nip: string | null;
  countryCode: string;
  addressLine1: string;
  addressLine2: string;
}

export interface CashRegister {
  id: string;
  openingDate: string;
  openingBalance: number;
}

/** Wystawiony dowód kasowy (wiersz `cash_documents`). */
export interface CashDocument {
  id: string;
  tenantId: string;
  kind: CashKind;
  number: string;
  /** Dzień wystawienia w Polsce (chwila zapisu). */
  issueDate: string;
  /** Dzień operacji gotówkowej (wybrany przez wystawiającego). */
  operationDate: string;
  /** Ujemna tylko w korekcie (storno). */
  amount: number;
  title: string;
  counterparty: CashParty;
  issuer: CashParty;
  issuedByName: string;
  issuedAt: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  paymentId: string | null;
  relatedDocument: string | null;
  correctsId: string | null;
  correctsNumber: string | null;
  correctionReason: string | null;
}

/** Dowód w raporcie kasowym (wynik RPC `cash_report`). */
export interface CashReportDocument {
  id: string;
  kind: CashKind;
  number: string;
  operationDate: string;
  issueDate: string;
  amount: number;
  title: string;
  counterpartyName: string;
  invoiceNumber: string | null;
  correctsNumber: string | null;
  correctedByNumber: string | null;
  issuedAt: string;
}

export interface CashReportData {
  register: CashRegister | null;
  from: string;
  to: string;
  /** Stan kasy przed pierwszym dniem okresu (stan początkowy plus dowody sprzed okresu). */
  balanceBefore: number;
  documents: CashReportDocument[];
}

export interface CashReportRow extends CashReportDocument {
  /** Kwota w kolumnie wpłat (KP, korekta KP ujemna) albo null. */
  receipt: number | null;
  /** Kwota w kolumnie wypłat (KW, korekta KW ujemna) albo null. */
  payout: number | null;
  /** Stan kasy po tym dowodzie. */
  balance: number;
}

export interface CashReport {
  from: string;
  to: string;
  openingDate: string;
  balanceStart: number;
  receipts: number;
  payouts: number;
  balanceEnd: number;
  rows: CashReportRow[];
  /** Najniższy stan na koniec dnia w okresie; null bez dowodów. */
  lowest: { balance: number; day: string } | null;
  /** Stan na koniec któregoś dnia poniżej zera. Baza na to nie pozwala, więc to sygnał błędu. */
  belowZero: boolean;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  // filtr-wyjatek: data-warszawa sprawdzenie dnia kalendarzowego na dacie w UTC, nie dzisiejsza data
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** „2026-11-05” → „05.11.2026”. */
export function dayPl(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Kwota po polsku z „zł”: „1234,56 zł”, „-50,00 zł” (separator tysięcy jak w całym panelu). */
export function formatCashMoney(amount: number): string {
  return `${amount.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
}

/**
 * Kwota wpisana przez człowieka, w złotych z groszami (ten sam kształt co
 * „Zapisz wpłatę”, `parsePaymentAmount`). Kwota dowodu musi być większa od
 * zera; stan początkowy kasy może być zerem (`allowZero`).
 */
export function parseCashAmount(text: string, options: { allowZero?: boolean } = {}): number | null {
  const amount = parsePaymentAmount(text);
  if (amount !== null) return amount;
  if (options.allowZero && /^0+(?:[.,]0{1,2})?$/.test(text.trim())) return 0;
  return null;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Migawka strony z JSONB; bez nazwy to null (nie zgadujemy treści dowodu). */
export function partyFromJson(value: unknown, requireNip = false): CashParty | null {
  const v = record(value);
  if (!v) return null;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  const nip = typeof v.nip === 'string' && v.nip.trim() !== '' ? v.nip.trim() : null;
  if (!name || (requireNip && !nip)) return null;
  return {
    name,
    nip,
    countryCode: typeof v.countryCode === 'string' && v.countryCode.trim() !== '' ? v.countryCode.trim() : 'PL',
    addressLine1: typeof v.addressLine1 === 'string' ? v.addressLine1.trim() : '',
    addressLine2: typeof v.addressLine2 === 'string' ? v.addressLine2.trim() : '',
  };
}

/** Wiersz `cash_documents` → dowód; wiersz w nieznanym kształcie to null. */
export function parseCashDocumentRow(row: unknown): CashDocument | null {
  const r = record(row);
  if (!r) return null;
  const id = text(r.id);
  const tenantId = text(r.tenant_id);
  const number = text(r.number);
  const amount = finite(r.amount);
  const counterparty = partyFromJson(r.counterparty);
  const issuer = partyFromJson(r.issuer, true);
  const issuedByName = typeof r.issued_by_name === 'string' ? r.issued_by_name.trim() : '';
  const title = text(r.title);
  const issuedAt = text(r.issued_at);
  if (!id || !tenantId || !isCashKind(r.kind) || !number || amount === null || amount === 0 || !counterparty || !issuer) return null;
  if (!issuedByName || !title || !issuedAt || !isRealDay(r.issue_date) || !isRealDay(r.operation_date)) return null;
  return {
    id,
    tenantId,
    kind: r.kind,
    number,
    issueDate: r.issue_date,
    operationDate: r.operation_date,
    amount,
    title,
    counterparty,
    issuer,
    issuedByName,
    issuedAt,
    invoiceId: text(r.invoice_id),
    invoiceNumber: text(r.invoice_number),
    paymentId: text(r.payment_id),
    relatedDocument: text(r.related_document),
    correctsId: text(r.corrects_id),
    correctsNumber: text(r.corrects_number),
    correctionReason: text(r.correction_reason),
  };
}

function reportDocument(raw: unknown): CashReportDocument | null {
  const r = record(raw);
  if (!r) return null;
  const id = text(r.id);
  const number = text(r.number);
  const amount = finite(r.amount);
  const title = text(r.title);
  const issuedAt = text(r.issued_at);
  if (!id || !number || !isCashKind(r.kind) || amount === null || amount === 0 || !title || !issuedAt) return null;
  if (!isRealDay(r.operation_date) || !isRealDay(r.issue_date)) return null;
  return {
    id,
    kind: r.kind,
    number,
    operationDate: r.operation_date,
    issueDate: r.issue_date,
    amount,
    title,
    counterpartyName: text(r.counterparty_name) ?? '',
    invoiceNumber: text(r.invoice_number),
    correctsNumber: text(r.corrects_number),
    correctedByNumber: text(r.corrected_by_number),
    issuedAt,
  };
}

/**
 * Wynik RPC `cash_report` (00194). Kształt inny niż oczekiwany to `null`:
 * ekran mówi wtedy, że raportu nie udało się wczytać, zamiast pokazać pusty
 * (fałszywy) raport.
 */
export function parseCashReportRpc(data: unknown): CashReportData | null {
  const r = record(data);
  if (!r || r.status !== 'ok') return null;
  if (r.register === null || r.register === undefined) {
    return {
      register: null,
      from: typeof r.from === 'string' ? r.from : '',
      to: typeof r.to === 'string' ? r.to : '',
      balanceBefore: 0,
      documents: [],
    };
  }
  const reg = record(r.register);
  const registerId = text(reg?.id);
  const openingBalance = finite(reg?.opening_balance);
  if (!reg || !registerId || openingBalance === null || !isRealDay(reg.opening_date)) return null;
  const balanceBefore = finite(r.balance_before);
  if (balanceBefore === null || !isRealDay(r.from) || !isRealDay(r.to) || !Array.isArray(r.documents)) return null;
  const documents: CashReportDocument[] = [];
  for (const raw of r.documents) {
    const doc = reportDocument(raw);
    if (!doc) return null;
    documents.push(doc);
  }
  return {
    register: { id: registerId, openingDate: reg.opening_date, openingBalance },
    from: r.from,
    to: r.to,
    balanceBefore,
    documents,
  };
}

/** Kolejność raportu jak w `cash_report`: dzień, w obrębie dnia KP przed KW, potem chwila wystawienia. */
function byReportOrder(a: CashReportDocument, b: CashReportDocument): number {
  return (
    a.operationDate.localeCompare(b.operationDate)
    || a.kind.localeCompare(b.kind)
    || a.issuedAt.localeCompare(b.issuedAt)
    || a.id.localeCompare(b.id)
  );
}

/**
 * Raport kasowy za okres: stan na początek, wpłaty, wypłaty, stan na koniec
 * i stan po każdym dowodzie. Kwoty przez `roundToCents`, jak na fakturze.
 * Stan liczony na koniec dnia (dowody mają dzień, nie godzinę), dlatego
 * w obrębie dnia najpierw wpłaty, potem wypłaty.
 */
export function buildCashReport(input: {
  from: string;
  to: string;
  openingDate: string;
  balanceBefore: number;
  documents: readonly CashReportDocument[];
}): CashReport {
  const balanceStart = roundToCents(input.balanceBefore);
  let balance = balanceStart;
  let receipts = 0;
  let payouts = 0;
  const rows: CashReportRow[] = [];
  const endOfDay = new Map<string, number>();
  for (const doc of [...input.documents].sort(byReportOrder)) {
    balance = roundToCents(balance + cashDelta(doc.kind, doc.amount));
    if (doc.kind === 'KP') receipts = roundToCents(receipts + doc.amount);
    else payouts = roundToCents(payouts + doc.amount);
    rows.push({
      ...doc,
      receipt: doc.kind === 'KP' ? doc.amount : null,
      payout: doc.kind === 'KW' ? doc.amount : null,
      balance,
    });
    endOfDay.set(doc.operationDate, balance);
  }
  let lowest: CashReport['lowest'] = null;
  for (const [day, value] of endOfDay) {
    if (lowest === null || value < lowest.balance) lowest = { balance: value, day };
  }
  return {
    from: input.from,
    to: input.to,
    openingDate: input.openingDate,
    balanceStart,
    receipts,
    payouts,
    balanceEnd: balance,
    rows,
    lowest,
    belowZero: balanceStart < 0 || (lowest !== null && lowest.balance < 0),
  };
}

function daysBetween(from: string, to: string): number {
  // filtr-wyjatek: kwoty-bez-float liczba dni między datami, nie kwota
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export interface CashPeriod {
  from: string;
  to: string;
  /** Wyjaśnienie, gdy okres z adresu poprawiono albo odrzucono. */
  notice: string | null;
}

/**
 * Okres raportu z adresu strony (`?od=…&do=…`): domyślnie bieżący miesiąc do
 * dziś. Nie wcześniej niż dzień rozpoczęcia kasy i nie dalej niż dziś;
 * najwyżej rok. Zły okres to bieżący miesiąc z wyjaśnieniem.
 */
export function resolveCashPeriod(input: { od?: string; do?: string; today: string; openingDate: string }): CashPeriod {
  const monthStart = `${input.today.slice(0, 8)}01`;
  const fallback = (notice: string | null): CashPeriod => ({
    from: monthStart < input.openingDate ? input.openingDate : monthStart,
    to: input.today,
    notice,
  });
  if (input.od === undefined && input.do === undefined) return fallback(null);
  if (!isRealDay(input.od) || !isRealDay(input.do)) {
    return fallback('Nie rozpoznaliśmy dat okresu. Pokazujemy bieżący miesiąc.');
  }
  if (input.od > input.do) return fallback('Data „od” jest późniejsza niż data „do”. Pokazujemy bieżący miesiąc.');
  let from = input.od;
  let notice: string | null = null;
  if (from < input.openingDate) {
    from = input.openingDate;
    notice = `Kasa działa w FaktWay od ${dayPl(input.openingDate)}, więc raport zaczyna się od tego dnia.`;
  }
  const to = input.do > input.today ? input.today : input.do;
  if (from > to) return fallback(notice);
  if (daysBetween(from, to) > CASH_LIMITS.reportDays) {
    return fallback('Raport obejmuje najwyżej rok. Pokazujemy bieżący miesiąc.');
  }
  return { from, to, notice };
}

/**
 * Okres raportu w PDF: daty muszą być poprawne, „od” nie później niż „do”,
 * najwyżej rok; „do” z przyszłości to dziś. Odmowa ma komunikat dla klienta.
 */
export function parseCashPeriodStrict(input: { od: string | null; do: string | null; today: string }):
  | { ok: true; from: string; to: string }
  | { ok: false; error: string } {
  if (!isRealDay(input.od) || !isRealDay(input.do)) {
    return { ok: false, error: 'Wybierz okres raportu: daty od i do.' };
  }
  if (input.od > input.do) return { ok: false, error: 'Data „od” jest późniejsza niż data „do”.' };
  const to = input.do > input.today ? input.today : input.do;
  if (input.od > to) return { ok: false, error: 'Okres raportu zaczyna się w przyszłości.' };
  if (daysBetween(input.od, to) > CASH_LIMITS.reportDays) {
    return { ok: false, error: 'Raport obejmuje najwyżej rok. Wybierz krótszy okres.' };
  }
  return { ok: true, from: input.od, to };
}
