import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { getQuote, listContractorOptions } from '@/lib/proformy/baza';
import type { QuoteContractorOption, SalesQuote } from '@/lib/proformy/model';
import { quoteToDraftInput } from '@/lib/proformy/schemat';
import { QUOTE_TEXTS, quoteIssuedLockedMessage } from '@/lib/proformy/teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { QuoteForm } from '../../_components/quote-form';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Edycja szkicu proformy albo oferty (krok 2.4). Wystawionego nie edytuje się: poprawka to nowy dokument. */
export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) notFound();
  const { supabase, tenantId } = await getPageContext();

  let quote: SalesQuote | null;
  let contractors: QuoteContractorOption[];
  try {
    quote = await getQuote(supabase, tenantId, id);
    contractors = quote && quote.status === 'draft' ? await listContractorOptions(supabase, tenantId) : [];
  } catch (error) {
    console.error('[proformy] edycja:', error);
    return (
      <Alert variant='destructive'>
        <AlertTitle>Nie udało się wczytać dokumentu</AlertTitle>
        <AlertDescription>{QUOTE_TEXTS.readFailed}</AlertDescription>
      </Alert>
    );
  }
  if (!quote) notFound();

  if (quote.status === 'issued') {
    return (
      <div className='flex flex-col gap-6'>
        <h1 className='text-2xl font-semibold tracking-tight'>{quote.number}</h1>
        <Alert>
          <AlertDescription>
            {quoteIssuedLockedMessage(quote.kind, quote.number)}{' '}
            <Link href={`/proformy/${quote.id}`} className='underline'>
              Wróć do dokumentu
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-6'>
      <div>
        <Link href={`/proformy/${quote.id}`} className='text-muted-foreground text-sm hover:underline'>
          Wróć do podglądu
        </Link>
        <h1 className='text-2xl font-semibold tracking-tight'>Edycja szkicu</h1>
      </div>
      <QuoteForm
        tenantId={tenantId}
        contractors={contractors}
        today={todayInWarsaw()}
        quoteId={quote.id}
        initial={quoteToDraftInput(quote)}
      />
    </div>
  );
}
