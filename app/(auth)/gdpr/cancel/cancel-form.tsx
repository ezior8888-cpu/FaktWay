'use client';

// Plan Finora P15 (E10b): prymitywy Finory (`Button`, `Alert`). Logika bez
// zmian: `useActionState(cancelGdprDeletionAction)`.

import { useActionState, useEffect } from 'react';

import { AuthMessage } from '@/components/auth/finora/auth-message';
import { Button } from '@/components/ui/button';

import { cancelGdprDeletionAction, type GdprCancelState } from './actions';

export function GdprCancelForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<GdprCancelState, FormData>(cancelGdprDeletionAction, { outcome: 'idle' });
  useEffect(() => {
    if (state.outcome === 'canceled') window.history.replaceState(null, '', '/gdpr/cancel');
  }, [state.outcome]);

  if (state.outcome === 'canceled') {
    return <AuthMessage tone="success">Żądanie usunięcia konta zostało anulowane. Twoje konto pozostaje aktywne.</AuthMessage>;
  }
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <p className="text-muted-foreground">
        Samo otwarcie linku nie zmienia Twojej decyzji. Użyj przycisku,
        aby anulować zaplanowane usunięcie konta.
      </p>
      {state.outcome === 'invalid' && <AuthMessage tone="error">Link jest nieprawidłowy, został już użyty lub usuwanie konta już się rozpoczęło.</AuthMessage>}
      {state.outcome === 'failed' && <AuthMessage tone="error">Nie udało się potwierdzić anulowania. Spróbuj ponownie.</AuthMessage>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Potwierdzanie...' : 'Zachowaj moje konto'}
      </Button>
    </form>
  );
}
