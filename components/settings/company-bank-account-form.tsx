'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { updateCompanyBankAccountAction } from '@/app/actions/company-bank-account';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { normalizujRachunekFirmy, rachunekFirmyDoCzytania } from '@/lib/expenses/rachunek-firmy';

/**
 * Rachunek firmy (krok 3.4, część 2; `tenants.bank_account`, 00183): rachunek
 * zleceniodawcy w pliku przelewów z listy „Do zapłaty”. Walidacja w
 * przeglądarce tą samą funkcją co w akcji serwerowej. Wygląd jak
 * `BusinessStartForm` (wiersz Finory: opis po lewej, pole po prawej), jedno
 * `Field` w `FieldGroup` strony.
 */
export function CompanyBankAccountForm({
  initialAccount,
  canEdit,
}: {
  initialAccount: string | null;
  /** Właściciel i administrator; pozostali widzą numer bez możliwości zmiany. */
  canEdit: boolean;
}) {
  const [value, setValue] = useState(initialAccount ? rachunekFirmyDoCzytania(initialAccount) : '');
  const [saved, setSaved] = useState(initialAccount);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (raw: string, clear = false) => {
    if (!clear && raw.trim() === '' && saved) {
      setFieldError('Pole jest puste. Żeby usunąć rachunek, użyj „Wyczyść”.');
      return;
    }
    let numer: string | null;
    try {
      numer = normalizujRachunekFirmy(clear ? '' : raw);
    } catch (e) {
      setFieldError(e instanceof Error ? e.message : 'Nieprawidłowy numer rachunku.');
      return;
    }
    setFieldError(null);
    if (numer === saved) return;
    startTransition(async () => {
      const result = await updateCompanyBankAccountAction(numer).catch(() => ({
        success: false as const,
        error: 'Nie udało się zapisać rachunku firmy. Sprawdź połączenie i spróbuj ponownie.',
      }));
      if (result.success) {
        setSaved(result.rachunek);
        setValue(result.rachunek ? rachunekFirmyDoCzytania(result.rachunek) : '');
        toast.success(result.rachunek ? 'Rachunek firmy zapisany' : 'Rachunek firmy usunięty');
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel htmlFor="company-bank-account">Rachunek firmy</FieldLabel>
        <FieldDescription id="company-bank-account-help">
          Rachunek, z którego płacisz koszty. Plik przelewów z listy „Do zapłaty” w Wydatkach zleca z niego przelewy.
          Numer w formacie NRB: 26 cyfr, spacje i „PL” na początku można zostawić.
        </FieldDescription>
        {canEdit ? null : <FieldDescription>Zmienić to może właściciel albo administrator firmy.</FieldDescription>}
      </FieldContent>
      <div className="flex w-full flex-col gap-2 sm:w-80">
        <Input
          id="company-bank-account"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={!canEdit || pending}
          onChange={(e) => {
            setValue(e.target.value);
            setFieldError(null);
          }}
          className="font-mono max-lg:min-h-[44px]"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? 'company-bank-account-error company-bank-account-help' : 'company-bank-account-help'}
        />
        {fieldError ? (
          <p id="company-bank-account-error" role="alert" className="text-destructive text-xs">
            {fieldError}
          </p>
        ) : null}
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button type="button" onClick={() => submit(value)} disabled={pending} className="max-lg:min-h-[44px]">
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Zapisz
            </Button>
            {saved ? (
              <Button type="button" variant="ghost" onClick={() => submit('', true)} disabled={pending} className="max-lg:min-h-[44px]">
                Wyczyść
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Field>
  );
}
