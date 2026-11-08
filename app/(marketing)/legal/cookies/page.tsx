import type { Metadata } from 'next';

import { CookieSettings } from '@/components/legal/cookie-settings';
import { LegalDocumentView } from '@/components/legal/legal-page';
import { POLITYKA_COOKIES } from '@/lib/legal/documents';

export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'Polityka cookies',
  description: 'Jakie pliki cookies i dane w przeglądarce zapisuje FaktWay oraz jak zmienić zgodę na analitykę.',
};

export default function CookiesPage() {
  return (
    <LegalDocumentView doc={POLITYKA_COOKIES}>
      <section id="ustawienia" className="not-prose my-10 scroll-mt-8 rounded-2xl bg-card p-6 ring-1 ring-border sm:p-8">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Twoje ustawienia</h2>
        <CookieSettings />
      </section>
    </LegalDocumentView>
  );
}
