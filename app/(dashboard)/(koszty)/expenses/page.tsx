import Link from 'next/link';

import { CaptureButton } from '@/components/expenses/capture-button';
import { KosztyDoZaplaty } from '@/components/expenses/do-zaplaty/koszty-do-zaplaty';
import { ExpensesTable } from '@/components/expenses/finora/expenses-table';
import MonthSelector from '@/components/expenses/finora/month-selector';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { listaDoZaplaty } from '@/lib/expenses/do-zaplaty';
import { wczytajKosztyDoZaplaty } from '@/lib/expenses/do-zaplaty-dane';
import { grupyDoIdentyfikatora, mozeTworzycIdentyfikator } from '@/lib/expenses/identyfikator-zbiorczy';
import { wczytajZapisaneIdentyfikatory } from '@/lib/expenses/identyfikator-zbiorczy-dane';
import { readTenantBankAccount } from '@/lib/expenses/rachunek-firmy';
import { monthRange, parseExpenseMonth } from '@/lib/expenses/month';
import { canChangeExpensePayment } from '@/lib/expenses/zaplata-kosztu';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
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
  // Krok 3.4 (koszty do zapłaty): trzeci widok w tym samym pasku (decyzja D1:
  // dodany link tym samym komponentem, dwa dotychczasowe stoją jak stały).
  const toPay = filter === 'do-zaplaty';

  const { supabase, tenantId, role } = await getPageContext();

  if (toPay) {
    const dzis = todayInWarsaw();
    const srodowisko = configuredKsefEnvironment();
    // Krok 3.4, część 2: rachunek firmy do pliku przelewów. Błąd odczytu to tu
    // brak rachunku (blok pliku poprosi o uzupełnienie); akcja pliku czyta go
    // jeszcze raz i przy błędzie odmawia.
    const [dane, rachunekFirmy] = await Promise.all([
      srodowisko
        ? wczytajKosztyDoZaplaty(supabase, tenantId, srodowisko)
        : Promise.resolve({ blad: 'nie ustawiono środowiska KSeF aplikacji' } as const),
      readTenantBankAccount(supabase, tenantId).catch(() => null),
    ]);
    const odczyt = 'blad' in dane ? dane : { lista: listaDoZaplaty(dane.wiersze, dzis), obcieta: dane.obcieta };
    // Krok 1.4, część 2: grupy faktur jednego dostawcy i zapisane dla nich
    // identyfikatory zbiorcze (00191). Błąd odczytu to brak zapisanych: przycisk
    // i tak nie utworzy drugiego identyfikatora (rezerwacja w bazie go odda).
    const nipyGrup = 'lista' in odczyt ? [...new Set(grupyDoIdentyfikatora(odczyt.lista.pozycje).map((g) => g.nip))] : [];
    const zapisane =
      srodowisko && nipyGrup.length > 0 ? await wczytajZapisaneIdentyfikatory(supabase, tenantId, srodowisko, nipyGrup) : [];
    return (
      <div className="ff-tab-panel flex w-full flex-1 flex-col pt-2">
        <h1 className="sr-only">Wydatki do zapłaty</h1>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          {expensesViewNav('do-zaplaty')}
        </div>
        {'blad' in odczyt ? (
          <div className="px-4 pt-2">
            <Alert variant="destructive">
              <AlertTitle>
                Nie udało się pobrać kosztów do zapłaty: {odczyt.blad}. Odśwież stronę, a jeśli to nie pomoże, napisz do pomocy FaktWay.
              </AlertTitle>
            </Alert>
          </div>
        ) : (
          <KosztyDoZaplaty
            lista={odczyt.lista}
            dzis={dzis}
            mozeOznaczac={canChangeExpensePayment(role)}
            obcieta={odczyt.obcieta}
            rachunekFirmy={rachunekFirmy}
            grupy={grupyDoIdentyfikatora(odczyt.lista.pozycje, zapisane)}
            mozeTworzycIdentyfikator={mozeTworzycIdentyfikator(role)}
          />
        )}
      </div>
    );
  }

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
        {expensesViewNav(unreviewedOnly ? 'unreviewed' : 'month')}
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

type ExpensesView = 'month' | 'unreviewed' | 'do-zaplaty';

const VIEWS: ReadonlyArray<{ value: ExpensesView; href: string; label: string }> = [
  { value: 'month', href: '/expenses', label: 'Miesiąc' },
  { value: 'unreviewed', href: '/expenses?filter=unreviewed', label: 'Do opisania' },
  { value: 'do-zaplaty', href: '/expenses?filter=do-zaplaty', label: 'Do zapłaty' },
];

/**
 * Pasek widoków listy: te same linki co dotąd, trzeci dochodzi na końcu.
 * Zwykła funkcja, nie komponent: `<nav>` stoi w drzewie strony jak wcześniej.
 */
function expensesViewNav(active: ExpensesView) {
  return (
    <nav aria-label="Widok listy wydatków" className="flex">
      {VIEWS.map((view) => (
        <Link
          key={view.value}
          href={view.href}
          prefetch
          scroll={false}
          aria-current={active === view.value ? 'page' : undefined}
          className={buttonVariants({ variant: active === view.value ? 'default' : 'outline' })}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}
