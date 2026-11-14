import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { config } from '@/proxy';

// Ten sam kompilator matchera, którego Next używa przy budowie (manifest proxy).
// Next nie publikuje do niego typów, więc podpis opisujemy sami.
const { getMiddlewareMatchers } = createRequire(import.meta.url)('next/dist/build/analysis/get-page-static-info.js') as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: object) => Array<{ regexp: string }>;
};

/**
 * Plan skalowania, sesja 31 (LIM-08, HOR-V1, CPU-06). Gdy ścieżka pasuje do
 * matchera proxy, Next 16 czyta CAŁE ciało żądania z gniazda i trzyma w pamięci
 * jego kopię do 10 MiB (`proxyClientMaxBodySize`, nadmiar ucina po cichu), zanim
 * ruszy trasa (`next/dist/server/body-streams.js`). Trasa wgrywania nie może
 * więc odmówić „przed odczytem ciała”, a większy plik dociera do niej ucięty.
 *
 * Dlatego trasy wgrywania (`/api/uploads/*`) i `/share-target` są poza proxy
 * i same sprawdzają sesję, 2FA, firmę, Origin i rozmiar (`lib/uploads/server.ts`).
 * Ten test pilnuje obu stron: wyłączone są dokładnie te trzy adresy (bez
 * podścieżek — wszystko inne pod `/api/uploads/` i `/share-target/` dalej
 * idzie przez bramkę proxy), a każda trasa wgrywania przechodzi przez
 * wspólną bramkę.
 */

const matchers = getMiddlewareMatchers(config.matcher, {});
const passesProxy = (pathname: string) => matchers.some((m) => new RegExp(m.regexp).test(pathname));

describe('matcher proxy a trasy wgrywania', () => {
  it.each([
    '/api/uploads/expense',
    '/api/uploads/import',
    '/api/uploads/expense/',
    // Logo firmy na fakturze (plan kompletnej aplikacji, krok 2.2, część 1).
    '/api/uploads/logo',
    '/api/uploads/logo/',
    '/share-target',
    '/share-target/',
  ])(
    '%s omija proxy (ciało nie jest buforowane przed trasą)',
    (pathname) => {
      expect(passesProxy(pathname)).toBe(false);
    },
  );

  it.each([
    '/api/uploads',
    '/api/uploads/',
    '/api/uploads/inna',
    '/api/uploads/expense/x',
    '/api/uploads/expenses',
    '/api/uploads/logo/x',
    '/api/uploads/logos',
    '/share-target/x',
    '/share-target/x/strona',
    '/api/uploadsx/expense',
    '/api/upload/expense',
    '/API/uploads/expense',
    '/share-targets',
    '/share-target-x',
    '/Share-Target',
    '/api/invoices/batch-pdf',
    '/api/ksef/health',
    '/expenses',
    '/dashboard',
    '/ingest/e',
  ])('%s dalej przechodzi przez proxy', (pathname) => {
    expect(passesProxy(pathname)).toBe(true);
  });

  it('pliki statyczne dalej omijają proxy (lista z AGENTS.md, niezmiennik 7)', () => {
    expect(passesProxy('/icons/icon-96x96.png')).toBe(false);
    expect(passesProxy('/_next/static/chunks/app.js')).toBe(false);
  });
});

function routeFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('każda trasa poza proxy pilnuje się sama', () => {
  const uploads = routeFiles(path.join(process.cwd(), 'app', 'api', 'uploads'));

  it('pod /api/uploads/ są trasy kosztu, importu i logo firmy', () => {
    const names = uploads.map((file) => path.relative(process.cwd(), file).split(path.sep).join('/')).sort();
    expect(names).toEqual(['app/api/uploads/expense/route.ts', 'app/api/uploads/import/route.ts', 'app/api/uploads/logo/route.ts']);
  });

  it.each([
    ...routeFiles(path.join(process.cwd(), 'app', 'api', 'uploads')),
    path.join(process.cwd(), 'app', 'share-target', 'route.ts'),
  ].map((file) => path.relative(process.cwd(), file).split(path.sep).join('/')))(
    '%s przechodzi przez bramkę wgrywania i eksportuje tylko POST',
    (file) => {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source).toContain("from '@/lib/uploads/server'");
      expect(source).toMatch(/authorizeUpload\(/);
      expect(source).toMatch(/checkUploadHeaders\(/);
      expect(source).toMatch(/checkUploadRate\(/);
      expect(source).toMatch(/reserveUploadBytes\(/);
      expect(source).toMatch(/readUploadForm\(/);
      expect(source).toMatch(/export async function POST\(/);
      expect(source).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)\b/);
    },
  );
});
