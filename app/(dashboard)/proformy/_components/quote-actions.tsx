'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  RiDeleteBinLine,
  RiDownload2Line,
  RiEditLine,
  RiFileAddLine,
  RiFileTransferLine,
  RiLoader4Line,
  RiSendPlaneLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import { deleteQuoteDraftAction, issueQuoteAction, sendQuoteEmailAction } from '@/app/actions/proformy';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  QUOTE_KIND_ACCUSATIVE,
  QUOTE_KIND_GENITIVE,
  type QuoteInvoiceLink,
  type QuoteKind,
  type QuoteStatus,
} from '@/lib/proformy/model';
import { invoiceNumbersSentence } from '@/lib/proformy/teksty';

type Target = 'regular' | 'advance';

const TARGET_LABELS: Record<Target, string> = {
  regular: 'Wystaw fakturę',
  advance: 'Wystaw fakturę zaliczkową',
};

/** Formularz faktury z dokumentem w adresie; `kolejna=1` tylko po potwierdzeniu w oknie. */
function conversionHref(target: Target, quoteId: string, confirmed: boolean): string {
  return `/invoices/new/${target}?proforma=${quoteId}${confirmed ? '&kolejna=1' : ''}`;
}

/**
 * Przyciski podglądu proformy albo oferty (krok 2.4). Szkic: wystaw (z
 * potwierdzeniem, bo potem dokument jest zamrożony), edytuj, usuń. Wystawiony:
 * wysyłka mailem (arkusz z adresem kontrahenta), PDF, zamiana w fakturę albo
 * fakturę zaliczkową, nowy dokument. Zamiana tylko otwiera formularz faktury
 * z danymi dokumentu; gdy z dokumentu jest już faktura, najpierw pyta (druga
 * faktura tylko po potwierdzeniu). Każda akcja sprawdza wszystko jeszcze raz
 * po stronie serwera i bazy.
 */
export function QuoteActions({
  quoteId,
  kind,
  status,
  number,
  defaultEmail,
  issuerReady,
  invoices,
}: {
  quoteId: string;
  kind: QuoteKind;
  status: QuoteStatus;
  number: string | null;
  /** Adres kontrahenta z migawki dokumentu. */
  defaultEmail: string | null;
  /** Dane firmy kompletne (szkic): bez nich wystawienie odmówi z tym samym komunikatem. */
  issuerReady: boolean;
  /** Faktury już utworzone z dokumentu. */
  invoices: QuoteInvoiceLink[];
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [confirm, setConfirm] = useState<'issue' | 'delete' | null>(null);
  const [convert, setConvert] = useState<Target | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [to, setTo] = useState(defaultEmail ?? '');
  const [sendError, setSendError] = useState<string | null>(null);

  const issue = () => {
    start(async () => {
      const result = await issueQuoteAction(quoteId);
      setConfirm(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(result.alreadyIssued ? `Dokument był już wystawiony jako ${result.number}.` : `Wystawiono ${result.number}.`);
      router.refresh();
    });
  };

  const remove = () => {
    start(async () => {
      const result = await deleteQuoteDraftAction(quoteId);
      setConfirm(null);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success('Usunięto szkic.');
      router.push('/proformy');
    });
  };

  const send = () => {
    setSendError(null);
    start(async () => {
      const result = await sendQuoteEmailAction(quoteId, to);
      if (!result.success) {
        setSendError(result.error);
        return;
      }
      toast.success(`Wysłano dokument na adres ${result.recipient}.`);
      setSheetOpen(false);
      router.refresh();
    });
  };

  if (status === 'draft') {
    return (
      <div className='flex flex-wrap gap-2'>
        <Button onClick={() => setConfirm('issue')} disabled={isPending || !issuerReady}>
          Wystaw {QUOTE_KIND_ACCUSATIVE[kind]}
        </Button>
        <Link href={`/proformy/${quoteId}/edycja`} className={buttonVariants({ variant: 'outline' })}>
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
              <AlertDialogTitle>{confirm === 'delete' ? 'Usunąć szkic?' : `Wystawić ${QUOTE_KIND_ACCUSATIVE[kind]}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirm === 'delete'
                  ? 'Szkic nie ma numeru, więc w serii nie powstanie luka. Tego nie da się cofnąć.'
                  : 'Dokument dostanie kolejny numer z serii i od tej chwili nie można go zmienić ani usunąć. Poprawka to nowy dokument.'}
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
                {confirm === 'delete' ? 'Usuń szkic' : `Wystaw ${QUOTE_KIND_ACCUSATIVE[kind]}`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  const formId = `quote-email-${quoteId}`;
  const converted = invoices.length > 0;
  const conversionButton = (target: Target, primary: boolean) =>
    converted ? (
      <Button variant={primary ? 'default' : 'outline'} onClick={() => setConvert(target)}>
        <RiFileTransferLine />
        {TARGET_LABELS[target]}
      </Button>
    ) : (
      <Link href={conversionHref(target, quoteId, false)} className={buttonVariants({ variant: primary ? 'default' : 'outline' })}>
        <RiFileTransferLine />
        {TARGET_LABELS[target]}
      </Link>
    );

  return (
    <div className='flex flex-wrap gap-2'>
      {conversionButton('regular', true)}
      {conversionButton('advance', false)}
      <Button
        variant='outline'
        onClick={() => {
          setTo(defaultEmail ?? '');
          setSendError(null);
          setSheetOpen(true);
        }}
      >
        <RiSendPlaneLine />
        Wyślij e-mailem
      </Button>
      <a href={`/api/proformy/${quoteId}/pdf`} className={buttonVariants({ variant: 'outline' })} download>
        <RiDownload2Line />
        Pobierz PDF
      </a>
      <Link href='/proformy/nowa' className={buttonVariants({ variant: 'outline' })}>
        <RiFileAddLine />
        Nowy dokument
      </Link>

      <AlertDialog
        open={convert !== null}
        onOpenChange={(open) => {
          if (!open) setConvert(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Z tej {QUOTE_KIND_GENITIVE[kind]} jest już faktura</AlertDialogTitle>
            <AlertDialogDescription>
              Faktury z tego dokumentu: {invoiceNumbersSentence(invoices)}. Kolejna faktura z tego samego dokumentu to
              osobna sprzedaż w KSeF i w księgach. Otworzyć formularz kolejnej faktury z danymi dokumentu?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            {convert ? (
              <Link href={conversionHref(convert, quoteId, true)} className={buttonVariants()}>
                {TARGET_LABELS[convert]}
              </Link>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className='sm:max-w-md'>
          <SheetHeader>
            <SheetTitle>Wyślij {number} e-mailem</SheetTitle>
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
                    Wyślemy wiadomość FaktWay z dokumentem w PDF. Treść i temat są stałe. Ponowna wysyłka na ten sam adres
                    wysyła dokument jeszcze raz.
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
