'use client';

import { useState, useTransition } from 'react';
import { RiFileCopyLine, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { createCalendarFeedAction, deleteCalendarFeedAction } from '@/components/settings/calendar-feed-actions';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Adres kalendarza (krok 7.3 planu kompletnej aplikacji): terminy płatności,
 * faktur cyklicznych, a przy włączonej księgowości także podatków i ZUS,
 * w Google Kalendarzu, Apple albo Outlooku. Adres z tokenem widać raz, zaraz po
 * utworzeniu (w bazie jest tylko skrót); wymiana unieważnia poprzedni adres.
 * Wygląd jak pozostałe wiersze „Firmy”: etykieta i opis po lewej, akcje pod nimi.
 */
export function CalendarFeedCard({ initialActive }: { initialActive: boolean }) {
  const [active, setActive] = useState(initialActive);
  const [url, setUrl] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const create = () => {
    setStepUp(null);
    startTransition(async () => {
      const result = await createCalendarFeedAction();
      if (result.success) {
        setActive(true);
        setUrl(result.url);
        toast.success('Adres kalendarza gotowy');
      } else if (result.mfaStepUp) {
        setStepUp(result.error);
      } else {
        toast.error(result.error);
      }
    });
  };

  const remove = () => {
    startTransition(async () => {
      const result = await deleteCalendarFeedAction();
      if (result.success) {
        setActive(false);
        setUrl(null);
        toast.success('Adres kalendarza usunięty, aplikacje przestaną go odświeżać');
      } else {
        toast.error(result.error);
      }
    });
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Skopiowano adres');
    } catch {
      toast.error('Nie udało się skopiować. Zaznacz adres i skopiuj ręcznie.');
    }
  };

  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Adres kalendarza</FieldLabel>
          <FieldDescription>
            Terminy płatności faktur, faktury cykliczne oraz, gdy masz włączoną księgowość, terminy podatków i ZUS w
            Twoim kalendarzu (Google, Apple, Outlook). Kto zna adres, widzi numery faktur, kwoty i nazwy nabywców,
            więc nie wysyłaj go dalej. Wygenerowanie nowego adresu wyłącza poprzedni.
          </FieldDescription>
        </FieldContent>
      </Field>

      {url ? (
        <div className="flex flex-col gap-2">
          <Input readOnly value={url} aria-label="Adres kalendarza" onFocus={(e) => e.currentTarget.select()} />
          <p className="text-muted-foreground text-xs">
            Adres widać tylko teraz. Wklej go w kalendarzu jako „dodaj kalendarz z adresu URL”.
          </p>
          <div>
            <Button type="button" variant="outline" onClick={copy}>
              <RiFileCopyLine aria-hidden />
              Kopiuj adres
            </Button>
          </div>
        </div>
      ) : null}

      {stepUp ? (
        <MfaStepUpNotice returnTo="/settings">{stepUp} Po potwierdzeniu wrócisz tutaj.</MfaStepUpNotice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={create} disabled={pending}>
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          {active ? 'Wygeneruj nowy adres' : 'Adres kalendarza'}
        </Button>
        {active ? (
          <Button type="button" variant="ghost" onClick={remove} disabled={pending}>
            Usuń adres
          </Button>
        ) : null}
      </div>
    </FieldGroup>
  );
}
