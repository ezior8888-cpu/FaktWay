import type { ReactNode } from 'react';
import Link from 'next/link';
import { RiDownload2Line } from '@remixicon/react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CASH_PARTY_LABELS, cashKindTitle, dayPl, formatCashMoney, type CashDocument, type CashParty } from '@/lib/kasa/model';
import { CASH_BOOKS_NOTICE, CASH_CORRECTION_INFO } from '@/lib/kasa/teksty';
import { cn } from '@/lib/utils';

import { CashCorrectionButton } from './cash-correction-button';

const TOUCH_TARGET = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';

function Party({ heading, party }: { heading: string; party: CashParty }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-muted-foreground text-xs font-medium'>{heading}</span>
      <span className='font-medium'>{party.name}</span>
      {party.nip ? <span className='text-muted-foreground text-sm'>NIP: {party.nip}</span> : null}
      {party.addressLine1 ? <span className='text-muted-foreground text-sm'>{party.addressLine1}</span> : null}
      {party.addressLine2 ? <span className='text-muted-foreground text-sm'>{party.addressLine2}</span> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5 sm:flex-row sm:gap-4'>
      <dt className='text-muted-foreground w-44 shrink-0 text-sm'>{label}</dt>
      <dd className='text-sm'>{children}</dd>
    </div>
  );
}

/**
 * Podgląd wystawionego dowodu kasowego (krok 3.7): wszystkie elementy z PDF,
 * pobranie PDF i korekta (tylko dla dowodu bez korekty, który sam nie jest
 * korektą, i tylko dla roli, która wystawia dowody).
 */
export function CashDocumentView({
  cash,
  correction,
  canWrite,
}: {
  cash: CashDocument;
  /** Korekta, która znosi ten dowód, jeśli jest. */
  correction: { id: string; number: string } | null;
  canWrite: boolean;
}) {
  const isCorrection = cash.correctsId !== null;
  const canCorrect = canWrite && !isCorrection && correction === null;

  return (
    <div className='flex flex-col gap-4'>
      <Card className='shadow-none'>
        <CardHeader>
          <CardTitle className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
            <span>{cashKindTitle(cash.kind)}{isCorrection ? ', korekta' : ''}</span>
            <span className='text-muted-foreground text-base font-normal'>Nr {cash.number}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-6'>
          {isCorrection && cash.correctsId ? (
            <Alert>
              <AlertDescription>
                <span>
                  Korekta dowodu{' '}
                  <Link href={`/kasa/${cash.correctsId}`} className='underline'>
                    {cash.correctsNumber}
                  </Link>
                  . Znosi tamten dowód w całości.
                </span>
                {cash.correctionReason ? <span className='block'>Przyczyna korekty: {cash.correctionReason}</span> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {correction ? (
            <Alert>
              <AlertDescription>
                <span>
                  Ten dowód skorygowano dowodem{' '}
                  <Link href={`/kasa/${correction.id}`} className='underline'>
                    {correction.number}
                  </Link>
                  . W raporcie kasowym oba dowody znoszą się.
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
            <Party heading='Wystawca' party={cash.issuer} />
            <Party heading={CASH_PARTY_LABELS[cash.kind]} party={cash.counterparty} />
          </div>

          <dl className='flex flex-col gap-2'>
            <Row label='Data wystawienia'>{dayPl(cash.issueDate)}</Row>
            <Row label='Data operacji'>{dayPl(cash.operationDate)}</Row>
            <Row label='Tytułem'>{cash.title}</Row>
            {cash.invoiceNumber ? (
              <Row label='Dotyczy faktury'>
                {cash.invoiceId ? (
                  <Link href={`/invoices/${cash.invoiceId}`} className='underline'>
                    {cash.invoiceNumber}
                  </Link>
                ) : (
                  cash.invoiceNumber
                )}
              </Row>
            ) : null}
            {cash.relatedDocument ? <Row label='Dotyczy'>{cash.relatedDocument}</Row> : null}
            <Row label='Kwota'>
              <span className='text-base font-semibold tabular-nums'>{formatCashMoney(cash.amount)}</span>
            </Row>
            <Row label='Wystawił'>{cash.issuedByName}</Row>
          </dl>

          <div className='flex flex-col gap-2 sm:flex-row'>
            <a href={`/api/kasa/${cash.id}/pdf`} className={cn(buttonVariants({ variant: 'default' }), TOUCH_TARGET)} download>
              <RiDownload2Line aria-hidden />
              Pobierz PDF
            </a>
            {canCorrect ? <CashCorrectionButton documentId={cash.id} number={cash.number} /> : null}
          </div>
          {canCorrect ? <p className='text-muted-foreground text-xs'>{CASH_CORRECTION_INFO}</p> : null}
        </CardContent>
      </Card>
      <p className='text-muted-foreground text-xs'>{CASH_BOOKS_NOTICE}</p>
    </div>
  );
}
