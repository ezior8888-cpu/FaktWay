import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { getQuote, listQuoteEmails, listQuoteInvoices, loadIssuerPreview } from '@/lib/proformy/baza';
import type { QuoteEmailRecord, QuoteInvoiceLink, QuoteParty, SalesQuote } from '@/lib/proformy/model';
import { QUOTE_TEXTS } from '@/lib/proformy/teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { QuoteActions } from '../_components/quote-actions';
import { QuoteDocument } from '../_components/quote-document';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVOICE_KIND_LABELS: Record<string, string> = {
  regular: 'faktura',
  advance: 'faktura zaliczkowa',
};

function EmailHistory({ emails }: { emails: QuoteEmailRecord[] | null }) {
  return (
    <Card className='shadow-none'>
      <CardContent className='flex flex-col gap-2 text-sm'>
        <h2 className='font-medium'>Wysyłki mailem</h2>
        {emails === null ? (
          <p className='text-muted-foreground'>Nie udało się wczytać historii wysyłek. Odśwież stronę za chwilę.</p>
        ) : emails.length === 0 ? (
          <p className='text-muted-foreground'>Ten dokument nie był jeszcze wysyłany mailem.</p>
        ) : (
          <ul className='flex flex-col gap-1'>
            {emails.map((email) => (
              <li key={email.id}>
                {formatWarsawDateTime(email.sentAt)}: {email.recipient}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Faktury utworzone z dokumentu (powiązanie z 00198), z linkiem do każdej. */
function InvoicesFromQuote({ invoices }: { invoices: QuoteInvoiceLink[] | null }) {
  return (
    <Card className='shadow-none'>
      <CardContent className='flex flex-col gap-2 text-sm'>
        <h2 className='font-medium'>Faktury z tego dokumentu</h2>
        {invoices === null ? (
          <p className='text-muted-foreground'>Nie udało się wczytać faktur z tego dokumentu. Odśwież stronę za chwilę.</p>
        ) : invoices.length === 0 ? (
          <p className='text-muted-foreground'>
            Z tego dokumentu nie ma jeszcze faktury. Przycisk Wystaw fakturę otworzy formularz faktury z danymi dokumentu.
          </p>
        ) : (
          <ul className='flex flex-col gap-1'>
            {invoices.map((invoice) => (
              <li key={invoice.invoiceId}>
                <Link href={`/invoices/${invoice.invoiceId}`} className='font-medium hover:underline'>
                  {invoice.internalNumber ?? 'Faktura bez numeru'}
                </Link>{' '}
                <span className='text-muted-foreground'>
                  ({INVOICE_KIND_LABELS[invoice.invoiceKind] ?? 'faktura'}
                  {invoice.ksefStatus === 'draft' ? ', szkic' : ''})
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Podgląd proformy albo oferty (krok 2.4): dokument jak w PDF, przyciski,
 * faktury z dokumentu i historia wysyłek. Odczyt klientem z sesji (RLS
 * 00198); dokument innej firmy to „nie znaleziono”.
 */
export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) notFound();
  const { supabase, tenantId } = await getPageContext();

  let quote: SalesQuote | null;
  try {
    quote = await getQuote(supabase, tenantId, id);
  } catch (error) {
    console.error('[proformy] podgląd:', error);
    return (
      <Alert variant='destructive'>
        <AlertTitle>Nie udało się wczytać dokumentu</AlertTitle>
        <AlertDescription>{QUOTE_TEXTS.readFailed}</AlertDescription>
      </Alert>
    );
  }
  if (!quote) notFound();

  const issued = quote.status === 'issued';
  const [issuer, emails, invoices]: [QuoteParty | null, QuoteEmailRecord[] | null, QuoteInvoiceLink[] | null] = await Promise.all([
    issued ? Promise.resolve(quote.issuer) : loadIssuerPreview(supabase, tenantId),
    issued ? listQuoteEmails(supabase, tenantId, quote.id).catch(() => null) : Promise.resolve([]),
    issued ? listQuoteInvoices(supabase, tenantId, quote.id).catch(() => null) : Promise.resolve([]),
  ]);

  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
        <div>
          <Link href='/proformy' className='text-muted-foreground text-sm hover:underline'>
            Wróć do proform i ofert
          </Link>
          <h1 className='text-2xl font-semibold tracking-tight'>{quote.number ?? 'Szkic dokumentu'}</h1>
        </div>
        <QuoteActions
          quoteId={quote.id}
          kind={quote.kind}
          status={quote.status}
          number={quote.number}
          defaultEmail={quote.counterparty.email ?? null}
          issuerReady={issuer !== null}
          invoices={invoices ?? []}
        />
      </div>

      {!issued && issuer === null ? (
        <Alert>
          <AlertDescription>
            {QUOTE_TEXTS.issuerIncomplete}{' '}
            <Link href='/settings' className='underline'>
              Przejdź do Ustawień
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {!issued && quote.contractorId === null ? (
        <Alert>
          <AlertDescription>{QUOTE_TEXTS.contractorRemoved}</AlertDescription>
        </Alert>
      ) : null}

      <QuoteDocument quote={quote} issuer={issuer} />
      {issued ? <InvoicesFromQuote invoices={invoices} /> : null}
      {issued ? <EmailHistory emails={emails} /> : null}
    </div>
  );
}
