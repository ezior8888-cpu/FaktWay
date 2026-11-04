'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { updateCompanyProfileAction } from '@/app/actions/company-profile';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Edycja nazwy i adresu siedziby firmy (F-008). Dane trafiają na każdą
 * KOLEJNĄ fakturę; wystawione faktury mają własną kopię i się nie zmieniają.
 *
 * Wygląd: pola jak w `change-password-card.tsx` Finory (etykieta nad polem
 * na całą szerokość, przycisk pod spodem).
 */
export function CompanyProfileForm({
  initial,
}: {
  initial: { name: string; addressLine1: string; addressLine2: string };
}) {
  const [name, setName] = useState(initial.name);
  const [addressLine1, setAddressLine1] = useState(initial.addressLine1);
  const [addressLine2, setAddressLine2] = useState(initial.addressLine2);
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const result = await updateCompanyProfileAction({ name, addressLine1, addressLine2 });
      if (result.success) {
        toast.success('Dane firmy zapisane — trafią na kolejne faktury');
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <FieldGroup>
      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="company-name">Nazwa firmy</FieldLabel>
        </FieldContent>
        <div className="w-full!">
          <Input id="company-name" value={name} maxLength={512} onChange={(e) => setName(e.target.value)} />
        </div>
      </Field>
      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="company-address-1">Ulica i numer</FieldLabel>
        </FieldContent>
        <div className="w-full!">
          <Input
            id="company-address-1"
            value={addressLine1}
            maxLength={512}
            onChange={(e) => setAddressLine1(e.target.value)}
          />
        </div>
      </Field>
      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="company-address-2">Kod pocztowy i miejscowość</FieldLabel>
          <FieldDescription>
            Zmiana dotyczy kolejnych faktur. Wystawione faktury zachowują dane z dnia wystawienia. NIP nie podlega
            zmianie.
          </FieldDescription>
        </FieldContent>
        <div className="w-full!">
          <Input
            id="company-address-2"
            value={addressLine2}
            maxLength={512}
            placeholder="00-001 Warszawa"
            onChange={(e) => setAddressLine2(e.target.value)}
          />
        </div>
      </Field>
      <div>
        <Button onClick={save} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Zapisz dane firmy
        </Button>
      </div>
    </FieldGroup>
  );
}
