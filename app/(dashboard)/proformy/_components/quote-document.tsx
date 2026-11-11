import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { formatIbanForPrint } from '@/lib/noty/model';
import {
  QUOTE_KIND_LABELS,
  QUOTE_PAYMENT_METHOD_LABELS,
  quoteVatRateLabel,
  quoteVatSummary,
  type QuoteParty,
  type SalesQuote,
} from '@/lib/proformy/model';
import { QUOTE_BOOKS_NOTICE, quoteNotInvoiceNotice } from '@/lib/proformy/teksty';

/**
 * Podgląd proformy albo oferty na ekranie (krok 2.4): te same elementy co PDF
 * (`lib/proformy/pdf.ts`). Szkic nie ma numeru: nadaje go baza przy
 * wystawieniu. Dla szkicu `issuer` to bieżące dane firmy z profilu; po
 * wystawieniu dokument pokazuje dane z chwili wystawienia. Pozycje: od `md`
 * tabela, poniżej karty (bez przewijania w bok na telefonie).
 */

function Party({ heading, party }: { heading: string; party: QuoteParty | null }) {
  return (
    <div className='flex flex-col gap-0.5 text-sm'>
      <span className='text-muted-foreground text-xs font-medium'>{heading}</span>
      {party ? (
        <>
          <span className='font-semibold'>{party.name}</span>
          <span>NIP: {party.nip}</span>
          {party.addressLine1 ? <span>{party.addressLine1}</span> : null}
          {party.addressLine2 ? <span>{party.addressLine2}</span> : null}
        </>
      ) : (
        <span className='text-muted-foreground'>Uzupełnij dane firmy w Ustawieniach: nazwę, NIP i adres.</span>
      )}
    </div>
  );
}

function Amount({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className='flex items-baseline justify-between gap-3'>
      <dt className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</dt>
      <dd className={strong ? 'text-base font-semibold tabular-nums' : 'font-medium tabular-nums'}>{formatPlMoney(value)} zł</dd>
    </div>
  );
}

export function QuoteDocument({ quote, issuer }: { quote: SalesQuote; issuer: QuoteParty | null }) {
  const issued = quote.status === 'issued';
  const summary = quoteVatSummary(quote.items);
  return (
    <Card className='shadow-none'>
      <CardContent className='flex flex-col gap-6'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-xl font-semibold'>{QUOTE_KIND_LABELS[quote.kind]}</h2>
          {issued && quote.number ? (
            <p className='text-sm'>Nr {quote.number}</p>
          ) : (
            <p className='text-muted-foreground text-sm'>Szkic: numer nada się przy wystawieniu dokumentu.</p>
          )}
          <p className='text-muted-foreground text-sm'>Data wystawienia: {formatIsoDatePl(quote.issueDate)}</p>
          {quote.kind === 'offer' && quote.validUntil ? (
            <p className='text-sm'>Oferta ważna do: {formatIsoDatePl(quote.validUntil)}</p>
          ) : null}
        </div>

        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Party heading='Sprzedawca' party={issued ? quote.issuer : issuer} />
          <Party heading='Nabywca' party={quote.counterparty} />
        </div>

        <div className='hidden md:block'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-10'>Lp</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead className='text-right'>Ilość</TableHead>
                <TableHead>J.m.</TableHead>
                <TableHead className='text-right'>Cena netto</TableHead>
                <TableHead className='text-right'>Wartość netto</TableHead>
                <TableHead className='text-right'>VAT</TableHead>
                <TableHead className='text-right'>Wartość brutto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quote.items.map((item, index) => (
                <TableRow key={index}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell className='whitespace-normal'>{item.name}</TableCell>
                  <TableCell className='text-right tabular-nums'>{item.quantity.toLocaleString('pl-PL', { maximumFractionDigits: 4 })}</TableCell>
                  <TableCell>{item.unit}</TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {item.unitPriceNet.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>{formatPlMoney(item.netAmount)}</TableCell>
                  <TableCell className='text-right'>{quoteVatRateLabel(item.vatRate)}</TableCell>
                  <TableCell className='text-right tabular-nums'>{formatPlMoney(item.grossAmount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className='flex flex-col divide-y md:hidden'>
          {quote.items.map((item, index) => (
            <li key={index} className='flex flex-col gap-1 py-2 text-sm'>
              <span className='font-medium'>
                {index + 1}. {item.name}
              </span>
              <span className='text-muted-foreground'>
                {item.quantity.toLocaleString('pl-PL', { maximumFractionDigits: 4 })} {item.unit} ×{' '}
                {item.unitPriceNet.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} zł netto,
                VAT {quoteVatRateLabel(item.vatRate)}
              </span>
              <span className='flex justify-between gap-2'>
                <span>netto {formatPlMoney(item.netAmount)} zł</span>
                <span className='tabular-nums font-medium'>brutto {formatPlMoney(item.grossAmount)} zł</span>
              </span>
            </li>
          ))}
        </ul>

        <div className='flex justify-end'>
          <section aria-label='Podsumowanie dokumentu' className='w-full space-y-1.5 text-sm sm:max-w-80'>
            <dl className='space-y-1.5'>
              <Amount label='Razem netto' value={quote.netTotal} />
              {summary.map((row) => (
                <Amount key={row.rate} label={`VAT ${quoteVatRateLabel(row.rate)}`} value={row.vat} />
              ))}
              <Amount label='Razem VAT' value={quote.vatTotal} />
            </dl>
            <Separator className='my-2' />
            <dl>
              <Amount label={quote.kind === 'proforma' ? 'Do zapłaty' : 'Razem brutto'} value={quote.grossTotal} strong />
            </dl>
          </section>
        </div>

        {quote.kind === 'proforma' ? (
          <div className='flex flex-col gap-1 text-sm'>
            {quote.paymentMethod ? <p>Sposób zapłaty: {QUOTE_PAYMENT_METHOD_LABELS[quote.paymentMethod]}</p> : null}
            {quote.paymentDueDate ? <p>Termin zapłaty: {formatIsoDatePl(quote.paymentDueDate)}</p> : null}
            {quote.bankAccount ? <p>Numer rachunku: {formatIbanForPrint(quote.bankAccount)}</p> : null}
          </div>
        ) : null}

        {quote.notes ? <p className='text-sm whitespace-pre-line'>Uwagi: {quote.notes}</p> : null}

        <Alert>
          <AlertDescription className='flex flex-col gap-1'>
            <span className='font-medium'>{quoteNotInvoiceNotice(quote.kind)}</span>
            <span>{QUOTE_BOOKS_NOTICE}</span>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
