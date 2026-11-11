import { z } from 'zod';

/**
 * Pola numeracji w schematach formularzy faktury (krok 2.5): zwykła,
 * zaliczkowa, końcowa i korekta. Wszystkie opcjonalne, więc stare wywołania
 * i formularz firmy bez serii działają jak dotąd. Pusty tekst znaczy „bez
 * serii” (zapis i tak sprawdza identyfikatory, `saveWithInvoiceNumber`).
 */
const optionalUuid = (message: string) => z.union([z.string().uuid(message), z.literal('')]).optional();

export const numberingFormFields = {
  /** Seria numeracji wybrana w formularzu. */
  numberSeriesId: optionalUuid('Nieprawidłowa seria numeracji. Odśwież stronę i wybierz serię ponownie.'),
  /** Podpowiedź z licznika serii, którą formularz wpisał w pole numeru. */
  numberPreview: z.string().max(50).optional(),
  /** Klucz zapisu: jeden na otwarcie formularza (drugi zapis nie tworzy drugiej faktury). */
  numberRequestKey: optionalUuid('Nieprawidłowy klucz zapisu. Odśwież stronę.'),
};
