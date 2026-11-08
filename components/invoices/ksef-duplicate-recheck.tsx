'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import type { DuplicateRecheckView } from '@/lib/ksef/duplicate-recheck';

import { recheckKsefDuplicateAction } from './actions-detail';

interface Props {
  invoiceId: string;
  view: DuplicateRecheckView;
}

const T = DUPLICATE_DECISION_TEXTS.RECHECK;

/** Zapas po końcu cooldownu: serwer liczy go zegarem aplikacji i bazy, więc odświeżamy tuż po, nie tuż przed. */
const COOLDOWN_REFRESH_SLACK_MS = 1_000;

/**
 * „Sprawdź ponownie” na karcie faktury w `KSEF_DUPLICATE_RECONCILE`, gdy brakuje danych oryginału
 * (D-A4-1b-3 PR D). Komponent niczego nie liczy: widok (powód, rola, cooldown) przychodzi z serwera
 * (`duplicateRecheckView`), a akcja `recheckKsefDuplicateAction` sprawdza to samo od nowa.
 * Po akcji toast (zdanie z serwera, także przy odmowie) i `router.refresh()` — stan mógł się zmienić.
 *
 * Teksty: `DUPLICATE_DECISION_TEXTS.RECHECK` (lista prawnika). Przycisk widzi właściciel/administrator;
 * członek firmy dostaje dane tylko do odczytu i prośbę o właściciela.
 *
 * Cooldown: przycisk jest nieaktywny wg widoku z serwera, a widok sam się nie przelicza (Realtime odświeża kartę
 * tylko po zmianie wiersza faktury). Dlatego po `view.cooldownMsLeft` (czas WZGLĘDNY z serwera, więc rozjazd zegara
 * przeglądarki nic nie psuje) karta woła `router.refresh()` i dostaje widok z aktywnym przyciskiem.
 */
export function KsefDuplicateRecheck({ invoiceId, view }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const nr = view.invoiceNumber ?? '(bez numeru)';
  const refusal = view.refusal;
  // Przycisk jest tam, gdzie klient może go kiedyś użyć: aktywny albo (cooldown) chwilowo nieaktywny.
  const showButton = refusal === null || refusal.code === 'cooldown';
  const cooldownMsLeft = view.cooldownMsLeft;

  useEffect(() => {
    if (cooldownMsLeft === null) return;
    const timer = setTimeout(() => router.refresh(), cooldownMsLeft + COOLDOWN_REFRESH_SLACK_MS);
    return () => clearTimeout(timer);
    // `view` w zależnościach: każdy świeży widok z serwera zaczyna odliczanie od nowa.
  }, [view, cooldownMsLeft, router]);

  function run() {
    startTransition(async () => {
      const result = await recheckKsefDuplicateAction(invoiceId);
      if (result.success) toast.success(result.message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="mt-3 space-y-2 text-sm text-amber-900 dark:text-amber-100" data-testid="sprawdz-ponownie">
      <p>{view.reason === 'env-mismatch' ? T.ENV_MISMATCH : T.INTRO(nr, view.originalKsefNumber, view.assignedDay)}</p>
      {view.grantInvoiceRead && <p>{T.HINT_403}</p>}
      {/* Obietnica crona (I5) tylko tam, gdzie cron naprawdę sprawdza: blokada SQL decyzji nie patrzy na środowisko, więc
          powód decyzyjny z innego środowiska to I5D i nikt go sam nie ponowi. ENV_MISMATCH mówi już, co zrobić. */}
      {refusal === null && view.reason !== 'env-mismatch' && <p>{T.WHAT_NEXT}</p>}
      {refusal && <p>{refusal.message}</p>}
      {showButton && (
        <Button type="button" size="sm" disabled={pending || refusal !== null} onClick={run}>
          {pending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          {T.BUTTON}
        </Button>
      )}
      {!refusal?.message.includes(T.NO_REISSUE) && <p className="font-medium">{T.NO_REISSUE}</p>}
    </div>
  );
}
