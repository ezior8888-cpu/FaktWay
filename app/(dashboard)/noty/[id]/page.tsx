import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { getNote, listNoteEmails, loadIssuerPreview } from '@/lib/noty/baza';
import type { AccountingNote, NoteEmailRecord, NoteParty } from '@/lib/noty/model';
import { NOTE_TEXTS } from '@/lib/noty/teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { NoteActions } from '../_components/note-actions';
import { NoteDocument } from '../_components/note-document';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function EmailHistory({ emails }: { emails: NoteEmailRecord[] | null }) {
  return (
    <Card className='shadow-none'>
      <CardContent className='flex flex-col gap-2 text-sm'>
        <h2 className='font-medium'>Wysyłki mailem</h2>
        {emails === null ? (
          <p className='text-muted-foreground'>Nie udało się wczytać historii wysyłek. Odśwież stronę za chwilę.</p>
        ) : emails.length === 0 ? (
          <p className='text-muted-foreground'>Ta nota nie była jeszcze wysyłana mailem.</p>
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

/**
 * Podgląd noty (krok 2.9, część 1): dokument jak w PDF i przyciski. Odczyt
 * klientem z sesji (RLS 00193); nota innej firmy to „nie znaleziono”.
 */
export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) notFound();
  const { supabase, tenantId } = await getPageContext();

  let note: AccountingNote | null;
  try {
    note = await getNote(supabase, tenantId, id);
  } catch (error) {
    console.error('[noty] podgląd:', error);
    return (
      <Alert variant='destructive'>
        <AlertTitle>Nie udało się wczytać noty</AlertTitle>
        <AlertDescription>{NOTE_TEXTS.readFailed}</AlertDescription>
      </Alert>
    );
  }
  if (!note) notFound();

  const issuer: NoteParty | null = note.status === 'issued' ? note.issuer : await loadIssuerPreview(supabase, tenantId);
  const emails = note.status === 'issued' ? await listNoteEmails(supabase, tenantId, note.id).catch(() => null) : [];

  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
        <div>
          <Link href='/noty' className='text-muted-foreground text-sm hover:underline'>
            Wróć do listy not
          </Link>
          <h1 className='text-2xl font-semibold tracking-tight'>{note.number ?? 'Szkic noty'}</h1>
        </div>
        <NoteActions
          noteId={note.id}
          status={note.status}
          number={note.number}
          defaultEmail={note.counterparty.email ?? null}
          issuerReady={issuer !== null}
        />
      </div>

      {note.status === 'draft' && issuer === null ? (
        <Alert>
          <AlertDescription>
            {NOTE_TEXTS.issuerIncomplete}{' '}
            <Link href='/settings' className='underline'>
              Przejdź do Ustawień
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {note.status === 'draft' && note.contractorId === null ? (
        <Alert>
          <AlertDescription>{NOTE_TEXTS.contractorRemoved}</AlertDescription>
        </Alert>
      ) : null}

      <NoteDocument note={note} issuer={issuer} />
      {note.status === 'issued' ? <EmailHistory emails={emails} /> : null}
    </div>
  );
}
