import Link from 'next/link';
import { RiAddLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { listQuotes } from '@/lib/proformy/baza';
import type { QuoteListItem } from '@/lib/proformy/model';
import { QUOTE_BOOKS_NOTICE, quoteNotInvoiceNotice } from '@/lib/proformy/teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { QuotesList } from './_components/quotes-list';

export const dynamic = 'force-dynamic';

/**
 * Proformy i oferty (plan kompletnej aplikacji, krok 2.4): lista dokumentów
 * firmy z odczytem klientem z sesji (RLS 00198). Osobna pozycja menu
 * w „Sprzedaży”, nie rodzaj faktury: dokumenty poza KSeF i poza przychodem.
 * Błąd odczytu to komunikat, nie pusta lista („nie wiem” to nie „brak”).
 */
export default async function QuotesPage() {
  const { supabase, tenantId } = await getPageContext();

  let rows: QuoteListItem[] = [];
  let readFailed = false;
  try {
    rows = await listQuotes(supabase, tenantId);
  } catch (error) {
    console.error('[proformy] lista:', error);
    readFailed = true;
  }

  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h1 className='text-2xl font-semibold tracking-tight'>Proformy i oferty</h1>
          <p className='text-muted-foreground text-sm'>
            Proformy i oferty z pozycjami jak na fakturze, z PDF, wysyłką mailem i zamianą w fakturę.
          </p>
        </div>
        <Link href='/proformy/nowa' className={buttonVariants()}>
          <RiAddLine />
          Nowy dokument
        </Link>
      </div>

      <Alert>
        <AlertDescription className='flex flex-col gap-1'>
          <span>{quoteNotInvoiceNotice('proforma')}</span>
          <span>{QUOTE_BOOKS_NOTICE}</span>
        </AlertDescription>
      </Alert>

      {readFailed ? (
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać proform i ofert</AlertTitle>
          <AlertDescription>Odśwież stronę za chwilę. Jeśli błąd wróci, napisz do pomocy FaktWay.</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <QuotesList rows={rows} />
      ) : (
        <Card className='flex-1 shadow-none'>
          <QuotesList rows={rows} />
          {rows.length >= 200 ? (
            <p className='text-muted-foreground px-4 text-xs'>Pokazujemy 200 ostatnich dokumentów.</p>
          ) : null}
        </Card>
      )}
    </div>
  );
}
