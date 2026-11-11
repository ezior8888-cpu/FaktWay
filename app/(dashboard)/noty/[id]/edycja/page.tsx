import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { getNote, listContractorOptions } from '@/lib/noty/baza';
import type { AccountingNote, NoteContractorOption } from '@/lib/noty/model';
import { noteToDraftInput } from '@/lib/noty/schemat';
import { NOTE_TEXTS, noteIssuedLockedMessage } from '@/lib/noty/teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { NoteForm } from '../../_components/note-form';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Edycja szkicu noty (krok 2.9, część 1). Wystawionej nie edytuje się: poprawka to nowa nota. */
export default async function EditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) notFound();
  const { supabase, tenantId } = await getPageContext();

  let note: AccountingNote | null;
  let contractors: NoteContractorOption[];
  try {
    note = await getNote(supabase, tenantId, id);
    contractors = note && note.status === 'draft' ? await listContractorOptions(supabase, tenantId) : [];
  } catch (error) {
    console.error('[noty] edycja:', error);
    return (
      <Alert variant='destructive'>
        <AlertTitle>Nie udało się wczytać noty</AlertTitle>
        <AlertDescription>{NOTE_TEXTS.readFailed}</AlertDescription>
      </Alert>
    );
  }
  if (!note) notFound();

  if (note.status === 'issued') {
    return (
      <div className='flex flex-col gap-6'>
        <h1 className='text-2xl font-semibold tracking-tight'>Nota {note.number}</h1>
        <Alert>
          <AlertDescription>
            {noteIssuedLockedMessage(note.number)}{' '}
            <Link href={`/noty/${note.id}`} className='underline'>
              Wróć do noty
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-6'>
      <div>
        <Link href={`/noty/${note.id}`} className='text-muted-foreground text-sm hover:underline'>
          Wróć do podglądu
        </Link>
        <h1 className='text-2xl font-semibold tracking-tight'>Edycja szkicu noty</h1>
      </div>
      <NoteForm
        tenantId={tenantId}
        contractors={contractors}
        today={todayInWarsaw()}
        noteId={note.id}
        initial={noteToDraftInput(note)}
      />
    </div>
  );
}
