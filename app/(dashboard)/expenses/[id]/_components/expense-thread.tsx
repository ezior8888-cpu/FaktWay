import { Suspense } from 'react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EXPENSE_THREAD_ANCHOR, canUseExpenseThread } from '@/lib/expenses/expense-thread';
import { loadExpenseThread } from '@/lib/expenses/expense-thread-load';
import { getPageContext } from '@/lib/supabase/page-context';

import { ExpenseThreadPanel } from './expense-thread-panel';

/**
 * Wątek przy koszcie (plan kompletnej aplikacji, krok 6.2, część 3, 00192):
 * komentarze i prośby o dokument pod formularzem kosztu. Strona kosztu zmienia
 * się o jedną linię; wątek czyta się w osobnej granicy Suspense, więc formularz
 * nie czeka na jego zapytania.
 *
 * Odstępy: formularz kończy się `pb-32` pod przyklejony pasek akcji
 * (`.ff-sticky-actions`). Sekcja wchodzi w ten odstęp (`-mt-32 pt-6`, czyli
 * 24 px pod ostatnią kartą, jak `space-y-6` formularza) i sama zostawia
 * `pb-32`, żeby pasek nie zasłaniał formularza wpisu. Kotwica `#komentarze`
 * to cel linku z dzwonka.
 */
export function ExpenseThread({ expenseId }: { expenseId: string }) {
  return (
    <section id={EXPENSE_THREAD_ANCHOR} aria-label="Komentarze i prośby o dokument" className="-mt-32 pt-6 pb-32">
      <Suspense fallback={<ExpenseThreadSkeleton />}>
        <ExpenseThreadContent expenseId={expenseId} />
      </Suspense>
    </section>
  );
}

/** Dane wątku z sesji: aktywna firma, użytkownik i rola (członkostwo sprawdza `getPageContext`). */
export async function ExpenseThreadContent({ expenseId }: { expenseId: string }) {
  const { supabase, tenantId, user, role } = await getPageContext();
  const thread = await loadExpenseThread(supabase, { tenantId, expenseId, userId: user.id });
  return <ExpenseThreadPanel expenseId={expenseId} thread={thread} canWrite={canUseExpenseThread(role)} />;
}

function ExpenseThreadSkeleton() {
  return (
    <Card aria-busy="true">
      <CardHeader>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-20 w-full" />
      </CardContent>
    </Card>
  );
}
