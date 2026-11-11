import Link from 'next/link';
import { RiAddLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { listNotes } from '@/lib/noty/baza';
import type { NoteListItem } from '@/lib/noty/model';
import { NOTE_BOOKS_NOTICE, NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { NotesList } from './_components/notes-list';

export const dynamic = 'force-dynamic';

/**
 * Noty obciążeniowe i uznaniowe (plan kompletnej aplikacji, krok 2.9,
 * część 1): lista not firmy z odczytem klientem z sesji (RLS 00193). Osobna
 * pozycja menu w „Sprzedaży”, nie zakładka „Rodzaje faktur”: nota nie jest
 * fakturą. Błąd odczytu to komunikat, nie pusta lista („nie wiem” to nie
 * „brak not”).
 */
export default async function NotesPage() {
  const { supabase, tenantId } = await getPageContext();

  let rows: NoteListItem[] = [];
  let readFailed = false;
  try {
    rows = await listNotes(supabase, tenantId);
  } catch (error) {
    console.error('[noty] lista:', error);
    readFailed = true;
  }

  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h1 className='text-2xl font-semibold tracking-tight'>Noty</h1>
          <p className='text-muted-foreground text-sm'>
            Noty obciążeniowe i uznaniowe dla kontrahentów, z PDF i wysyłką mailem.
          </p>
        </div>
        <Link href='/noty/nowa' className={buttonVariants()}>
          <RiAddLine />
          Nowa nota
        </Link>
      </div>

      <Alert>
        <AlertDescription className='flex flex-col gap-1'>
          <span>{NOTE_NOT_INVOICE_NOTICE}</span>
          <span>{NOTE_BOOKS_NOTICE}</span>
        </AlertDescription>
      </Alert>

      {readFailed ? (
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać not</AlertTitle>
          <AlertDescription>Odśwież stronę za chwilę. Jeśli błąd wróci, napisz do pomocy FaktWay.</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <NotesList rows={rows} />
      ) : (
        <Card className='flex-1 shadow-none'>
          <NotesList rows={rows} />
          {rows.length >= 200 ? (
            <p className='text-muted-foreground px-4 text-xs'>Pokazujemy 200 ostatnich not.</p>
          ) : null}
        </Card>
      )}
    </div>
  );
}
