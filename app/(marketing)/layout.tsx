import type { Metadata } from 'next';

import { SiteShell } from '@/components/site/site-shell';

import { fraunces } from './_fonts';

export const metadata: Metadata = {
  title: {
    default: 'FaktWay',
    template: '%s | FaktWay',
  },
};

/**
 * Layout stron marketingowych: O nas, blog, cennik, pomoc, dokumenty prawne,
 * kontakt, kalkulator, porównania.
 *
 * Od 23.10.2026 ten sam nagłówek, stopka i animacje co strona główna
 * (`components/site`), na tokenach aplikacji. Wcześniej strony brały
 * elementy szablonu Zova i paletę `.marketing-landing`.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Nowy wygląd stron (#318) + Fraunces tylko w marketingu (#326): zmienna
  // `--font-fraunces` na elemencie `contents`, więc nie dodaje pudełka do układu.
  return (
    <div className={`${fraunces.variable} contents`}>
      <SiteShell>{children}</SiteShell>
    </div>
  );
}
