'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { updateCashMethodAction } from '@/app/actions/cash-method';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

/**
 * Metoda kasowa VAT firmy. Na każdej fakturze: P_16 = 1 w KSeF i wyrazy
 * „metoda kasowa” (art. 106e ust. 1 pkt 16).
 *
 * Wygląd: wiersz z przełącznikiem z Finory (`security-preferences-card.tsx`
 * — etykieta i opis po lewej, `Switch` po prawej).
 */
export function CashMethodForm({
  initialEnabled,
  canEdit,
}: {
  initialEnabled: boolean;
  /** Właściciel i administrator; pozostali widzą stan bez możliwości zmiany. */
  canEdit: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const result = await updateCashMethodAction(enabled);
      if (result.success) {
        toast.success(result.enabled ? 'Metoda kasowa włączona' : 'Metoda memoriałowa (bez metody kasowej)');
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <FieldGroup>
      <Field orientation="horizontal" className="items-center!">
        <FieldContent>
          <FieldLabel htmlFor="cash-method">Rozliczam VAT metodą kasową</FieldLabel>
          <FieldDescription>
            Dla małych podatników VAT, którzy wybrali metodę kasową (art. 21 ustawy o VAT). Każda faktura dostanie
            wtedy wymagane wyrazy „metoda kasowa”. Nie dotyczy firm zwolnionych z VAT.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="cash-method"
          checked={enabled}
          disabled={!canEdit || pending}
          onCheckedChange={(checked) => setEnabled(checked)}
        />
      </Field>
      {canEdit ? (
        <div>
          <Button type="button" variant="outline" onClick={save} disabled={pending}>
            {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
            Zapisz metodę rozliczania
          </Button>
        </div>
      ) : null}
    </FieldGroup>
  );
}
