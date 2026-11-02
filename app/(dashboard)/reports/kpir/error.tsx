'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { RiErrorWarningLine, RiRefreshLine } from '@remixicon/react';

import { kpirMonthTitle, kpirPeriodFromParams } from '@/components/reports/kpir/kpir-model';
import { KpirToolbar } from '@/components/reports/kpir/kpir-toolbar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * Błąd KPiR w powłoce ekranu (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości): strona celowo rzuca przy niepełnym
 * środowisku KSeF albo proweniencji dokumentów, zamiast liczyć księgę
 * z dziurą. Klient dostaje zakładki (może przejść do Eksportu), ponowienie
 * i kontakt; operator — zgłoszenie w Sentry i runbook środowiska KSeF.
 *
 * Przełącznik miesiąca nad kartą (jak w „Raport wstrzymany”): błąd bywa
 * ograniczony do jednego miesiąca, a gdy to miesiąc bieżący (domyślne
 * wejście), inny miesiąc był osiągalny tylko z ręcznie wpisanego adresu.
 * Granica błędu Next czyści się sama tylko przy zmianie ścieżki, a KPiR
 * zmienia miesiąc w `?month=&year=` — więc inny adres (wybór miesiąca,
 * Wstecz, zakładka „KPiR”) sam wywołuje `reset()`; jeśli tamten miesiąc też
 * rzuca, granica łapie go od nowa.
 *
 * Odstępstwo od reguły „w KPiR tylko `useRouter`” (niezmiennik 12): ten ekran
 * nie wie inaczej, który miesiąc się nie wczytał ani kiedy adres się zmienił.
 * Reguła chroni atrapy testów strony i `KpirView` — ten plik nie jest w ich
 * drzewie (test: `kpir-blad.test.tsx`). Miesiąc liczy `kpirPeriodFromParams`
 * (te same reguły co `resolveKpirPeriod`, bez importu odczytu z bazy).
 */
export default function KpirError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const search = searchParams.toString();
  // Adres z chwili błędu — zmiana na inny zdejmuje błąd (komentarz wyżej).
  const [errorSearch] = useState(search);
  const today = todayInWarsaw();
  const { month, year, period } = kpirPeriodFromParams(
    { month: searchParams.get('month'), year: searchParams.get('year') },
    today,
  );

  useEffect(() => {
    if (search !== errorSearch) reset();
  }, [search, errorSearch, reset]);

  useEffect(() => {
    Sentry.captureException(error);
    if (process.env.NODE_ENV === 'development') {
      console.error(error);
    }
  }, [error]);

  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6">
      <h1 className="sr-only">Książka przychodów i rozchodów</h1>
      <KpirToolbar period={period} currentMonth={today.slice(0, 7)} monthTitle={kpirMonthTitle(month, year)} />
      <Card className="flex-1">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
              <RiErrorWarningLine aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Nie udało się wczytać KPiR</EmptyTitle>
            <EmptyDescription>Spróbuj ponownie. Jeśli błąd wraca, napisz do nas.</EmptyDescription>
            {error.digest ? <p className="text-muted-foreground text-xs">Kod błędu: {error.digest}</p> : null}
          </EmptyHeader>
          <EmptyContent className="flex-row flex-wrap justify-center gap-2">
            {/* Odświeżenie danych serwera, potem ponowny render segmentu (wzór Next.js dla błędów RSC). */}
            <Button
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
            <Button variant="outline" render={<a href={`mailto:${SUPPORT_EMAIL}?subject=KPiR`} />} nativeButton={false}>
              Napisz do nas
            </Button>
          </EmptyContent>
        </Empty>
      </Card>
    </div>
  );
}
