import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CloudSync,
  CreditCard,
  ReceiptText,
  Rocket,
  ScanText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';

import {
  getAllHelpArticles,
  HELP_CATEGORIES,
  type HelpCategoryId,
} from '@/lib/help/articles';
import { SUPPORT_EMAIL } from '@/lib/site';
import { Reveal, RevealGroup, RevealItem } from '@/components/site/motion';
import { PageHero } from '@/components/site/page-hero';
import { ButtonLink, Container } from '@/components/site/ui';

import { HelpSearch, type HelpSearchItem } from './_components/help-search';

// Końcówkę „| FaktWay” dopisuje szablon tytułu z layoutu.
export const metadata: Metadata = {
  title: 'Centrum pomocy',
  description:
    'Poradniki i odpowiedzi na pytania o KSeF, wystawianie faktur, koszty ze zdjęcia, KPiR i abonament. Pomoc dla mikrofirm i księgowych.',
};

/*
 * Ikony kategorii z lucide, jak na stronie głównej. Nazwy Material Symbols
 * w `HELP_CATEGORIES.icon` zostają dla innych miejsc; mapa jest pełna,
 * więc nowa kategoria bez ikony nie przejdzie typecheck.
 */
const CATEGORY_ICONS: Record<HelpCategoryId, LucideIcon> = {
  start: Rocket,
  ksef: CloudSync,
  faktury: ReceiptText,
  'ocr-kpir': ScanText,
  rozliczenia: CreditCard,
  zespol: Users,
  bezpieczenstwo: ShieldCheck,
};

/** Twarda spacja po jednoliterowym słowie, żeby nie zostało samo na końcu linii. */
function bezSierotek(text: string): string {
  return text.replace(/(?<=^|\s)([aiouwz])\s+/giu, '$1 ');
}

export default function PomocPage() {
  const articles = getAllHelpArticles();

  const searchItems: HelpSearchItem[] = articles.map((a) => ({
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    categoryLabel:
      HELP_CATEGORIES.find((c) => c.id === a.category)?.label ?? a.category,
  }));

  return (
    <>
      <PageHero
        title="Centrum pomocy"
        lead={`Poradniki krok po kroku. Nie znajdujesz odpowiedzi? Napisz na ${SUPPORT_EMAIL}.`}
      >
        <div className="mx-auto max-w-2xl">
          <HelpSearch items={searchItems} />
        </div>
      </PageHero>

      <div className="pb-20 sm:pb-28">
        <Container>
          {articles.length === 0 ? (
            <p className="text-center text-muted-foreground">
              Artykuły pomocy są w przygotowaniu.
            </p>
          ) : (
            <div className="space-y-14 sm:space-y-16">
              {HELP_CATEGORIES.map((cat) => {
                const inCat = articles.filter((a) => a.category === cat.id);
                if (inCat.length === 0) return null;
                const Icon = CATEGORY_ICONS[cat.id];
                return (
                  <section
                    key={cat.id}
                    id={`kategoria-${cat.id}`}
                    aria-labelledby={`kategoria-${cat.id}-title`}
                    className="grid scroll-mt-8 gap-6 border-t border-border pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-12"
                  >
                    <Reveal>
                      <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                        <Icon aria-hidden className="size-5" />
                      </span>
                      <h2
                        id={`kategoria-${cat.id}-title`}
                        className="mt-5 text-2xl font-semibold tracking-tight text-balance"
                      >
                        {bezSierotek(cat.label)}
                      </h2>
                      <p className="mt-2 text-pretty text-muted-foreground">
                        {cat.description}
                      </p>
                    </Reveal>

                    <RevealGroup as="ul" className="grid gap-4 sm:grid-cols-2">
                      {inCat.map((a) => (
                        <RevealItem as="li" key={a.slug} className="flex">
                          <article className="group relative flex w-full flex-col rounded-2xl bg-card p-6 text-card-foreground ring-1 ring-border transition hover:shadow-lg hover:shadow-primary/5 hover:ring-primary/40 focus-within:ring-2 focus-within:ring-ring">
                            <h3 className="font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary">
                              <Link
                                href={`/pomoc/${a.slug}`}
                                className="outline-none after:absolute after:inset-0 after:rounded-2xl"
                              >
                                {a.title}
                              </Link>
                            </h3>
                            <p className="mt-2 line-clamp-2 text-sm text-pretty text-muted-foreground">
                              {a.summary}
                            </p>
                          </article>
                        </RevealItem>
                      ))}
                    </RevealGroup>
                  </section>
                );
              })}
            </div>
          )}

          <Reveal className="mt-20 rounded-3xl bg-muted/50 px-6 py-12 text-center ring-1 ring-border sm:px-12 sm:py-16">
            <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Nie znalazłeś odpowiedzi?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-muted-foreground">
              Napisz do nas, odpisuje człowiek. Po zalogowaniu pomoże też automatyczny czat
              (ikona pomocy w panelu, na telefonie w menu „Więcej”), a z niego przejdziesz do człowieka.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <ButtonLink href="/kontakt">Napisz do nas</ButtonLink>
              <ButtonLink href="/login" variant="outline">
                Przejdź do panelu
              </ButtonLink>
            </div>
          </Reveal>
        </Container>
      </div>
    </>
  );
}
