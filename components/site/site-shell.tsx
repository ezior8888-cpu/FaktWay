import type { ReactNode } from 'react';

import { SiteMotion } from './motion';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * Układ stron przed logowaniem: nagłówek, treść, stopka, wspólne ustawienia
 * animacji. Motyw aplikacji (jasny i ciemny), bez osobnej palety.
 */
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <SiteMotion>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </div>
    </SiteMotion>
  );
}
