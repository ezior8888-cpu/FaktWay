'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

import './globals.css';

/**
 * Błąd krytyczny — ten komponent zastępuje CAŁY dokument, więc renderuje
 * własne `<html>` i `<body>`. Wcześniej pokazywał domyślną stronę błędu
 * Next.js, czyli surowy komunikat na białym tle bez śladu naszej marki.
 *
 * Nie korzystamy tu z komponentów strony: skoro aplikacja właśnie się
 * wywróciła, strona awaryjna nie może zależeć od niczego, co też mogło paść.
 * Stąd czysty znacznik na tokenach z `globals.css` (wygląd jak strona
 * główna, od 23.10.2026; wcześniej arkusz szablonu Zova).
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pl">
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center bg-background px-5 text-center text-foreground">
          <div className="flex max-w-xl flex-col items-center">
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Chwilowo mamy usterkę
            </h1>

            <p className="mt-5 text-lg text-pretty text-muted-foreground">
              Zgłoszenie już do nas poszło i się tym zajmujemy. Odśwież
              stronę za moment, a jeśli problem wróci, napisz do nas.
            </p>

            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Odśwież stronę
              </button>
              {/* Celowo zwykły <a>, nie <Link>: to jest strona awaryjna
                  zastępująca cały dokument. Router Next.js mógł paść razem
                  z aplikacją, więc powrót musi być zwykłym przeładowaniem. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                className="inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-foreground ring-1 ring-border transition-colors hover:bg-muted"
              >
                Strona główna
              </a>
            </div>

            {error.digest ? (
              <p className="mt-8 text-sm text-muted-foreground">
                Numer zgłoszenia: {error.digest}
              </p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  );
}
