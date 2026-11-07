import { SectionTabsNav } from '@/components/lists/section-tabs-nav';
import { zakladkiKsiegowosci, type ObszaryKsiegowosci } from '@/components/reports/ksiegowosc-tabs';
import { Card } from '@/components/ui/card';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { getPageContext } from '@/lib/supabase/page-context';

/**
 * Sekcja Księgowości: KPiR (`/reports/kpir`) i Eksport (`/reports/exports`)
 * — jedna strona, nie dwie podstrony (poprawka Bartosza 25.10.2026).
 *
 * Rząd zakładek stoi u góry sekcji, w smukłej karcie, i nie zmienia się przy
 * przełączaniu: layout nie renderuje się ponownie, a strona zakładki
 * (`.ff-tab-panel`) podmienia się pod nim. Inaczej niż na Fakturach
 * i Kosztach zakładki nie siedzą w karcie z tabelą — KPiR i Eksport nie mają
 * wspólnej tabeli (księga z paskiem miesiąca i podsumowaniem kontra formularz
 * nowego pliku i historia), więc wspólny jest tylko rząd zakładek. Dawniej
 * siedział w karcie każdej z nich i przy przełączeniu skakał o kilkaset
 * pikseli w pionie.
 *
 * Plan księgowości JDG (K2, K3): firma w pilotażu dostaje zakładki
 * „Ewidencja” i „Ustawienia podatkowe”. Błąd odczytu wyłącznika chowa tylko
 * je, a KPiR i Eksport działają jak dotąd.
 */
export default async function KsiegowoscLayout({ children }: { children: React.ReactNode }) {
  const tabs = zakladkiKsiegowosci(await widoczneObszary());
  return (
    <div className="ff-page-fill flex flex-col gap-6">
      <Card className="gap-0 py-0 shadow-none">
        <SectionTabsNav label="Księgowość" tabs={tabs} className="border-b-0" />
      </Card>
      {children}
    </div>
  );
}

async function widoczneObszary(): Promise<ObszaryKsiegowosci> {
  // Poza try: przekierowanie na logowanie z getPageContext musi przejść dalej.
  const ctx = await getPageContext();
  const czy = async (obszar: 'ewidencja' | 'ustawienia') => {
    try {
      return (await czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, obszar)).wlaczony;
    } catch {
      return false;
    }
  };
  const [ewidencja, ustawienia] = await Promise.all([czy('ewidencja'), czy('ustawienia')]);
  return { ewidencja, ustawienia };
}
