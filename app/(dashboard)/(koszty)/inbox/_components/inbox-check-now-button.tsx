'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { requestInboxCheckAction } from '@/app/actions/ksef-inbox';
import { Button } from '@/components/ui/button';

/** Takt rozsyłki idzie co minutę, a przebieg trwa chwilę: po tylu sekundach lista ma już nowe faktury. */
const REFRESH_AFTER_MS = 75_000;

/**
 * „Sprawdź teraz” przy kaflu „Ostatnie pobranie z KSeF”. Faktury pobiera worker,
 * więc po przyjęciu prośby lista odświeża się sama, bez kolejnego kliknięcia.
 */
export function InboxCheckNowButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const check = () => {
    startTransition(async () => {
      const result = await requestInboxCheckAction();
      if (result.status === 'error') {
        toast.error(result.message);
        return;
      }
      if (result.status === 'too_soon' || result.status === 'no_ksef') {
        toast.info(result.message);
        return;
      }
      toast.success(result.message);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), REFRESH_AFTER_MS);
    });
  };

  return (
    <Button type='button' variant='outline' size='sm' className='mt-2' disabled={pending} onClick={check}>
      {pending ? 'Sprawdzam…' : 'Sprawdź teraz'}
    </Button>
  );
}
