import { z } from 'zod';

import { CASH_LIMITS, dayPl, isRealDay, parseCashAmount } from '@/lib/kasa/model';

/**
 * Schematy pól Kasy (krok 3.7): ten sam schemat sprawdza formularz i akcję
 * serwerową. Ostatnie słowo ma RPC w 00194 (data w Warszawie, dzień
 * rozpoczęcia kasy, stan kasy, faktura i wpłata).
 */

export const CASH_SOURCES = ['invoice', 'payment', 'none'] as const;
export type CashSource = (typeof CASH_SOURCES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CashDocumentSchemaOptions {
  /** Dziś w Europe/Warsaw (RRRR-MM-DD): górna granica daty operacji. */
  today: string;
  /** Dzień rozpoczęcia kasy, gdy formularz go zna; akcja zostawia to bazie. */
  openingDate?: string | null;
}

/** Pola dowodu KP albo KW jako napisy, tak jak w formularzu. */
export function cashDocumentSchema({ today, openingDate = null }: CashDocumentSchemaOptions) {
  return z
    .object({
      kind: z.enum(['KP', 'KW']),
      source: z.enum(CASH_SOURCES),
      invoiceId: z.string(),
      paymentId: z.string(),
      operationDate: z
        .string()
        .refine(isRealDay, 'Wpisz datę operacji.')
        .refine((value) => !isRealDay(value) || value >= '2000-01-01', 'Sprawdź rok w dacie operacji: wygląda na literówkę.')
        .refine(
          (value) => !isRealDay(value) || value <= today,
          'Data operacji nie może być z przyszłości. Wpisz dzisiejszą albo wcześniejszą datę.',
        )
        .refine(
          (value) => !isRealDay(value) || !openingDate || value >= openingDate,
          { message: `Data operacji nie może być wcześniejsza niż dzień rozpoczęcia kasy (${dayPl(openingDate)}).` },
        ),
      amount: z
        .string()
        .trim()
        .min(1, 'Wpisz kwotę.')
        .refine((value) => parseCashAmount(value) !== null, 'Wpisz kwotę większą od zera, np. 300 albo 1 234,56.')
        .refine((value) => {
          const amount = parseCashAmount(value);
          return amount === null || amount <= CASH_LIMITS.maxAmount;
        }, 'Kwota może mieć najwyżej 999 999 999,99 zł.'),
      title: z
        .string()
        .trim()
        .min(1, 'Wpisz tytuł operacji, np. „Zapłata za fakturę FV/1/2026”.')
        .max(CASH_LIMITS.title, `Tytuł może mieć najwyżej ${CASH_LIMITS.title} znaków.`),
      counterpartyName: z
        .string()
        .trim()
        .min(1, 'Wpisz nazwę firmy albo imię i nazwisko.')
        .max(CASH_LIMITS.partyName, `Nazwa może mieć najwyżej ${CASH_LIMITS.partyName} znaki.`),
      counterpartyNip: z.string().trim().max(CASH_LIMITS.partyNip, `NIP może mieć najwyżej ${CASH_LIMITS.partyNip} znaki.`),
      counterpartyAddressLine1: z.string().trim().max(CASH_LIMITS.partyAddress, `Adres może mieć najwyżej ${CASH_LIMITS.partyAddress} znaki.`),
      counterpartyAddressLine2: z.string().trim().max(CASH_LIMITS.partyAddress, `Adres może mieć najwyżej ${CASH_LIMITS.partyAddress} znaki.`),
      relatedDocument: z
        .string()
        .trim()
        .max(CASH_LIMITS.relatedDocument, `Pole „Dotyczy” może mieć najwyżej ${CASH_LIMITS.relatedDocument} znaków.`),
    })
    .superRefine((value, ctx) => {
      if (value.kind === 'KW' && value.source !== 'none') {
        ctx.addIssue({
          code: 'custom',
          path: ['source'],
          message: 'Wypłata (KW) nie wiąże się z fakturą sprzedaży. Wybierz „Inna wypłata”.',
        });
        return;
      }
      if (value.source === 'invoice' && !UUID.test(value.invoiceId)) {
        ctx.addIssue({ code: 'custom', path: ['invoiceId'], message: 'Wybierz fakturę, którą zapłacono gotówką.' });
      }
      if (value.source === 'payment' && !UUID.test(value.paymentId)) {
        ctx.addIssue({ code: 'custom', path: ['paymentId'], message: 'Wybierz wpłatę zapisaną przy fakturze.' });
      }
    });
}

export type CashDocumentFields = z.input<ReturnType<typeof cashDocumentSchema>>;
export type CashDocumentField = keyof CashDocumentFields;

/** Stan początkowy kasy: dzień rozpoczęcia (nie z przyszłości) i gotówka w kasie tego dnia (od zera). */
export function cashOpeningSchema({ today }: { today: string }) {
  return z.object({
    openingDate: z
      .string()
      .refine(isRealDay, 'Wpisz dzień rozpoczęcia kasy.')
      .refine((value) => !isRealDay(value) || value >= '2000-01-01', 'Sprawdź rok w dacie rozpoczęcia: wygląda na literówkę.')
      .refine((value) => !isRealDay(value) || value <= today, 'Dzień rozpoczęcia nie może być z przyszłości.'),
    openingBalance: z
      .string()
      .trim()
      .min(1, 'Wpisz, ile gotówki jest w kasie (może być 0).')
      .refine(
        (value) => parseCashAmount(value, { allowZero: true }) !== null,
        'Wpisz kwotę od zera wzwyż, np. 0 albo 1 250,00.',
      )
      .refine((value) => {
        const amount = parseCashAmount(value, { allowZero: true });
        return amount === null || amount <= CASH_LIMITS.maxAmount;
      }, 'Kwota może mieć najwyżej 999 999 999,99 zł.'),
  });
}

export type CashOpeningFields = z.input<ReturnType<typeof cashOpeningSchema>>;

/** Korekta (storno): przyczyna wymagana, bo dowód korygujący ją podaje. */
export const cashCorrectionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Wpisz przyczynę korekty.')
    .max(CASH_LIMITS.reason, `Przyczyna korekty może mieć najwyżej ${CASH_LIMITS.reason} znaków.`),
});

// ─── wejście i wynik akcji (app/actions/kasa.ts) ────────────────
// Typy tutaj, bo plik „use server” eksportuje tylko funkcje asynchroniczne.

/** Pola formularza KP albo KW plus klucz idempotencji (UUID z chwili otwarcia formularza). */
export interface IssueCashDocumentInput extends CashDocumentFields {
  idempotencyKey: string;
}

export type IssueCashDocumentResult =
  | {
      success: true;
      status: 'issued' | 'already_issued';
      documentId: string;
      number: string;
      /** KP do faktury zapisał wpłatę przy fakturze. */
      paymentRecorded: boolean;
      invoiceNumber: string | null;
    }
  | { success: false; error: string; field?: CashDocumentField };

export interface CorrectCashDocumentInput {
  documentId: string;
  /** UUID z chwili otwarcia okna korekty: ponowienie wystawia korektę raz. */
  idempotencyKey: string;
  reason: string;
}

export type CorrectCashDocumentResult =
  | {
      success: true;
      status: 'issued' | 'already_issued';
      documentId: string;
      number: string;
      correctsNumber: string;
      /** Korekta KP cofnęła wpłatę przy fakturze. */
      paymentVoided: boolean;
      invoiceNumber: string | null;
    }
  | { success: false; error: string; field?: 'reason' };

export type OpenCashRegisterResult =
  | { success: true; status: 'opened' | 'updated' | 'unchanged' }
  | { success: false; error: string; field?: keyof CashOpeningFields };
