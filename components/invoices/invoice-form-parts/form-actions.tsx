import { Loader2 } from 'lucide-react';
import { RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import { RECURRING_NO_DRAFT_TEXT } from './constants';

/** Karta akcji od `lg` w trybie cyklicznym. */
export function RecurringActionsCard({
  busy,
  isSending,
  onSend,
}: {
  busy: boolean;
  isSending: boolean;
  onSend: () => void;
}) {
  return (
    // Ta sama karta co `InvoiceCreateActions`, bez „Zapisz szkic” (C2).
    <Card data-testid="akcje-formularza" className="h-max shadow-none max-lg:hidden">
      <CardContent className="space-y-4">
        <Button type="button" className="w-full" disabled={busy} onClick={onSend}>
          {isSending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiSendPlaneLine aria-hidden />}
          Wystaw i wyślij do KSeF
        </Button>
        <p className="text-muted-foreground text-xs">{RECURRING_NO_DRAFT_TEXT}</p>
      </CardContent>
    </Card>
  );
}

/** Pasek akcji przyklejony do dołu ekranu — tylko telefon i tablet. */
export function StickyFormActions({
  recurringMode,
  busy,
  isSaving,
  isSending,
  onSaveDraft,
  onSend,
}: {
  recurringMode: boolean;
  busy: boolean;
  isSaving: boolean;
  isSending: boolean;
  onSaveDraft: () => void;
  onSend: () => void;
}) {
  return (
    <div className="ff-sticky-actions pointer-events-none lg:hidden">
      {/* Na telefonie wysyłka jest szeroka i pierwsza (kciuk trafia w nią bez
          celowania), a „Zapisz” wąskie obok — układ z makiety. Od `sm`
          wracają dwa przyciski o naturalnej szerokości, dosunięte do prawej.
          Na telefonie „Zapisz” niesie tę samą akcję co „Szkic” w nagłówku;
          to nie jest dubel do usunięcia, tylko ten sam wybór w zasięgu kciuka
          i w zasięgu wzroku. */}
      {recurringMode ? (
        <p className="text-muted-foreground pointer-events-auto mx-auto mb-2 max-w-7xl text-xs sm:text-right">
          {RECURRING_NO_DRAFT_TEXT}
        </p>
      ) : null}
      <div className="pointer-events-auto mx-auto flex max-w-7xl gap-3 sm:justify-end">
        {recurringMode ? null : (
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={onSaveDraft}
            disabled={busy}
            className="order-2 flex-1 sm:order-1 sm:flex-none"
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <span className="sm:hidden">Zapisz</span>
            <span className="hidden sm:inline">Zapisz szkic</span>
          </Button>
        )}
        <Button
          type="button"
          size="lg"
          onClick={onSend}
          disabled={busy}
          className="order-1 flex-[2] sm:order-2 sm:flex-none"
        >
          {isSending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <span className="sm:hidden">Wyślij do KSeF</span>
          <span className="hidden sm:inline">Wystaw i wyślij do KSeF</span>
        </Button>
      </div>
    </div>
  );
}
