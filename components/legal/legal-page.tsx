import Link from 'next/link';
import type { ReactNode } from 'react';

import type { LegalDocument } from '@/lib/legal/doc-model';
import { LEGAL_DOCUMENTS } from '@/lib/legal/documents';
import { cn } from '@/lib/utils';

import { PageHero } from '@/components/site/page-hero';
import { Container } from '@/components/site/ui';

import { LegalDocumentBody, LegalDraftBanner } from './legal-document';

/*
 * Strona dokumentu prawnego: nagłówek jak na innych podstronach, pod nim
 * nawigacja po komplecie dokumentów (klient przed zawarciem umowy ma widzieć
 * regulamin, umowę powierzenia i polityki w jednym miejscu), niżej treść
 * w wąskiej kolumnie. Animuje się tylko nagłówek, długi tekst stoi.
 *
 * Osobny plik, bo `legal-document.tsx` importują formularze klienckie
 * (`LegalInline`) i nie powinny ciągnąć treści wszystkich dokumentów.
 */

/** Zakładki dokumentów; bieżący dokument podaje strona (bez `usePathname`). */
function LegalNav({ current }: { current: string }) {
  return (
    <nav aria-label="Dokumenty prawne">
      <ul className="mx-auto inline-flex max-w-full flex-wrap justify-center gap-1 rounded-2xl bg-muted/60 p-1.5 ring-1 ring-border">
        {LEGAL_DOCUMENTS.map((d) => {
          const active = d.href === current;
          return (
            <li key={d.href}>
              <Link
                href={d.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex rounded-xl px-3.5 py-2 text-sm transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  active
                    ? 'bg-card font-medium text-foreground shadow-sm ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
                )}
              >
                {d.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function LegalPage({
  title,
  meta,
  current,
  children,
}: {
  title: ReactNode;
  /** Wiersz pod tytułem: wersja, data stanu, link do pobrania. */
  meta?: ReactNode;
  /** Adres tej strony z `LEGAL_DOCUMENTS`, podświetlany w nawigacji. */
  current: string;
  children: ReactNode;
}) {
  return (
    <article className="pb-20 sm:pb-28">
      <PageHero title={title} lead={meta ? <span className="text-base">{meta}</span> : undefined}>
        <LegalNav current={current} />
      </PageHero>
      <Container>
        <div className="prose prose-neutral mx-auto max-w-3xl dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-primary prose-a:underline-offset-2">
          <LegalDraftBanner />
          {children}
        </div>
      </Container>
    </article>
  );
}

export function LegalDocumentView({
  doc,
  downloadable = true,
  children,
}: {
  doc: LegalDocument;
  /** Link do wersji tekstowej (utrwalenie treści — art. 8 ust. 1 pkt 2 u.ś.u.d.e.). */
  downloadable?: boolean;
  /** Dodatkowa treść między streszczeniem a dokumentem (np. ustawienia cookies). */
  children?: ReactNode;
}) {
  return (
    <LegalPage
      title={doc.title}
      current={`/legal/${doc.slug}`}
      meta={
        <>
          Wersja z dnia {doc.version}
          {downloadable ? (
            <>
              {' · '}
              <a
                href={`/legal/pobierz/${doc.slug}`}
                download
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Pobierz jako plik tekstowy
              </a>
            </>
          ) : null}
        </>
      }
    >
      <LegalDocumentBody doc={doc}>{children}</LegalDocumentBody>
    </LegalPage>
  );
}
