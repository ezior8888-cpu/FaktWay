'use client';

import { useEffect, useState } from 'react';
import { RiAlertLine, RiCloseLine, RiCloudOffLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import type { KsefHealthPublic } from '@/lib/ksef/health-status';

/** Widoczna karta odpytuje co 120 s plus losowo do 30 s. */
const POLL_INTERVAL_MS = 120_000;
const POLL_JITTER_MS = 30_000;
/** Powrót do karty odpytuje od razu, ale najwyżej raz na tyle. */
const RETURN_POLL_MIN_GAP_MS = 60_000;

interface Props {
  initial: KsefHealthPublic | null;
}

/**
 * Banner gdy KSeF jest `degraded` lub `down`. Polluje `/api/ksef/health`
 * tylko z widocznej karty — odpada koszt WebSocket setup'u (Supabase
 * Realtime, dedykowany pub/sub) dla zdarzenia, które realnie zmienia się max
 * kilka razy w tygodniu. Baner siedzi w layoucie panelu, więc odpytuje każda
 * otwarta karta (plan skalowania, sesja 1):
 *  - karta w tle nie ma zegara wcale;
 *  - widoczna co 120–150 s; rozrzut, żeby karty otwarte razem (np. po
 *    wdrożeniu) nie pytały w tej samej sekundzie. Także przy `operational`,
 *    bo inaczej awaria nie miałaby jak się pojawić;
 *  - po powrocie do karty od razu, żeby baner awarii się nie spóźnił, ale
 *    najwyżej raz na 60 s — przełączanie kart robi serię zdarzeń.
 *
 * Dismiss: użytkownik może schować banner — flaga w `sessionStorage`, więc
 * po odświeżeniu lub eskalacji do `down` banner wraca.
 */
export function KsefHealthBannerClient({ initial }: Props) {
  const [snapshot, setSnapshot] = useState<KsefHealthPublic | null>(initial);
  // Lazy init: czytamy sessionStorage raz w pierwszym renderze (SSR-safe
  // przez `typeof window` guard), zamiast useEffect+setState — ESLint
  // `react-hooks/set-state-in-effect` flaguje cascading renders inaczej.
  const [dismissedLevel, setDismissedLevel] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return window.sessionStorage.getItem('ff:ksef-banner-dismissed');
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let timer: number | undefined;
    let inFlight: AbortController | null = null;
    let stopped = false;
    // Snapshot z renderu serwera jest świeży — liczy się jak odpytanie. Czas
    // z zegara monotonicznego: cofnięcie zegara systemowego nie odsunie terminu.
    let lastPollAt = performance.now();

    const poll = async () => {
      lastPollAt = performance.now();
      // Zawieszona poprzednia odpowiedź nie nadpisze nowszej.
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      try {
        // Bez `no-store`: trasa pozwala trzymać odpowiedź 15 s, więc karty
        // jednej przeglądarki odpytujące blisko siebie dzielą odpowiedź.
        const res = await fetch('/api/ksef/health', { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as KsefHealthPublic & { stale?: boolean };
        if (data.stale) return;
        setSnapshot(data);
      } catch {
        // Sieć padła? UI nie ma jak wiedzieć — zostawmy ostatni stan.
      }
    };

    // Jeden zegar naraz, termin liczony od ostatniego odpytania: krótkie
    // wyjście z karty go nie odsuwa. Ukryta karta (albo odmontowany baner)
    // nie dostaje zegara. Zegar nie czeka na odpowiedź, więc zawieszone
    // żądanie nie zatrzymuje odpytywania.
    const schedule = () => {
      window.clearTimeout(timer);
      if (stopped || document.visibilityState !== 'visible') return;
      const dueAt = lastPollAt + POLL_INTERVAL_MS + Math.random() * POLL_JITTER_MS;
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void poll();
        schedule();
      }, Math.max(0, dueAt - performance.now()));
    };

    const onVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        performance.now() - lastPollAt >= RETURN_POLL_MIN_GAP_MS
      ) {
        void poll();
      }
      schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  if (!snapshot || snapshot.level === 'operational') return null;
  if (dismissedLevel === snapshot.level) return null;

  const isDown = snapshot.level === 'down';
  const Icon = isDown ? RiCloudOffLine : RiAlertLine;

  const title = isDown
    ? snapshot.isMfOutage
      ? 'Ministerstwo Finansów zgłasza awarię KSeF'
      : 'KSeF jest niedostępny'
    : 'KSeF działa wolno';

  const description = isDown
    ? 'Nowe faktury pozostaną szkicami. Automatyczny Offline24 jest wstrzymany; po przywróceniu KSeF sprawdź stan dokumentu przed wysyłką.'
    : `Pingi do KSeF trwają ${snapshot.responseTimeMs ?? '?'}ms. Wysyłka faktur może być wolniejsza, ale działa.`;

  const handleDismiss = () => {
    setDismissedLevel(snapshot.level);
    try {
      window.sessionStorage.setItem('ff:ksef-banner-dismissed', snapshot.level);
    } catch {
      // Nawet bez storage user nie zobaczy banera do refresh — OK.
    }
  };

  return (
    <Alert
      role="status"
      aria-live="polite"
      variant={isDown ? 'destructive' : 'default'}
      className={cn(
        'pr-10',
        !isDown &&
          'border-[var(--ff-warn-border)] bg-[var(--ff-warn-tint)] text-[var(--ff-warn-text)]',
      )}
    >
      <Icon aria-hidden />
      <AlertTitle className="font-semibold">{title}</AlertTitle>
      <AlertDescription className={cn(!isDown && 'text-[var(--ff-warn-text)]')}>
        {description}
      </AlertDescription>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Schowaj baner"
        className="hover:bg-foreground/10 absolute top-1.5 right-1.5 shrink-0 p-1 transition-colors"
      >
        <RiCloseLine className="text-muted-foreground size-4" aria-hidden />
      </button>
    </Alert>
  );
}
