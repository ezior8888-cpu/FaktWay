import { Suspense } from 'react';

import { InvoiceStatTiles } from '@/app/(dashboard)/invoices/_components/invoice-stat-tiles';
import { RecurringDueBanner } from '@/app/(dashboard)/invoices/_components/recurring-due-banner';
import { INVOICES_TABS } from '@/components/invoices/invoices-tabs';
import { SectionTabsNav } from '@/components/lists/section-tabs-nav';
import { Card } from '@/components/ui/card';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { getPageContext } from '@/lib/supabase/page-context';

/**
 * Sekcja Faktur: Wystawione (`/invoices`), Cykliczne (`/invoices/recurring`)
 * i Po terminie (`/payments/overdue`) — jedna strona z tabelą, nie trzy
 * podstrony (poprawka Bartosza 25.10.2026: „chcę, żeby zmieniała się sama
 * tabelka, a nie cała strona”).
 *
 * Grupa tras `(faktury)` nie zmienia adresów. Layout NIE renderuje się
 * ponownie przy przejściu między zakładkami, więc baner, kafle, karta i rząd
 * zakładek stoją w miejscu, bez szkieletów i bez animacji całej strony
 * (szablon `(dashboard)/template.tsx` widzi ten sam segment `(faktury)`).
 * Strona zakładki to zawartość karty (`.ff-tab-panel`).
 *
 * Kafle są jedne dla całej sekcji (decyzja Bartosza 25.10.2026). Liczby
 * właściwe tylko „Po terminie” stoją w pasku nad jej tabelą. Podgląd faktury
 * i kreator (`invoices/[id]`, `invoices/new`) zostają poza grupą — mają
 * własny układ.
 */
export default async function FakturyLayout({ children }: { children: React.ReactNode }) {
  const { supabase, tenantId } = await getPageContext();
  const today = todayInWarsaw();

  return (
    <div className="ff-page-fill flex flex-col gap-6">
      {/* N1: ile faktur cyklicznych czeka na wystawienie. Własny odczyt w Suspense — nie wstrzymuje sekcji, a jego błąd jej nie psuje. */}
      <Suspense fallback={null}>
        <RecurringDueBanner supabase={supabase} tenantId={tenantId} today={today} />
      </Suspense>

      <InvoiceStatTiles supabase={supabase} tenantId={tenantId} />

      <Card className="flex-1 pt-0 shadow-none">
        <SectionTabsNav label="Rodzaje faktur" tabs={INVOICES_TABS} />
        {children}
      </Card>
    </div>
  );
}
