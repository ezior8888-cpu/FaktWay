import { Fraunces } from 'next/font/google';

/**
 * Fraunces — display serif stron marketingowych (klasy `.font-editorial`
 * i `.editorial-section-num` w `app/globals.css`). Poza `(marketing)` nikt
 * go nie używa: panel stoi na Outfit, strona główna i logowanie też go nie
 * mają.
 *
 * Do 24.10.2026 był zadeklarowany w `app/layout.tsx`. `next/font` preładowuje
 * każdy font z layoutu na wszystkich trasach pod nim, więc panel na każdej
 * stronie pobierał dwa pliki Fraunces (~220 KB), których nie rysował. Teraz
 * zmienną `--font-fraunces` ustawia wyłącznie `(marketing)/layout.tsx`.
 *
 * `latin-ext` jest KRYTYCZNE — polskie znaki (ą, ć, ę, ł, ń, ó, ś, ź, ż)
 * nie są w podstawowym `latin`. `opsz` = optical sizing dla naturalnych
 * rozmiarów display, `SOFT` = wariacja miękkości krawędzi serifów.
 */
export const fraunces = Fraunces({
  variable: '--font-fraunces',
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  axes: ['opsz', 'SOFT'],
});
