'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { openCashRegisterAction } from '@/app/actions/kasa';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cashOpeningSchema, type CashOpeningFields, type OpenCashRegisterResult } from '@/lib/kasa/schemat';
import { CASH_OPEN_FAILED, CASH_OPENING_INFO } from '@/lib/kasa/teksty';

const TOUCH_TARGET = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';

const safeOpen = (input: CashOpeningFields, tenantId: string): Promise<OpenCashRegisterResult> =>
  openCashRegisterAction(input, tenantId).catch(() => ({ success: false, error: CASH_OPEN_FAILED }));

/** Kwota do pola: „0,00”, „1250,50” (polski przecinek, bez separatora tysięcy). */
function amountText(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

const OPENED_TOAST: Record<'opened' | 'updated' | 'unchanged', string> = {
  opened: 'Kasa otwarta. Możesz wystawiać dowody KP i KW.',
  updated: 'Zmieniono stan początkowy kasy.',
  unchanged: 'Stan początkowy bez zmian.',
};

/**
 * Stan początkowy kasy (krok 3.7): dzień, od którego firma prowadzi kasę
 * w FaktWay, i gotówka w kasie tego dnia. Zmienia się go, dopóki nie ma
 * pierwszego dowodu; potem odmawia baza (00194).
 */
export function CashOpeningForm({
  tenantId,
  today,
  initial,
}: {
  /** Firma, dla której strona wyrenderowała formularz: zapis odsyła ją akcji (UX-01). */
  tenantId: string;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) z serwera. */
  today: string;
  initial: { openingDate: string; openingBalance: number } | null;
}) {
  const router = useRouter();
  const formId = useId();
  const [openingDate, setOpeningDate] = useState(initial?.openingDate ?? today);
  const [openingBalance, setOpeningBalance] = useState(initial ? amountText(initial.openingBalance) : '0');
  const [errors, setErrors] = useState<Partial<Record<keyof CashOpeningFields, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setFormError(null);
    const parsed = cashOpeningSchema({ today }).safeParse({ openingDate, openingBalance });
    if (!parsed.success) {
      const next: Partial<Record<keyof CashOpeningFields, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'openingDate' || field === 'openingBalance') next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const result = await safeOpen(parsed.data, tenantId);
      if (!result.success) {
        if (result.field) setErrors({ [result.field]: result.error });
        else setFormError(result.error);
        return;
      }
      toast.success(OPENED_TOAST[result.status]);
      router.refresh();
    });
  };

  const error = (field: keyof CashOpeningFields) =>
    errors[field] ? (
      <p id={`${formId}-${field}-blad`} role='alert' className='text-destructive text-xs'>
        {errors[field]}
      </p>
    ) : null;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className='flex flex-col gap-4'
    >
      <p className='text-muted-foreground text-sm'>{CASH_OPENING_INFO}</p>
      <FieldGroup className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field>
          <FieldLabel htmlFor={`${formId}-openingDate`}>Dzień rozpoczęcia</FieldLabel>
          <Input
            id={`${formId}-openingDate`}
            name='openingDate'
            type='date'
            max={today}
            value={openingDate}
            disabled={pending}
            onChange={(event) => setOpeningDate(event.target.value)}
            aria-invalid={errors.openingDate ? true : undefined}
            aria-describedby={errors.openingDate ? `${formId}-openingDate-blad` : undefined}
            className={TOUCH_TARGET}
          />
          {error('openingDate')}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-openingBalance`}>Gotówka w kasie tego dnia (zł)</FieldLabel>
          <Input
            id={`${formId}-openingBalance`}
            name='openingBalance'
            inputMode='decimal'
            autoComplete='off'
            value={openingBalance}
            disabled={pending}
            onChange={(event) => setOpeningBalance(event.target.value)}
            aria-invalid={errors.openingBalance ? true : undefined}
            aria-describedby={errors.openingBalance ? `${formId}-openingBalance-blad` : undefined}
            className={TOUCH_TARGET}
          />
          <FieldDescription>Może być 0, jeśli kasa startuje pusta.</FieldDescription>
          {error('openingBalance')}
        </Field>
      </FieldGroup>
      {formError ? (
        <p role='alert' className='text-destructive text-sm'>
          {formError}
        </p>
      ) : null}
      <div>
        <Button type='submit' className={TOUCH_TARGET} disabled={pending}>
          {pending ? <RiLoader4Line className='animate-spin' aria-hidden /> : null}
          {initial ? 'Zapisz stan początkowy' : 'Otwórz kasę'}
        </Button>
      </div>
    </form>
  );
}
