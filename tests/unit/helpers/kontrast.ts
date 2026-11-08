import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Kontrast WCAG liczony z wartości oklch motywu aplikacji (`app/globals.css`)
 * i palety Tailwinda (`tailwindcss/theme.css`). Wspólny dla testów kontrastu
 * Finory (wyodrębniony z `faktury-cykliczne-lista-kontrast.test.tsx`).
 */

const ROOT = join(__dirname, '..', '..', '..');
const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
const twTheme = readFileSync(join(ROOT, 'node_modules/tailwindcss/theme.css'), 'utf8');

export type Rgb = [number, number, number];
export type Theme = Record<string, string>;

/** Zmienne `--…` z bloku `selector { … }` w `app/globals.css`. */
export function themeBlock(selector: string): Theme {
  const start = css.indexOf(`\n${selector} {\n`);
  if (start < 0) throw new Error(`brak bloku ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars: Theme = {};
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) vars[m[1]] = m[2].trim();
  return vars;
}

/** Zmienne motywu jasnego (`:root`) i ciemnego (`.dark`). */
export const themes = { jasny: themeBlock(':root'), ciemny: themeBlock('.dark') } as const;
export type ThemeName = keyof typeof themes;
export const THEME_NAMES = Object.keys(themes) as ThemeName[];

/** `oklch(0.55 0.22 262.96)` albo `oklch(55.5% 0.163 48.998)` → liniowe sRGB (obcięte do gamutu). */
export function oklch(value: string): Rgb {
  const m = /^oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`nie oklch: ${value}`);
  const l = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const [c, h] = [Number(m[3]), (Number(m[4]) * Math.PI) / 180];
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
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((x, i) => decode(encode(x) * alpha + encode(bg[i]) * (1 - alpha))) as Rgb;
}

/** Współczynnik kontrastu WCAG 2.x. */
export function contrast(x: Rgb, y: Rgb): number {
  const lum = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Token motywu aplikacji (`--primary` …) albo paleta Tailwinda (`amber-800`). */
export function color(token: string, theme: Theme): Rgb {
  const tw = new RegExp(`--color-${token}:\\s*(oklch\\([^)]+\\))`).exec(twTheme);
  if (tw) return oklch(tw[1]);
  const value = theme[`--${token}`];
  if (!value) throw new Error(`brak koloru ${token}`);
  return oklch(value);
}

/** `token` z kryciem `alpha` na karcie (`--card`) motywu. */
export function onCard(token: string, alpha: number, theme: Theme): Rgb {
  return over(color(token, theme), alpha, oklch(theme['--card']));
}

/** Tła, na których leży tekst w tabeli: karta, wiersz hover/menu (`muted/50`), wiersz zaznaczony (`muted`). */
export function rowBackgrounds(theme: Theme): Record<string, Rgb> {
  const card = oklch(theme['--card']);
  const muted = oklch(theme['--muted']);
  return { karta: card, 'wiersz hover/menu': over(muted, 0.5, card), 'wiersz zaznaczony': over(muted, 1, card) };
}
