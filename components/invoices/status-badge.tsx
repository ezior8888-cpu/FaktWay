import { RiLoader4Line } from '@remixicon/react';

import { badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { sendErrorClassOf } from '@/lib/ksef/send-error-classes';

type FfStatusTone = 'success' | 'warning' | 'info' | 'danger' | 'violet' | 'neutral';

/**
 * Plakietka statusu KSeF w stylu Finory (plan Finora E3b): `Badge` szablonu
 * z klasami plakietki „Paid” z `invoice-table/data-table.tsx` (`h-auto
 * rounded-sm`, tło = 10% koloru roli, tekst = kolor roli) zamiast dawnych
 * pigułek na `--ff-*`. Status niesie etykieta, nie sam kolor; spinner mówi,
 * że coś trwa. Bez `data-slot="badge"`: na liście faktur ten znacznik ma
 * tylko plakietka „Opłacona” w kolumnie „Do zapłaty”.
 *
 * Odstępstwo od Finory: w jasnym motywie tekst w odcieniu 700, nie 600 —
 * zielony i bursztynowy 600 na własnym tle 10% mają kontrast ok. 3:1, a axe
 * w `e2e/tests/06-accessibility.spec.ts` wymaga 4,5:1 (WCAG AA).
 */
export const STATUS_TONE_CLASS: Record<FfStatusTone, string> = {
  success: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  warning: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
  info: 'bg-sky-600/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-400',
  danger: 'bg-destructive/10 text-destructive',
  violet: 'bg-violet-600/10 text-violet-700 dark:bg-violet-400/10 dark:text-violet-400',
  neutral: 'bg-muted text-muted-foreground',
};
const STATUS_MAP: Record<string, { label: string; tone: FfStatusTone }> = {
  draft: { label: 'Szkic', tone: 'neutral' },
  pending: { label: 'W kolejce', tone: 'warning' },
  queued: { label: 'W kolejce', tone: 'warning' },
  sending: { label: 'Wysyłanie', tone: 'info' },
  offline_queued: { label: 'Offline (do uzgodnienia)', tone: 'warning' },
  accepted: { label: 'Zaakceptowana', tone: 'success' },
  rejected: { label: 'Odrzucona', tone: 'danger' },
  failed: { label: 'Błąd', tone: 'danger' },
  received: { label: 'Odebrana', tone: 'violet' },
};

const FALLBACK: { label: string; tone: FfStatusTone } = {
  label: 'Nieznany',
  tone: 'neutral',
};

/**
 * `failed` z kodem z katalogu `ksef_error_codes` (00131): etykieta mówi, co
 * dalej — automat, operator czy klient (cykl życia faktury, sekcja 7).
 */
const FAILED_BY_CLASS: Record<string, { label: string; tone: FfStatusTone }> = {
  transient: { label: 'Błąd — ponawiamy', tone: 'warning' },
  hold: { label: 'Wstrzymana', tone: 'warning' },
  reconcile: { label: 'Do uzgodnienia', tone: 'warning' },
  setup: { label: 'Brak certyfikatu', tone: 'danger' },
  terminal: { label: 'Błąd treści', tone: 'danger' },
};

/**
 * Kody, dla których etykieta klasy myli: `ENV_MISMATCH` jest klasy terminal
 * (tylko szkic, D-A4-2), ale treść dokumentu jest w porządku.
 */
const FAILED_BY_CODE = new Map<string, { label: string; tone: FfStatusTone }>([
  ['ENV_MISMATCH', { label: 'Inne środowisko KSeF', tone: 'warning' }],
  ['ISSUE_DATE_PASSED', { label: 'Data wystawienia minęła', tone: 'warning' }],
]);

/** Klasa transient bez automatu (kod spoza `auto_requeue`, dokument po dacie wystawienia, brak danych). */
const FAILED_TRANSIENT_MANUAL: { label: string; tone: FfStatusTone } = { label: 'Błąd wysyłki', tone: 'danger' };

interface StatusBadgeProps {
  status: string;
  /** `invoices.last_error_code` — doprecyzowuje etykietę stanu `failed`. */
  errorCode?: string | null;
  /**
   * Czy automat naprawdę ponowi wysyłkę (`automaticResendExpected`). Bez tej
   * informacji znaczek nie obiecuje ponowienia: „Błąd wysyłki”.
   */
  automaticResend?: boolean;
  isLoading?: boolean;
}

export function StatusBadge({ status, errorCode, automaticResend, isLoading }: StatusBadgeProps) {
  const failedClass = status === 'failed' ? sendErrorClassOf(errorCode) : null;
  const byCode = status === 'failed' && errorCode ? FAILED_BY_CODE.get(errorCode) : undefined;
  const byClass = failedClass === 'transient' && automaticResend !== true
    ? FAILED_TRANSIENT_MANUAL
    : failedClass ? FAILED_BY_CLASS[failedClass] : undefined;
  const meta = byCode ?? byClass ?? STATUS_MAP[status] ?? FALLBACK;
  const showSpinner =
    isLoading === true ||
    status === 'queued' ||
    status === 'pending' ||
    status === 'sending';

  return (
    <span
      data-slot="status-ksef"
      data-tone={meta.tone}
      className={cn(badgeVariants({ variant: 'secondary' }), 'h-auto rounded-sm', STATUS_TONE_CLASS[meta.tone])}
    >
      {showSpinner ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
      {meta.label}
    </span>
  );
}
