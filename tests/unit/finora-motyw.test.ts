import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Plan Finora, E1 (D2, §10.1, §10.2 pkt 1): motyw aplikacji to preset
 * „Modern Minimal” z szablonu Finora, z poprawkami kontrastu do WCAG AA.
 * Wątek FLO (D4) zostaje w dawnych kolorach — kryterium „kolory wątku bez
 * zmian” z E1 i E2.
 */

const ROOT = join(__dirname, '..', '..');
const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');

/** Deklaracje `--x: wartość;` z pierwszego bloku o dokładnie tym selektorze. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {\n`);
  expect(start, `brak bloku ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) vars[m[1]] = m[2].trim();
  return vars;
}

type Rgb = [number, number, number];

/** oklch → liniowe sRGB (obcięte do gamutu). */
function oklch(value: string): Rgb {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`nie oklch: ${value}`);
  const [l, c, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb: Rgb = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  return rgb.map((x) => Math.min(1, Math.max(0, x))) as Rgb;
}

const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** Kolor z kryciem `alpha` na tle (mieszanie w sRGB, jak przeglądarka). */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((x, i) => decode(encode(x) * alpha + encode(bg[i]) * (1 - alpha))) as Rgb;
}

function contrast(x: Rgb, y: Rgb): number {
  const lum = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

const light = block(':root');
const dark = block('.dark');

describe('preset Modern Minimal (plan Finora, §10.1)', () => {
  it.each([
    ['--background', 'oklch(1 0 0)', 'oklch(0.2 0 0)'],
    ['--foreground', 'oklch(0.32 0 0)', 'oklch(0.92 0 0)'],
    ['--card', 'oklch(1 0 0)', 'oklch(0.27 0 0)'],
    ['--muted-foreground', 'oklch(0.55 0.02 264.41)', 'oklch(0.72 0 0)'],
    ['--accent', 'oklch(0.95 0.03 233.56)', 'oklch(0.38 0.14 265.59)'],
    ['--border', 'oklch(0.93 0.01 261.82)', 'oklch(0.37 0 0)'],
    ['--ring', 'oklch(0.62 0.19 259.76)', 'oklch(0.62 0.19 259.76)'],
    ['--chart-1', 'oklch(0.62 0.19 259.76)', 'oklch(0.71 0.14 254.69)'],
    ['--chart-5', 'oklch(0.38 0.14 265.59)', 'oklch(0.42 0.18 265.55)'],
    ['--sidebar', 'oklch(0.98 0 0)', 'oklch(0.21 0.01 285.93)'],
  ])('%s jak w presecie (jasny %s, ciemny %s)', (name, l, d) => {
    expect(light[name]).toBe(l);
    expect(dark[name]).toBe(d);
  });

  it('promień zostaje 0.625rem (preset go nie ustawia)', () => {
    expect(light['--radius']).toBe('0.625rem');
  });
});

describe('kontrast WCAG AA 4,5:1 (§10.2 pkt 1)', () => {
  it.each([
    ['jasny', light],
    ['ciemny', dark],
  ])('%s: tekst przycisku na `--primary`', (_, t) => {
    expect(contrast(oklch(t['--primary-foreground']), oklch(t['--primary']))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['jasny', light],
    ['ciemny', dark],
  ])('%s: `--primary` jako tekst (link) na tle', (_, t) => {
    expect(contrast(oklch(t['--primary']), oklch(t['--background']))).toBeGreaterThanOrEqual(4.5);
  });

  // Przycisk i plakietka `destructive` mają półprzezroczyste tło (jasny /10,
  // ciemny /20), które leży na stronie, karcie albo w oknie dialogowym.
  it.each([
    ['jasny', light, 0.1],
    ['ciemny', dark, 0.2],
  ])('%s: tekst `destructive` na własnym półprzezroczystym tle przycisku', (_, t, alpha) => {
    const fg = oklch(t['--destructive']);
    for (const surface of ['--background', '--card', '--popover']) {
      expect(contrast(fg, over(fg, alpha as number, oklch(t[surface]))), surface).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, oklch(t[surface])), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  // `--ff-accent-tint` to tło pigułek i baneru z linkiem w kolorze akcentu
  // (np. podkład z ostatniej faktury w `invoice-form.tsx`).
  it.each([
    ['jasny', light, block('.ff-dashboard')['--ff-accent-tint']],
    ['ciemny', dark, block('html.dark .ff-dashboard')['--ff-accent-tint']],
  ])('%s: akcent jako tekst na `--ff-accent-tint`', (_, t, tint) => {
    const m = /^color-mix\(in oklch, var\(--primary\) (\d+)%, var\(--card\)\)$/.exec(tint ?? '');
    expect(m, `--ff-accent-tint: ${tint}`).not.toBeNull();
    const share = Number(m![1]) / 100;
    // color-mix w oklch: L i C liniowo, odcień z jedynego składnika z chromą.
    const [pl, pc, ph] = t['--primary'].slice(6, -1).split(' ').map(Number);
    const [cl] = t['--card'].slice(6, -1).split(' ').map(Number);
    const mixed = `oklch(${pl * share + cl * (1 - share)} ${pc * share} ${ph})`;
    expect(contrast(oklch(t['--primary']), oklch(mixed))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['jasny', light],
    ['ciemny', dark],
  ])('%s: tekst i tekst przygaszony na tle i karcie', (_, t) => {
    for (const surface of ['--background', '--card']) {
      expect(contrast(oklch(t['--foreground']), oklch(t[surface]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(oklch(t['--muted-foreground']), oklch(t[surface]))).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Pasek boczny (E2): pigułka aktywnej pozycji to `--primary` 10% (jasny)
  // albo 20% (ciemny) na `--sidebar`.
  it('jasny: aktywna pozycja menu (`chart-3`) na pigułce `primary`/10 nad paskiem', () => {
    const pigulka = over(oklch(light['--primary']), 0.1, oklch(light['--sidebar']));
    expect(contrast(oklch(light['--chart-3']), pigulka)).toBeGreaterThanOrEqual(4.5);
  });

  it('ciemny: aktywna pozycja menu (`primary`) na pigułce `primary`/20 nad paskiem', () => {
    const pigulka = over(oklch(dark['--primary']), 0.2, oklch(dark['--sidebar']));
    expect(contrast(oklch(dark['--primary']), pigulka)).toBeGreaterThanOrEqual(4.5);
  });

  it('jasny: etykiety grup (`--sidebar-foreground`) na pasku', () => {
    expect(contrast(oklch(light['--sidebar-foreground']), oklch(light['--sidebar']))).toBeGreaterThanOrEqual(4.5);
  });

  it('jasny: inicjały avatara (`--accent-foreground`) na `primary`/10 nad tłem', () => {
    const tlo = over(oklch(light['--primary']), 0.1, oklch(light['--background']));
    expect(contrast(oklch(light['--accent-foreground']), tlo)).toBeGreaterThanOrEqual(4.5);
  });

  it('jasny: pierścień fokusu paska (`--sidebar-ring`) ma 3:1 względem paska (WCAG 1.4.11)', () => {
    expect(contrast(oklch(light['--sidebar-ring']), oklch(light['--sidebar']))).toBeGreaterThanOrEqual(3);
  });
});

describe('font i skala (D2)', () => {
  it('interfejs w Outfit z polskimi znakami, liczby w IBM Plex Mono', () => {
    expect(css).toContain('--font-sans: var(--font-outfit);');
    expect(css).toContain('--font-mono: var(--font-ibm-plex-mono);');
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/Outfit\(\{\s*variable: '--font-outfit',\s*subsets: \['latin', 'latin-ext'\]/);
  });

  it('skala SM na `.ff-dashboard`, nie na <html> (landing i logowanie bez zmian)', () => {
    const panel = block('.ff-dashboard');
    expect(panel['--spacing']).toBe('0.222222rem');
    expect(panel['--text-sm']).toBe('0.75rem');
    expect(css).not.toMatch(/^:root\s*{[^}]*--spacing:/m);
  });
});

describe('wątek FLO w dawnych kolorach (D4, kryterium E1)', () => {
  const pinLight = block(
    ".ff-flo-legacy,\n.ff-dashboard[data-slot='sheet-content']:has(section[aria-label='Co Flo zrobił'])",
  );
  const pinDark = block(
    "html.dark .ff-flo-legacy,\nhtml.dark .ff-dashboard[data-slot='sheet-content']:has(section[aria-label='Co Flo zrobił'])",
  );

  it.each([
    ['--ff-surface', '#ffffff', '#12171f'],
    ['--ff-border', '#e6e8ec', '#1c2230'],
    ['--ff-text-strong', '#0f172a', '#f4f6f8'],
    ['--ff-text-muted', '#64748b', '#8a94a3'],
    ['--ff-accent', '#2563eb', '#60a5fa'],
    ['--ff-cta-bg', '#2563eb', '#60a5fa'],
    ['--ff-cta-fg', '#ffffff', '#0b1b34'],
    ['--ff-surface-inset', '#f7f8fa', '#0d1117'],
  ])('%s: jasny %s, ciemny %s — jak przed E1', (name, l, d) => {
    expect(pinLight[name]).toBe(l);
    expect(pinDark[name]).toBe(d);
  });

  it('reszta panelu bierze `--ff-*` z presetu', () => {
    const panel = block('.ff-dashboard');
    expect(panel['--ff-surface']).toBe('var(--card)');
    expect(panel['--ff-accent']).toBe('var(--primary)');
    expect(panel['--ff-text-muted']).toBe('var(--muted-foreground)');
  });

  it('hak przypięcia istnieje: panel „Co Flo zrobił” w arkuszu; Pulpit bez FLO', () => {
    // Od 19.10.2026 Pulpit nie ma slotu FLO (strona Finance Finory) — hak
    // dawnych kolorów został tylko w arkuszu kolejki FLO.
    const page = readFileSync(join(ROOT, 'app/(dashboard)/dashboard/page.tsx'), 'utf8');
    expect(page).not.toMatch(/ff-flo-legacy|components\/flo\//);
    // Zmiana tej etykiety w pliku FLO odpina arkusz kolejki od dawnych kolorów.
    const history = readFileSync(join(ROOT, 'components/flo/flo-history-panel.tsx'), 'utf8');
    expect(history).toContain('aria-label="Co Flo zrobił"');
    const sheet = readFileSync(join(ROOT, 'components/flo/flo-queue-sheet.tsx'), 'utf8');
    expect(sheet).toContain('<FloHistoryPanel />');
  });
});
