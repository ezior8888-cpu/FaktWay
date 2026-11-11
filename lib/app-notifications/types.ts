/**
 * Powiadomienia w aplikacji, czyli dzwonek w nagłówku (plan kompletnej
 * aplikacji, krok 8.1, część 2; tabela `app_notifications`, 00188).
 *
 * Ten plik nie importuje niczego, więc nadaje się i na serwer (joby, akcje),
 * i do komponentu klienckiego dzwonka.
 */

/**
 * Rodzaje wpisów; ta sama lista jest w CHECK `app_notifications_kind_check`
 * (ostatnia definicja: 00197, wpłata do faktury z kolejki
 * `invoice.payment.received.bell`; wcześniej 00192, komentarz i prośba
 * o dokument przy koszcie, zapisywane przez funkcję bazy `expense_comment_add`).
 */
export const APP_NOTIFICATION_KINDS = [
  'inbox_new',
  'invoice_accepted',
  'invoice_rejected',
  'tax_deadline',
  'expense_comment',
  'expense_document_request',
  'payment_received',
] as const;

export type AppNotificationKind = (typeof APP_NOTIFICATION_KINDS)[number];

/** Ile ostatnich wpisów pokazuje dzwonek. */
export const APP_NOTIFICATION_LIST_LIMIT = 20;

/** Limity kolumn z CHECK-ów migracji 00188. */
export const APP_NOTIFICATION_LIMITS = { objectKey: 200, title: 200, body: 1000, link: 500 } as const;

/**
 * Wpis do zapisania przez zadanie. Trafia do każdego aktywnego członka firmy;
 * `kind` + `objectKey` to klucz idempotencji (UNIQUE w 00188), więc ponowienie
 * joba z tym samym kluczem nie dubluje wpisu.
 */
export interface AppNotificationInput {
  tenantId: string;
  kind: AppNotificationKind;
  objectKey: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/** Wpis w dzwonku, tak jak widzi go przeglądarka. */
export interface AppNotificationItem {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string | null;
  /** Ścieżka w aplikacji (`/invoices/…`); `null`, gdy wpis nie prowadzi do obiektu. */
  link: string | null;
  createdAt: string;
  read: boolean;
}

export type AppNotificationsResult =
  | { success: true; unread: number; items: AppNotificationItem[] }
  | { success: false; error: string };

export type MarkAppNotificationsReadResult = { success: true; updated: number } | { success: false; error: string };

export function isAppNotificationKind(kind: unknown): kind is AppNotificationKind {
  return typeof kind === 'string' && (APP_NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/**
 * Link tylko do ścieżki w aplikacji: od „/” i litery, bez „//” (inna domena),
 * ukośnika wstecznego i białych znaków. To samo sprawdza CHECK
 * `app_notifications_link_check`.
 */
export function isAppNotificationLink(link: unknown): link is string {
  return (
    typeof link === 'string' &&
    link.length >= 2 &&
    link.length <= APP_NOTIFICATION_LIMITS.link &&
    /^\/[a-z]/.test(link) &&
    !link.includes('//') &&
    !link.includes('\\') &&
    // Białe i sterujące znaki (także \u0000-\u001f i \u007f) odrzucamy celowo.
    !/[\s\p{Cc}]/u.test(link)
  );
}
