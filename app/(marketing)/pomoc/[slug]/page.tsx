import fs from 'fs';
import path from 'path';

import { compileMDX } from 'next-mdx-remote/rsc';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';

import {
  getArticlesByCategory,
  getCategory,
  getHelpArticle,
} from '@/lib/help/articles';
import { cn } from '@/lib/utils';
import { Reveal, RevealGroup, RevealItem } from '@/components/site/motion';
import { Container } from '@/components/site/ui';

type PageProps = { params: Promise<{ slug: string }> };

/** Twarda spacja po jednoliterowym słowie, żeby nie zostało samo na końcu linii. */
function bezSierotek(text: string): string {
  return text.replace(/(?<=^|\s)([aiouwz])\s+/giu, '$1 ');
}

/*
 * Treść MDX na tokenach aplikacji: kolory nagłówków, linków, cytatów i kodu
 * idą za motywem (jasny i ciemny). Ten sam zestaw co w artykule bloga.
 */
const PROSE = cn(
  'prose prose-lg prose-neutral max-w-none dark:prose-invert',
  'prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-foreground',
  'prose-h2:mt-10 prose-h2:mb-3 prose-h2:text-2xl prose-h3:mt-6 prose-h3:text-lg',
  'prose-p:leading-relaxed prose-strong:text-foreground',
  'prose-a:font-medium prose-a:text-primary prose-a:underline-offset-4',
  'prose-blockquote:border-l-primary prose-blockquote:font-normal prose-blockquote:text-foreground',
  'prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:font-medium prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none',
  'prose-hr:border-border',
);

/** Poświata nagłówka, ta sama co w `PageHero`. */
const HEADER_GLOW = {
  background:
    'radial-gradient(48rem 20rem at 50% -10%, color-mix(in oklch, var(--primary) 14%, transparent), transparent 70%)',
} as const;

export async function generateStaticParams() {
  const dir = path.join(process.cwd(), 'content/help');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => ({ slug: f.replace(/\.mdx$/u, '') }));
}

// Końcówkę „| FaktWay” dopisuje szablon tytułu z layoutu.
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) return { title: 'Pomoc' };
  return {
    title: `${article.title} | Pomoc`,
    description: article.summary,
  };
}

export default async function HelpArticlePage({ params }: PageProps) {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) notFound();

  const category = getCategory(article.category);
  // Powiązane artykuły z tej samej kategorii (max 4, bez bieżącego).
  const related = getArticlesByCategory(article.category)
    .filter((a) => a.slug !== article.slug)
    .slice(0, 4);

  const { content } = await compileMDX({
    source: article.content,
    options: { parseFrontmatter: false },
  });

  return (
    <article>
      <header className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[28rem]"
          style={HEADER_GLOW}
        />
        <Container className="relative max-w-3xl pt-10 pb-10 sm:pt-16 sm:pb-12">
          <Reveal onLoad y={12}>
            <Link
              href="/pomoc"
              className="inline-flex items-center gap-1.5 rounded-full text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <ArrowLeft className="size-4" aria-hidden />
              Centrum pomocy
            </Link>
          </Reveal>
          <Reveal onLoad delay={0.05}>
            <h1 className="mt-10 text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
              {bezSierotek(article.title)}
            </h1>
            {/* Kategoria w wierszu pod tytułem, nie jako etykieta nad nim. */}
            {category || article.updated ? (
              <p className="mt-5 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                {category ? (
                  <Link
                    href={`/pomoc#kategoria-${category.id}`}
                    className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                  >
                    {category.label}
                  </Link>
                ) : null}
                {category && article.updated ? <span aria-hidden>·</span> : null}
                {article.updated ? (
                  <span>
                    Zaktualizowano:{' '}
                    <time dateTime={article.updated}>
                      {new Date(article.updated).toLocaleDateString('pl-PL', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </time>
                  </span>
                ) : null}
              </p>
            ) : null}
          </Reveal>
        </Container>
      </header>

      <Container className="max-w-3xl pb-20 sm:pb-28">
        {/* Cały tekst odsłania się raz przy załadowaniu: przy długim
            artykule odsłanianie przy przewijaniu mogłoby się nie włączyć. */}
        <Reveal onLoad delay={0.15} className="border-t border-border pt-10">
          <div className={PROSE}>{content}</div>
        </Reveal>

        {related.length > 0 && (
          <section aria-labelledby="zobacz-tez-title" className="mt-16 border-t border-border pt-10">
            <Reveal>
              <h2 id="zobacz-tez-title" className="text-2xl font-semibold tracking-tight">
                Zobacz też
              </h2>
            </Reveal>
            <RevealGroup as="ul" className="mt-6 grid gap-4 sm:grid-cols-2">
              {related.map((r) => (
                <RevealItem as="li" key={r.slug} className="flex">
                  <div className="group relative flex w-full flex-col rounded-2xl bg-card p-6 text-card-foreground ring-1 ring-border transition hover:shadow-lg hover:shadow-primary/5 hover:ring-primary/40 focus-within:ring-2 focus-within:ring-ring">
                    <p className="font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary">
                      <Link
                        href={`/pomoc/${encodeURIComponent(r.slug)}`}
                        className="outline-none after:absolute after:inset-0 after:rounded-2xl"
                      >
                        {r.title}
                      </Link>
                    </p>
                    <p className="mt-2 line-clamp-2 text-sm text-pretty text-muted-foreground">
                      {r.summary}
                    </p>
                  </div>
                </RevealItem>
              ))}
            </RevealGroup>
          </section>
        )}
      </Container>
    </article>
  );
}
