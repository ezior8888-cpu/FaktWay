import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sesja 9 planu skalowania (CPU-14, CAC-09): layout panelu przy każdym
 * renderze brał tytuły pomocy z `getAllHelpArticles()`, a ta czytała
 * synchronicznie cały katalog `content/help` (32 pliki MDX z parsowaniem).
 * Pliki są w obrazie i zmieniają się tylko z wdrożeniem, więc lista jest
 * liczona raz na proces. W dev (`next dev`) bez pamięci: edycja `.mdx` ma
 * być widoczna od razu.
 */

const PLIKI_MDX = fs.readdirSync('content/help').filter((f) => f.endsWith('.mdx')).length;

let readdir: ReturnType<typeof vi.spyOn>;
let readFile: ReturnType<typeof vi.spyOn>;

/** Nowa kopia modułu (pusta pamięć); liczniki od zera po imporcie, bez odczytów samego ładowania. */
async function swiezyModul() {
  vi.resetModules();
  const modul = await import('@/lib/help/articles');
  readdir.mockClear();
  readFile.mockClear();
  return modul;
}

beforeEach(() => {
  readdir = vi.spyOn(fs, 'readdirSync');
  readFile = vi.spyOn(fs, 'readFileSync');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('getAllHelpArticles', () => {
  it('dwa wywołania czytają dysk raz i dają tę samą listę', async () => {
    const { getAllHelpArticles } = await swiezyModul();
    const pierwsza = getAllHelpArticles();
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(PLIKI_MDX);

    const druga = getAllHelpArticles();
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(PLIKI_MDX);
    expect(druga).toEqual(pierwsza);
    expect(pierwsza.length).toBeGreaterThan(0);
  });

  it('każde wywołanie dostaje własną tablicę (sortowanie u wołającego nie psuje pamięci)', async () => {
    const { getAllHelpArticles } = await swiezyModul();
    const pierwsza = getAllHelpArticles();
    const kolejnosc = pierwsza.map((a) => a.slug);
    pierwsza.reverse();
    expect(getAllHelpArticles().map((a) => a.slug)).toEqual(kolejnosc);
  });

  it('w dev każde wywołanie czyta dysk od nowa', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { getAllHelpArticles } = await swiezyModul();
    getAllHelpArticles();
    getAllHelpArticles();
    expect(readdir).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(2 * PLIKI_MDX);
  });

  it('getArticlesByCategory korzysta z tej samej listy', async () => {
    const { getAllHelpArticles, getArticlesByCategory } = await swiezyModul();
    getAllHelpArticles();
    const flo = getArticlesByCategory('flo');
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(flo.every((a) => a.category === 'flo')).toBe(true);
  });
});
