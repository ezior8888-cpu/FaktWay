import { z } from 'zod';

/**
 * Wątek przy koszcie: komentarze i prośby o dokument (plan kompletnej
 * aplikacji, krok 6.2, część 3; tabela `expense_comments`, 00192). Role,
 * schemat treści, kształty wyników i teksty w module bez importów serwerowych:
 * biorą go akcje, ładowarka wątku i komponent klienta.
 *
 * Zapis idzie wyłącznie przez funkcje bazy (`expense_comment_add`,
 * `expense_document_request_resolve`): komentarz, wpis w dzwonku pozostałych
 * członków firmy i audyt prośby powstają w jednej transakcji, bez klucza
 * serwisowego w akcji użytkownika.
 */

/**
 * Kto widzi i pisze: ci sami, którzy widzą koszty. Polityka kosztów (00034)
 * wpuszcza każdego aktywnego członka aktywnej firmy, bez podziału na role.
 * Ta sama lista stoi w funkcjach 00192 (i w liście odbiorców wpisu w dzwonku).
 */
export const EXPENSE_THREAD_ROLES = ['owner', 'admin', 'member', 'accountant'] as const;
export type ExpenseThreadRole = (typeof EXPENSE_THREAD_ROLES)[number];

export function canUseExpenseThread(role: unknown): role is ExpenseThreadRole {
  return typeof role === 'string' && (EXPENSE_THREAD_ROLES as readonly string[]).includes(role);
}

/** Rodzaje wpisów; ta sama lista jest w CHECK `expense_comments_kind_check`. */
export const EXPENSE_COMMENT_KINDS = ['comment', 'document_request'] as const;
export type ExpenseCommentKind = (typeof EXPENSE_COMMENT_KINDS)[number];

export function isExpenseCommentKind(kind: unknown): kind is ExpenseCommentKind {
  return typeof kind === 'string' && (EXPENSE_COMMENT_KINDS as readonly string[]).includes(kind);
}

/** Limit treści z CHECK `expense_comments_body_check`. */
export const EXPENSE_COMMENT_MAX_LENGTH = 2000;
/** Ile ostatnich wpisów pokazuje wątek. */
export const EXPENSE_THREAD_LIMIT = 100;
/** Kotwica sekcji na ekranie kosztu; link z dzwonka (00192) prowadzi do `/expenses/<id>#komentarze`. */
export const EXPENSE_THREAD_ANCHOR = 'komentarze';

/** Etykiety ról jak w ustawieniach zespołu (`components/team/team-management.tsx`). */
export const EXPENSE_THREAD_ROLE_LABELS: Record<ExpenseThreadRole, string> = {
  owner: 'właściciel',
  admin: 'admin',
  member: 'członek',
  accountant: 'księgowy',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Treść wpisu: ta sama reguła w formularzu i w akcji; funkcja bazy sprawdza ją jeszcze raz. */
const bodySchema = z
  .string()
  .trim()
  .min(1, 'Wpisz treść wpisu.')
  .max(EXPENSE_COMMENT_MAX_LENGTH, 'Wpis może mieć najwyżej 2000 znaków. Skróć go i zapisz ponownie.');

export const expenseCommentFormSchema = z.object({ body: bodySchema });
export type ExpenseCommentFormValues = z.infer<typeof expenseCommentFormSchema>;

export const expenseCommentInputSchema = z.object({
  expenseId: z.string().regex(UUID_RE),
  /** Klucz idempotencji: ten sam przy ponowieniu tej samej treści (00192). */
  commentId: z.string().regex(UUID_RE),
  kind: z.enum(EXPENSE_COMMENT_KINDS),
  body: bodySchema,
});
export type ExpenseCommentInput = z.input<typeof expenseCommentInputSchema>;

/** Wpis w wątku, tak jak widzi go przeglądarka (bez identyfikatorów osób). */
export interface ExpenseThreadEntry {
  id: string;
  kind: ExpenseCommentKind;
  body: string;
  createdAt: string;
  /** „Ty”, nazwa osoby ze wspólnej firmy, rola (osoba spoza firmy) albo „Konto usunięte”. */
  authorLabel: string;
  /** Rola autora w chwili wpisu; `null`, gdy już stoi w `authorLabel`. */
  authorRoleLabel: string | null;
  mine: boolean;
  /** Tylko prośba o dokument: kiedy załatwiona (`null` = otwarta). */
  resolvedAt: string | null;
  resolvedByLabel: string | null;
}

export type ExpenseThreadLoad =
  | { ok: true; entries: ExpenseThreadEntry[]; truncated: boolean }
  | { ok: false; error: string };

export type AddExpenseCommentResult = { success: true; status: 'created' | 'exists' } | { success: false; error: string };

export type ResolveDocumentRequestResult =
  | { success: true; status: 'resolved' | 'already_resolved' }
  | { success: false; error: string };

export const THREAD_LOAD_ERROR = 'Nie udało się wczytać komentarzy do kosztu. Odśwież stronę za chwilę.';
export const COMMENT_SAVE_ERROR = 'Nie udało się zapisać wpisu. Sprawdź połączenie i spróbuj ponownie.';
export const REQUEST_RESOLVE_ERROR = 'Nie udało się oznaczyć prośby jako załatwionej. Sprawdź połączenie i spróbuj ponownie.';
export const THREAD_NO_ACCESS = 'Nie masz dostępu do kosztów tej firmy. Odśwież stronę albo przełącz firmę.';

export const COMMENT_ADDED = 'Komentarz dodany.';
export const REQUEST_ADDED = 'Prośba o dokument dodana.';
export const REQUEST_RESOLVED = 'Prośba oznaczona jako załatwiona.';
export const REQUEST_ALREADY_RESOLVED = 'Ta prośba była już załatwiona.';

/** Odmowa `expense_comment_add`: mówi, co zrobić (protokół napraw, pkt 4). */
export function addCommentRefusalText(code: unknown): string {
  switch (code) {
    case 'empty_body':
      return 'Wpisz treść wpisu.';
    case 'body_too_long':
      return 'Wpis może mieć najwyżej 2000 znaków. Skróć go i zapisz ponownie.';
    case 'not_found':
      return 'Nie znaleziono tego kosztu w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'conflict':
      return 'Ten wpis zapisał się już w innej wersji. Odśwież stronę i sprawdź komentarze.';
    default:
      return COMMENT_SAVE_ERROR;
  }
}

/** Odmowa `expense_document_request_resolve`. */
export function resolveRefusalText(code: unknown): string {
  switch (code) {
    case 'not_found':
      return 'Nie znaleziono tej prośby o dokument w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'not_request':
      return 'Jako załatwioną można oznaczyć tylko prośbę o dokument.';
    default:
      return REQUEST_RESOLVE_ERROR;
  }
}

/** „1 otwarta prośba”, „3 otwarte prośby”, „5 otwartych próśb” (polska odmiana liczebnika). */
export function openRequestsLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) return '1 otwarta prośba';
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${n} otwarte prośby`;
  return `${n} otwartych próśb`;
}

/**
 * Identyfikator nowego wpisu z przeglądarki (UUID v4). `crypto.randomUUID`
 * działa tylko w bezpiecznym kontekście, więc obok jest wersja z
 * `getRandomValues` (te same bity wersji i wariantu).
 */
export function newCommentId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
