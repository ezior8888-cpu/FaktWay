'use client';

import { useTransition } from 'react';
import { RiExternalLinkLine, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

import { openCustomerPortalAction } from '../actions';

interface Props {
  disabled?: boolean;
  /** Wersja zgody na BLIK pokazanej przy przycisku: trafia do audytu otwarcia portalu. */
  blikStatementVersion?: string | null;
}

/**
 * Przycisk otwierający Stripe Customer Portal w nowym tabie. Klient sam
 * zmienia plan i metodę płatności albo anuluje, my dostajemy webhook'a i synchronizujemy
 * lokalną subscription.
 */
export function PortalButton({ disabled, blikStatementVersion = null }: Props) {
  const [isPending, startTransition] = useTransition();

  const handle = () => {
    startTransition(async () => {
      try {
        await openCustomerPortalAction(blikStatementVersion);
      } catch (e) {
        const err = e as Error;
        if (err.message?.includes('NEXT_REDIRECT')) return;
        toast.error('Nie udało się otworzyć portalu. Spróbuj ponownie.');
      }
    });
  };

  return (
    <Button
      variant="outline"
      onClick={handle}
      disabled={disabled || isPending}
    >
      {isPending ? (
        <RiLoader4Line className="animate-spin" aria-hidden />
      ) : (
        <RiExternalLinkLine aria-hidden />
      )}
      Zarządzaj subskrypcją
    </Button>
  );
}
