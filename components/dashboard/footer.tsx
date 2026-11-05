import Link from 'next/link';

import { FooterHelpButton } from '@/components/dashboard/footer-help-button';

// Na telefonie link ma 44 px wysokości: bez tego trzy linki stopki miały po 17 px
// i trudno było w nie trafić kciukiem. Piksele, nie `min-h-11`: korzeń ma tu
// 14 px, więc `h-11` daje 38,5 px.
const LINK_CLASS =
  'text-muted-foreground transition-colors duration-300 hover:text-foreground max-sm:inline-flex max-sm:min-h-[44px] max-sm:min-w-[44px] max-sm:items-center max-sm:justify-center';

/**
 * Stopka panelu (plan Finora P0, E2) — wygląd `Footer.tsx` z szablonu, treść
 * nasza: „© FaktWay · Regulamin · Polityka prywatności · Pomoc”.
 *
 * Stoi jako drugie dziecko `.ff-shell-scroll` (kolumna flex, kontener treści
 * rośnie), więc zawsze jest na samym dole strony — także na krótkiej.
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="ff-shell-footer">
      <div className="mx-auto flex w-full max-w-[1500px] items-center justify-between gap-3 px-4 py-3 text-sm max-sm:flex-col sm:gap-6 sm:px-[var(--ff-container-padding)] lg:pr-[100px]">
        <p className="text-muted-foreground text-balance max-sm:text-center">
          © {year} FaktWay
        </p>
        <nav aria-label="Stopka" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
          <Link href="/legal/regulamin" prefetch={false} className={LINK_CLASS}>
            Regulamin
          </Link>
          <Link
            href="/legal/polityka-prywatnosci"
            prefetch={false}
            className={LINK_CLASS}
          >
            Polityka prywatności
          </Link>
          <FooterHelpButton className={`${LINK_CLASS} cursor-pointer`} />
        </nav>
      </div>
    </footer>
  );
}
