import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import manifest from '@/app/manifest';
import { FaktWayLogo, FaktWayMark } from '@/components/brand/faktway-logo';
import { LOCKUP, MARK } from '@/lib/brand/faktway-logo-paths';
import InvoiceFailed from '@/lib/email/templates/InvoiceFailed';

/**
 * Logo FaktWay w aplikacji (zestaw: docs/brand/logo). Do 25.10.2026 manifest,
 * metadane i service worker wskazywały `/icons/*.png`, których w `public/`
 * nigdy nie było: produkcja zwracała 404 na favicon, ikony PWA i ikonę
 * powiadomień. Ten test pilnuje, żeby każda wskazana ikona istniała.
 */

const ROOT = process.cwd();
const inPublic = (url: string) => existsSync(join(ROOT, 'public', url.replace(/^\//, '')));

describe('ikony aplikacji istnieją w public/', () => {
  const m = manifest();
  const manifestIcons = [
    ...(m.icons ?? []).map((i) => i.src),
    ...(m.shortcuts ?? []).flatMap((s) => (s.icons ?? []).map((i) => i.src)),
  ];

  it.each(manifestIcons)('manifest PWA: %s', (src) => {
    expect(inPublic(src)).toBe(true);
  });

  it('manifest ma ikony maskowalne 192 i 512 px', () => {
    const maskable = (m.icons ?? []).filter((i) => i.purpose === 'maskable').map((i) => i.sizes);
    expect(maskable).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });

  const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
  const iconsBlock = layout.match(/\n  icons: \{[\s\S]*?\n  \},/)?.[0] ?? '';
  const layoutIcons = [...iconsBlock.matchAll(/'(\/[^']+\.(?:png|ico|svg))'/g)].map((x) => x[1]);

  it('metadane mają favicon i ikonę iOS', () => {
    expect(layoutIcons).toEqual(expect.arrayContaining(['/favicon.ico', '/icons/apple-touch-icon.png']));
  });

  it.each(layoutIcons)('metadane <head>: %s', (src) => {
    expect(inPublic(src)).toBe(true);
  });

  const sw = readFileSync(join(ROOT, 'app/sw.ts'), 'utf8');
  const swIcons = [...sw.matchAll(/'(\/icons\/[^']+\.png)'/g)].map((x) => x[1]);

  it.each(swIcons)('powiadomienia push: %s', (src) => {
    expect(inPublic(src)).toBe(true);
  });

  it('przeglądarka dostaje /favicon.ico z katalogu głównego', () => {
    expect(inPublic('/favicon.ico')).toBe(true);
  });
});

describe('stare pliki marki zniknęły', () => {
  it.each(['public/brand/faktflow-logo.png', 'public/favicon.zip', 'public/favicon/favicon.svg'])('%s', (path) => {
    expect(existsSync(join(ROOT, path))).toBe(false);
  });
});

describe('logo w interfejsie, mailach i PDF', () => {
  it('FaktWayLogo: SVG z etykietą, wersja jasna i odchudzona ciemna', () => {
    const html = renderToStaticMarkup(<FaktWayLogo />);
    expect(html).toContain('role="img" aria-label="FaktWay"');
    expect(html).toContain('class="dark:hidden"');
    expect(html).toContain('class="hidden dark:inline"');
    expect(html).toContain(`d="${LOCKUP.symbol.brand}"`);
    expect(html).toContain(`d="${LOCKUP.symbol.reversed}"`);
  });

  it('FaktWayLogo tone="inverse": całe białe, bez wersji kolorowej', () => {
    const html = renderToStaticMarkup(<FaktWayLogo tone="inverse" />);
    expect(html).toContain('fill="#FFFFFF"');
    expect(html).not.toContain('#2463EF');
  });

  it('FaktWayMark: sam znak', () => {
    const html = renderToStaticMarkup(<FaktWayMark />);
    expect(html).toContain(`viewBox="${MARK.viewBox}"`);
    expect(html).toContain(`d="${MARK.brand}"`);
  });

  it('mail do użytkownika ma logo PNG z public/brand', () => {
    const html = renderToStaticMarkup(
      <InvoiceFailed invoiceId="00000000-0000-0000-0000-000000000000" errorMessage="x" appUrl="https://faktway.pl" />,
    );
    const img = html.match(/<img[^>]*>/)?.[0] ?? '';
    expect(img).toContain('alt="FaktWay"');
    expect(img).toMatch(/src="https?:\/\/[^"]+\/brand\/faktway-logo-email\.png"/);
    expect(inPublic('/brand/faktway-logo-email.png')).toBe(true);
  });

  it('stopka PDF rysuje znak FaktWay', () => {
    const renderer = readFileSync(join(ROOT, 'lib/pdf/invoice-renderer.ts'), 'utf8');
    expect(renderer).toContain('doc.path(MARK.brand)');
  });
});
