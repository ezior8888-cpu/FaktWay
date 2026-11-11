'use client';

import { useRef, useState, useTransition, type FormEvent, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { RiChat3Line, RiCheckLine, RiFileSearchLine, RiLoader4Line, RiRefreshLine } from '@remixicon/react';

import { addExpenseCommentAction, resolveDocumentRequestAction } from '@/app/actions/expense-thread';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  COMMENT_ADDED,
  COMMENT_SAVE_ERROR,
  EXPENSE_COMMENT_MAX_LENGTH,
  EXPENSE_THREAD_LIMIT,
  REQUEST_ADDED,
  REQUEST_ALREADY_RESOLVED,
  REQUEST_RESOLVE_ERROR,
  REQUEST_RESOLVED,
  expenseCommentFormSchema,
  newCommentId,
  openRequestsLabel,
  type ExpenseCommentFormValues,
  type ExpenseCommentKind,
  type ExpenseThreadEntry,
  type ExpenseThreadLoad,
} from '@/lib/expenses/expense-thread';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

/**
 * Wątek przy koszcie w przeglądarce (plan kompletnej aplikacji, krok 6.2,
 * część 3, 00192): wpisy od najstarszego, prośba o dokument ze stanem
 * (otwarta albo załatwiona: kto i kiedy) i formularz z dwoma przyciskami.
 * Po zapisie akcja odświeża stronę kosztu (`revalidatePath`), więc lista
 * przychodzi z serwera, a formularz się czyści.
 */

const TITLE = 'Komentarze i prośby o dokument';

export function ExpenseThreadPanel({
  expenseId,
  thread,
  canWrite,
}: {
  expenseId: string;
  thread: ExpenseThreadLoad;
  canWrite: boolean;
}) {
  if (!thread.ok) return <ThreadLoadError error={thread.error} />;
  return <ThreadView expenseId={expenseId} entries={thread.entries} truncated={thread.truncated} canWrite={canWrite} />;
}

/** Błąd odczytu: komunikat z wyjściem, nigdy pusta lista udająca brak wpisów. */
function ThreadLoadError({ error }: { error: string }) {
  const router = useRouter();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE}</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
          <AlertDescription>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => router.refresh()}>
              <RiRefreshLine />
              Spróbuj ponownie
            </Button>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function ThreadView({
  expenseId,
  entries,
  truncated,
  canWrite,
}: {
  expenseId: string;
  entries: ExpenseThreadEntry[];
  truncated: boolean;
  canWrite: boolean;
}) {
  const open = entries.filter((entry) => entry.kind === 'document_request' && !entry.resolvedAt).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE}</CardTitle>
        <CardDescription>Widzą je osoby z dostępem do kosztów tej firmy. Nowy wpis trafia do ich powiadomień.</CardDescription>
        {open > 0 ? (
          <CardAction>
            <Badge>{openRequestsLabel(open)}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {truncated ? (
          <p className="text-muted-foreground text-xs">Widać {EXPENSE_THREAD_LIMIT} ostatnich wpisów.</p>
        ) : null}
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nie ma jeszcze wpisów. Tu zapytasz o ten koszt albo poprosisz o dokument, np. o fakturę zamiast paragonu.
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {entries.map((entry) => (
              <ThreadEntry key={entry.id} entry={entry} canWrite={canWrite} />
            ))}
          </ol>
        )}
        {canWrite ? (
          <ThreadForm expenseId={expenseId} />
        ) : (
          <p className="text-muted-foreground text-sm">Masz tu tylko wgląd.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ThreadEntry({ entry, canWrite }: { entry: ExpenseThreadEntry; canWrite: boolean }) {
  const [pending, start] = useTransition();
  const request = entry.kind === 'document_request';

  const resolve = () =>
    start(async () => {
      try {
        const result = await resolveDocumentRequestAction(entry.id);
        if (result.success) toast.success(result.status === 'resolved' ? REQUEST_RESOLVED : REQUEST_ALREADY_RESOLVED);
        else toast.error(result.error);
      } catch {
        toast.error(REQUEST_RESOLVE_ERROR);
      }
    });

  return (
    <li className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{entry.authorLabel}</span>
        {entry.authorRoleLabel ? <span className="text-muted-foreground">{entry.authorRoleLabel}</span> : null}
        <time dateTime={entry.createdAt} className="text-muted-foreground text-xs tabular-nums">
          {formatWarsawDateTime(entry.createdAt)}
        </time>
      </div>
      {request ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <RiFileSearchLine aria-hidden />
            Prośba o dokument
          </Badge>
          <Badge variant={entry.resolvedAt ? 'secondary' : 'default'}>{entry.resolvedAt ? 'Załatwiona' : 'Otwarta'}</Badge>
        </div>
      ) : null}
      <p className="text-sm break-words whitespace-pre-wrap">{entry.body}</p>
      {request && entry.resolvedAt ? (
        <p className="text-muted-foreground text-xs">
          Załatwiona: {entry.resolvedByLabel}, {formatWarsawDateTime(entry.resolvedAt)}
        </p>
      ) : null}
      {request && !entry.resolvedAt && canWrite ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={resolve} disabled={pending}>
            {pending ? <RiLoader4Line className="animate-spin" /> : <RiCheckLine />}
            Oznacz jako załatwioną
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function ThreadForm({ expenseId }: { expenseId: string }) {
  const [pending, start] = useTransition();
  const [pendingKind, setPendingKind] = useState<ExpenseCommentKind | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // Ostatnia wysyłka bez potwierdzenia: ta sama treść i rodzaj idą z tym samym
  // identyfikatorem, więc ponowienie po zerwanym połączeniu nie dubluje wpisu
  // (baza zwraca „exists”). Zmieniona treść to nowy wpis i nowy identyfikator.
  const draft = useRef<{ id: string; signature: string } | null>(null);
  const form = useForm<ExpenseCommentFormValues>({
    resolver: zodResolver(expenseCommentFormSchema),
    defaultValues: { body: '' },
  });
  const fieldId = `expense-thread-body-${expenseId}`;
  const bodyError = form.formState.errors.body;

  const save = (kind: ExpenseCommentKind, values: ExpenseCommentFormValues) => {
    const body = values.body.trim();
    const signature = `${kind}\n${body}`;
    if (draft.current?.signature !== signature) draft.current = { id: newCommentId(), signature };
    const commentId = draft.current.id;
    setServerError(null);
    setPendingKind(kind);
    start(async () => {
      try {
        const result = await addExpenseCommentAction({ expenseId, commentId, kind, body });
        if (result.success) {
          draft.current = null;
          form.reset({ body: '' });
          toast.success(kind === 'comment' ? COMMENT_ADDED : REQUEST_ADDED);
        } else {
          setServerError(result.error);
        }
      } catch {
        setServerError(COMMENT_SAVE_ERROR);
      } finally {
        setPendingKind(null);
      }
    });
  };

  const addComment = (event: FormEvent<HTMLFormElement>) => {
    void form.handleSubmit((values) => save('comment', values))(event);
  };
  const requestDocument = (event: MouseEvent<HTMLButtonElement>) => {
    void form.handleSubmit((values) => save('document_request', values))(event);
  };

  return (
    <form onSubmit={addComment} noValidate className="flex flex-col gap-3 border-t pt-4">
      <Field data-invalid={!!bodyError}>
        <FieldLabel htmlFor={fieldId}>Nowy wpis</FieldLabel>
        <FieldContent>
          <Textarea
            id={fieldId}
            rows={3}
            maxLength={EXPENSE_COMMENT_MAX_LENGTH}
            placeholder="Np. czy to koszt firmowy? Albo: proszę o fakturę zamiast paragonu."
            aria-invalid={!!bodyError}
            {...form.register('body')}
          />
          <FieldError errors={[bodyError]} />
          {serverError ? <FieldError>{serverError}</FieldError> : null}
          <FieldDescription>Wpisu nie da się potem zmienić ani usunąć.</FieldDescription>
        </FieldContent>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pendingKind === 'comment' ? <RiLoader4Line className="animate-spin" /> : <RiChat3Line />}
          Dodaj komentarz
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={requestDocument}>
          {pendingKind === 'document_request' ? <RiLoader4Line className="animate-spin" /> : <RiFileSearchLine />}
          Poproś o dokument
        </Button>
      </div>
    </form>
  );
}
