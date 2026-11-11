import type { ReactNode } from 'react';
import { RiDownloadLine, RiFileCodeLine } from '@remixicon/react';

import { InvoiceQr } from '@/components/invoices/invoice-qr';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatTimestampDatePl } from '@/lib/format/iso-date';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import type { BuyerInvoiceView, BuyerParty } from '@/lib/invoice-share/buyer-invoice';
import { formatInvoiceDate } from '@/lib/invoices/display-date';
import { vatSummaryAgreesWithGross, vatSummaryByRate } from '@/lib/invoices/vat-summary';
import { cn } from '@/lib/utils';

/**
 * Strona faktury dla nabywcy (krok 2.10) z komponentów Finory: Card, Table,
 * Separator i przyciski jak w karcie faktury panelu. Układ od telefonu: na
 * górze to, po co nabywca przychodzi (kwota, termin, PDF, XML, numer KSeF),
 * niżej dane do przelewu i podgląd dokumentu w układzie podglądu panelu
 * (`components/invoices/invoice-detail-view.tsx`), z tymi samymi regułami
 * podsumowania VAT.
 *
 * Odnośniki do plików to zwykłe `<a>`: `next/link` pobrałby trasę z góry,
 * czyli wygenerował PDF i zużył limit prób bez kliknięcia.
 */

const DOCUMENT_TITLE: Record<string, string> = {
  VAT: 'Faktura VAT',
  ZAL: 'Faktura zaliczkowa',
  UPR: 'Faktura uproszczona',
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  transfer: 'Przelew',
  cash: 'Gotówka',
  card: 'Karta',
  mobile: 'Płatność mobilna',
  other: 'Inna',
};

function documentTitle(invoiceType: string | null, invoiceKind: string): string {
  return DOCUMENT_TITLE[invoiceType ?? ''] ?? (invoiceKind === 'advance' ? DOCUMENT_TITLE.ZAL! : 'Faktura');
}

/** Liczba po polsku z co najmniej 2 i najwyżej `maxDigits` miejscami (ilość i cena mają 4, jak na PDF). */
function formatNumber(value: number | null, maxDigits = 2): string {
  if (value === null || !Number.isFinite(value)) return '';
  return value.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: maxDigits });
}

function vatRateLabel(rate: string | null): string {
  if (!rate) return '';
  if (rate === 'np_ii') return 'np. II';
  return /^\d+(?:[.,]\d+)?$/.test(rate) ? `${rate}%` : rate;
}

function PartyLines({ party }: { party: BuyerParty }) {
  return (
    <div className="text-muted-foreground space-y-1 text-sm">
      {party.name && <p className="text-foreground font-medium">{party.name}</p>}
      {party.addressLine1 && <p>{party.addressLine1}</p>}
      {party.addressLine2 && <p>{party.addressLine2}</p>}
      {party.nip ? <p>NIP: {party.nip}</p> : party.vatUeNumber ? <p>VAT UE: {party.vatUeNumber}</p> : null}
    </div>
  );
}

function Detail({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-medium sm:mb-0 mb-2', mono && 'font-mono break-all')}>{children}</dd>
    </>
  );
}

export function BuyerInvoiceDocument({
  view,
  pdfHref,
  xmlHref,
  payAction,
}: {
  view: BuyerInvoiceView;
  pdfHref: string;
  xmlHref: string;
  /** Krok 3.3 (link do płatności): przycisk „Zapłać” trafi tutaj, pod dane do przelewu. */
  payAction?: ReactNode;
}) {
  const money = (value: number | null) => `${formatNumber(value)} ${view.currency}`;
  const title = documentTitle(view.invoiceType, view.invoiceKind);
  const heading = view.number ? `${title} nr ${view.number}` : title;
  const sellerName = view.seller.name?.trim() || null;
  const dueDate = view.payment.dueDate ? formatInvoiceDate(view.payment.dueDate) : null;
  const vatRows = vatSummaryByRate(view.lines);
  // Wiersze stawek tylko, gdy zgadzają się z nagłówkiem (jak w podglądzie panelu): lepiej samo „Razem”.
  const showVatRows = vatRows !== null && vatRows.length > 0 && vatSummaryAgreesWithGross(vatRows, view.grossTotal);
  const method = view.payment.method ? PAYMENT_METHOD_LABEL[view.payment.method] ?? view.payment.method : null;

  return (
    <main className="bg-background text-foreground min-h-screen p-4 lg:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="shadow-none" data-testid="faktura-nabywcy-podsumowanie">
          <CardContent className="space-y-6">
            <div className="space-y-1">
              {sellerName && <p className="text-muted-foreground text-sm">Od: {sellerName}</p>}
              <h1 className="text-xl font-semibold sm:text-2xl">{heading}</h1>
            </div>

            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
              <div className="space-y-1">
                <dt className="text-muted-foreground">Do zapłaty</dt>
                <dd className="text-xl font-semibold tabular-nums">{money(view.amountDue)}</dd>
              </div>
              {dueDate && (
                <div className="space-y-1">
                  <dt className="text-muted-foreground">Termin płatności</dt>
                  <dd className="text-base font-medium">{dueDate}</dd>
                </div>
              )}
              <div className="space-y-1">
                <dt className="text-muted-foreground">Data wystawienia</dt>
                <dd className="text-base font-medium">{formatInvoiceDate(view.issueDate)}</dd>
              </div>
            </dl>

            <div className="flex flex-col gap-2 sm:flex-row">
              <a href={pdfHref} rel="nofollow noreferrer" className={cn(buttonVariants(), 'w-full sm:w-auto')}>
                <RiDownloadLine aria-hidden />
                Pobierz PDF
              </a>
              <a href={xmlHref} rel="nofollow noreferrer" className={cn(buttonVariants({ variant: 'outline' }), 'w-full sm:w-auto')}>
                <RiFileCodeLine aria-hidden />
                Pobierz plik XML z KSeF
              </a>
            </div>

            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">Numer KSeF</p>
              <p className="font-mono break-all">{view.ksefNumber}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none" data-testid="faktura-nabywcy-platnosc">
          <CardHeader>
            <CardTitle>{view.payment.bankAccount ? 'Dane do przelewu' : 'Płatność'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-y-2">
              {sellerName && <Detail label="Odbiorca">{sellerName}</Detail>}
              {view.payment.bankAccount && <Detail label="Numer rachunku" mono>{view.payment.bankAccount}</Detail>}
              {view.payment.bankName && <Detail label="Bank">{view.payment.bankName}</Detail>}
              {view.currency !== 'PLN' && view.payment.swift && <Detail label="SWIFT" mono>{view.payment.swift}</Detail>}
              <Detail label="Kwota">
                <span className="tabular-nums">{money(view.amountDue)}</span>
              </Detail>
              {dueDate && <Detail label="Termin">{dueDate}</Detail>}
              {method && <Detail label="Forma płatności">{method}</Detail>}
              {view.number && <Detail label="Numer faktury">{view.number}</Detail>}
              <Detail label="Numer KSeF" mono>{view.ksefNumber}</Detail>
              {view.splitPayment && <Detail label="MPP">Faktura w mechanizmie podzielonej płatności</Detail>}
            </dl>
            {payAction}
          </CardContent>
        </Card>

        <Card className="gap-6 py-0 shadow-none" data-testid="faktura-nabywcy-dokument">
          <div className="bg-muted/50 flex flex-wrap items-start justify-between gap-6 p-6">
            <div className="min-w-0 space-y-2">
              <h2 className="text-sm font-medium">Sprzedawca</h2>
              <PartyLines party={view.seller} />
            </div>
            <div className="space-y-1 text-sm sm:text-right">
              <h2 className="text-base font-semibold">{heading}</h2>
              <p className="text-muted-foreground">Data wystawienia: {formatInvoiceDate(view.issueDate)}</p>
              {view.saleDate && <p className="text-muted-foreground">Data sprzedaży: {formatInvoiceDate(view.saleDate)}</p>}
              {dueDate && <p className="text-muted-foreground">Termin płatności: {dueDate}</p>}
            </div>
          </div>

          <CardContent className="space-y-6 px-6 pb-6">
            <div className="min-w-0 space-y-2">
              <h2 className="text-sm font-medium">Nabywca</h2>
              <PartyLines party={view.buyer} />
            </div>

            {/* Telefon: tabela pozycji przewija się w poziomie w kontenerze `Table`, jak w podglądzie panelu. */}
            <Table className="min-w-[40rem] border">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Lp.</TableHead>
                  <TableHead>Nazwa</TableHead>
                  <TableHead className="text-right">Ilość</TableHead>
                  <TableHead>J.m.</TableHead>
                  <TableHead className="text-right">Cena netto</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                  <TableHead className="text-right">Netto</TableHead>
                  <TableHead className="pr-4 text-right">Brutto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-muted-foreground py-4 text-center text-xs">
                      Pozycje faktury są w pliku PDF.
                    </TableCell>
                  </TableRow>
                )}
                {view.lines.map((line) => (
                  <TableRow key={line.ordinal}>
                    <TableCell className="pl-4">{line.ordinal}</TableCell>
                    <TableCell className="font-medium whitespace-normal">{line.name ?? ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(line.quantity, 4)}</TableCell>
                    <TableCell className="text-muted-foreground">{line.unit ?? ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(line.unit_price_net, 4)}</TableCell>
                    <TableCell className="text-right">{vatRateLabel(line.vat_rate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(line.net_amount)}</TableCell>
                    <TableCell className="pr-4 text-right font-medium tabular-nums">{formatNumber(line.gross_amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="min-w-0 flex-1 basis-72">
                {showVatRows && vatRows && (
                  <Table className="border">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Stawka</TableHead>
                        <TableHead className="text-right">Netto</TableHead>
                        <TableHead className="text-right">VAT</TableHead>
                        <TableHead className="pr-4 text-right">Brutto</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {vatRows.map((row) => (
                        <TableRow key={row.rate}>
                          <TableCell className="pl-4">{vatRateLabel(row.rate)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNumber(row.net)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNumber(row.vat)}</TableCell>
                          <TableCell className="pr-4 text-right tabular-nums">{formatNumber(row.gross)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
              <div className="w-full max-w-64 space-y-1.5 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Razem netto:</span>
                  <span className="font-medium tabular-nums">{money(view.netTotal)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">VAT:</span>
                  <span className="font-medium tabular-nums">{money(view.vatTotal)}</span>
                </div>
                <Separator className="my-2" />
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium">Razem brutto:</span>
                  <span className="font-medium tabular-nums">{money(view.grossTotal)}</span>
                </div>
              </div>
            </div>

            {view.notes && (
              <>
                <Separator />
                <p className="text-sm">
                  <span className="font-medium">Uwagi:</span>{' '}
                  <span className="text-muted-foreground whitespace-pre-wrap">{view.notes}</span>
                </p>
              </>
            )}

            <Separator />
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="min-w-0 space-y-1 text-sm">
                <p className="text-muted-foreground">Numer KSeF</p>
                <p className="font-mono break-all">{view.ksefNumber}</p>
                {view.ksefAcceptedAt && (
                  <p className="text-muted-foreground text-xs">Przyjęta w KSeF: {formatWarsawDateTime(view.ksefAcceptedAt)}</p>
                )}
              </div>
              <InvoiceQr qr={view.qr} />
            </div>
          </CardContent>
        </Card>

        <div className="text-muted-foreground space-y-1 pb-2 text-center text-xs">
          <p>
            Link działa do {formatTimestampDatePl(view.expiresAt)}. Fakturą jest dokument w KSeF, czyli plik XML;
            PDF to jego wizualizacja z kodem QR, którym sprawdzisz fakturę w KSeF.
          </p>
          <p>Fakturę udostępnia sprzedawca przez FaktWay.</p>
        </div>
      </div>
    </main>
  );
}
