'use client';

import { useLayoutEffect } from 'react';

import { SegmentErrorCard } from '@/components/segment-error-card';
import { buttonVariants } from '@/components/ui/button';
import { applyTheme, readStoredTheme } from '@/lib/theme/theme';

/**
 * Błąd poniżej głównego layoutu, na każdej grupie tras. Przede wszystkim awaria
 * `app/(dashboard)/layout.tsx`, której nie obejmuje `(dashboard)/error.tsx`:
 * ta sama karta i to samo ponowienie co w panelu, z motywem i czcionkami
 * głównego layoutu (decyzja Bartosza z 03.11). `global-error.tsx` obsługuje
 * już tylko awarię samego głównego layoutu.
 *
 * `ff-dashboard` daje skalę i tokeny panelu, jak w `auth-split-layout`, bo
 * powłoki panelu tu nie ma. Z tego samego powodu „Strona główna”: wokół karty
 * nie ma nawigacji, a przy trwałym błędzie samo ponowienie nigdzie nie
 * prowadzi. Adres publiczny, bo stronę widzi też niezalogowany (zalogowanego
 * proxy kieruje z `/` do panelu). Zwykły `<a>`: gdy padła sama strona główna,
 * `<Link>` do tego samego adresu nie zdjąłby błędu z granicy (robi to dopiero
 * zmiana ścieżki).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Po awarii przy pełnym wczytaniu (HTTP 500) Next składa dokument
  // w przeglądarce, a React nie wykonuje wstawionego przez siebie
  // `THEME_BOOT_SCRIPT`. Przed malowaniem, żeby ciemny motyw nie mignął jasną kartą.
  useLayoutEffect(() => {
    try {
      applyTheme(readStoredTheme());
    } catch {
      // Zablokowany localStorage: motyw domyślny, jak w `THEME_BOOT_SCRIPT`.
    }
  }, []);

  return (
    <main className="ff-dashboard flex min-h-dvh items-center justify-center p-6 text-foreground">
      <SegmentErrorCard
        error={error}
        reset={reset}
        heading="h1"
        extraAction={
          // eslint-disable-next-line @next/next/no-html-link-for-pages -- komentarz wyżej: `<Link>` nie zdjąłby błędu
          <a href="/" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            Strona główna
          </a>
        }
      />
    </main>
  );
}
