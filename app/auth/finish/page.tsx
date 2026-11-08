'use client';

// Plan Finora P15 (E10b): ekran przejściowy (sekunda „Sprawdzam link…”, albo
// błąd starego linku) na karcie Finory, bez animowanego tła: strona żyje
// chwilę, a tło z kanwą to drugi efekt obok czyszczenia adresu. Logika bez
// zmian (`finishSignInFromFragment`).

import { useEffect, useRef, useState } from 'react';

import { FaktWayLogo } from '@/components/brand/faktway-logo';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { finishSignInFromFragment, type FinishSignInResult } from '@/lib/auth/finish-sign-in';
import { cn } from '@/lib/utils';

/**
 * Czyści historyczne linki z tokenami w kotwicy bez zmiany bieżącej sesji.
 * Nowe logowania i reset hasła kończą się przez PKCE w /auth/callback.
 */
export default function FinishPage() {
  const [blad, setBlad] = useState<string | null>(null);
  const completion = useRef<Promise<FinishSignInResult> | null>(null);

  useEffect(() => {
    let active = true;
    // StrictMode replays the effect. Reuse the result after URL cleanup.
    if (!completion.current) {
      completion.current = finishSignInFromFragment({
        fragment: window.location.hash,
        clearFragment: () => window.history.replaceState(null, '', window.location.pathname),
      });
    }
    void completion.current.then((result) => {
      if (!active) return;
      setBlad(result.error === 'legacy_link'
        ? 'Ten link logowania nie jest już obsługiwany. Zaloguj się standardowo lub poproś o nowy link do zmiany hasła.'
        : 'Nie udało się potwierdzić linku. Zaloguj się lub poproś o nowy link do zmiany hasła.');
    }).catch(() => {
      if (active) setBlad('Nie udało się dokończyć logowania. Spróbuj ponownie.');
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="ff-dashboard flex min-h-dvh items-center justify-center p-6 text-foreground">
      <Card className="w-full max-w-lg gap-6 py-8">
        <CardHeader className="gap-6 px-8">
          {/* Logo jak w `AuthLogo`: wbudowany SVG, bez `next/image`. */}
          <FaktWayLogo className="h-8 w-fit" />
          {blad ? (
            <CardTitle className="text-2xl font-semibold">
              <h1>Nie udało się dokończyć logowania</h1>
            </CardTitle>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-8">
          {blad ? (
            <>
              <p className="text-muted-foreground">{blad}</p>
              <a href="/login" className={cn(buttonVariants(), 'w-full')}>
                Wróć do logowania
              </a>
              <a href="/forgot-password" className={cn(buttonVariants({ variant: 'ghost' }), 'w-full')}>
                Poproś o nowy link do zmiany hasła
              </a>
            </>
          ) : (
            <p role="status" className="text-muted-foreground">Sprawdzam link…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
