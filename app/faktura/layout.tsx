import type { Metadata } from 'next';

/**
 * Strona faktury dla nabywcy (`/faktura/<token>`, krok 2.10). Jak portal
 * księgowej (`app/accountant/layout.tsx`): token jest w adresie, więc
 * `<meta name="referrer" content="no-referrer">` i bez indeksowania. Te same
 * zasady jako nagłówki HTTP dokłada proxy (`lib/supabase/middleware.ts`).
 * Tytuł bez numeru faktury i nazwy firmy: podgląd linku w komunikatorze nie
 * powinien ich pokazywać.
 */
export const metadata: Metadata = {
  title: 'Faktura | FaktWay',
  referrer: 'no-referrer',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function BuyerInvoiceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
