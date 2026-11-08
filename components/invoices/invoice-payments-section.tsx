'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { recordInvoicePaymentAction, voidInvoicePaymentAction } from '@/app/actions/invoice-payments';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatIsoDatePl, formatTimestampDatePl } from '@/lib/format/iso-date';
import {
  ALREADY_RECORDED_TOAST,
  ALREADY_VOIDED_TOAST,
  PAYMENT_NOTE_MAX,
  PAYMENTS_LOAD_FAILED,
  PAYMENTS_MISMATCH,
  RECORD_PAYMENT_FAILED,
  VOID_PAYMENT_FAILED,
  formatPaymentMoney,
  isVoidableSource,
  paymentEntrySchema,
  paymentSourceLabel,
  paymentStateLabel,
  recordedPaymentToast,
  voidedPaymentToast,
  type InvoicePaymentEntry,
  type InvoicePaymentsData,
  type PaymentEntryField,
  type RecordInvoicePaymentResult,
  type VoidInvoicePaymentResult,
} from '@/lib/invoices/invoice-payments';
import { cn } from '@/lib/utils';

import { TOUCH_TARGET, type PayableInvoice } from './use-invoice-payment';

/**
 * Sekcja „Wpłaty” w karcie „Status” szczegółów faktury (plan kompletnej
 * aplikacji, krok 3.1): historia wpłat z resztą do zapłaty, „Zapisz wpłatę”
 * (kwota, data przelewu, notatka) i „Cofnij wpłatę” z potwierdzeniem. Dane
 * liczy serwer (`loadPaymentHistory` strony faktury), zapis i cofnięcie robią
 * RPC z 00176. Decyzja D1 planu: nowa sekcja z istniejących komponentów, pod
 * panelem „Zapłacone”, bez zmiany tego, co już jest. Pola dotyku co najmniej
 * 44 px poniżej `lg`, okno mieści się w telefonie (`DialogContent`).
 */
export function InvoicePaymentsSection({ invoice, data }: { invoice: PayableInvoice; data: InvoicePaymentsData }) {
  const money = (amount: number) => formatPaymentMoney(amount, data.currency);
  const state = paymentStateLabel(data.status);
  const showRest = data.paid > 0 && data.remaining > 0;

  return (
    <div data-testid="wplaty-faktury" className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">Wpłaty</h3>
        {state ? <span className="text-muted-foreground text-xs">{state}</span> : null}
      </div>

      {data.loadError ? (
        <p role="alert" className="text-destructive text-sm">{PAYMENTS_LOAD_FAILED}</p>
      ) : (
        <>
          {data.mismatch ? <p role="alert" className="text-destructive text-sm">{PAYMENTS_MISMATCH}</p> : null}
          {showRest ? (
            <p className="text-sm">
              Zapłacono {money(data.paid)} z {money(data.due)}. Pozostało do zapłaty:{' '}
              <span className="font-medium tabular-nums">{money(data.remaining)}</span>.
            </p>
          ) : null}
          {data.entries.length > 0 ? (
            <ul className="space-y-3">
              {data.entries.map((entry) => (
                <PaymentRow key={entry.id} entry={entry} invoice={invoice} currency={data.currency} canVoid={data.canVoid} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Nie ma jeszcze zapisanych wpłat.</p>
          )}
          {data.canRecord ? (
            <RecordPaymentDialog invoice={invoice} remaining={data.remaining} currency={data.currency} today={data.today} />
          ) : null}
        </>
      )}
    </div>
  );
}

function PaymentRow({
  entry,
  invoice,
  currency,
  canVoid,
}: {
  entry: InvoicePaymentEntry;
  invoice: PayableInvoice;
  currency: string;
  canVoid: boolean;
}) {
  const voided = entry.voidedAt !== null;
  const label = paymentSourceLabel(entry.source);
  return (
    <li data-testid="wplata" className="space-y-1">
      <div className={cn('flex items-baseline justify-between gap-3 text-sm', voided && 'text-muted-foreground')}>
        <span className={cn(voided && 'line-through')}>{formatIsoDatePl(entry.paidOn)}</span>
        <span className={cn('font-medium tabular-nums', voided && 'line-through')}>
          {formatPaymentMoney(entry.amount, currency)}
        </span>
      </div>
      {label ? <p className="text-muted-foreground text-xs">{label}</p> : null}
      {entry.note ? <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">{entry.note}</p> : null}
      {voided ? (
        <p className="text-muted-foreground text-xs">Cofnięta {formatTimestampDatePl(entry.voidedAt)}</p>
      ) : canVoid && isVoidableSource(entry.source) ? (
        <VoidPaymentButton entry={entry} invoice={invoice} currency={currency} />
      ) : null}
    </li>
  );
}

const safeRecord = (input: Parameters<typeof recordInvoicePaymentAction>[0]): Promise<RecordInvoicePaymentResult> =>
  recordInvoicePaymentAction(input).catch(() => ({ success: false, error: RECORD_PAYMENT_FAILED }));
const safeVoid = (paymentId: string): Promise<VoidInvoicePaymentResult> =>
  voidInvoicePaymentAction(paymentId).catch(() => ({ success: false, error: VOID_PAYMENT_FAILED }));

/** Klucz idempotencji: jeden na otwarcie okna, więc ponowienie tej samej wpłaty zapisuje ją raz. */
function newPaymentKey(): string {
  return crypto.randomUUID();
}

function RecordPaymentDialog({
  invoice,
  remaining,
  currency,
  today,
}: {
  invoice: PayableInvoice;
  remaining: number;
  currency: string;
  today: string;
}) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<PaymentEntryField, string>>>({});
  const [pending, startTransition] = useTransition();

  const openDialog = () => {
    setKey(newPaymentKey());
    setAmount('');
    setPaidOn(today);
    setNote('');
    setErrors({});
    setOpen(true);
  };

  const clear = (field: PaymentEntryField) =>
    setErrors((current) => {
      if (!(field in current)) return current;
      const rest = { ...current };
      delete rest[field];
      return rest;
    });

  const submit = () => {
    const parsed = paymentEntrySchema({ today, maxAmount: remaining }).safeParse({ amount, paidOn, note });
    if (!parsed.success) {
      const next: Partial<Record<PaymentEntryField, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'amount' || field === 'paidOn' || field === 'note') next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const result = await safeRecord({
        invoiceId: invoice.id,
        amount: parsed.data.amount,
        paidOn: parsed.data.paidOn,
        note: parsed.data.note,
        idempotencyKey: key,
      });
      if (!result.success) {
        // Ten sam klucz zostaje: ponowienie po błędzie sieci to ta sama wpłata.
        if (result.field) setErrors({ [result.field]: result.error });
        else toast.error(result.error);
        return;
      }
      if (result.status === 'already_recorded') toast.info(ALREADY_RECORDED_TOAST);
      else toast.success(recordedPaymentToast(result.amount, result.number ?? invoice.number, result.paidInFull));
      setOpen(false);
      router.refresh();
    });
  };

  const fieldId = (field: PaymentEntryField) => `${formId}-${field}`;
  const errorId = (field: PaymentEntryField) => (errors[field] ? `${formId}-${field}-blad` : undefined);
  const errorText = (field: PaymentEntryField) =>
    errors[field] ? (
      <p id={`${formId}-${field}-blad`} role="alert" className="text-destructive text-xs">
        {errors[field]}
      </p>
    ) : null;

  return (
    <>
      <Button type="button" variant="outline" className={cn(TOUCH_TARGET, 'w-full')} onClick={openDialog}>
        Zapisz wpłatę
      </Button>
      <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Zapisz wpłatę</DialogTitle>
            <DialogDescription>
              {invoice.number ? `Faktura ${invoice.number}. ` : ''}Pozostało do zapłaty: {formatPaymentMoney(remaining, currency)}.
            </DialogDescription>
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
                <FieldLabel htmlFor={fieldId('amount')}>Kwota ({currency})</FieldLabel>
                <Input
                  id={fieldId('amount')}
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  placeholder="np. 300,00"
                  disabled={pending}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    clear('amount');
                  }}
                  aria-invalid={errors.amount ? true : undefined}
                  aria-describedby={errorId('amount')}
                  className={TOUCH_TARGET}
                />
                <FieldDescription>Najwyżej {formatPaymentMoney(remaining, currency)}. Nadpłat FaktWay nie zapisuje.</FieldDescription>
                {errorText('amount')}
              </Field>
              <Field>
                <FieldLabel htmlFor={fieldId('paidOn')}>Data wpłaty</FieldLabel>
                <Input
                  id={fieldId('paidOn')}
                  type="date"
                  required
                  max={today}
                  value={paidOn}
                  disabled={pending}
                  onChange={(event) => {
                    setPaidOn(event.target.value);
                    clear('paidOn');
                  }}
                  aria-invalid={errors.paidOn ? true : undefined}
                  aria-describedby={errorId('paidOn')}
                  className={TOUCH_TARGET}
                />
                <FieldDescription>Dzień, w którym pieniądze wpłynęły, na przykład z wyciągu.</FieldDescription>
                {errorText('paidOn')}
              </Field>
              <Field>
                <FieldLabel htmlFor={fieldId('note')}>Notatka</FieldLabel>
                <Textarea
                  id={fieldId('note')}
                  value={note}
                  maxLength={PAYMENT_NOTE_MAX}
                  rows={2}
                  placeholder="Nieobowiązkowo, np. przelew z mBanku"
                  disabled={pending}
                  onChange={(event) => {
                    setNote(event.target.value);
                    clear('note');
                  }}
                  aria-invalid={errors.note ? true : undefined}
                  aria-describedby={errorId('note')}
                />
                {errorText('note')}
              </Field>
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" className={TOUCH_TARGET} disabled={pending} onClick={() => setOpen(false)}>
              Anuluj
            </Button>
            <Button type="submit" form={formId} className={TOUCH_TARGET} disabled={pending}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Zapisz wpłatę
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function VoidPaymentButton({
  entry,
  invoice,
  currency,
}: {
  entry: InvoicePaymentEntry;
  invoice: PayableInvoice;
  currency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const amount = formatPaymentMoney(entry.amount, currency);
  const day = formatIsoDatePl(entry.paidOn);

  const confirm = () =>
    startTransition(async () => {
      const result = await safeVoid(entry.id);
      setOpen(false);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      if (result.status === 'already_voided') toast.info(ALREADY_VOIDED_TOAST);
      else toast.success(voidedPaymentToast(result.amount ?? entry.amount));
      router.refresh();
    });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(TOUCH_TARGET, 'px-0')}
        aria-label={`Cofnij wpłatę ${amount} z ${day}`}
        onClick={() => setOpen(true)}
      >
        Cofnij wpłatę
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cofnąć wpłatę {amount} z {day}?</AlertDialogTitle>
            <AlertDialogDescription>
              {entry.source === 'manual'
                ? `${invoice.number ? `Faktura ${invoice.number}` : 'Faktura'} wróci do stanu sprzed oznaczenia „Zapłacone”. Cofnięcie zostaje w historii zmian firmy.`
                : 'Kwota wróci do pozostałej do zapłaty, a wpłata zostanie w historii jako cofnięta.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
            <Button type="button" variant="destructive" className={TOUCH_TARGET} onClick={confirm} disabled={pending}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Cofnij wpłatę
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
