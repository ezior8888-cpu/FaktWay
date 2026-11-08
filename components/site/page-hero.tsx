import type { ReactNode } from 'react';

import { Reveal } from './motion';
import { Container } from './ui';

/**
 * Nagłówek podstrony (blog, cennik, kontakt, dokumenty…): ten sam krój co
 * hero strony głównej, mniejszy, na jasnej poświacie w kolorze akcentu.
 */
export function PageHero({
  title,
  lead,
  children,
}: {
  title: ReactNode;
  lead?: ReactNode;
  /** Np. przyciski albo nawigacja pod nagłówkiem. */
  children?: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[28rem]"
        style={{
          background:
            'radial-gradient(48rem 20rem at 50% -10%, color-mix(in oklch, var(--primary) 14%, transparent), transparent 70%)',
        }}
      />
      <Container className="relative pt-12 pb-12 text-center sm:pt-20 sm:pb-16">
        <Reveal onLoad>
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
            {title}
          </h1>
        </Reveal>
        {lead ? (
          <Reveal onLoad delay={0.1}>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-pretty text-muted-foreground">{lead}</p>
          </Reveal>
        ) : null}
        {children ? (
          <Reveal onLoad delay={0.2} className="mt-8">
            {children}
          </Reveal>
        ) : null}
      </Container>
    </section>
  );
}
