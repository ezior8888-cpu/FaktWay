/**
 * Panele i tabele dashboardu — metryki 1:1 z prototypu „FaktWay Dashboard".
 *
 * Prototyp opisuje tabelę jako: karta `#12171f` w ramce `#1c2230` (radius 16),
 * pasek narzędzi i nagłówek oddzielone tą samą ramką, wiersze rozdzielone
 * słabszą linią `#161c26` i podświetlane `#141a24` na hover. Liczby zawsze
 * mono i wyrównane do prawej — dzięki temu przecinki układają się w kolumnę.
 */
export const ffSettingsPanel =
  'rounded-[var(--ff-radius-lg)] border border-[var(--ff-border)] bg-[var(--ff-surface)]';

export const ffSettingsPanelPadded =
  'rounded-[var(--ff-radius-lg)] border border-[var(--ff-border)] bg-[var(--ff-surface)] p-6 lg:p-8';

export const ffTable = {
  card: 'overflow-hidden rounded-[var(--ff-radius-lg)] border border-[var(--ff-border)] bg-[var(--ff-surface)]',
  header: 'border-b border-[var(--ff-border)] px-[22px] py-[18px]',
  title: 'text-[15px] font-semibold text-[var(--ff-text-strong)]',
  subtitle: 'mt-1 text-[13px] text-[var(--ff-text-muted)]',
  scroll: 'overflow-x-auto',
  table: 'w-full min-w-[880px] text-left text-[13.5px]',
  headRow: 'border-b border-[var(--ff-border)]',
  th: 'px-6 py-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ff-text-dim)]',
  thRight:
    'px-6 py-3.5 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ff-text-dim)]',
  row: 'border-b border-[var(--ff-row-divider)] transition-colors last:border-0 hover:bg-[var(--ff-row-hover)]',
  td: 'px-6 py-4',
  tdMuted: 'px-6 py-4 font-mono text-[13px] text-[var(--ff-text-muted)]',
  tdMono: 'px-6 py-4 font-mono text-[13px] text-[var(--ff-text-soft)]',
  tdStrong:
    'px-6 py-4 text-right font-mono text-[13.5px] font-semibold text-[var(--ff-text-strong)]',
  /** Stopka karty tabeli — podsumowanie „Wyświetlono X z Y". */
  footer:
    'flex items-center justify-between px-6 py-4 text-[13px] text-[var(--ff-text-muted)]',
  badge:
    'inline-flex items-center gap-1.5 rounded-full bg-[var(--ff-neutral-chip)] px-2.5 py-1 text-xs font-semibold text-[var(--ff-neutral-chip-fg)]',
} as const;

/**
 * „Pigułki" statusów z prototypu: tło = przyciemniony odcień koloru roli,
 * tekst = sam kolor roli. Kropka 6 px po lewej niesie status na tyle mocno,
 * że sam kolor tekstu nie musi dźwigać całego znaczenia (a11y).
 */
export const ffStatusTone = {
  success: 'bg-[var(--ff-accent-tint)] text-[var(--ff-accent)]',
  warning: 'bg-[var(--ff-warn-tint)] text-[var(--ff-warn)]',
  info: 'bg-[var(--ff-info-tint)] text-[var(--ff-info)]',
  danger: 'bg-[var(--ff-danger-tint)] text-[var(--ff-danger)]',
  violet: 'bg-[var(--ff-violet-tint)] text-[var(--ff-violet)]',
  neutral: 'bg-[var(--ff-neutral-chip)] text-[var(--ff-neutral-chip-fg)]',
} as const;

export type FfStatusTone = keyof typeof ffStatusTone;

/** Baza „pigułki" — łącz z `ffStatusTone[tone]`. */
export const ffStatusPill =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold';
