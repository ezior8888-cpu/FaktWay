'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { updateTaxOfficeAction } from '@/app/actions/tax-office';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TAX_OFFICES, taxOfficeName } from '@/lib/exports/tax-offices';

const LIST_ID = 'tax-office-options';

function label(code: string): string {
  const name = taxOfficeName(code);
  return name ? `${code} — ${name}` : code;
}

/**
 * Urząd skarbowy firmy — trafia do nagłówka plików JPK (KodUrzedu).
 * Wybór z oficjalnej listy MF: wpisz miasto albo kod, podpowiedzi zawężają.
 */
export function TaxOfficeForm({ initialCode }: { initialCode: string | null }) {
  const [value, setValue] = useState(initialCode ? label(initialCode) : '');
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const result = await updateTaxOfficeAction(value);
      if (result.success) {
        setValue(result.code ? label(result.code) : '');
        toast.success(result.code ? 'Urząd skarbowy zapisany' : 'Urząd skarbowy usunięty');
      } else {
        toast.error(result.error);
      }
    });
  };

  // Wygląd: pole jak w `change-password-card.tsx` Finory (etykieta nad polem
  // na całą szerokość), przycisk pod spodem.
  return (
    <FieldGroup>
      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="tax-office">Urząd skarbowy firmy</FieldLabel>
          <FieldDescription>
            Urząd, do którego firma składa JPK — ten sam, w którym rozlicza VAT. Bez niego eksport plików JPK
            nie poda urzędu. Nie wiesz, który? Sprawdź na podatki.gov.pl albo zapytaj księgową.
          </FieldDescription>
        </FieldContent>
        <div className="w-full!">
          <Input
            id="tax-office"
            list={LIST_ID}
            value={value}
            disabled={pending}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Wpisz miasto albo kod, np. Kraków lub 1213"
            autoComplete="off"
          />
          <datalist id={LIST_ID}>
            {TAX_OFFICES.map(([code, name]) => (
              <option key={code} value={`${code} — ${name}`} />
            ))}
          </datalist>
        </div>
      </Field>
      <div>
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Zapisz
        </Button>
      </div>
    </FieldGroup>
  );
}
