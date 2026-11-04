'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { updateBusinessStartAction } from '@/app/actions/business-start';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BUSINESS_START_MIN, businessStartSchema } from '@/lib/invoices/business-start';

/**
 * Data rozpoczęcia działalności — do limitu zwolnienia z VAT na Pulpicie.
 * Walidacja w przeglądarce tym samym schematem co w akcji serwerowej.
 *
 * Wygląd: wiersz Finory z `general/index.tsx` (etykieta i opis po lewej,
 * pole `sm:w-64` po prawej). Komponent oddaje jedno `Field`, więc stoi
 * w `FieldGroup` strony.
 */
export function BusinessStartForm({
  initialStartedOn,
  canEdit,
  today,
}: {
  initialStartedOn: string | null;
  /** Właściciel i administrator; pozostali widzą stan bez możliwości zmiany. */
  canEdit: boolean;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) — górna granica pola. */
  today: string;
}) {
  const [value, setValue] = useState(initialStartedOn ?? '');
  const [saved, setSaved] = useState(initialStartedOn);
  const [fieldError, setFieldError] = useState<string | null>(null);
  // Niepełna albo niemożliwa data w <input type="date"> daje value === '' —
  // bez tej flagi wyglądałaby jak „puste pole” i skasowała zapisaną datę.
  const [badInput, setBadInput] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = (raw: string, clear = false) => {
    if (!clear) {
      if (badInput) {
        setFieldError('Podaj datę w formacie DD.MM.RRRR.');
        return;
      }
      if (raw.trim() === '' && saved) {
        setFieldError('Pole jest puste. Żeby usunąć datę, użyj „Wyczyść”.');
        return;
      }
    }
    const parsed = businessStartSchema(today).safeParse(raw);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Nieprawidłowa data.');
      return;
    }
    setFieldError(null);
    // Bez zmiany nie wołamy akcji (ani wpisu audytu „null → null”).
    if (parsed.data === saved) return;
    startTransition(async () => {
      const result = await updateBusinessStartAction(parsed.data);
      if (result.success) {
        setSaved(result.startedOn);
        setValue(result.startedOn ?? '');
        setBadInput(false);
        toast.success(result.startedOn ? 'Data rozpoczęcia działalności zapisana' : 'Data rozpoczęcia działalności wyczyszczona');
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel htmlFor="business-started-on">Data rozpoczęcia działalności</FieldLabel>
        <FieldDescription id="business-started-on-help">
          Potrzebna do limitu zwolnienia z VAT: firma, która rozpoczęła działalność w trakcie roku, ma limit
          proporcjonalny do dni działalności. Puste pole — data nieznana, a Pulpit pokaże samą sprzedaż.
        </FieldDescription>
        {canEdit ? null : (
          <FieldDescription>Zmienić to może właściciel albo administrator firmy.</FieldDescription>
        )}
      </FieldContent>
      <div className="flex w-full flex-col gap-2 sm:w-64">
        <Input
          id="business-started-on"
          type="date"
          min={BUSINESS_START_MIN}
          max={today}
          value={value}
          disabled={!canEdit || pending}
          onChange={(e) => {
            setValue(e.target.value);
            setBadInput(e.target.validity.badInput);
            setFieldError(null);
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? 'business-started-on-error business-started-on-help' : 'business-started-on-help'}
        />
        {fieldError ? (
          <p id="business-started-on-error" role="alert" className="text-destructive text-xs">
            {fieldError}
          </p>
        ) : null}
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button type="button" onClick={() => submit(value)} disabled={pending}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Zapisz
            </Button>
            {saved ? (
              <Button type="button" variant="ghost" onClick={() => submit('', true)} disabled={pending}>
                Wyczyść
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Field>
  );
}
