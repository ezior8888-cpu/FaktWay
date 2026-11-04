import { RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Prawa kolumna formularza (Finora: `invoice-create-actions.tsx`):
 * „Send Invoice” → „Wystaw i wyślij do KSeF” (główny), „Save” → „Zapisz szkic”.
 *
 * „Podgląd” z planu (P5) NIE wchodzi: formularz nie ma dziś podglądu
 * dokumentu przed zapisem, a nowej funkcji w etapie oprawy nie wymyślamy.
 *
 * Telefon: karta jest schowana (`max-lg:hidden`) — tam te same akcje niesie
 * przyklejony pasek `.ff-sticky-actions` w zasięgu kciuka. Dwa komplety
 * przycisków na jednym ekranie to dubel dla czytnika ekranu i dla e2e
 * (`getByRole('button', { name: 'Zapisz szkic' })` w trybie ścisłym).
 *
 * Akcje przychodzą z formularza bez zmian — ta sama funkcja co w pasku,
 * z tym samym zabezpieczeniem przed podwójnym kliknięciem.
 */
export function InvoiceCreateActions({
  onSend,
  onSave,
  sending,
  saving,
  disabled,
  sendLabel = 'Wystaw i wyślij do KSeF',
  saveLabel = 'Zapisz szkic',
  className,
}: {
  onSend: () => void;
  onSave: () => void;
  sending: boolean;
  saving: boolean;
  disabled: boolean;
  sendLabel?: string;
  saveLabel?: string;
  className?: string;
}) {
  return (
    <Card
      data-testid="akcje-formularza"
      className={cn('h-max shadow-none max-lg:hidden', className)}
    >
      <CardContent className="space-y-4">
        <Button type="button" className="w-full" disabled={disabled} onClick={onSend}>
          {sending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiSendPlaneLine aria-hidden />}
          {sendLabel}
        </Button>
        <Button type="button" variant="outline" className="w-full" disabled={disabled} onClick={onSave}>
          {saving ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          {saveLabel}
        </Button>
      </CardContent>
    </Card>
  );
}
