import Link from 'next/link';
import type { ReactNode } from 'react';

import { Reveal } from './motion';
import { Container, Wordmark } from './ui';

/**
 * Pełnoekranowy komunikat (404, przerwa techniczna): napis FaktWay u góry,
 * nagłówek, jedno zdanie i przyciski. Bez nawigacji i stopki: z takiej
 * strony użytkownik ma wrócić, a nie zwiedzać serwis.
 */
export function StatusScreen({
  title,
  lead,
  actions,
}: {
  title: ReactNode;
  lead: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[32rem]"
        style={{
          background:
            'radial-gradient(48rem 24rem at 50% -10%, color-mix(in oklch, var(--primary) 14%, transparent), transparent 70%)',
        }}
      />
      <Container className="relative w-full py-6 sm:py-8">
        <Link href="/" aria-label="FaktWay, strona główna">
          <Wordmark />
        </Link>
      </Container>
      <main className="relative flex flex-1 items-center justify-center px-4 pb-24 text-center">
        <Reveal onLoad className="flex max-w-xl flex-col items-center">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{title}</h1>
          <p className="mt-5 text-lg text-pretty text-muted-foreground">{lead}</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">{actions}</div>
        </Reveal>
      </main>
    </div>
  );
}
