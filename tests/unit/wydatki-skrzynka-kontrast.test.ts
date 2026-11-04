import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SOURCE_LABELS, SOURCE_STYLES } from '@/components/expenses/finora/labels';

/**
 * Plakietki „Źródło” Wydatków (P8 ← Finora `TRANSACTION_GROUP_STYLES`):
 * tekst 12 px na karcie, więc WCAG AA 4,5:1 w OBU motywach (§10.2 pkt 1).
 * U nas `chart-2`/`chart-3` to niebieskie odcienie presetu, nie zielenie
 * Finory — w ciemnym motywie same miały ok. 3,6:1 i 2,7:1.
 * Pomocnicze funkcje koloru jak w `finora-motyw.test.ts`.
 */

const css = readFileSync(join(__dirname, '..', '..', 'app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {\n`);
  expect(start, `brak bloku ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) vars[m[1]] = m[2].trim();
  return vars;
}

type Rgb = [number, number, number];

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

function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((x, i) => decode(encode(x) * alpha + encode(bg[i]) * (1 - alpha))) as Rgb;
}

function contrast(x: Rgb, y: Rgb): number {
  const lum = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Klasa `text-…` i `bg-…[/N]` dla motywu (warianty `dark:` mają pierwszeństwo w ciemnym). */
function badgeColors(classes: string, theme: 'light' | 'dark') {
  const tokens = classes.split(/\s+/);
  const pick = (prefix: 'text-' | 'bg-') => {
    const plain = tokens.find((t) => t.startsWith(prefix));
    const darkVariant = tokens.find((t) => t.startsWith(`dark:${prefix}`))?.slice(5);
    return theme === 'dark' ? (darkVariant ?? plain) : plain;
  };
  const text = pick('text-')!.slice(5);
  const [bgName, bgAlpha] = pick('bg-')!.slice(3).split('/');
  return { text, bg: bgName!, alpha: bgAlpha ? Number(bgAlpha) / 100 : 1 };
}

describe('plakietki „Źródło” — kontrast WCAG AA na karcie', () => {
  for (const theme of ['light', 'dark'] as const) {
    const vars = block(theme === 'light' ? ':root' : '.dark');
    for (const [source, classes] of Object.entries(SOURCE_STYLES)) {
      it(`${theme}: ${SOURCE_LABELS[source as keyof typeof SOURCE_LABELS]} ≥ 4,5:1`, () => {
        const { text, bg, alpha } = badgeColors(classes, theme);
        const card = oklch(vars['--card']!);
        const surface = over(oklch(vars[`--${bg}`]!), alpha, card);
        expect(contrast(oklch(vars[`--${text}`]!), surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
