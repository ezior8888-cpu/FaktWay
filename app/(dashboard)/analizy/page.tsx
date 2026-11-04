import { redirect } from 'next/navigation';

import { ANALYTICS_MONTH_PARAM, isMonthKey } from '@/lib/analytics-finance/months';

/**
 * `/analizy` → `/analizy/sprzedaz` (poprawka Bartosza 21.10.2026: jedna
 * pozycja menu „Analizy” z przełącznikiem „Sprzedaż | Koszty”). Wpisany
 * ręcznie adres bez rodzaju analizy nie kończy się 404. Miesiąc z adresu
 * idzie dalej tylko w formacie RRRR-MM; czy jest wśród proponowanych,
 * sprawdza strona docelowa (`resolveAnalyticsMonth`).
 */
export const dynamic = 'force-dynamic';

export default async function AnalizyRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params[ANALYTICS_MONTH_PARAM];
  const miesiac = Array.isArray(raw) ? raw[0] : raw;
  redirect(`/analizy/sprzedaz${isMonthKey(miesiac) ? `?${ANALYTICS_MONTH_PARAM}=${miesiac}` : ''}`);
}
