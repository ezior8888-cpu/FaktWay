import { SectionTabsNav } from '@/components/lists/section-tabs-nav';
import { KSIEGOWOSC_TABS } from '@/components/reports/ksiegowosc-tabs';
import { Card } from '@/components/ui/card';

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
 */
export default function KsiegowoscLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="ff-page-fill flex flex-col gap-6">
      <Card className="gap-0 py-0 shadow-none">
        <SectionTabsNav label="Księgowość" tabs={KSIEGOWOSC_TABS} className="border-b-0" />
      </Card>
      {children}
    </div>
  );
}
