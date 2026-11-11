import { z } from 'zod';

import { NOTE_CURRENCY, NOTE_KINDS, NOTE_LIMITS, type AccountingNote } from '@/lib/noty/model';
import { normalizeIban, parseIsoDate, roundToCents, validateIban } from '@/lib/xml/invoice-calculator';

/**
 * Szkic noty (krok 2.9, część 1): jeden schemat dla formularza i akcji
 * zapisu (AGENTS.md: walidacja klient + serwer). Kwoty przychodzą tekstem
 * z polskim przecinkiem albo liczbą; wynik ma liczby z groszami. Granice jak
 * w CHECK-ach 00193, więc szkic, który przejdzie schemat, przejdzie bazę.
 */

export const NOTE_CURRENCY_ERROR = 'Notę można na razie wystawić tylko w złotych (PLN).';

/** „1 250,50”, „1250.50”, „12 000” (także z twardą spacją) → liczba; inny tekst → null. */
export function parsePlAmount(text: string): number | null {
  const clean = text.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

/** Pierwszy problem z kwotą pozycji albo null. */
function amountProblem(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return 'Podaj kwotę, na przykład 1250,00.';
  if (value <= 0) return 'Kwota musi być większa od zera.';
  if (value > NOTE_LIMITS.amountMax) return 'Kwota pozycji może mieć najwyżej 1 000 000 000 zł.';
  if (roundToCents(value) !== value) return 'Kwota może mieć najwyżej dwa miejsca po przecinku.';
  return null;
}

const amountSchema = z
  .union([z.number(), z.string()], { message: 'Podaj kwotę, na przykład 1250,00.' })
  .transform((raw, ctx) => {
    const value = typeof raw === 'number' ? raw : parsePlAmount(raw);
    const problem = amountProblem(value);
    if (problem || value === null) {
      ctx.addIssue({ code: 'custom', message: problem ?? 'Podaj kwotę, na przykład 1250,00.' });
      return z.NEVER;
    }
    return value;
  });

const itemSchema = z.object({
  description: z
    .string({ message: 'Opisz pozycję.' })
    .trim()
    .min(1, 'Opisz pozycję.')
    .max(NOTE_LIMITS.description, `Opis pozycji może mieć najwyżej ${NOTE_LIMITS.description} znaków.`),
  amount: amountSchema,
});

/** Pole opcjonalne: pusty tekst albo brak to null; reszta po sprawdzeniu. */
function optionalText(check: (value: string) => string | null, map: (value: string) => string = (v) => v) {
  return z
    .string()
    .nullish()
    .transform((raw, ctx) => {
      const value = (raw ?? '').trim();
      if (!value) return null;
      const problem = check(value);
      if (problem) {
        ctx.addIssue({ code: 'custom', message: problem });
        return z.NEVER;
      }
      return map(value);
    });
}

export const noteDraftSchema = z
  .object({
    kind: z.enum(NOTE_KINDS, { message: 'Wybierz rodzaj noty.' }),
    contractorId: z.string({ message: 'Wybierz kontrahenta z bazy kontrahentów.' }).uuid('Wybierz kontrahenta z bazy kontrahentów.'),
    issueDate: z
      .string({ message: 'Podaj poprawną datę wystawienia.' })
      .refine((value) => parseIsoDate(value) !== null, { message: 'Podaj poprawną datę wystawienia.' }),
    title: z
      .string({ message: 'Podaj tytuł noty, na przykład kara umowna.' })
      .trim()
      .min(1, 'Podaj tytuł noty, na przykład kara umowna.')
      .max(NOTE_LIMITS.title, `Tytuł może mieć najwyżej ${NOTE_LIMITS.title} znaków.`),
    items: z
      .array(itemSchema, { message: 'Dodaj co najmniej jedną pozycję.' })
      .min(1, 'Dodaj co najmniej jedną pozycję.')
      .max(NOTE_LIMITS.items, `Nota może mieć najwyżej ${NOTE_LIMITS.items} pozycji.`),
    currency: z.string({ message: NOTE_CURRENCY_ERROR }).transform((value, ctx) => {
      if (value.trim().toUpperCase() !== NOTE_CURRENCY) {
        ctx.addIssue({ code: 'custom', message: NOTE_CURRENCY_ERROR });
        return z.NEVER;
      }
      return NOTE_CURRENCY;
    }),
    relatedDocument: optionalText((value) =>
      value.length > NOTE_LIMITS.related ? `Odniesienie może mieć najwyżej ${NOTE_LIMITS.related} znaków.` : null,
    ),
    dueDate: optionalText((value) => (parseIsoDate(value) ? null : 'Podaj poprawny termin zapłaty.')),
    bankAccount: optionalText(
      (value) =>
        validateIban(normalizeIban(value))
          ? null
          : 'Numer rachunku jest niepoprawny. Wpisz 26 cyfr rachunku albo pełny numer IBAN.',
      normalizeIban,
    ),
  })
  .transform((data, ctx) => {
    // Termin zapłaty i rachunek ma tylko nota obciążeniowa (CHECK accounting_notes_payment_check).
    const debit = data.kind === 'debit';
    const dueDate = debit ? data.dueDate : null;
    const bankAccount = debit ? data.bankAccount : null;
    if (dueDate && dueDate < data.issueDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'Termin zapłaty nie może być wcześniejszy niż data wystawienia.',
      });
      return z.NEVER;
    }
    return { ...data, dueDate, bankAccount };
  });

/** Wartości formularza (kwoty tekstem). */
export type NoteDraftInput = z.input<typeof noteDraftSchema>;
/** Szkic po walidacji (kwoty liczbami, puste pola jako null). */
export type NoteDraft = z.output<typeof noteDraftSchema>;

/** Szkic z bazy jako wartości formularza: kwoty z przecinkiem, bez grupowania tysięcy. */
export function noteToDraftInput(note: AccountingNote): NoteDraftInput {
  return {
    kind: note.kind,
    contractorId: note.contractorId ?? '',
    issueDate: note.issueDate,
    title: note.title,
    // filtr-wyjatek: kwoty-bez-float zapis kwoty z dwoma miejscami do pola formularza, bez rachunku
    items: note.items.map((item) => ({ description: item.description, amount: item.amount.toFixed(2).replace('.', ',') })),
    currency: note.currency,
    relatedDocument: note.relatedDocument ?? '',
    dueDate: note.dueDate ?? '',
    bankAccount: note.bankAccount ?? '',
  };
}

/** Data wystawienia z przyszłości: odmowa (ten sam warunek sprawdza RPC wystawienia). */
export function noteIssueDateError(issueDate: string, today: string): string | null {
  return issueDate > today ? 'Data wystawienia noty nie może być z przyszłości.' : null;
}
