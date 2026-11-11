'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RiDeleteBinLine, RiDownload2Line, RiEditLine, RiFileAddLine, RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';
import { toast } from 'sonner';

import { deleteNoteDraftAction, issueNoteAction, sendNoteEmailAction } from '@/app/actions/noty';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { NoteStatus } from '@/lib/noty/model';

/**
 * Przyciski podglądu noty (krok 2.9, część 1). Szkic: wystaw (z potwierdzeniem,
 * bo potem nota jest zamrożona), edytuj, usuń. Wystawiona: PDF, wysyłka mailem
 * (arkusz z adresem kontrahenta), nowa nota. Każda akcja sprawdza wszystko
 * jeszcze raz po stronie serwera i bazy.
 */
export function NoteActions({
  noteId,
  status,
  number,
  defaultEmail,
  issuerReady,
}: {
  noteId: string;
  status: NoteStatus;
  number: string | null;
  /** Adres kontrahenta z migawki noty. */
  defaultEmail: string | null;
  /** Dane firmy kompletne (szkic): bez nich wystawienie odmówi z tym samym komunikatem. */
  issuerReady: boolean;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [confirm, setConfirm] = useState<'issue' | 'delete' | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [to, setTo] = useState(defaultEmail ?? '');
  const [sendError, setSendError] = useState<string | null>(null);

  const issue = () => {
    start(async () => {
      const result = await issueNoteAction(noteId);
      setConfirm(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(result.alreadyIssued ? `Nota była już wystawiona jako ${result.number}.` : `Wystawiono notę ${result.number}.`);
      router.refresh();
    });
  };

  const remove = () => {
    start(async () => {
      const result = await deleteNoteDraftAction(noteId);
      setConfirm(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success('Usunięto szkic noty.');
      router.push('/noty');
    });
  };

  const send = () => {
    setSendError(null);
    start(async () => {
      const result = await sendNoteEmailAction(noteId, to);
      if (!result.success) {
        setSendError(result.error);
        return;
      }
      toast.success(`Wysłano notę na adres ${result.recipient}.`);
      setSheetOpen(false);
      router.refresh();
    });
  };

  if (status === 'draft') {
    return (
      <div className='flex flex-wrap gap-2'>
        <Button onClick={() => setConfirm('issue')} disabled={isPending || !issuerReady}>
          Wystaw notę
        </Button>
        <Link href={`/noty/${noteId}/edycja`} className={buttonVariants({ variant: 'outline' })}>
          <RiEditLine />
          Edytuj
        </Link>
        <Button variant='outline' onClick={() => setConfirm('delete')} disabled={isPending}>
          <RiDeleteBinLine />
          Usuń szkic
        </Button>

        <AlertDialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm === 'delete' ? 'Usunąć szkic noty?' : 'Wystawić notę?'}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirm === 'delete'
                  ? 'Szkic nie ma numeru, więc w serii nie powstanie luka. Tego nie da się cofnąć.'
                  : 'Nota dostanie kolejny numer z serii i od tej chwili nie można jej zmienić ani usunąć. Poprawka to nowa nota.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Anuluj</AlertDialogCancel>
              <AlertDialogAction
                variant={confirm === 'delete' ? 'destructive' : 'default'}
                disabled={isPending}
                onClick={confirm === 'delete' ? remove : issue}
              >
                {isPending ? <RiLoader4Line className='animate-spin' /> : null}
                {confirm === 'delete' ? 'Usuń szkic' : 'Wystaw notę'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  const formId = `note-email-${noteId}`;
  return (
    <div className='flex flex-wrap gap-2'>
      <Button
        onClick={() => {
          setTo(defaultEmail ?? '');
          setSendError(null);
          setSheetOpen(true);
        }}
      >
        <RiSendPlaneLine />
        Wyślij e-mailem
      </Button>
      <a href={`/api/noty/${noteId}/pdf`} className={buttonVariants({ variant: 'outline' })} download>
        <RiDownload2Line />
        Pobierz PDF
      </a>
      <Link href='/noty/nowa' className={buttonVariants({ variant: 'outline' })}>
        <RiFileAddLine />
        Nowa nota
      </Link>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className='sm:max-w-md'>
          <SheetHeader>
            <SheetTitle>Wyślij notę {number} e-mailem</SheetTitle>
          </SheetHeader>
          <form
            id={formId}
            className='flex flex-1 flex-col overflow-y-auto px-4'
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <FieldGroup>
              {sendError ? (
                <Alert variant='destructive'>
                  <AlertDescription>{sendError}</AlertDescription>
                </Alert>
              ) : null}
              <Field>
                <FieldLabel htmlFor={`${formId}-to`}>Do</FieldLabel>
                <FieldContent>
                  <Input
                    id={`${formId}-to`}
                    type='email'
                    autoComplete='email'
                    placeholder='e-mail kontrahenta'
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                  />
                  <FieldDescription>
                    Wyślemy wiadomość FaktWay z notą w PDF. Treść i temat są stałe. Ponowna wysyłka na ten sam adres
                    wysyła notę jeszcze raz.
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>
          </form>
          <SheetFooter className='flex-row'>
            <Button type='submit' form={formId} disabled={isPending || to.trim() === ''}>
              {isPending ? <RiLoader4Line className='animate-spin' /> : null}
              Wyślij
            </Button>
            <Button type='button' variant='outline' onClick={() => setSheetOpen(false)} disabled={isPending}>
              Anuluj
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
