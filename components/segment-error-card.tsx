'use client';

import { useEffect, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { RiErrorWarningLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Karta błędu segmentu, wspólna dla `app/(dashboard)/error.tsx` (w powłoce
 * panelu) i `app/error.tsx` (bez powłoki, także na logowaniu i stronach
 * marketingowych). Nie może więc zależeć od kontekstu panelu: paska bocznego,
 * sesji ani firmy.
 */
export function SegmentErrorCard({
  error,
  reset,
  heading: Heading = 'h2',
  extraAction,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** `h1`, gdy karta jest jedyną treścią strony. */
  heading?: 'h1' | 'h2';
  /** Wyjście obok ponowienia, gdy wokół karty nie ma nawigacji. */
  extraAction?: ReactNode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    Sentry.captureException(error);
    if (process.env.NODE_ENV === 'development') {
      console.error(error);
    }
  }, [error]);

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardContent className="space-y-6 py-12 text-center">
        <div className="bg-destructive/10 text-destructive inline-flex size-14 items-center justify-center">
          <RiErrorWarningLine className="size-7" aria-hidden />
        </div>
        <div className="space-y-2">
          <Heading className="text-xl font-semibold tracking-tight">Coś poszło nie tak</Heading>
          <p className="text-muted-foreground mx-auto max-w-sm text-sm">
            Wystąpił nieoczekiwany błąd. Możesz spróbować ponownie.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {/* Samo `reset()` renderuje ten sam ładunek RSC, więc błąd Server
              Componentu wraca od razu. `router.refresh()` pobiera stronę od
              nowa (razem z layoutami), a `reset()` w tym samym przejściu
              renderuje segment dopiero z nowymi danymi — wzór jak
              w `reports/kpir/error.tsx`. Gdy przy ponowieniu z panelu padnie
              jego layout (ta sama awaria bazy), błąd trafia do `app/error.tsx`,
              jak po F5. Wyłączony do odpowiedzi serwera: kolejne kliknięcia
              nie wysyłają następnych odświeżeń. Testy:
              `panel-blad-ponow.test.tsx`, `blad-segment-glowny.test.tsx`. */}
          <Button
            size="lg"
            disabled={isPending}
            onClick={() =>
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
          >
            <RiRefreshLine aria-hidden />
            Spróbuj ponownie
          </Button>
          {extraAction}
        </div>
      </CardContent>
    </Card>
  );
}
