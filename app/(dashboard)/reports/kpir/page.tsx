import { KpirView } from '@/components/expenses/kpir-view';
import { KpirBlocked } from '@/components/reports/kpir/kpir-blocked';
import { blockingSaleInvoices, kpirMonthTitle } from '@/components/reports/kpir/kpir-model';
import { KpirToolbar } from '@/components/reports/kpir/kpir-toolbar';
import { Card } from '@/components/ui/card';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { kpirPrzykladowe, trybDanych } from '@/lib/demo/tryb-danych';
import { getKpirData, resolveKpirPeriod } from '@/lib/reports/kpir-data';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * KPiR — zakładka „KPiR” ekranu Księgowość (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości). Dane czyta `getKpirData`
 * (`lib/reports/kpir-data.ts`) — logika bez zmian i BEZ try/catch: błąd
 * środowiska KSeF albo proweniencji ma wywrócić stronę do `error.tsx`, a nie
 * pokazać księgi z niepełnymi danymi.
 *
 * Zawartość zakładki „KPiR” (rząd zakładek Księgowości stoi nad nią
 * w `reports/layout.tsx`): tytuł dla czytników, pasek miesiąca, karty, na
 * końcu karta księgi sięgająca stopki. Dzieci
 * korzenia to zwykłe warunki (bez fragmentu): test strefy czasowej szuka
 * wśród nich `KpirView` po liczbowym `month`, więc pasek i blokada dostają
 * `period`. Waluta nie do potwierdzenia: pasek miesiąca i „Raport
 * wstrzymany” w karcie z zakładkami — bez kwot.
 */
export default async function KpirPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await getPageContext();
  const { supabase, tenantId } = ctx;
  // Poprawka Bartosza 21.10.2026: przed weryfikacją KSeF księga z danymi
  // przykładowymi (lib/demo/kpir-przykladowe.ts) i plakietką — klient widzi
  // pełną okazałość ekranu. Prawdziwych danych wtedy nie czytamy. Decyzję
  // podejmuje jedna funkcja trybu (lib/demo/tryb-danych.ts, Z15).
  if ((await trybDanych(ctx, new Date())).tryb === 'przyklad') {
    const { month, year } = resolveKpirPeriod(sp);
    const demo = kpirPrzykladowe(month, year);
    return (
      <div className="ff-tab-panel flex flex-1 flex-col gap-6">
        <h1 className="sr-only">Książka przychodów i rozchodów</h1>
        <KpirView key={`${year}-${month}`} month={month} year={year} expenses={demo.expenses} invoices={demo.invoices} today={todayInWarsaw()} demo />
      </div>
    );
  }
  const data = await getKpirData(supabase, tenantId, sp);
  const period = `${data.year}-${String(data.month).padStart(2, '0')}`;
  const today = todayInWarsaw();
  const blockedMessage = data.currencyBlocked;
  const blocked = blockedMessage !== null;

  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6">
      <h1 className="sr-only">Książka przychodów i rozchodów</h1>
      {blocked ? (
        <KpirToolbar period={period} currentMonth={today.slice(0, 7)} monthTitle={kpirMonthTitle(data.month, data.year)} />
      ) : null}
      {blocked ? (
        <Card className="flex-1">
          <KpirBlocked
            message={blockedMessage}
            period={period}
            blockingInvoices={blockingSaleInvoices(data.invoices)}
          />
        </Card>
      ) : null}
      {!blocked ? (
        // `key` na miesiąc: Next 16 trzyma stan strony bez parametrów adresu,
        // więc bez klucza segment („Do sprawdzenia”), filtr kolumny, szukanie
        // i strona tabeli przechodziły na następny miesiąc — także tam, gdzie
        // takiego segmentu nie ma, z pustą księgą (poprawka Bartosza 21.10.2026:
        // przeprojektowanie Księgowości).
        <KpirView
          key={period}
          month={data.month}
          year={data.year}
          expenses={data.expenses}
          invoices={data.invoices}
          settledError={data.settledError}
          today={today}
        />
      ) : null}
    </div>
  );
}
