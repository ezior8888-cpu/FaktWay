import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import HomePage, { metadata } from '@/app/(home)/page';
import { PRICE_GROSS, TRIAL_DAYS } from '@/lib/billing/pricing';
import { METODA_PLATNOSCI, OFERTA } from '@/lib/marketing/oferta';

import { tekstBezZnacznikow } from './helpers/tekst-html';

/**
 * Strona główna od 23.10.2026: prosty układ w duchu Salient/TaxPal, pisany
 * od zera na naszych tokenach. Zasady od Bartosza:
 *  - nagłówek to jedno zdanie oferty FaktWay 1.0 (lib/marketing/oferta.ts);
 *  - bez FLO, asystenta i AI w obietnicach (decyzja z 29.10.2026, całość
 *    stron publicznych pilnuje tests/unit/strony-publiczne-obietnice);
 *  - bez opinii klientów (nie mamy prawdziwych, art. 7 pkt 23b-23c u.p.n.p.r.);
 *  - bez plakietek nad nagłówkami i bez długich myślników w tekstach.
 */

const html = renderToStaticMarkup(<HomePage />);
const text = html.replace(/<[^>]+>/g, ' ');

/** Tekst nagłówka bez znaczników i twardych spacji. */
function h1Text(): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
  return tekstBezZnacznikow(h1).replaceAll('\u00a0', ' ').trim();
}

describe('strona główna', () => {
  it('bez długich myślników w tekstach i w tytule', () => {
    expect(text).not.toMatch(/[—–]/);
    expect(String(metadata.title)).not.toMatch(/[—–]/);
    expect(String(metadata.description)).not.toMatch(/[—–]/);
  });

  it('bez opinii, ocen i logotypów „klientów”', () => {
    expect(text).not.toMatch(/opini|ocen[ay]|zaufali|★/i);
  });

  it('nagłówek to hasło, a opis meta to zdanie oferty', () => {
    // Hasło od 03.11.2026 (decyzja Bartosza), w formacie dawnego „bez stresu”.
    expect(h1Text()).toBe('Faktury w KSeF z głowy');
    expect(metadata.description).toBe(OFERTA);
  });

  it('bez FLO i bez AI w obietnicach', () => {
    expect(html).not.toContain('id="flo"');
    expect(text).not.toMatch(/\bflo\b|asystent|\bagent|\bAI\b/i);
  });

  it('telefon opisany tak, jak działa: przeglądarka i ekran główny', () => {
    expect(text).toContain('w przeglądarce telefonu');
    expect(text).toContain('ekranu głównego');
    expect(text).not.toMatch(/App Store|Google Play/);
  });

  it('bez plakietki nad nagłówkiem strony', () => {
    const beforeH1 = html.slice(0, html.indexOf('<h1'));
    expect(beforeH1).not.toMatch(/rounded-full[^"]*bg-accent/);
  });

  it('cena i okres próbny z lib/billing/pricing, metoda płatności z lib/marketing/oferta', () => {
    expect(text).toContain(PRICE_GROSS);
    expect(text).toContain(`${TRIAL_DAYS} dni za darmo`);
    expect(text).toContain(METODA_PLATNOSCI);
  });

  it('kotwice, do których prowadzą nawigacja, O nas, Blog i stopka', () => {
    for (const id of ['funkcje', 'telefon', 'pricing', 'faq']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('href="/register"');
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/#telefon"');
  });

  it('nie korzysta z grafik szablonu Zova ani starego znaku marki', () => {
    const dir = join(process.cwd(), 'app/(home)');
    const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/\/landing\/|_assets|zova|faktflow-mark/);
  });
});
