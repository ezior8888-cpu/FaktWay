import Link from 'next/link';

import { CaptureButton } from '@/components/expenses/capture-button';
import { ExpensesTable } from '@/components/expenses/finora/expenses-table';
import MonthSelector from '@/components/expenses/finora/month-selector';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { monthRange, parseExpenseMonth } from '@/lib/expenses/month';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * Wydatki (plan Finora P8 ← Finora `/transactions`: `TransactionsView` =
 * kafle + karta z tabelą). Wybór miesiąca jak w Finora Monthly Analytics.
 * Lista i jej zapytanie bez zmian (F-087: miesiąc od–do albo wszystkie „Do
 * opisania”); kafle liczą własne zapytania (§2.4 pkt 12) w osobnych granicach
 * błędu.
 *
 * Poprawka Bartosza 21.10.2026: zakładka „Wydatki” ekranu Koszty (druga to
 * „Skrzynka KSeF”), jak zakładki Faktur — bez widocznego nagłówka (tytuł dla
 * czytników ekranu), karta z zakładkami sięga do stopki (`ff-page-fill`).
 *
 * Od 25.10.2026 kafle, karta i rząd zakładek stoją w `(koszty)/layout.tsx`,
 * a ta strona to zawartość karty: przełączenie zakładki albo widoku zmienia
 * tylko tabelę. „Miesiąc / Do opisania” i wybór miesiąca filtrują tylko
 * tabelę, więc stoją w jej pasku (kafle sekcji liczą bieżący miesiąc).
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; miesiac?: string }>;
}) {
  const { filter, miesiac } = await searchParams;
  const unreviewedOnly = filter === 'unreviewed';

  const { supabase, tenantId } = await getPageContext();

  // Wybrany miesiąc (domyślnie bieżący w czasie polskim) z zakresem od–do
  // — wcześniej tylko „od początku bieżącego miesiąca” w strefie serwera (F-087).
  const month = parseExpenseMonth(miesiac);
  const currentMonth = parseExpenseMonth(undefined);
  const { from: monthStart, to: monthEnd } = monthRange(month);

  let expensesQuery = supabase
    .from('expenses')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('issue_date', { ascending: false });

  if (unreviewedOnly) {
    expensesQuery = expensesQuery.eq('is_reviewed', false).limit(200);
  } else {
    expensesQuery = expensesQuery.gte('issue_date', monthStart).lte('issue_date', monthEnd).limit(500);
  }

  const { data: expenses, error } = await expensesQuery;

  // Bez dolnego odstępu pod pływającym „+ Dodaj wydatek”: karta ma sięgać stopki
  // jak w Skrzynce KSeF, a na końcu przewijania stopka z `py-6` powłoki i tak
  // trzyma paginację z dala od przycisku.
  return (
    <div className="ff-tab-panel flex w-full flex-1 flex-col pt-2">
      <h1 className="sr-only">Wydatki</h1>

      {/* Widok i miesiąc filtrują tylko tabelę — w jej pasku, w karcie. Linki bez
          przewijania: zmienia się lista, nie ekran. */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <nav aria-label="Widok listy wydatków" className="flex">
          <Link
            href="/expenses"
            prefetch
            scroll={false}
            aria-current={!unreviewedOnly ? 'page' : undefined}
            className={buttonVariants({ variant: !unreviewedOnly ? 'default' : 'outline' })}
          >
            Miesiąc
          </Link>
          <Link
            href="/expenses?filter=unreviewed"
            prefetch
            scroll={false}
            aria-current={unreviewedOnly ? 'page' : undefined}
            className={buttonVariants({ variant: unreviewedOnly ? 'default' : 'outline' })}
          >
            Do opisania
          </Link>
        </nav>
        {!unreviewedOnly ? (
          <MonthSelector month={month} currentMonth={currentMonth} basePath="/expenses" />
        ) : null}
      </div>

      {error ? (
        // Błąd w karcie sekcji — rząd zakładek nad nim prowadzi do Skrzynki KSeF.
        <div className="flex flex-col gap-4 px-4 pt-2">
          <Alert variant="destructive">
            <AlertTitle>Nie udało się pobrać wydatków: {error.message}</AlertTitle>
          </Alert>
          {/* Od `lg` przycisk stoi w pasku tabeli; bez tabeli dodawanie zostaje tu. */}
          <div className="flex justify-end max-lg:hidden">
            <CaptureButton />
          </div>
        </div>
      ) : (
        <div className="flex w-full flex-1 flex-col">
          <ExpensesTable
            expenses={expenses ?? []}
            listVariant={unreviewedOnly ? 'unreviewed' : 'month'}
          />
        </div>
      )}

      <div className="fixed bottom-[calc(1.5rem+var(--ff-bottom-nav-h)+var(--ff-safe-b))] right-6 z-30 lg:hidden">
        <CaptureButton triggerClassName="h-11 px-4 shadow-lg" />
      </div>
    </div>
  );
}
