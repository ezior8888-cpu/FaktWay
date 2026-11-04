import type { Database } from '@/types/database'

/**
 * Etykiety i style wartości wydatków dla tabeli Finory (P8) — wspólne dla
 * komórek, filtrów i kart na telefonie. Moduł bez importów wykonywalnych:
 * serwer i przeglądarka.
 */

type ExpenseSource = Database['public']['Enums']['expense_source']

/** Kolumna „Źródło” (Finora: Group). */
export const SOURCE_LABELS: Record<ExpenseSource, string> = {
  ksef_inbox: 'KSeF',
  ocr_photo: 'Zdjęcie',
  manual: 'Ręcznie',
  import: 'Import'
}

/**
 * Kolory plakietek jak `TRANSACTION_GROUP_STYLES` Finory (tło `…/10` koloru
 * grupy). Tekst o odcień ciemniejszy w jasnym motywie i jaśniejszy
 * w ciemnym, bo w naszym presecie `chart-2`/`chart-3` to niebieskie, nie
 * zielenie Finory: same dawały na karcie 4,4:1 (jasny), 3,6:1 i 2,7:1
 * (ciemny), poniżej WCAG AA dla tekstu 12 px. Pilnuje
 * `tests/unit/wydatki-skrzynka-kontrast.test.ts`.
 */
export const SOURCE_STYLES: Record<ExpenseSource, string> = {
  ksef_inbox: 'bg-primary/10 text-chart-3 dark:text-primary',
  ocr_photo: 'bg-chart-2/10 text-chart-4 dark:text-accent-foreground',
  manual: 'bg-muted text-muted-foreground',
  import: 'bg-chart-3/10 text-chart-3 dark:bg-chart-3/20 dark:text-foreground'
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source as ExpenseSource] ?? SOURCE_LABELS.manual
}

export function sourceStyle(source: string): string {
  return SOURCE_STYLES[source as ExpenseSource] ?? SOURCE_STYLES.manual
}

const KPIR_LABELS: Record<string, string> = {
  col_7: 'Kol. 7',
  col_8: 'Kol. 8',
  col_10: 'Towary',
  col_11: 'Koszty uboczne',
  col_12: 'Wynagrodzenia',
  col_13: 'Pozostałe',
  col_15: 'B+R',
  col_16: 'Kol. 16'
}

export function kpirShortLabel(col: string | null): string {
  if (!col) return '—'
  return KPIR_LABELS[col] ?? col
}

const DOCUMENT_LABELS: Record<string, string> = {
  invoice: 'Faktura',
  simplified_invoice: 'Faktura uproszczona',
  receipt: 'Paragon',
  other: 'Inny dokument'
}

export function documentLabel(type: string | null): string {
  return DOCUMENT_LABELS[type ?? 'invoice'] ?? 'Inny dokument'
}

export const NO_CATEGORY = 'Bez kategorii'

/** Status (Finora: completed / pending) → Opisany / Do opisania. */
export type ReviewStatus = 'reviewed' | 'unreviewed'

export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  reviewed: 'Opisany',
  unreviewed: 'Do opisania'
}

/**
 * Kolory jak `TRANSACTION_STATUS_STYLES` Finory (completed / pending), z tekstem
 * o odcień ciemniejszym w jasnym motywie (700 zamiast 600): plakietka niesie
 * tekst, a `amber-600` na jasnym tle ma ok. 3:1, poniżej WCAG AA.
 */
export const REVIEW_STYLES: Record<ReviewStatus, string> = {
  reviewed: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  unreviewed: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400'
}

/** Data RRRR-MM-DD → DD.MM.RRRR (plan Finora §7.1); inna wartość bez zmian. */
export function plDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso
}
