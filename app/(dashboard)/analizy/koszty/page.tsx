import { AnalizyHeader } from '@/components/analizy/analizy-header';
import { KosztyGrid } from '@/components/analizy/koszty-grid';
import {
  ANALYTICS_MONTH_PARAM,
  analyticsMonthOptions,
  currentMonthKey,
  resolveAnalyticsMonth,
} from '@/lib/analytics-finance/months';
import { kontekstDanych } from '@/lib/demo/tryb-danych';
import { getPageContext } from '@/lib/supabase/page-context';

/**
 * Analiza kosztów (plan Finora P10 ← Finora `money-management/monthly-analytics`).
 * Poprawka Bartosza 21.10.2026 (Analizy 1:1 z Finory): siatka 9 kart jak
 * Monthly Analytics; z analizą sprzedaży łączy ją przełącznik „Sprzedaż |
 * Koszty” w nagłówku (jedna pozycja menu „Analizy”).
 * Strona nie liczy niczego sama (§2.4 pkt 15): każda karta w `KosztyGrid`
 * pobiera dane osobno, więc awaria jednego odczytu zabiera jedną kartę.
 * Wybrany miesiąc w adresie: `?miesiac=RRRR-MM` (Finora: `?month=`).
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Analiza kosztów' };

export default async function AnalizaKosztowPage({
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
        mode="koszty"
        demo={demo}
        options={analyticsMonthOptions(now)}
        month={month}
        currentMonth={currentMonthKey(now)}
      />
      <KosztyGrid supabase={supabase} tenantId={tenantId} nowIso={now.toISOString()} month={month} tryb={tryb} kosztyKsefOd={kosztyKsefOd} />
    </div>
  );
}
