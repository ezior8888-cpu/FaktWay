import { receivedInflows } from '@/lib/dashboard/cash-movements';
import { getInflows } from '@/lib/dashboard/inflows';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Kafle listy faktur (P3, PLAN-FINORA §5): Kontrahenci, Faktury w tym
 * miesiącu, Opłacone. „Do zapłaty” to `getReceivables`
 * (`lib/dashboard/receivables.ts`).
 *
 * Każdy kafel ma własną funkcję, bo każda karta to osobny Server Component
 * w <Suspense> + `SectionErrorBoundary` (§2.4 pkt 15) — wyjątek strażnika
 * zabiera jedną kartę, nie tabelę.
 *
 * Miesiąc liczony w Europe/Warsaw z `todayInWarsaw` (§2.4 pkt 10), tak
 * samo jak w `getMonthlyFigures`.
 */

const ENVIRONMENT_ERROR = 'Przyjęte faktury wymagają uzgodnienia środowiska KSeF';

/**
 * Podpis karty „Opłacone” (§2.4 pkt 14) i jej pusty stan, gdy `paidThisMonth`
 * zwraca null — nigdy „0 zł”. Teksty mieszkają w module bez importów, bo
 * biorą je też komponenty klienckie `/przeplywy`.
 */
export { PAID_EMPTY_STATE, PAID_NOTE } from '@/lib/invoices/paid-labels';

export interface WarsawMonthBounds {
  /** Pierwszy dzień miesiąca, RRRR-MM-DD. */
  start: string;
  /** Pierwszy dzień następnego miesiąca, RRRR-MM-DD. */
  endExclusive: string;
  /** RRRR-MM. */
  monthKey: string;
}

/** Bieżący miesiąc kalendarzowy w Europe/Warsaw. */
export function warsawMonthBounds(now: Date = new Date()): WarsawMonthBounds {
  const today = todayInWarsaw(now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${today.slice(0, 7)}-01`,
    endExclusive: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
    monthKey: today.slice(0, 7),
  };
}

function headCount(label: string, result: { count: number | null; error: { message: string } | null }): number {
  if (result.error || typeof result.count !== 'number' || !Number.isSafeInteger(result.count) || result.count < 0) {
    throw new Error(label);
  }
  return result.count;
}

/** Kafel „Kontrahenci”: liczba kontrahentów firmy. */
export async function countContractors(
  supabase: PageContext['supabase'],
  tenantId: string,
): Promise<number> {
  const result = await supabase
    .from('contractors')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  return headCount('Nie można odczytać liczby kontrahentów', result);
}

export interface InvoicesThisMonth {
  /** Faktury sprzedaży przyjęte w KSeF (aktywne środowisko), wystawione w tym miesiącu. */
  accepted: number;
  /** Szkice bez środowiska z datą wystawienia w tym miesiącu (jak `getMonthlyFigures`). */
  drafts: number;
}

/**
 * Kafel „Faktury w tym miesiącu”. Filtry 1:1 z `getMonthlyFigures`
 * (§2.4 pkt 2) — przyjęte w aktywnym środowisku, szkice osobno — tylko
 * granice miesiąca z Europe/Warsaw. Przyjęta faktura miesiąca bez środowiska
 * rzuca, jak `assertAcceptedEnvironmentKnown`.
 */
export async function countInvoicesThisMonth(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<InvoicesThisMonth> {
  const environment = requireConfiguredKsefEnvironment();
  const { start, endExclusive } = warsawMonthBounds(now);

  const [unknownEnvironment, accepted, drafts] = await Promise.all([
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .is('ksef_environment', null)
      .gte('issue_date', start)
      .lt('issue_date', endExclusive),
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .gte('issue_date', start)
      .lt('issue_date', endExclusive),
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'draft')
      .is('ksef_environment', null)
      .gte('issue_date', start)
      .lt('issue_date', endExclusive),
  ]);

  if (headCount('Nie można sprawdzić środowiska faktur KSeF', unknownEnvironment) > 0) {
    throw new Error(ENVIRONMENT_ERROR);
  }
  return {
    accepted: headCount('Nie można odczytać liczby faktur miesiąca', accepted),
    drafts: headCount('Nie można odczytać liczby szkiców', drafts),
  };
}

/**
 * Kafel „Opłacone”: wpływy w bieżącym miesiącu (Europe/Warsaw), do dziś. Liczy go
 * ta sama droga co Przepływy (`getInflows` + `receivedInflows`), więc obie liczby są
 * zgodne z założenia, a nie z dyscypliny dwóch zapytań:
 * - dzień zapłaty to `paid_at` (wpłaty, „Zapłacone”, FLO) albo `Zaplacono = 1` +
 *   `DataZaplaty` z FA(3) (`fa3_data.parsed.paidDate`; import ma `paid_at = NULL`),
 *   a `paid_at` opisuje stan „opłacona w całości” (00073), więc wpłaty częściowe
 *   pojawią się tu dopiero po dopłacie reszty;
 * - korekta in minus wystawiona do dnia zapłaty pomniejsza tę wpłatę („Zapłacone”
 *   zapisuje całą resztę brutto), a późniejsza jest osobnym ruchem w miesiącu swojego
 *   wystawienia (`lib/dashboard/inflows.ts`);
 * - wpłata jest faktem bez względu na pochodzenie i rodzaj dokumentu: „Zapłacone”
 *   działa też na imporcie, historii KSeF i korekcie in plus (00158). Zaliczka i jej
 *   ROZ to dwie różne wpłaty (`paid_amount` ROZ to reszta po zaliczkach, 00145).
 *
 * Faktura w obcej walucie jest pomijana (`foreignCurrency: 'skip'`): bez kursu nie
 * zgadujemy złotówek, ale lista faktur nie traci przez nią kafla. Przepływy w tym
 * samym przypadku pokazują kartę błędu.
 *
 * `null`, gdy w miesiącu nie ma żadnej opłaconej faktury z wpłatą > 0 (sama korekta
 * do wcześniejszej wpłaty to nie „opłacona” faktura) — karta pokazuje wtedy
 * `PAID_EMPTY_STATE`, nigdy „0 zł”.
 */
export async function paidThisMonth(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const { start, endExclusive } = warsawMonthBounds(now);
  const entries = await getInflows(
    supabase,
    tenantId,
    { from: start, toExclusive: endExclusive },
    { foreignCurrency: 'skip' },
  );
  const received = receivedInflows(entries, todayInWarsaw(now));
  if (!received.some((entry) => entry.basis === 'paid' && entry.amount > 0)) return null;
  return roundToCents(received.reduce((sum, entry) => sum + entry.amount, 0));
}
