/**
 * Noty obciążeniowe i uznaniowe (plan kompletnej aplikacji, krok 2.9,
 * część 1): typy i reguły wspólne dla bazy (00193), akcji, PDF, maila
 * i ekranów. Moduł bez importów serwerowych, więc nadaje się i do klienta.
 *
 * Nota nie jest fakturą: nie ma VAT, nie trafia do KSeF, KPiR, ewidencji ani
 * raportów (ksef.podatki.gov.pl, „Wystawianie i otrzymywanie faktur”,
 * pytanie 27). Kwoty liczymy tylko przez `roundToCents`.
 */
import { formatPlMoney } from '@/lib/format/pl';
import { roundToCents } from '@/lib/xml/invoice-calculator';

export const NOTE_KINDS = ['debit', 'credit'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  debit: 'Nota obciążeniowa',
  credit: 'Nota uznaniowa',
};

/** Przedrostek serii, ten sam co w CHECK `accounting_notes_issued_check` (00193). */
export const NOTE_NUMBER_PREFIXES: Record<NoteKind, string> = {
  debit: 'NO',
  credit: 'NU',
};

export type NoteStatus = 'draft' | 'issued';

export const NOTE_STATUS_LABELS: Record<NoteStatus, string> = {
  draft: 'Szkic',
  issued: 'Wystawiona',
};

/** W tej części tylko złote (CHECK `accounting_notes_currency_check`). */
export const NOTE_CURRENCY = 'PLN';

/** Granice z CHECK-ów 00193; formularz i schemat używają tych samych liczb. */
export const NOTE_LIMITS = {
  title: 200,
  description: 300,
  items: 50,
  related: 120,
  amountMax: 1_000_000_000,
} as const;

/**
 * Notę zapisuje, wystawia i wysyła każdy aktywny członek firmy, tak jak
 * fakturę (RLS `invoices` z 00002 i 00037, wysyłka faktury mailem bez filtra
 * roli; pomoc „Role i uprawnienia”: księgowy ma uprawnienia członka). Te same
 * role sprawdzają polityki i funkcje 00193.
 */
export const NOTE_WRITER_ROLES = ['owner', 'admin', 'member', 'accountant'] as const;

export function canWriteNotes(role: string | null | undefined): boolean {
  return typeof role === 'string' && (NOTE_WRITER_ROLES as readonly string[]).includes(role);
}

export interface NoteItem {
  description: string;
  amount: number;
}

/** Migawka strony noty: wystawca (z `tenants`) albo kontrahent (z `contractors`). */
export interface NoteParty {
  name: string;
  nip: string;
  countryCode: string;
  addressLine1: string;
  addressLine2: string;
  email?: string | null;
}

export interface AccountingNote {
  id: string;
  tenantId: string;
  kind: NoteKind;
  status: NoteStatus;
  /** Numer z bazy po wystawieniu; w szkicu `null`. */
  number: string | null;
  issueDate: string;
  title: string;
  items: NoteItem[];
  total: number;
  currency: typeof NOTE_CURRENCY;
  contractorId: string | null;
  counterparty: NoteParty;
  /** Dane firmy z chwili wystawienia; w szkicu `null` (podgląd bierze dane z profilu firmy). */
  issuer: NoteParty | null;
  relatedDocument: string | null;
  dueDate: string | null;
  bankAccount: string | null;
  issuedAt: string | null;
  createdAt: string;
}

/** Wiersz listy not. */
export interface NoteListItem {
  id: string;
  kind: NoteKind;
  status: NoteStatus;
  number: string | null;
  issueDate: string;
  title: string;
  counterpartyName: string;
  total: number;
}

/** Kontrahent z bazy firmy do wyboru w formularzu noty. */
export interface NoteContractorOption {
  id: string;
  name: string;
  nip: string;
  email: string | null;
}

export interface NoteEmailRecord {
  id: string;
  recipient: string;
  sentAt: string;
}

/** Suma pozycji co do grosza (`roundToCents` po każdym kroku, jak na fakturze). */
export function noteTotal(items: readonly Pick<NoteItem, 'amount'>[]): number {
  return items.reduce((sum, item) => roundToCents(sum + item.amount), 0);
}

/** Numer noty w kształcie z bazy (00193): `NO/1/2026`, `NU/12/2027`. */
export function formatNoteNumber(kind: NoteKind, seq: number, year: number): string {
  return `${NOTE_NUMBER_PREFIXES[kind]}/${seq}/${year}`;
}

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value);
}

/** Zdanie o kwocie (PDF i podgląd): nota obciążeniowa obciąża odbiorcę, uznaniowa uznaje go kwotą. */
export function noteAmountSentence(kind: NoteKind, total: number): string {
  const amount = `${formatPlMoney(total)} PLN`;
  return kind === 'debit' ? `Obciążamy Państwa kwotą ${amount}.` : `Uznajemy Państwa kwotą ${amount}.`;
}

/** IBAN do druku w grupach po cztery znaki: „PL61 1090 1014 …”. */
export function formatIbanForPrint(iban: string): string {
  return iban.replace(/\s/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}
