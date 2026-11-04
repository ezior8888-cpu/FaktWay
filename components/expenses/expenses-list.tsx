import Link from 'next/link';
import { RiCheckLine, RiFileList3Line, RiTimeLine } from '@remixicon/react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  kpirShortLabel,
  NO_CATEGORY,
  REVIEW_LABELS,
  REVIEW_STYLES,
  sourceLabel,
  sourceStyle,
} from '@/components/expenses/finora/labels';
import { formatPlMoney } from '@/lib/format/pl';
import { shortenLegalForm } from '@/lib/format/legal-form';
import { cn } from '@/lib/utils';
import type { Database } from '@/types/database';

export type ExpenseRow = Database['public']['Tables']['expenses']['Row'];

/**
 * Lista wydatków na telefonie (plan Finora §7.2: poniżej `lg` zostają karty
 * jak dziś — grupy po dniu z sumą dnia, wiersz = sprzedawca, kwota, źródło,
 * kategoria · KPiR, numer dokumentu). Oprawa Finory: rząd w karcie tabeli
 * (`TransactionDatatable`), plakietki i status jak w kolumnach tabeli.
 */

/** Pusty stan listy (miesiąc bez wydatków albo nic do opisania). */
export function ExpensesEmptyState({ variant }: { variant: 'month' | 'unreviewed' }) {
  const unreviewed = variant === 'unreviewed';
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <Avatar className="size-12 after:border-0">
        <AvatarFallback className="bg-primary/10 text-primary [&>svg]:size-6">
          {unreviewed ? <RiCheckLine /> : <RiFileList3Line />}
        </AvatarFallback>
      </Avatar>
      <div className="space-y-1">
        <h3 className="text-foreground text-base font-semibold">
          {unreviewed ? 'Brak wydatków do opisania' : 'Brak wydatków w tym miesiącu'}
        </h3>
        <p className="text-muted-foreground mx-auto max-w-md text-sm font-normal">
          {unreviewed
            ? 'Wszystkie wydatki są już sprawdzone — świetna robota.'
            : 'Zrób zdjęcie paragonu lub poczekaj, aż KSeF dostarczy faktury zakupowe'}
        </p>
      </div>
    </div>
  );
}

/** Dzień jako „poniedziałek, 5 października” (strefa bez znaczenia: data bez godziny). */
function dayHeading(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/**
 * Karty wydatków pogrupowane po dniu. `dayTotals` to suma brutto dnia ze
 * WSZYSTKICH wierszy po filtrach (nie tylko z bieżącej strony), żeby suma
 * dnia nie zmieniała się przy przejściu na następną stronę.
 */
export function ExpenseDayCards({
  expenses,
  dayTotals,
}: {
  expenses: ExpenseRow[];
  dayTotals: ReadonlyMap<string, number>;
}) {
  const order: string[] = [];
  const groups = new Map<string, ExpenseRow[]>();
  for (const expense of expenses) {
    const list = groups.get(expense.issue_date);
    if (list) list.push(expense);
    else {
      groups.set(expense.issue_date, [expense]);
      order.push(expense.issue_date);
    }
  }

  return (
    <div className="divide-y">
      {order.map((date) => (
        <section key={date}>
          <div className="bg-muted/50 flex items-baseline justify-between gap-3 px-4 py-2">
            <h2 className="text-muted-foreground text-xs font-medium first-letter:uppercase">{dayHeading(date)}</h2>
            <span className="text-muted-foreground text-xs font-medium tabular-nums">
              {formatPlMoney(dayTotals.get(date) ?? 0)} zł
            </span>
          </div>
          <div className="divide-y">
            {(groups.get(date) ?? []).map((expense) => (
              <ExpenseCard key={expense.id} expense={expense} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ExpenseCard({ expense }: { expense: ExpenseRow }) {
  const status = expense.is_reviewed ? 'reviewed' : 'unreviewed';
  const seller = shortenLegalForm(expense.seller_name);
  const category = expense.category_label?.trim() || NO_CATEGORY;

  return (
    <Link href={`/expenses/${expense.id}`} className="hover:bg-muted/50 flex items-start gap-3 px-4 py-3 transition-colors">
      <Avatar className="after:border-none">
        <AvatarFallback className={REVIEW_STYLES[status]}>
          {expense.is_reviewed ? <RiCheckLine className="size-4" /> : <RiTimeLine className="size-4" />}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="text-foreground truncate text-sm font-medium" title={expense.seller_name}>
            {seller}
          </p>
          <p className="text-foreground shrink-0 text-sm font-medium tabular-nums">
            {formatPlMoney(Number(expense.gross_amount))} zł
          </p>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge className={sourceStyle(expense.source)}>{sourceLabel(expense.source)}</Badge>
            <Badge variant="outline" className="max-w-full truncate">
              {category} · {kpirShortLabel(expense.kpir_column)}
            </Badge>
            {!expense.is_reviewed ? <Badge className={cn(REVIEW_STYLES.unreviewed)}>{REVIEW_LABELS.unreviewed}</Badge> : null}
          </div>
          <span className="text-muted-foreground font-mono text-xs">{expense.document_number ?? '—'}</span>
        </div>
      </div>
    </Link>
  );
}
