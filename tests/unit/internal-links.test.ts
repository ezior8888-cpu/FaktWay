import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { plikiKodu, toPosix } from '../helpers/schema-z-migracji';

/**
 * Linki wewnętrzne prowadzą do stron, które ISTNIEJĄ w `app/`.
 *
 * Link do nieistniejącej strony kompiluje się, przechodzi testy i kończy
 * się 404 dopiero u klienta. Najgorzej na kartach Flo: akcja `open` bierze
 * pierwszy dowód karty, więc zły adres psuje GŁÓWNY przycisk karty, nie
 * boczny odnośnik.
 *
 * Sprawdzamy: `href=`, `href:`, `url:` (push), `redirect/push/replace(…)`
 * oraz adresy absolutne `${appUrl}/…` (maile, Stripe, sitemap). `${…}` jako
 * cały segment pasuje do dowolnego segmentu; doklejony do segmentu (np.
 * query string) ucina ścieżkę w tym miejscu.
 */

const ROOT = process.cwd();

interface Trasa {
  plik: string;
  segmenty: string[];
}

/** Strony i route handlery z `app/`, bez grup `(x)` i slotów `@x`. */
function trasy(): Trasa[] {
  const out: Trasa[] = [];
  const idz = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) idz(p);
      else if (/^(page|route)\.(tsx?|jsx?)$/.test(e.name)) {
        const rel = toPosix(dir).replace(toPosix(join(ROOT, 'app')), '');
        out.push({
          plik: toPosix(p).replace(toPosix(ROOT) + '/', ''),
          segmenty: rel.split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')),
        });
      }
    }
  };
  idz(join(ROOT, 'app'));
  return out;
}

const TRASY = trasy();

function istnieje(sciezka: string): boolean {
  const link = sciezka.split('/').filter(Boolean);
  return TRASY.some(({ segmenty }) => {
    for (let i = 0; i < segmenty.length; i++) {
      const s = segmenty[i]!;
      if (/^\[\[\.\.\./.test(s)) return true;
      if (/^\[\.\.\./.test(s)) return link.length > i;
      const l = link[i];
      if (l === undefined) return false;
      if (/^\[.+\]$/.test(s) || l === '*') continue;
      if (l !== s) return false;
    }
    return link.length === segmenty.length;
  });
}

const Z = `[^"'\`\\s?#]*`;
const WZORCE_WZGLEDNE = [
  new RegExp(`href=\\{?\\s*["'\`](\\/${Z})`, 'g'),
  new RegExp(`href:\\s*["'\`](\\/${Z})`, 'g'),
  new RegExp(`\\burl:\\s*["'\`](\\/${Z})`, 'g'),
  new RegExp(`\\b(?:redirect|permanentRedirect|push|replace|prefetch)\\(\\s*["'\`](\\/${Z})`, 'g'),
];
const WZORZEC_ABSOLUTNY = new RegExp(
  `\\$\\{[A-Za-z_.()]*(?:[uU]rl|URL|[oO]rigin|[bB]ase|APP|SITE)[A-Za-z_.()]*\\}(\\/[a-z]${Z})`,
  'g',
);

/** Pliki, w których `${baseUrl}/…` to adres CUDZEGO serwera (API KSeF, GoTrue). */
const OBCE_ADRESY = /^lib\/ksef\/|^lib\/auth\/oauth-providers\.ts$/;
/** Atrapy kart Flo — pokazywane wyłącznie w lokalnym dev. */
const POMIJANE = new Set(['lib/flo/fixtures.ts']);

interface Link {
  klucz: string;
  gdzie: string;
}

function martweLinki(): Link[] {
  const out: Link[] = [];
  const pliki = ['app', 'components', 'lib']
    .flatMap((d) => plikiKodu(join(ROOT, d)))
    .map((f) => ({ sciezka: f, plik: toPosix(f).replace(toPosix(ROOT) + '/', '') }))
    .filter(({ plik }) => !/\.test\.tsx?$/.test(plik) && !POMIJANE.has(plik));

  for (const { sciezka, plik } of pliki) {
    // Komentarze → spacje z zachowaniem nowych linii (numery linii zostają).
    const kod = readFileSync(sciezka, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const wzorce = OBCE_ADRESY.test(plik) ? WZORCE_WZGLEDNE : [...WZORCE_WZGLEDNE, WZORZEC_ABSOLUTNY];

    for (const w of wzorce) {
      for (const m of kod.matchAll(w)) {
        let link = m[1]!.replace(/\/\$\{[^}]*\}(?=\/|$)/g, '/*');
        const doklejony = link.indexOf('${');
        if (doklejony >= 0) link = link.slice(0, doklejony);
        if (link.startsWith('//')) continue;
        if (/^\/(api\/auth|_next|images|icons|fonts|ingest)(\/|$)/.test(link)) continue;
        if (/\.[a-z0-9]{2,5}$/i.test(link)) continue; // pliki statyczne z public/
        if (istnieje(link)) continue;
        out.push({
          klucz: `${plik} ${link}`,
          gdzie: `${plik}:${kod.slice(0, m.index).split('\n').length} → ${link}`,
        });
      }
    }
  }
  return out;
}

/**
 * Znany dług — lista nie może rosnąć po cichu ani trzymać wpisów naprawionych.
 * Wszystkie wpisy siedzą w kodzie, który jeszcze nie działa (producenci Flo
 * bez podpięcia, martwy job) — dlatego zapisane, a nie naprawione na ślepo.
 */
const BRAK_STRONY_KONTRAHENTA =
  'nie ma strony /contractors/[id] — przed podpięciem producenta: strona albo inny cel';
const ZNANE: Record<string, string> = {
  'lib/flo/functions/contractor-check.ts /contractors/*': BRAK_STRONY_KONTRAHENTA,
  'lib/flo/functions/contractor-foreign.ts /contractors/*': BRAK_STRONY_KONTRAHENTA,
  'lib/flo/functions/invoice-final.ts /contractors/*': BRAK_STRONY_KONTRAHENTA,
  'lib/flo/functions/payment-score.ts /contractors/*': BRAK_STRONY_KONTRAHENTA,
  'lib/flo/functions/rate-raise.ts /contractors/*': BRAK_STRONY_KONTRAHENTA,
  // Jest tylko /payments/overdue. B-01 bez producenta.
  'lib/flo/functions/month-close.ts /payments': 'nie ma strony /payments',
  // Job bez nadawcy zdarzenia (patrz job-event-senders.test.ts).
  'lib/jobs/runners/cancel-reminders-on-payment.ts /payments': 'nie ma strony /payments',
};

describe('linki wewnętrzne', () => {
  it('rozpoznaje trasy, także dynamiczne i w grupach', () => {
    expect(istnieje('/invoices/123')).toBe(true); // (dashboard)/invoices/[id]
    expect(istnieje('/invoices/new/regular')).toBe(true);
    expect(istnieje('/invoices/new/*')).toBe(true); // ${type} jako segment
    expect(istnieje('/settings/billing')).toBe(true);
    expect(istnieje('/')).toBe(true);
    expect(istnieje('/contractors/123')).toBe(false);
    expect(TRASY.length).toBeGreaterThan(50);
  });

  it('żaden link nie prowadzi do nieistniejącej strony', () => {
    const nowe = martweLinki().filter((l) => !(l.klucz in ZNANE));
    expect(
      nowe.map((l) => l.gdzie),
      'Link do strony, której nie ma w app/ — u klienta skończy się 404.',
    ).toEqual([]);
  });

  it('lista znanego długu nie trzyma wpisów już naprawionych', () => {
    const teraz = new Set(martweLinki().map((l) => l.klucz));
    expect(
      Object.keys(ZNANE).filter((k) => !teraz.has(k)),
      'Te linki już działają — usuń je z ZNANE.',
    ).toEqual([]);
  });
});
