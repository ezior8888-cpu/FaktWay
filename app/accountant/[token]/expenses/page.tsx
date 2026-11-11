import { notFound } from 'next/navigation';

import { AccountantExpenseList } from '@/components/accountant/expense-list';
import {
  PortalHeader,
  PortalLimitedNotice,
  PortalPagination,
  PortalShell,
  PortalTabs,
  portalHref,
} from '@/components/accountant/portal-parts';
import MonthSelector from '@/components/expenses/finora/month-selector';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { loadAccountantExpenses } from '@/lib/accountant/load-accountant-expenses';
import { checkPortalLimit, parsePortalPage, portalTokenParam } from '@/lib/accountant/portal-access';
import { parseExpenseMonth } from '@/lib/expenses/month';

export const dynamic = 'force-dynamic';

/**
 * Zakładka „Koszty” portalu księgowej (krok 6.2 planu kompletnej aplikacji):
 * koszty firmy z tokenu za miesiąc (`?miesiac=RRRR-MM`, domyślnie bieżący),
 * strona po stronie (`?strona=N`), z podglądem albo pobraniem zdjęcia lub
 * XML dokumentu. Te same zabezpieczenia co strona dokumentów: limit prób
 * przed odczytem tokenu, token z wygasaniem i cofnięciem, wpis w audycie.
 */
export default async function AccountantExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ miesiac?: string | string[]; strona?: string | string[] }>;
}) {
  const { token: tokenParam } = await params;
  const { miesiac, strona } = await searchParams;

  const limit = await checkPortalLimit();
  if (!limit.allowed) {
    return (
      <PortalShell>
        <PortalLimitedNotice />
      </PortalShell>
    );
  }

  const rawToken = portalTokenParam(tokenParam);
  const month = parseExpenseMonth(typeof miesiac === 'string' ? miesiac : undefined);
  const data = await loadAccountantExpenses(rawToken, { month, page: parsePortalPage(strona) });

  if (!data) notFound();

  const { access, tenant, expenses } = data;
  const basePath = portalHref(rawToken, 'expenses');

  return (
    <PortalShell>
      <PortalHeader access={access} tenant={tenant} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <PortalTabs token={rawToken} active="expenses" />
        <MonthSelector
          month={data.month}
          currentMonth={parseExpenseMonth(undefined)}
          basePath={basePath}
          ariaLabel="Miesiąc kosztów"
        />
      </div>

      {expenses.status === 'error' ? (
        <Alert variant="destructive">
          <AlertTitle>Nie udało się wczytać kosztów. Odśwież stronę za chwilę.</AlertTitle>
        </Alert>
      ) : (
        <AccountantExpenseList
          rows={expenses.rows}
          page={expenses.page}
          canDownload={access.access_level === 'download'}
          token={rawToken}
          month={data.month}
          footer={
            <PortalPagination
              page={expenses.page}
              label="Strony listy kosztów"
              hrefFor={(page) => `${basePath}?miesiac=${data.month}&strona=${page}`}
            />
          }
        />
      )}
    </PortalShell>
  );
}
