import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { RECURRING_STATUS_LABELS, type RecurringStatus } from '@/types/recurring-invoice';

/**
 * Plakietka statusu faktury cyklicznej. Finora (`RECURRING_INVOICE_STATUS_STYLES`
 * w `types/pages/recurring-invoice-types.ts`) pokazuje w kolumnie Status sam
 * awatar z ikoną; plan P6 chce słów: Aktywna / Wstrzymana / Do wystawienia,
 * więc plakietka z tekstem (jak status w „Wszystkich operacjach” na
 * Przepływach), w kolorach Finory.
 *
 * Kontrast WCAG AA (4,5:1, tekst 12 px), policzony z oklch Tailwinda v4 na
 * tle plakietki (10% koloru) — na białej karcie ORAZ na wierszu tabeli w
 * stanie hover / z otwartym menu „⋯” (`bg-muted/50`) i zaznaczonym
 * (`bg-muted`), bo plakietka leży w wierszu. Pilnuje tego
 * `tests/unit/faktury-cykliczne-lista-kontrast.test.tsx`:
 * - Wstrzymana: tło Finory `amber-600/10`, tekst `amber-800` (Finora: 600,
 *   ok. 3:1). `amber-700` miał 4,53:1 na karcie, ale 4,41:1 na wierszu
 *   hover i 4,29:1 na zaznaczonym; `amber-800` daje 6,40 / 6,23 / 6,06:1.
 * - Aktywna: tło Finory `green-600/10`, tekst `green-800` — `green-700` daje
 *   tu tylko 4,41:1, więc o stopień ciemniej (6,33:1 na karcie, 6,17:1 na wierszu hover).
 * - Do wystawienia: stanu nie ma w Finorze (tam „ended” = destructive). To
 *   jedyny stan, który czeka na ruch klienta, więc dostaje pełny kolor
 *   główny (domyślny wariant `Badge` Finory): biały na `primary` 5,10:1,
 *   w ciemnym motywie 7,02:1. `text-primary` na `primary/10` miałby 4,44:1.
 * W ciemnym motywie `*-400` jak w Finorze (ok. 7:1 na karcie).
 */
export const RECURRING_STATUS_STYLES: Record<RecurringStatus, string> = {
  active:
    'bg-green-600/10 text-green-800 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40',
  paused:
    'bg-amber-600/10 text-amber-800 focus-visible:ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-400 dark:focus-visible:ring-amber-400/40',
  due: 'bg-primary text-primary-foreground focus-visible:ring-primary/20 dark:focus-visible:ring-primary/40',
};

export function RecurringStatusBadge({ status }: { status: RecurringStatus }) {
  return (
    <Badge className={cn('h-auto border-none focus-visible:outline-none', RECURRING_STATUS_STYLES[status])}>
      {RECURRING_STATUS_LABELS[status]}
    </Badge>
  );
}
