import { renderToStaticMarkup } from 'react-dom/server';
import { FileText } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import type { VariantProps } from 'class-variance-authority';
import { describe, expect, it } from 'vitest';

import { FinoraEmpty } from '@/components/analizy/finora-1do1/finora-empty';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { PulpitEmptyState } from '@/components/dashboard/pulpit/card-states';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * Link w stylu przycisku (`<Link className={buttonVariants(...)}>`) wygląda
 * tak samo jak `<Button>`.
 *
 * Błąd: baza cva ma `border border-transparent`, a wariant `outline`
 * `border-border`. `Button` scala klasy przez `cn()` (tailwind-merge) i zostaje
 * samo `border-border`. Wywołanie `buttonVariants` bez `cn()` zostawiało oba
 * kolory. Oba ustawiają tę samą właściwość, a Tailwind układa takie klasy po
 * nazwie: `border-transparent` ląduje w arkuszu później i wygrywa (build
 * z 08.11: `.border-border` na pozycji 61 807, `.border-transparent` na 65 341). W jasnym motywie
 * link traci ramkę, a ciemny ratuje `dark:border-input`. Tak było w 16 miejscach,
 * m.in. „Dodaj kolejną organizację” (/settings) i „Importuj historię” (/invoices).
 * Pięć miejsc łatało to własnym `cn()` (KPiR, Należności, Eksporty, `app/error.tsx`).
 *
 * Naprawa u źródła: `buttonVariants` zwraca klasy już scalone. Testy sprawdzają
 * każdą parę wariant × rozmiar, a nie tylko outline, bo ta sama baza psuła też
 * ikony w linkach `xs`/`sm` (`size-4` z bazy obok `size-3` z rozmiaru)
 * i kolor obwódki fokusu w `destructive`.
 */

type Variant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
type Size = NonNullable<VariantProps<typeof buttonVariants>['size']>;

// `satisfies Record<…>`: nowy wariant albo rozmiar w `button.tsx` bez wpisu tutaj
// nie przejdzie typecheck, więc test zawsze obejmuje całą macierz.
const VARIANTS = Object.keys({
  default: 1,
  outline: 1,
  secondary: 1,
  ghost: 1,
  destructive: 1,
  link: 1,
  glass: 1,
  'glass-primary': 1,
} satisfies Record<Variant, 1>) as Variant[];
const SIZES = Object.keys({
  default: 1,
  xs: 1,
  sm: 1,
  lg: 1,
  icon: 1,
  'icon-xs': 1,
  'icon-sm': 1,
  'icon-lg': 1,
} satisfies Record<Size, 1>) as Size[];

const PARY: Array<{ variant?: Variant; size?: Size }> = [
  {},
  ...VARIANTS.flatMap((variant) => [{ variant }, ...SIZES.map((size) => ({ variant, size }))]),
  ...SIZES.map((size) => ({ size })),
];

const klasy = (s: string) => s.split(/\s+/).filter(Boolean);

/** Atrybut z `renderToStaticMarkup` ma `&amp;` i `&#x27;` (klasy `[&_svg:not([class*='size-'])]`). */
const odkoduj = (s: string) =>
  s.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function klasyPrzycisku(props: { variant?: Variant; size?: Size }): string[] {
  const html = renderToStaticMarkup(<Button {...props}>x</Button>);
  return klasy(odkoduj(/class="([^"]*)"/.exec(html)![1]!));
}

/** Klasy każdego `<a>` na stronie. */
function klasyLinkow(html: string): string[][] {
  return [...html.matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => klasy(odkoduj(m[1]!)));
}

describe('buttonVariants: link w stylu przycisku = <Button>', () => {
  it.each(PARY)('klasy już scalone, bez dwóch klas na tę samą właściwość: %o', (props) => {
    const k = buttonVariants(props);
    expect(klasy(k)).toEqual(klasy(twMerge(k)));
  });

  it.each(PARY)('te same klasy co <Button>: %o', (props) => {
    expect(new Set(klasy(buttonVariants(props)))).toEqual(new Set(klasyPrzycisku(props)));
  });

  it('outline: ramka w jasnym motywie (`border-border`, bez `border-transparent`)', () => {
    for (const size of [undefined, ...SIZES]) {
      const k = klasy(buttonVariants({ variant: 'outline', size }));
      expect(k).toContain('border-border');
      expect(k).not.toContain('border-transparent');
    }
  });

  it('linki outline w prawdziwych komponentach mają jeden kolor ramki', () => {
    const strony = [
      renderToStaticMarkup(<MfaStepUpNotice returnTo="/settings/account">Ta operacja wymaga kodu.</MfaStepUpNotice>),
      renderToStaticMarkup(<FinoraEmpty message="Brak faktur" action={{ label: 'Wystaw fakturę', href: '/invoices/new' }} pad="py-6" />),
      renderToStaticMarkup(<PulpitEmptyState message="Brak faktur" action={{ label: 'Wystaw fakturę', href: '/invoices/new' }} />),
      renderToStaticMarkup(
        <EmptyState
          icon={FileText}
          title="Brak faktur"
          primaryAction={{ type: 'link', label: 'Wystaw fakturę', href: '/invoices/new' }}
          secondaryAction={{ type: 'link', label: 'Importuj historię', href: '/onboarding/import-source' }}
        />,
      ),
    ];
    for (const html of strony) {
      const obrysowane = klasyLinkow(html).filter((k) => k.includes('border-border'));
      expect(obrysowane.length).toBeGreaterThan(0);
      for (const k of obrysowane) expect(k).not.toContain('border-transparent');
    }
  });
});
