import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  getCashRegister,
  getCashReportData,
  getCompanyParty,
  listReceiptPayments,
  listReceivableInvoices,
  type CashInvoiceOption,
  type CashPaymentOption,
} from '@/lib/kasa/baza';
import { buildCashReport, canWriteCash, cashKindTitle, type CashKind } from '@/lib/kasa/model';
import { CASH_LOAD_FAILED, CASH_ROLE_REFUSAL, issueRefusalText } from '@/lib/kasa/teksty';
import { getPageContext } from '@/lib/supabase/page-context';
import { cn } from '@/lib/utils';

import { CashDocumentForm } from '../_components/cash-document-form';

export const dynamic = 'force-dynamic';

const TOUCH_TARGET = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';

function Kinds({ kind }: { kind: CashKind }) {
  return (
    <nav aria-label='Rodzaj dowodu' className='flex gap-2'>
      {(['KP', 'KW'] as const).map((k) => (
        <Link
          key={k}
          href={`/kasa/nowy?rodzaj=${k}`}
          aria-current={k === kind ? 'page' : undefined}
          className={cn(buttonVariants({ variant: k === kind ? 'default' : 'outline' }), TOUCH_TARGET)}
        >
          {k === 'KP' ? 'Wpłata (KP)' : 'Wypłata (KW)'}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Nowy dowód KP albo KW (krok 3.7). Formularz tylko dla roli, która wystawia
 * dowody, i tylko przy otwartej kasie; inaczej komunikat z wyjściem. Faktury
 * i wpłaty do KP czyta klient z sesji (RLS); błąd ich odczytu nie blokuje
 * KP bez faktury, tylko mówi, że lista jest niedostępna.
 */
export default async function NowyDowodKasowyPage({ searchParams }: { searchParams: Promise<{ rodzaj?: string; faktura?: string }> }) {
  const { supabase, tenantId, role } = await getPageContext();
  const query = await searchParams;
  const kind: CashKind = query.rodzaj === 'KW' ? 'KW' : 'KP';
  const today = todayInWarsaw();

  const back = (
    <Link href='/kasa' className='text-muted-foreground text-sm hover:underline'>
      Wróć do Kasy
    </Link>
  );

  if (!canWriteCash(role)) {
    return (
      <div className='ff-page-fill flex flex-col gap-6'>
        <h1 className='text-2xl font-semibold tracking-tight'>Nowy dowód kasowy</h1>
        <Alert>
          <AlertDescription>{CASH_ROLE_REFUSAL}</AlertDescription>
        </Alert>
        {back}
      </div>
    );
  }

  let register: Awaited<ReturnType<typeof getCashRegister>> = null;
  let balanceToday: number | null = null;
  let issuerReady = true;
  try {
    register = await getCashRegister(supabase, tenantId);
    if (register) {
      const now = await getCashReportData(supabase, today, today);
      balanceToday = buildCashReport({ from: today, to: today, openingDate: register.openingDate, balanceBefore: now.balanceBefore, documents: now.documents }).balanceEnd;
      const company = await getCompanyParty(supabase, tenantId);
      issuerReady = Boolean(company?.addressLine1 && company.addressLine2);
    }
  } catch (error) {
    console.error('[kasa] nowy dowód:', error);
    return (
      <div className='ff-page-fill flex flex-col gap-6'>
        <h1 className='text-2xl font-semibold tracking-tight'>Nowy dowód kasowy</h1>
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać kasy</AlertTitle>
          <AlertDescription>{CASH_LOAD_FAILED}</AlertDescription>
        </Alert>
        {back}
      </div>
    );
  }

  if (!register) {
    return (
      <div className='ff-page-fill flex flex-col gap-6'>
        <h1 className='text-2xl font-semibold tracking-tight'>Nowy dowód kasowy</h1>
        <Alert>
          <AlertDescription>{issueRefusalText('register_missing')}</AlertDescription>
        </Alert>
        <Link href='/kasa' className={cn(buttonVariants(), TOUCH_TARGET, 'self-start')}>
          Otwórz kasę
        </Link>
      </div>
    );
  }

  let invoices: CashInvoiceOption[] = [];
  let payments: CashPaymentOption[] = [];
  let listsFailed = false;
  if (kind === 'KP') {
    try {
      [invoices, payments] = await Promise.all([listReceivableInvoices(supabase, tenantId), listReceiptPayments(supabase)]);
    } catch (error) {
      console.error('[kasa] faktury i wpłaty do KP:', error);
      listsFailed = true;
    }
  }

  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <div className='flex flex-col gap-3'>
        {back}
        <h1 className='text-2xl font-semibold tracking-tight'>{cashKindTitle(kind)}</h1>
        <Kinds kind={kind} />
      </div>
      {!issuerReady ? (
        <Alert>
          <AlertDescription>
            {issueRefusalText('issuer_incomplete')}{' '}
            <Link href='/settings' className='underline'>
              Przejdź do Ustawień
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {listsFailed ? (
        <Alert>
          <AlertDescription>
            Nie udało się wczytać faktur i wpłat do wyboru. KP bez faktury wystawisz dalej; żeby wybrać fakturę, odśwież stronę.
          </AlertDescription>
        </Alert>
      ) : null}
      <CashDocumentForm
        tenantId={tenantId}
        kind={kind}
        today={today}
        openingDate={register.openingDate}
        balanceToday={balanceToday}
        invoices={invoices}
        payments={payments}
        initialInvoiceId={query.faktura ?? null}
      />
    </div>
  );
}
