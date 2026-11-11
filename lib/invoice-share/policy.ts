/**
 * Link do faktury dla nabywcy (plan kompletnej aplikacji, krok 2.10).
 *
 * Reguły w module bez importów, bo biorą je trzy miejsca: proxy (która
 * ścieżka jest publiczna i z jakimi nagłówkami), akcje w karcie faktury (kto
 * i dla jakiej faktury tworzy link) i strona `/faktura/<token>`. Te same
 * warunki faktury stoją w bazie: funkcja `invoice_shareable` w migracji 00179
 * (polityka INSERT i odczyt publiczny).
 *
 * Token: 32 losowe bajty w base64url (`generateAccountantToken` z
 * `lib/accountant/tokens.ts`, ten sam mechanizm co portal księgowej), czyli
 * 256 bitów losowości i 43 znaki. W bazie tylko skrót SHA-256.
 */

/** Ile dni działa link (domyślna i najdłuższa wartość w bazie, CHECK w 00179). */
export const BUYER_LINK_TTL_DAYS = 90;

/** Ścieżka strony nabywcy: `/faktura/<token>` oraz `/pdf` i `/xml` pod nią. */
export const BUYER_INVOICE_PATH_PREFIX = '/faktura';

/** Token z adresu: 43 znaki base64url (32 bajty). Inny kształt to od razu „link nie działa”. */
const BUYER_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isBuyerLinkToken(value: unknown): value is string {
  return typeof value === 'string' && BUYER_TOKEN.test(value);
}

/** Względny adres strony nabywcy; pełny buduje akcja z `siteUrl()`. */
export function buyerInvoicePath(token: string): string {
  return `${BUYER_INVOICE_PATH_PREFIX}/${token}`;
}

/**
 * Czy ścieżka należy do strony nabywcy. Tylko `/faktura/<coś>`: sam
 * `/faktura`, `/faktura/` i ścieżki o podobnym początku (`/faktury`,
 * `/fakturax`) zostają za logowaniem.
 */
export function isBuyerInvoicePath(pathname: string): boolean {
  const prefix = `${BUYER_INVOICE_PATH_PREFIX}/`;
  return pathname.startsWith(prefix) && pathname.length > prefix.length;
}

/**
 * Nagłówki każdej odpowiedzi strony nabywcy i jej plików: dane prywatne bez
 * cache, bez indeksowania, bez Referer (token jest w adresie). Ustawia je
 * proxy dla całej ścieżki, a trasy plików jeszcze raz same.
 */
export const BUYER_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Kto tworzy i cofa link. Jak przy oznaczaniu zapłaty (`INVOICE_PAYMENT_ROLES`):
 * księgowa ma wgląd, a link wysyła fakturę na zewnątrz w imieniu firmy. Ta sama
 * lista stoi w politykach RLS 00179.
 */
export const BUYER_LINK_ROLES = ['owner', 'admin', 'member'] as const;

export function canManageBuyerLinks(role: string | null | undefined): boolean {
  return typeof role === 'string' && (BUYER_LINK_ROLES as readonly string[]).includes(role);
}

/**
 * Rodzaje faktur z linkiem: VAT i zaliczkowa (`invoice_kind`). Korekta
 * i faktura rozliczeniowa mają na PDF stan przed i po albo rozliczenie
 * zaliczek, a dziś nie wychodzą do KSeF produkcyjnego (plan zero zgubionych
 * faktur, C1-C4). Ich podgląd dla nabywcy to osobny krok.
 */
export const BUYER_LINK_INVOICE_KINDS = ['regular', 'advance'] as const;

/** Fakty faktury, od których zależy link (kolumny `invoices`). */
export interface BuyerLinkInvoiceFacts {
  internal_number: string | null;
  direction: string | null;
  origin: string | null;
  ksef_status: string | null;
  invoice_kind: string | null;
  ksef_number: string | null;
  ksef_environment: string | null;
  xml_storage_path: string | null;
}

export const BUYER_LINK_TEXTS = {
  ROLE: 'Link dla nabywcy tworzy i cofa właściciel, administrator albo członek zespołu firmy. Poproś jedną z tych osób.',
  NOT_FOUND: 'Nie znaleziono tej faktury w aktywnej firmie. Odśwież stronę albo przełącz firmę.',
  ENVIRONMENT_MISSING: 'Aplikacja nie ma teraz poprawnie ustawionego środowiska KSeF, więc link nie powstanie. Spróbuj za chwilę, a jeśli to się powtórzy, napisz do pomoc@faktway.pl.',
  CREATE_FAILED: 'Nie udało się utworzyć linku. Spróbuj ponownie za chwilę.',
  CREATE_RACE: 'Link do tej faktury powstał przed chwilą w innym oknie. Zamknij to okno i otwórz „Link dla nabywcy” jeszcze raz.',
  READ_FAILED: 'Nie udało się sprawdzić linku do tej faktury. Spróbuj ponownie za chwilę.',
  REVOKE_FAILED: 'Nie udało się cofnąć linku. Spróbuj ponownie za chwilę.',
  REVOKE_GONE: 'Ten link jest już cofnięty albo nie należy do aktywnej firmy. Odśwież okno, żeby zobaczyć obecny stan.',
} as const;

function invoiceLabel(row: Pick<BuyerLinkInvoiceFacts, 'internal_number'>): string {
  const number = row.internal_number?.trim();
  return number ? `Faktura ${number}` : 'Ta faktura';
}

/**
 * Odmowa utworzenia linku (komunikat z nazwą dokumentu i tym, co zrobić)
 * albo `null`, gdy link wolno utworzyć. `xmlHash`: w `xml_documents` jest skrót
 * pliku wysłanego do KSeF (bez niego PDF nie ma kodu QR, a nabywca pliku XML).
 */
export function buyerLinkRefusal(
  row: BuyerLinkInvoiceFacts,
  environment: string | null,
  { xmlHash }: { xmlHash: boolean },
): string | null {
  const label = invoiceLabel(row);
  if (row.direction !== 'outgoing') {
    return 'Link dla nabywcy jest tylko przy fakturze sprzedaży. Fakturę zakupu masz w KSeF i w kosztach.';
  }
  if (row.origin !== 'app') {
    return `${label} nie została wystawiona w FaktWay, więc link nie powstanie. Link dla nabywcy jest przy fakturze sprzedaży wystawionej w FaktWay.`;
  }
  if (row.ksef_status !== 'accepted' || !row.ksef_number?.trim()) {
    return `${label} nie jest jeszcze przyjęta w KSeF. Link dla nabywcy utworzysz, gdy KSeF ją przyjmie i nada numer.`;
  }
  if (!(BUYER_LINK_INVOICE_KINDS as readonly string[]).includes(row.invoice_kind ?? '')) {
    return `${label} to korekta albo faktura rozliczeniowa. Link dla nabywcy działa na razie dla faktur VAT i zaliczkowych, więc ten dokument wyślij nabywcy e-mailem.`;
  }
  if (!environment || row.ksef_environment !== environment) {
    return `${label} pochodzi z innego środowiska KSeF niż to, w którym działa teraz aplikacja, więc link nie powstanie. Wyślij ją nabywcy e-mailem.`;
  }
  if (!row.xml_storage_path || !xmlHash) {
    return `${label} nie ma zapisanego pliku XML wysłanego do KSeF, więc link nie powstanie. Wyślij ją nabywcy e-mailem albo napisz do pomoc@faktway.pl.`;
  }
  return null;
}

/** Stan ostatniego linku faktury w panelu karty faktury. */
export type BuyerLinkStatus = 'active' | 'expired' | 'revoked';

export interface BuyerLinkState {
  id: string;
  status: BuyerLinkStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  openCount: number;
  lastOpenedAt: string | null;
}

export function buyerLinkStatus(
  row: { revoked_at: string | null; expires_at: string },
  now: Date = new Date(),
): BuyerLinkStatus {
  if (row.revoked_at) return 'revoked';
  const expires = new Date(row.expires_at).getTime();
  // Nieczytelny termin to link wygasły: lepiej poprosić o nowy, niż obiecać działający.
  return Number.isFinite(expires) && expires > now.getTime() ? 'active' : 'expired';
}
