import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { lastQuoteBankAccount, listContractorOptions } from '@/lib/proformy/baza';
import type { QuoteContractorOption } from '@/lib/proformy/model';
import { getPageContext } from '@/lib/supabase/page-context';

import { QuoteForm } from '../_components/quote-form';

export const dynamic = 'force-dynamic';

/**
 * Nowa proforma albo oferta (krok 2.4): formularz szkicu dla aktywnej firmy.
 * Podpowiedź rachunku: z ostatniej proformy firmy; zwolnienie z VAT daje „zw”
 * w nowych pozycjach, jak w formularzu faktury. Błąd odczytu podpowiedzi to
 * brak podpowiedzi.
 */
export default async function NewQuotePage() {
  const { supabase, tenantId } = await getPageContext();

  let contractors: QuoteContractorOption[];
  try {
    contractors = await listContractorOptions(supabase, tenantId);
  } catch (error) {
    console.error('[proformy] kontrahenci:', error);
    return (
      <div className='flex flex-col gap-6'>
        <h1 className='text-2xl font-semibold tracking-tight'>Nowy dokument</h1>
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać kontrahentów</AlertTitle>
          <AlertDescription>
            Odśwież stronę za chwilę. Proforma i oferta biorą kontrahenta z bazy kontrahentów firmy, więc bez listy nie
            zapiszemy szkicu.{' '}
            <Link href='/proformy' className='underline'>
              Wróć do listy proform i ofert
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const [lastAccount, vatExemptionBasis] = await Promise.all([
    lastQuoteBankAccount(supabase, tenantId),
    readTenantVatExemption(supabase, tenantId).catch(() => null),
  ]);

  return (
    <div className='flex flex-col gap-6'>
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>Nowa proforma albo oferta</h1>
        <p className='text-muted-foreground text-sm'>
          Zapisz szkic, sprawdź podgląd i dopiero wtedy wystaw dokument. Numer nada się przy wystawieniu.
        </p>
      </div>
      <QuoteForm
        tenantId={tenantId}
        contractors={contractors}
        today={todayInWarsaw()}
        defaultBankAccount={lastAccount}
        vatExempt={vatExemptionBasis !== null}
      />
    </div>
  );
}
