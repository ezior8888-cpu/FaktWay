import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';
import { compileMDX } from 'next-mdx-remote/rsc';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';

import { TRIAL_DAYS } from '@/lib/billing/pricing';
import { cn } from '@/lib/utils';
import { Reveal } from '@/components/site/motion';
import { BandGlow, ButtonLink, Container } from '@/components/site/ui';

type PageProps = { params: Promise<{ slug: string }> };

function blogDirPath(): string {
  return path.join(process.cwd(), 'content/blog');
}

function postFilePath(slug: string): string {
  return path.join(blogDirPath(), `${slug}.mdx`);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseMatterData(data: unknown): {
  title: string;
  description: string;
  date: string;
  readTime: number;
} | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!isNonEmptyString(d.title) || !isNonEmptyString(d.description) || !isNonEmptyString(d.date)) return null;
  if (Number.isNaN(new Date(d.date).getTime())) return null;
  const readTime =
    typeof d.readTime === 'number' && Number.isFinite(d.readTime) && d.readTime > 0 ? d.readTime : 5;
  return {
    title: d.title,
    description: d.description,
    date: d.date,
    readTime,
  };
}

/** Twarda spacja po jednoliterowym słowie, żeby nie zostało samo na końcu linii. */
function bezSierotek(text: string): string {
  return text.replace(/(?<=^|\s)([aiouwz])\s+/giu, '$1 ');
}

/*
 * Treść MDX na tokenach aplikacji: kolory nagłówków, linków, cytatów i kodu
 * idą za motywem (jasny i ciemny), bez palety bloga.
 */
const PROSE = cn(
  'prose prose-lg prose-neutral max-w-none dark:prose-invert',
  'prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-foreground',
  'prose-h2:mt-12 prose-h2:mb-4 prose-h2:text-3xl prose-h3:mt-8 prose-h3:text-xl',
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
  const dir = blogDirPath();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => ({ slug: f.replace(/\.mdx$/u, '') }));
}

// Końcówkę „| FaktWay” dopisuje szablon tytułu z layoutu.
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const fullPath = postFilePath(slug);
  if (!fs.existsSync(fullPath)) {
    return { title: 'Blog' };
  }
  const fileContents = fs.readFileSync(fullPath, 'utf8');
  const { data } = matter(fileContents);
  const parsed = parseMatterData(data);
  if (!parsed) {
    return { title: 'Blog' };
  }
  return {
    title: `${parsed.title} | Blog`,
    description: parsed.description,
  };
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const fullPath = postFilePath(slug);
  if (!fs.existsSync(fullPath)) notFound();

  const fileContents = fs.readFileSync(fullPath, 'utf8');
  const { data, content } = matter(fileContents);
  const parsed = parseMatterData(data);
  if (!parsed) notFound();

  const { content: compiledContent } = await compileMDX({
    source: content,
    options: { parseFrontmatter: false },
  });

  return (
    <>
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
                href="/blog"
                className="inline-flex items-center gap-1.5 rounded-full text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              >
                <ArrowLeft className="size-4" aria-hidden />
                Powrót do bloga
              </Link>
            </Reveal>
            <Reveal onLoad delay={0.05}>
              <p className="mt-10 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                <time dateTime={parsed.date}>
                  {new Date(parsed.date).toLocaleDateString('pl-PL', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </time>
                <span aria-hidden>·</span>
                <span>{parsed.readTime} min czytania</span>
              </p>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
                {bezSierotek(parsed.title)}
              </h1>
            </Reveal>
            <Reveal onLoad delay={0.1}>
              <p className="mt-6 text-lg text-pretty text-muted-foreground sm:text-xl">
                {parsed.description}
              </p>
            </Reveal>
          </Container>
        </header>

        <Container className="max-w-3xl pb-20 sm:pb-28">
          {/* Cały tekst odsłania się raz przy załadowaniu: przy długim
              artykule odsłanianie przy przewijaniu mogłoby się nie włączyć. */}
          <Reveal onLoad delay={0.2} className="border-t border-border pt-10 sm:pt-12">
            <div className={PROSE}>{compiledContent}</div>
          </Reveal>
        </Container>
      </article>

      <section
        aria-labelledby="blog-start-title"
        className="relative overflow-hidden bg-primary py-20 text-primary-foreground sm:py-28"
      >
        <BandGlow className="rotate-180" />
        <Container className="relative">
          <Reveal className="mx-auto max-w-xl text-center">
            <h2
              id="blog-start-title"
              className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
            >
              Wystaw pierwszą fakturę jeszcze dziś
            </h2>
            <p className="mt-4 text-lg text-pretty text-primary-foreground">
              {TRIAL_DAYS} dni za darmo. Rezygnujesz, kiedy chcesz.
            </p>
            <ButtonLink href="/register" variant="inverse" className="mt-10">
              Wypróbuj za darmo
            </ButtonLink>
          </Reveal>
        </Container>
      </section>
    </>
  );
}
