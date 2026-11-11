import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { lastDebitBankAccount, listContractorOptions } from '@/lib/noty/baza';
import type { NoteContractorOption } from '@/lib/noty/model';
import { getPageContext } from '@/lib/supabase/page-context';

import { NoteForm } from '../_components/note-form';

export const dynamic = 'force-dynamic';

/** Nowa nota (krok 2.9, część 1): formularz szkicu dla aktywnej firmy. */
export default async function NewNotePage() {
  const { supabase, tenantId } = await getPageContext();

  let contractors: NoteContractorOption[];
  try {
    contractors = await listContractorOptions(supabase, tenantId);
  } catch (error) {
    console.error('[noty] kontrahenci:', error);
    return (
      <div className='flex flex-col gap-6'>
        <h1 className='text-2xl font-semibold tracking-tight'>Nowa nota</h1>
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać kontrahentów</AlertTitle>
          <AlertDescription>
            Odśwież stronę za chwilę. Nota bierze kontrahenta z bazy kontrahentów firmy, więc bez listy nie zapiszemy szkicu.{' '}
            <Link href='/noty' className='underline'>
              Wróć do listy not
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const bankAccount = await lastDebitBankAccount(supabase, tenantId);

  return (
    <div className='flex flex-col gap-6'>
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>Nowa nota</h1>
        <p className='text-muted-foreground text-sm'>
          Zapisz szkic, sprawdź podgląd i dopiero wtedy wystaw notę. Numer nada się przy wystawieniu.
        </p>
      </div>
      <NoteForm tenantId={tenantId} contractors={contractors} today={todayInWarsaw()} defaultBankAccount={bankAccount} />
    </div>
  );
}
