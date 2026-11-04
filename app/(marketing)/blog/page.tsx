import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { RevealGroup, RevealItem } from '@/components/site/motion';
import { PageHero } from '@/components/site/page-hero';
import { Container } from '@/components/site/ui';

// Sam „Blog”: końcówkę „| FaktWay” dopisuje szablon tytułu z layoutu.
export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Poradniki o KSeF, fakturach i prowadzeniu małej firmy. Konkretnie, bez urzędowego żargonu.',
};

interface Post {
  slug: string;
  title: string;
  description: string;
  date: string;
  readTime: number;
}

/**
 * Wpisy czytamy z `content/blog` tym samym sposobem co poprzednia wersja
 * listy (gray-matter na frontmatterze). Kolejność: od najnowszego.
 */
function getPosts(): Post[] {
  const dir = path.join(process.cwd(), 'content', 'blog');
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((file) => {
      const { data } = matter(fs.readFileSync(path.join(dir, file), 'utf8'));
      return {
        slug: file.replace(/\.mdx$/, ''),
        title: String(data.title ?? ''),
        description: String(data.description ?? ''),
        date: String(data.date ?? ''),
        readTime: Number(data.readTime ?? 5),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

const MIESIACE = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
];

function dataPl(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MIESIACE[d.getMonth()]} ${d.getFullYear()}`;
}

/*
 * Od 23.10.2026 w wyglądzie strony głównej (components/site). Karty bez
 * okładek: obrazki z szablonu Zova miały niepotwierdzoną licencję.
 */
export default function BlogPage() {
  const posts = getPosts();

  return (
    <>
      <PageHero
        // Twarda spacja: „z” nie może zostać samo na końcu linii.
        title={'Poradniki dla tych, którzy wolą mieć to z głowy'}
        lead="Poradniki o KSeF, fakturach i prowadzeniu małej firmy. Konkretnie, bez urzędowego żargonu."
      />

      <section aria-label="Wpisy" className="pb-20 sm:pb-28">
        <Container>
          {posts.length === 0 ? (
            <p className="text-center text-muted-foreground">Wpisy są w przygotowaniu.</p>
          ) : (
            <RevealGroup as="ul" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {posts.map((p) => (
                <RevealItem as="li" key={p.slug} className="flex">
                  {/* Cała karta klikalna przez rozciągnięty link w tytule,
                      więc czytnik ekranu czyta jako link sam tytuł. */}
                  <article className="group relative flex w-full flex-col rounded-3xl bg-card p-8 text-card-foreground ring-1 ring-border transition hover:shadow-lg hover:shadow-primary/5 hover:ring-primary/40 focus-within:ring-2 focus-within:ring-ring">
                    <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                      <time dateTime={p.date}>{dataPl(p.date)}</time>
                      <span aria-hidden>·</span>
                      <span>{p.readTime} min czytania</span>
                    </p>
                    <h2 className="mt-4 text-xl font-semibold tracking-tight text-balance text-foreground transition-colors group-hover:text-primary">
                      <Link
                        href={`/blog/${encodeURIComponent(p.slug)}`}
                        className="outline-none after:absolute after:inset-0 after:rounded-3xl"
                      >
                        {p.title}
                      </Link>
                    </h2>
                    <p className="mt-3 text-pretty text-muted-foreground">{p.description}</p>
                    <span
                      aria-hidden
                      className="mt-auto inline-flex items-center gap-1.5 pt-8 text-sm font-semibold text-primary"
                    >
                      Czytaj
                      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </article>
                </RevealItem>
              ))}
            </RevealGroup>
          )}
        </Container>
      </section>
    </>
  );
}
