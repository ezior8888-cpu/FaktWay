import { z } from 'zod';

import { RECURRING_DAY_MAX, RECURRING_DAY_MIN } from '@/lib/invoices/recurring/schedule';
import { RECURRING_FREQUENCIES } from '@/types/recurring-invoice';

/**
 * Faktura cykliczna (plan Finora N1) — jeden schemat dla formularza P6
 * i akcji serwerowych (AGENTS.md: walidacja klient + serwer).
 *
 * Treści faktury-wzoru tu nie ma i nie będzie: pozycja wskazuje wzór,
 * a formularz faktury wypełnia się z niego przy „Wystaw teraz”.
 */

/** Górna granica z CHECK w 00154. */
export const RECURRING_NAME_MAX = 120;

export const recurringInvoiceSchema = z.object({
  templateInvoiceId: z.string().uuid('Wybierz fakturę-wzór'),
  name: z
    .string()
    .trim()
    .min(1, 'Podaj nazwę faktury cyklicznej')
    .max(RECURRING_NAME_MAX, `Nazwa może mieć najwyżej ${RECURRING_NAME_MAX} znaków`),
  frequency: z.enum(RECURRING_FREQUENCIES, { message: 'Wybierz częstotliwość' }),
  dayOfMonth: z
    .number({ message: `Podaj dzień miesiąca od ${RECURRING_DAY_MIN} do ${RECURRING_DAY_MAX}` })
    .int(`Podaj dzień miesiąca od ${RECURRING_DAY_MIN} do ${RECURRING_DAY_MAX}`)
    .min(RECURRING_DAY_MIN, `Podaj dzień miesiąca od ${RECURRING_DAY_MIN} do ${RECURRING_DAY_MAX}`)
    .max(RECURRING_DAY_MAX, `Podaj dzień miesiąca od ${RECURRING_DAY_MIN} do ${RECURRING_DAY_MAX} — 29, 30 i 31 nie ma w każdym miesiącu`),
});

export type RecurringInvoiceFormValues = z.infer<typeof recurringInvoiceSchema>;

/** Identyfikator pozycji w akcjach wstrzymania, wznowienia, edycji i usuwania. */
export const recurringInvoiceIdSchema = z.string().uuid('Nie znaleziono faktury cyklicznej');
