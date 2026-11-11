import { renderToStaticMarkup } from 'react-dom/server';
import { twMerge } from 'tailwind-merge';
import type { VariantProps } from 'class-variance-authority';
import { describe, expect, it } from 'vitest';

import { Badge, badgeVariants } from '@/components/ui/badge';

/**
 * Element w stylu odznaki (`<span className={badgeVariants(...)}>`, `<Link>`)
 * wygląda tak samo jak `<Badge>`.
 *
 * Błąd: baza cva ma `border border-transparent` i `focus-visible:ring-ring/50`,
 * wariant `outline` dodaje `border-border`, a `destructive`
 * `focus-visible:ring-destructive/20`. `Badge` scala klasy przez `cn()`
 * (tailwind-merge) i zostaje klasa wariantu. Wywołanie `badgeVariants` bez
 * `cn()` zostawiało obie. Ustawiają tę samą właściwość, a o wyniku decyduje
 * kolejność reguł w arkuszu Tailwinda, nie w atrybucie `class`: w obu parach
 * klasa bazy stoi później i wygrywa (kompilacja `app/globals.css` z 09.11:
 * `.border-border` 74 373, `.border-transparent` 78 917;
 * `.focus-visible:ring-destructive/20` 194 592, `.focus-visible:ring-ring/50`
 * 195 815). Odznaka outline traci wtedy ramkę w obu motywach (w odróżnieniu od
 * przycisku nie ma `dark:` dla ramki), a destructive w jasnym motywie dostaje
 * zwykłą obwódkę fokusu zamiast czerwonej. To ta sama przyczyna co
 * w `buttonVariants` (PR #536, test `przycisk-link-ramka`).
 *
 * Dziś błąd jest uśpiony: jedyne wywołanie poza `components/ui`
 * (`components/invoices/status-badge.tsx`) idzie przez `cn()` z wariantem
 * `secondary`. Naprawa u źródła: `badgeVariants` zwraca klasy już scalone.
 */

type Variant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

// `satisfies Record<…>`: nowy wariant w `badge.tsx` bez wpisu tutaj nie
// przejdzie typecheck, więc test zawsze obejmuje wszystkie warianty.
const VARIANTS = Object.keys({
  default: 1,
  secondary: 1,
  destructive: 1,
  outline: 1,
  ghost: 1,
  link: 1,
} satisfies Record<Variant, 1>) as Variant[];

const PROPSY: Array<{ variant?: Variant }> = [{}, ...VARIANTS.map((variant) => ({ variant }))];

const klasy = (s: string) => s.split(/\s+/).filter(Boolean);

/** Atrybut z `renderToStaticMarkup` ma `&amp;` i `&gt;` (klasy `[&>svg]:size-3!`). */
const odkoduj = (s: string) =>
  s.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function klasyOdznaki(props: { variant?: Variant }): string[] {
  const html = renderToStaticMarkup(<Badge {...props}>x</Badge>);
  return klasy(odkoduj(/class="([^"]*)"/.exec(html)![1]!));
}

describe('badgeVariants: element w stylu odznaki = <Badge>', () => {
  it.each(PROPSY)('klasy już scalone, bez dwóch klas na tę samą właściwość: %o', (props) => {
    const k = badgeVariants(props);
    expect(klasy(k)).toEqual(klasy(twMerge(k)));
  });

  it.each(PROPSY)('te same klasy co <Badge>: %o', (props) => {
    expect(new Set(klasy(badgeVariants(props)))).toEqual(new Set(klasyOdznaki(props)));
  });

  it('bez argumentów: wariant domyślny, klasy już scalone', () => {
    expect(new Set(klasy(badgeVariants()))).toEqual(new Set(klasyOdznaki({})));
  });

  it('outline: ma ramkę (`border-border`, bez `border-transparent`)', () => {
    const k = klasy(badgeVariants({ variant: 'outline' }));
    expect(k).toContain('border-border');
    expect(k).not.toContain('border-transparent');
  });

  it('destructive: czerwona obwódka fokusu (bez `focus-visible:ring-ring/50` z bazy)', () => {
    const k = klasy(badgeVariants({ variant: 'destructive' }));
    expect(k).toContain('focus-visible:ring-destructive/20');
    expect(k).not.toContain('focus-visible:ring-ring/50');
  });
});
