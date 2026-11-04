'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { updateVatExemptionAction } from '@/app/actions/vat-exemption';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { VAT_EXEMPTION_PRESETS } from '@/lib/invoices/vat-exemption';

const CUSTOM = 'inna';

const BASIS_OPTIONS: { label: string; value: string }[] = [
  ...VAT_EXEMPTION_PRESETS.map((p) => ({ label: p.label, value: p.value })),
  { label: 'Inna podstawa (np. zwolnienie przedmiotowe z art. 43)', value: CUSTOM },
];

/**
 * Zwolnienie z VAT firmy. Podstawa trafia do każdej faktury ze stawką „zw”
 * jako P_19A w FA(3). Firma zwolniona dostaje „zw” jako domyślną stawkę.
 *
 * Wygląd: przełącznik jak w Finorze (`security-preferences-card.tsx`), wybór
 * podstawy jak `Select` z `general/index.tsx` — na całą szerokość
 * (`flex-col!`, jak pola w `change-password-card.tsx`), bo nazwy podstaw
 * prawnych są długie.
 */
export function VatExemptionForm({
  initialBasis,
  canEdit,
}: {
  initialBasis: string | null;
  /** Właściciel i administrator; pozostali widzą stan bez możliwości zmiany. */
  canEdit: boolean;
}) {
  const presetMatch = VAT_EXEMPTION_PRESETS.find((p) => p.value === initialBasis)?.value;
  const [exempt, setExempt] = useState(initialBasis !== null);
  const [choice, setChoice] = useState<string>(presetMatch ?? (initialBasis ? CUSTOM : VAT_EXEMPTION_PRESETS[0].value));
  const [custom, setCustom] = useState(presetMatch ? '' : initialBasis ?? '');
  const [pending, startTransition] = useTransition();

  const save = () => {
    const basis = !exempt ? null : choice === CUSTOM ? custom : choice;
    startTransition(async () => {
      const result = await updateVatExemptionAction(basis);
      if (result.success) {
        toast.success(result.basis ? 'Zwolnienie z VAT zapisane' : 'Firma jest czynnym podatnikiem VAT');
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <FieldGroup>
      <Field orientation="horizontal" className="items-center!">
        <FieldContent>
          <FieldLabel htmlFor="vat-exempt">Moja firma jest zwolniona z VAT</FieldLabel>
          <FieldDescription>
            Zwolnienie podmiotowe albo przedmiotowe. Faktury dostaną stawkę „zw” i podstawę zwolnienia.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="vat-exempt"
          checked={exempt}
          disabled={!canEdit || pending}
          onCheckedChange={(checked) => setExempt(checked)}
        />
      </Field>

      {exempt ? (
        <Field orientation="responsive" className="flex-col!">
          <FieldContent>
            <FieldLabel htmlFor="vat-exemption-basis">Podstawa prawna zwolnienia</FieldLabel>
            <FieldDescription>
              Ta podstawa trafi na każdą fakturę ze stawką „zw” (pole P_19A w KSeF). Nowe pozycje faktury dostaną
              stawkę „zw” domyślnie.
            </FieldDescription>
          </FieldContent>
          <div className="flex w-full! flex-col gap-3">
            <Select
              items={BASIS_OPTIONS}
              value={choice}
              disabled={!canEdit || pending}
              onValueChange={(value) => value && setChoice(value)}
            >
              <SelectTrigger id="vat-exemption-basis" className="w-full">
                <SelectValue placeholder="Podstawa prawna zwolnienia" />
              </SelectTrigger>
              <SelectContent className="p-1" alignItemWithTrigger={false}>
                <SelectGroup>
                  {BASIS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {choice === CUSTOM ? (
              <Input
                value={custom}
                disabled={!canEdit || pending}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="np. art. 43 ust. 1 pkt 29 lit. c ustawy o VAT"
                maxLength={256}
                aria-label="Inna podstawa prawna zwolnienia"
              />
            ) : null}
          </div>
        </Field>
      ) : null}

      {canEdit ? (
        <div>
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
            Zapisz
          </Button>
        </div>
      ) : (
        <FieldDescription>Zmienić to może właściciel albo administrator firmy.</FieldDescription>
      )}
    </FieldGroup>
  );
}
