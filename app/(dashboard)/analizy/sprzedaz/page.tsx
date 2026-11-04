import { AnalizyHeader } from '@/components/analizy/analizy-header';
import { SprzedazGrid } from '@/components/analizy/sprzedaz-grid';
import {
  ANALYTICS_MONTH_PARAM,
  analyticsMonthOptions,
  currentMonthKey,
  resolveAnalyticsMonth,
} from '@/lib/analytics-finance/months';
import { kontekstDanych } from '@/lib/demo/tryb-danych';
import { getPageContext } from '@/lib/supabase/page-context';

/**
 * Analiza sprzedaży (plan Finora P11 ← Finora `money-management/monthly-analytics`).
 * Poprawka Bartosza 21.10.2026 (Analizy 1:1 z Finory): ta sama siatka
 * 9 kart co Monthly Analytics, bez dodatkowego wiersza; z analizą kosztów
 * łączy ją przełącznik „Sprzedaż | Koszty” w nagłówku (jedna pozycja menu).
 * Strona nie liczy niczego sama (§2.4 pkt 15): każda karta w `SprzedazGrid`
 * pobiera dane osobno. Wybrany miesiąc w adresie: `?miesiac=RRRR-MM`.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Analiza sprzedaży' };

export default async function AnalizaSprzedazyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [pageCtx, params] = await Promise.all([getPageContext(), searchParams]);
  const now = new Date();
  // Przed weryfikacją KSeF: dane przykładowe; tryb liczy lib/demo/tryb-danych.ts.
  const { supabase, tenantId, demo, tryb, kosztyKsefOd } = await kontekstDanych(pageCtx, now);
  const month = resolveAnalyticsMonth(params[ANALYTICS_MONTH_PARAM], now);

  return (
    // Ciemny motyw: w naszym `.dark` `--muted` == `--card`, więc Finorowe
    // `bg-muted` (wiersze, kółka ikon, tor paska, puste pola kalendarza)
    // znikałyby na karcie. Na tej stronie `--muted` dostaje kolor wnęki
    // (`--background`, jak `--ff-surface-inset`); znaczniki Finory bez zmian.
    // Ładowanie jak Pulpit (poprawka Bartosza 23.10.2026): strona czeka na
    // wszystkie karty i wchodzi RAZ, w całości, z animacją `ff-route-content`.
    <div className="ff-route-content space-y-6 dark:[--muted:var(--background)]">
      <AnalizyHeader
        mode="sprzedaz"
        demo={demo}
        options={analyticsMonthOptions(now)}
        month={month}
        currentMonth={currentMonthKey(now)}
      />
      <SprzedazGrid supabase={supabase} tenantId={tenantId} nowIso={now.toISOString()} month={month} tryb={tryb} kosztyKsefOd={kosztyKsefOd} />
    </div>
  );
}
