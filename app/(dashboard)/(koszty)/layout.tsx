import { COSTS_TABS } from '@/components/expenses/costs-tabs';
import {
  ExpensesGrossCell,
  ExpensesToReviewCell,
  ExpensesVatCell,
} from '@/components/expenses/finora/expense-stat-cells';
import { StatSlot } from '@/components/expenses/finora/stat-slot';
import { StatsCardsFrame } from '@/components/expenses/finora/stats-cards';
import { SectionTabsNav } from '@/components/lists/section-tabs-nav';
import { Card } from '@/components/ui/card';
import { parseExpenseMonth } from '@/lib/expenses/month';
import { getPageContext } from '@/lib/supabase/page-context';

import { InboxLastFetchCell } from './inbox/_components/inbox-stat-cells';

/** Podpis kafla wydatków w sekcji: kafle liczą bieżący miesiąc, nie miesiąc z filtra tabeli. */
const GROSS_LABEL = 'Wydatki w tym miesiącu';

/**
 * Sekcja Kosztów: Wydatki (`/expenses`) i Skrzynka KSeF (`/inbox`) — jedna
 * strona z tabelą, nie dwie podstrony (poprawka Bartosza 25.10.2026: „nie
 * chcę, żeby cała strona się zmieniała, tylko sama tabelka”).
 *
 * Grupa tras `(koszty)` nie zmienia adresów. Layout nie renderuje się ponownie
 * przy zmianie zakładki, więc kafle, karta i rząd zakładek stoją w miejscu;
 * strona zakładki to zawartość karty (`.ff-tab-panel`). Podgląd wydatku
 * (`expenses/[id]`) zostaje poza grupą.
 *
 * Kafle są jedne dla sekcji (decyzja Bartosza 25.10.2026): wydatki i VAT
 * bieżącego miesiąca, wydatki do opisania i ostatnie pobranie z KSeF —
 * z dawnych zestawów Wydatków i Skrzynki po dwa najważniejsze. Wybór
 * miesiąca i „Miesiąc / Do opisania” filtrują tylko tabelę Wydatków, więc
 * stoją w jej pasku, w karcie.
 */
export default async function KosztyLayout({ children }: { children: React.ReactNode }) {
  const { supabase, tenantId, user } = await getPageContext();
  const month = parseExpenseMonth(undefined);
  const props = { supabase, tenantId, month };

  return (
    <div className="ff-page-fill flex flex-col gap-6">
      <StatsCardsFrame
        className="shadow-none"
        cells={[
          <StatSlot key="gross" label={GROSS_LABEL}>
            <ExpensesGrossCell {...props} label={GROSS_LABEL} />
          </StatSlot>,
          <StatSlot key="vat" label="VAT do odliczenia">
            <ExpensesVatCell {...props} />
          </StatSlot>,
          <StatSlot key="review" label="Do opisania">
            <ExpensesToReviewCell supabase={supabase} tenantId={tenantId} />
          </StatSlot>,
          <StatSlot key="last" label="Ostatnie pobranie z KSeF">
            <InboxLastFetchCell supabase={supabase} tenantId={tenantId} user={user} />
          </StatSlot>,
        ]}
      />

      <Card className="flex-1 pt-0">
        <SectionTabsNav label="Rodzaje kosztów" tabs={COSTS_TABS} />
        {children}
      </Card>
    </div>
  );
}
