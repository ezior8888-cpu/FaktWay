/**
 * Jedyne źródło ceny FaktWay.
 *
 * Decyzja Bartosza z 1 października 2026 (krok 8 planu automatyzacji):
 *   - jeden plan dla wszystkich, płatny co miesiąc — bez planu rocznego,
 *   - 29,99 zł BRUTTO (cena końcowa z 23% VAT),
 *   - 30 dni okresu próbnego, karta przy starcie (Stripe Checkout), a po włączeniu
 *     przełącznika także BLIK (lib/billing/trial-payment.ts),
 *   - bez „money-back” — zasady zwrotów ustala regulamin (prawnik).
 *
 * Wcześniej w repo było pięć wersji cennika (39,99 / 49 / 59 / 588 zł,
 * Start 0 zł / Biuro 99 zł), raz brutto, raz „+ VAT” — AUD-28, AUD-73.
 * Każdy tekst z ceną bierze ją stąd; test `cennik-jedna-cena` pilnuje, żeby
 * stare kwoty nie wróciły. Cena w Stripe (`STRIPE_PRICE_MONTHLY`) musi być tą
 * samą kwotą brutto w PLN — `lib/billing/self-invoice.ts` traktuje kwotę
 * z Stripe jako brutto.
 */

/** Cena miesięczna brutto w groszach. */
export const MONTHLY_PRICE_GROSS_GROSZE = 2999;

export const VAT_RATE_PERCENT = 23;

/** Netto i VAT z ceny brutto (zaokrąglenie do grosza, VAT jako różnica). */
export const MONTHLY_PRICE_NET_GROSZE = Math.round(
  (MONTHLY_PRICE_GROSS_GROSZE * 100) / (100 + VAT_RATE_PERCENT),
);
export const MONTHLY_VAT_GROSZE = MONTHLY_PRICE_GROSS_GROSZE - MONTHLY_PRICE_NET_GROSZE;

/** Okres próbny w Stripe Checkout (`trial_period_days`). */
export const TRIAL_DAYS = 30;

/** „29,99 zł” — zwykła spacja przed „zł”, bez separatora tysięcy (ceny < 1000 zł). */
export function formatPln(grosze: number): string {
  const zl = Math.trunc(grosze / 100);
  const gr = Math.abs(grosze % 100).toString().padStart(2, '0');
  return `${zl},${gr} zł`;
}

/** „29,99 zł” */
export const PRICE_GROSS = formatPln(MONTHLY_PRICE_GROSS_GROSZE);
/** „24,38 zł” */
export const PRICE_NET = formatPln(MONTHLY_PRICE_NET_GROSZE);
/** „5,61 zł” */
export const PRICE_VAT = formatPln(MONTHLY_VAT_GROSZE);

/** „29,99 zł/mc z VAT” — krótka forma do nagłówków i porównań. */
export const PRICE_PER_MONTH = `${PRICE_GROSS}/mc z VAT`;

/** „29,99 zł/mc z VAT (24,38 zł netto)” — forma z rozbiciem. */
export const PRICE_PER_MONTH_WITH_NET = `${PRICE_PER_MONTH} (${PRICE_NET} netto)`;

/** Przychód miesięczny netto z jednej aktywnej subskrypcji, w złotych (MRR). */
export const MONTHLY_NET_PLN = MONTHLY_PRICE_NET_GROSZE / 100;
