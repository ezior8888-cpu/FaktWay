import { Suspense } from 'react';

import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { RECURRING_GENERIC_ERROR, recurringErrorMessage } from '@/lib/invoices/recurring/error-message';
import {
  getRecurringTemplateCandidate,
  listRecurringInvoices,
  listRecurringTemplateCandidates,
  type RecurringInvoiceListItem,
  type RecurringTemplateCandidate,
} from '@/lib/invoices/recurring/queries';
import { getPageContext, type PageContext } from '@/lib/supabase/page-context';

import { RecurringInvoicesView } from './_components/recurring-invoices-view';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CANDIDATES_ERROR = 'Nie udało się wczytać faktur do wyboru wzoru. Spróbuj ponownie za chwilę.';
const TEMPLATE_NOT_FOUND =
  'Nie znaleźliśmy tej faktury wśród możliwych wzorów — mogła zostać usunięta albo nie spełnia warunków. Wzorem może być zwykła faktura VAT w złotych, wystawiona w FaktWay i przyjęta przez KSeF. Wybierz inną z listy.';

function param(params: Record<string, string | string[] | undefined>, key: string): string | null {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ? first.trim() : null;
}

function TableSkeleton() {
  return (
    <div className='space-y-4 p-4 pt-2' aria-busy='true'>
      <Skeleton className='h-9 w-full max-w-md' />
      <Skeleton className='h-56 w-full' />
    </div>
  );
}

/** Błąd w karcie sekcji — rząd zakładek nad nim (layout) prowadzi do pozostałych zakładek Faktur. */
function SectionError({ message }: { message: string }) {
  return (
    <div className='px-4 pt-2'>
      <Alert variant='destructive'>
        <AlertTitle>Nie udało się pobrać faktur cyklicznych</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}

/**
 * Lista + dane do arkusza „Nowa faktura cykliczna”. Błąd listy zastępuje tabelę
 * komunikatem (bez pustego stanu — „brak pozycji” to nie „nie wiem”); błąd
 * kandydatów na wzór zostaje w arkuszu, tabela działa dalej.
 */
async function RecurringSection({
  ctx,
  wzorId,
}: {
  ctx: PageContext;
  wzorId: string | null;
}) {
  const today = todayInWarsaw();

  let items: RecurringInvoiceListItem[];
  try {
    items = await listRecurringInvoices(ctx.supabase, ctx.tenantId, today);
  } catch (error) {
    const message = recurringErrorMessage(error);
    if (message === RECURRING_GENERIC_ERROR) console.error('[invoices/recurring] lista:', error);
    return <SectionError message={message} />;
  }

  let candidates: RecurringTemplateCandidate[] = [];
  let candidatesError: string | null = null;
  try {
    candidates = await listRecurringTemplateCandidates(ctx.supabase, ctx.tenantId, { limit: 50 });
  } catch (error) {
    console.error('[invoices/recurring] kandydaci na wzór:', error);
    candidatesError = CANDIDATES_ERROR;
  }

  // `?wzor=<id>` (z „Ustaw jako cykliczną” / „Zrób fakturę cykliczną”): wybrany wzór,
  // także starszy niż 50 najnowszych. Nie spełnia warunków → arkusz bez wyboru + komunikat.
  let initialTemplate: RecurringTemplateCandidate | null = null;
  let templateNotice: string | null = null;
  if (wzorId) {
    initialTemplate = UUID.test(wzorId)
      ? (candidates.find((c) => c.id === wzorId) ??
        (await getRecurringTemplateCandidate(ctx.supabase, ctx.tenantId, wzorId)))
      : null;
    if (!initialTemplate) templateNotice = TEMPLATE_NOT_FOUND;
  }

  return (
    <RecurringInvoicesView
      items={items}
      today={today}
      candidates={candidates}
      candidatesError={candidatesError}
      initialTemplate={initialTemplate}
      openSheetOnLoad={wzorId !== null}
      templateNotice={templateNotice}
    />
  );
}

/**
 * Faktury cykliczne (plan Finora P6, N1): tabela przypomnień o fakturach, które
 * wystawiasz co miesiąc, kwartał albo rok. Pozycja niczego nie wystawia sama —
 * „Wystaw teraz” otwiera formularz wypełniony z faktury-wzoru, a fakturę
 * zawsze sprawdza i wysyła człowiek. Jak `invoices-recurring` w Finorze strona
 * nie ma widocznego nagłówka; tytuł dla czytników ekranu.
 *
 * Poprawka 21.10.2026: zakładka „Cykliczne” ekranu Faktur — te same kafle co
 * „Wystawione”, karta do stopki. Od 25.10.2026 kafle i karta z zakładkami
 * stoją w `(faktury)/layout.tsx`, więc przełączenie zakładki naprawdę zmienia
 * tylko zawartość karty — ta strona.
 */
export default async function RecurringInvoicesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getPageContext();
  const wzorId = param((await searchParams) ?? {}, 'wzor');

  return (
    <div className='ff-tab-panel flex w-full flex-1 flex-col'>
      <h1 className='sr-only'>Faktury cykliczne</h1>
      <SectionErrorBoundary
        fallback={<SectionError message={RECURRING_GENERIC_ERROR} />}
      >
        <Suspense fallback={<TableSkeleton />}>
          <RecurringSection ctx={ctx} wzorId={wzorId} />
        </Suspense>
      </SectionErrorBoundary>
    </div>
  );
}
