import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

/**
 * Knowledge base — artykuły pomocy w `content/help/*.mdx`.
 *
 * Te same artykuły służą dwóm celom:
 *   1. Publiczna strona `/pomoc` (SEO + pomoc przed rejestracją).
 *   2. Kontekst dla AI support chatu (Krok 4 — `lib/support/knowledge-base.ts`
 *      czyta `content` i wkleja w system prompt).
 *
 * Frontmatter MDX:
 *   title    — tytuł artykułu
 *   category — jedna z HELP_CATEGORIES
 *   order    — kolejność w obrębie kategorii
 *   summary  — 1-2 zdania (lista + meta description + AI snippet)
 *   updated  — data ostatniej aktualizacji (YYYY-MM-DD)
 */

export type HelpCategoryId =
  | 'start'
  | 'ksef'
  | 'faktury'
  | 'ocr-kpir'
  | 'rozliczenia'
  | 'zespol'
  | 'bezpieczenstwo';

export interface HelpCategory {
  id: HelpCategoryId;
  label: string;
  description: string;
  /** Material Symbols icon name. */
  icon: string;
}

/*
 * FaktWay 1.0: bez kategorii o FLO. Sześć artykułów o agencie leży
 * w `content/flo/pomoc`, poza `content/help`, więc nie ma ich w `/pomoc`,
 * w generowanych stronach ani w bazie wiedzy czatu; stare adresy przekierowuje
 * next.config.ts.
 */
export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: 'start',
    label: 'Pierwsze kroki',
    description: 'Onboarding, konfiguracja konta, pierwsza faktura.',
    icon: 'rocket_launch',
  },
  {
    id: 'ksef',
    label: 'KSeF',
    description: 'Jak działa KSeF, certyfikat, błędy, co gdy KSeF nie działa.',
    icon: 'cloud_sync',
  },
  {
    id: 'faktury',
    label: 'Faktury',
    description: 'Wystawianie, korekty, zaliczki, klienci z zagranicy.',
    icon: 'receipt_long',
  },
  {
    id: 'ocr-kpir',
    label: 'Koszty i KPiR',
    description: 'Paragony ze zdjęcia, kategoryzacja kosztów, KPiR.',
    icon: 'document_scanner',
  },
  {
    id: 'rozliczenia',
    label: 'Subskrypcja',
    description: 'Cena, płatności, okres próbny.',
    icon: 'credit_card',
  },
  {
    id: 'zespol',
    label: 'Zespół i organizacje',
    description: 'Zapraszanie osób, role, wiele firm, księgowa.',
    icon: 'group',
  },
  {
    id: 'bezpieczenstwo',
    label: 'Bezpieczeństwo',
    description: 'Hasło, 2FA, sesje, RODO, usuwanie konta.',
    icon: 'shield',
  },
];

export interface HelpArticle {
  slug: string;
  title: string;
  category: HelpCategoryId;
  order: number;
  summary: string;
  updated: string;
  /** Surowa treść MDX (bez frontmatter). */
  content: string;
}

const VALID_CATEGORIES = new Set<string>(HELP_CATEGORIES.map((c) => c.id));

function helpDirPath(): string {
  return path.join(process.cwd(), 'content/help');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseArticle(file: string): HelpArticle | null {
  if (!file.endsWith('.mdx')) return null;
  const slug = file.replace(/\.mdx$/u, '');
  const raw = fs.readFileSync(path.join(helpDirPath(), file), 'utf8');
  const { data, content } = matter(raw);

  if (
    !isNonEmptyString(data.title) ||
    !isNonEmptyString(data.category) ||
    !VALID_CATEGORIES.has(data.category) ||
    !isNonEmptyString(data.summary)
  ) {
    // Świadomie nie rzucamy — jeden zły plik nie wywala całej strony /pomoc.
    console.warn(`[help] pominięto artykuł z niekompletnym frontmatter: ${file}`);
    return null;
  }

  const order =
    typeof data.order === 'number' && Number.isFinite(data.order)
      ? data.order
      : 999;
  const updated = isNonEmptyString(data.updated) ? data.updated : '';

  return {
    slug,
    title: data.title,
    category: data.category as HelpCategoryId,
    order,
    summary: data.summary,
    updated,
    content: content.trim(),
  };
}

/**
 * Lista liczona raz na proces: pliki są w obrazie (`outputFileTracingIncludes`)
 * i zmieniają się tylko z wdrożeniem, a layout panelu bierze z niej tytuły przy
 * każdym renderze (sesja 9 planu skalowania, CPU-14). W `next dev` bez pamięci,
 * żeby edycja `.mdx` była widoczna od razu.
 */
let allArticlesMemo: HelpArticle[] | null = null;

/** Wszystkie artykuły, posortowane (kategoria → order → tytuł). */
export function getAllHelpArticles(): HelpArticle[] {
  if (process.env.NODE_ENV === 'development') return readAllHelpArticles();
  allArticlesMemo ??= readAllHelpArticles();
  // Kopia tablicy: wołający może ją sortować albo filtrować w miejscu bez psucia pamięci.
  return [...allArticlesMemo];
}

function readAllHelpArticles(): HelpArticle[] {
  const dir = helpDirPath();
  if (!fs.existsSync(dir)) return [];
  const categoryRank = new Map(
    HELP_CATEGORIES.map((c, i) => [c.id, i] as const),
  );
  return fs
    .readdirSync(dir)
    .map(parseArticle)
    .filter((a): a is HelpArticle => a !== null)
    .sort((a, b) => {
      const catDiff =
        (categoryRank.get(a.category) ?? 99) -
        (categoryRank.get(b.category) ?? 99);
      if (catDiff !== 0) return catDiff;
      if (a.order !== b.order) return a.order - b.order;
      return a.title.localeCompare(b.title, 'pl');
    });
}

export function getHelpArticle(slug: string): HelpArticle | null {
  const file = `${slug}.mdx`;
  const full = path.join(helpDirPath(), file);
  if (!fs.existsSync(full)) return null;
  return parseArticle(file);
}

export function getArticlesByCategory(
  category: HelpCategoryId,
): HelpArticle[] {
  return getAllHelpArticles().filter((a) => a.category === category);
}

export function getCategory(id: string): HelpCategory | null {
  return HELP_CATEGORIES.find((c) => c.id === id) ?? null;
}
