/**
 * Hamulce wysyłki do KSeF (krok 5 planu automatyzacji).
 *
 * Dwie blokady, sprawdzane w tych samych miejscach co wstrzymanie ROZ
 * (`roz-submission-hold.ts`): przy kolejkowaniu z akcji użytkownika, na
 * starcie joba — przed sondą zdrowia i Offline24 — oraz tuż przed wysyłką.
 *
 * 1. Globalny wyłącznik `killAllKsefSubmissions` (AUD-63). Flaga istniała,
 *    ale nikt jej nie czytał — operator nie miał czym zatrzymać wysyłek.
 *    Odczyt autorytatywny: awaria bazy NIE może po cichu zdjąć wyłącznika.
 * 2. Faktury korygujące na KSeF produkcyjnym (AUD-03, AUD-04): generator
 *    wysyła wartości „po” zamiast różnicy i zamienia `zw` na 23%. Do czasu
 *    poprawki korekta zostaje szkicem. Na KSeF TEST wysyłka zostaje, żeby
 *    dało się sprawdzić poprawkę — dokumenty testowe nie mają skutków prawnych.
 *
 * Znaczniki w treści błędu przechodzą przez oba backendy jobów; handler
 * wyczerpania prób zamienia je na neutralny stan „do uzgodnienia”
 * (bez komunikatu „odrzucona”, jak `ROZ_HOLD_RECONCILE`).
 */

import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';

export const KSEF_PAUSED = 'KSEF_PAUSED';
export const KOR_HOLD = 'KOR_HOLD';

/** Odmowa przy kolejkowaniu: dokument zostaje szkicem, wysyła go człowiek. */
export const KSEF_PAUSED_MESSAGE =
  'Wysyłka faktur do KSeF jest chwilowo wstrzymana przez operatora. Faktura została zapisana jako szkic — wyślij ją ponownie, gdy wysyłka zostanie przywrócona.';

export const KOR_HOLD_MESSAGE =
  'Wysyłka faktur korygujących do KSeF jest tymczasowo wstrzymana do czasu poprawki ich kwot. Korekta została zapisana jako szkic.';

/**
 * Hamulec napotkany już W JOBIE: faktura ma status `failed` z kodem hamulca.
 * Cron cyklu życia (I7) wznawia sam tylko KSEF_PAUSED — dokumenty specjalne
 * tylko w dniu wystawienia (A4b PR2a); KOR_HOLD zostaje operatorowi do C4.
 * Komunikat mówi prawdę o tym, co się stanie (decyzja Bartosza 07.10.2026).
 */
export const KSEF_PAUSED_JOB_MESSAGE =
  'Wysyłka faktur do KSeF jest chwilowo wstrzymana przez operatora. Faktura wyjdzie automatycznie po przywróceniu wysyłki.';

/** KSEF_PAUSED dokumentu specjalnego: automat wznowi go tylko w dniu wystawienia. */
export const KSEF_PAUSED_SPECIAL_JOB_MESSAGE =
  'Wysyłka faktur do KSeF jest chwilowo wstrzymana przez operatora — tej próby wysyłki nie wykonaliśmy. Korektę i fakturę zaliczkową wyślemy automatycznie tylko wtedy, gdy wysyłka wróci w dniu ich wystawienia (co dalej — na dole strony).';

export const KOR_HOLD_JOB_MESSAGE =
  'Wysyłka faktur korygujących do KSeF jest tymczasowo wstrzymana do czasu poprawki ich kwot — tej próby wysyłki nie wykonaliśmy, a po zdjęciu blokady tej korekty sami nie wyślemy (co dalej — na dole strony).';

/** Czy operator zatrzymał wszystkie wysyłki. Rzuca przy błędzie bazy (fail-closed). */
export async function isKsefSubmissionPaused(): Promise<boolean> {
  return getGlobalFlagForExecution('killAllKsefSubmissions');
}

export function isCorrectionSubmission(input: {
  invoiceType?: string | null;
  storedInvoiceType?: string | null;
  invoiceKind?: string | null;
  auditKind?: string | null;
  correctionData?: unknown;
}): boolean {
  return input.invoiceType?.toUpperCase() === 'KOR'
    || input.storedInvoiceType?.toUpperCase() === 'KOR'
    || input.invoiceKind?.toLowerCase() === 'correction'
    || input.auditKind?.toLowerCase() === 'correction'
    || input.correctionData != null;
}

// Korekty są wstrzymane tylko na KSeF produkcyjnym — czysta definicja w kind-holds (A4b PR2a).
export { isCorrectionHeldForEnv } from './kind-holds';

/** Treść błędu joba ze znacznikiem neutralnej blokady; tekst KSEF_PAUSED zależy od rodzaju dokumentu. */
export function heldErrorMessage(code: typeof KSEF_PAUSED | typeof KOR_HOLD, invoiceKind: string | null = 'regular'): string {
  if (code === KOR_HOLD) return `[${code}] ${KOR_HOLD_JOB_MESSAGE}`;
  const special = invoiceKind !== null && invoiceKind !== 'regular';
  return `[${code}] ${special ? KSEF_PAUSED_SPECIAL_JOB_MESSAGE : KSEF_PAUSED_JOB_MESSAGE}`;
}
