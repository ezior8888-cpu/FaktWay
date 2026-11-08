import { LOCKUP, MARK } from '@/lib/brand/faktway-logo-paths';
import { cn } from '@/lib/utils';

/**
 * Logo FaktWay (zestaw i instrukcja: docs/brand/logo). Wbudowany SVG, bez
 * zapytania o plik i bez fontu: napis jest rysunkiem.
 *
 * `tone='brand'`: niebieski znak i granatowy napis; w trybie ciemnym jasny
 * niebieski znak i biały napis w odchudzonej wersji (jasny kształt na ciemnym
 * tle optycznie puchnie). `tone='inverse'`: całe białe, na niebieskie tło.
 * Rozmiar ustala `className` przez wysokość (np. `h-7`), szerokość idzie za nią.
 */

const BLUE = '#2463EF';
const NAVY = '#0D1936';
const LIGHT = '#61A4F7';
const WHITE = '#FFFFFF';

type LogoProps = {
  className?: string;
  tone?: 'brand' | 'inverse';
};

export function FaktWayLogo({ className, tone = 'brand' }: LogoProps) {
  const { symbol, wordmark } = LOCKUP;
  return (
    <svg
      viewBox={LOCKUP.viewBox}
      role="img"
      aria-label="FaktWay"
      className={cn('h-7 w-auto shrink-0', className)}
    >
      {tone === 'inverse' ? (
        <g fill={WHITE}>
          <path d={symbol.reversed} />
          <path d={wordmark.reversed} transform={wordmark.transform} />
        </g>
      ) : (
        <>
          <g className="dark:hidden">
            <path fill={BLUE} d={symbol.brand} />
            <path fill={NAVY} d={wordmark.brand} transform={wordmark.transform} />
          </g>
          <g className="hidden dark:inline">
            <path fill={LIGHT} d={symbol.reversed} />
            <path fill={WHITE} d={wordmark.reversed} transform={wordmark.transform} />
          </g>
        </>
      )}
    </svg>
  );
}

/** Sam znak: tam, gdzie pełne logo się nie mieści (zwinięty pasek boczny). */
export function FaktWayMark({ className, tone = 'brand' }: LogoProps) {
  return (
    <svg
      viewBox={MARK.viewBox}
      role="img"
      aria-label="FaktWay"
      className={cn('size-7 shrink-0', className)}
    >
      {tone === 'inverse' ? (
        <path fill={WHITE} d={MARK.reversed} />
      ) : (
        <>
          <path className="dark:hidden" fill={BLUE} d={MARK.brand} />
          <path className="hidden dark:inline" fill={LIGHT} d={MARK.reversed} />
        </>
      )}
    </svg>
  );
}
