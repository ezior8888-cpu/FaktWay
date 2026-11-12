'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { getDashboardPrefetchHrefs } from '@/lib/dashboard-nav-config';

const CONCURRENCY = 3;

function scheduleIdle(cb: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => cb(), { timeout: 2500 });
    return;
  }
  setTimeout(cb, 0);
}

/**
 * Prefetch RSC celów dolnego paska (`getDashboardPrefetchHrefs`) w czasie
 * bezczynności — nie blokuje kliknięć; krótka kolejka równoległości ogranicza
 * burst na słabszych urządzeniach. Resztę menu pobiera najechanie albo fokus
 * (plan skalowania 3000, sesja 10).
 */
export function PrefetchDashboardRoutes() {
  const router = useRouter();

  useEffect(() => {
    const hrefs = getDashboardPrefetchHrefs();
    let cancelled = false;
    let index = 0;
    let inFlight = 0;

    const pump = () => {
      if (cancelled) return;
      while (inFlight < CONCURRENCY && index < hrefs.length) {
        const href = hrefs[index]!;
        index += 1;
        inFlight += 1;
        void Promise.resolve(router.prefetch(href)).finally(() => {
          inFlight -= 1;
          pump();
        });
      }
    };

    scheduleIdle(pump);

    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
