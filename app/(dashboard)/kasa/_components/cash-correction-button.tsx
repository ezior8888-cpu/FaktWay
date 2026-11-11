'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { correctCashDocumentAction } from '@/app/actions/kasa';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { CASH_LIMITS } from '@/lib/kasa/model';
import { cashCorrectionSchema, type CorrectCashDocumentResult } from '@/lib/kasa/schemat';
import { CASH_CORRECT_FAILED, CASH_CORRECTION_INFO, alreadyIssuedToast, correctedToast } from '@/lib/kasa/teksty';
import { cn } from '@/lib/utils';

/** Piksele, nie `min-h-11`: `--spacing` aplikacji jest mniejszy niż 4 px (jak w sekcji wpłat). */
const TOUCH_TARGET = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';

const safeCorrect = (input: Parameters<typeof correctCashDocumentAction>[0]): Promise<CorrectCashDocumentResult> =>
  correctCashDocumentAction(input).catch(() => ({ success: false, error: CASH_CORRECT_FAILED }));

/**
 * „Korekta dowodu” (krok 3.7): okno z przyczyną, która trafia na dowód
 * korygujący. Klucz idempotencji powstaje przy otwarciu okna i zostaje przy
 * ponowieniu po błędzie, więc to samo kliknięcie wystawia korektę raz.
 */
export function CashCorrectionButton({ documentId, number, className }: { documentId: string; number: string; className?: string }) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const openDialog = () => {
    setKey(crypto.randomUUID());
    setReason('');
    setError(null);
    setOpen(true);
  };

  const submit = () => {
    const parsed = cashCorrectionSchema.safeParse({ reason });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? CASH_CORRECT_FAILED);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await safeCorrect({ documentId, idempotencyKey: key, reason: parsed.data.reason });
      if (!result.success) {
        // Ten sam klucz zostaje: ponowienie po błędzie sieci to ta sama korekta.
        setError(result.error);
        return;
      }
      toast.success(
        result.status === 'already_issued'
          ? alreadyIssuedToast(result.number)
          : correctedToast(result.number, result.correctsNumber || number, result.paymentVoided, result.invoiceNumber),
      );
      setOpen(false);
      router.push(`/kasa/${result.documentId}`);
    });
  };

  const errorId = `${formId}-blad`;

  return (
    <>
      <Button type='button' variant='outline' className={cn(TOUCH_TARGET, className)} onClick={openDialog}>
        Korekta dowodu
      </Button>
      <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Korekta dowodu {number}</DialogTitle>
            <DialogDescription>{CASH_CORRECTION_INFO}</DialogDescription>
          </DialogHeader>
          <form
            id={formId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-przyczyna`}>Przyczyna korekty</FieldLabel>
                <Textarea
                  id={`${formId}-przyczyna`}
                  value={reason}
                  maxLength={CASH_LIMITS.reason}
                  rows={3}
                  placeholder='np. zła kwota albo dowód wystawiony dwa razy'
                  disabled={pending}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setError(null);
                  }}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
                <FieldDescription>Przyczyna będzie na dowodzie korygującym.</FieldDescription>
                {error ? (
                  <p id={errorId} role='alert' className='text-destructive text-xs'>
                    {error}
                  </p>
                ) : null}
              </Field>
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button type='button' variant='outline' className={TOUCH_TARGET} disabled={pending} onClick={() => setOpen(false)}>
              Anuluj
            </Button>
            <Button type='submit' form={formId} className={TOUCH_TARGET} disabled={pending}>
              {pending ? <RiLoader4Line className='animate-spin' aria-hidden /> : null}
              Wystaw korektę
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
