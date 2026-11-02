import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { RECEIVABLE_BASE_COLUMNS } from '@/lib/dashboard/receivables';
import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';
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
const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set(['test', 'demo', 'production']);

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
 * Kafel „Opłacone”: wpłaty w bieżącym miesiącu (Europe/Warsaw) — suma
 * `paid_amount` faktur sprzedaży przyjętych w KSeF, w PLN, według `paid_at`,
 * czyli dnia zapłaty (§2.4 pkt 14). `paid_at` opisuje stan „opłacona w całości”
 * (00073), więc wpłaty częściowe pojawią się tu dopiero po dopłacie reszty.
 *
 * Bez warunków należności z pkt 11: wpłata jest faktem bez względu na pochodzenie
 * i rodzaj dokumentu. „Zapłacone” działa też na imporcie, historii KSeF i korekcie
 * in plus (00158), a kafel ma się zgadzać z Przepływami. Opłacona faktura, która
 * potem dostała korektę albo ROZ, nadal jest wpływem (C2). Zaliczka i jej ROZ to
 * dwie różne wpłaty (`paid_amount` ROZ to reszta po zaliczkach, 00145).
 *
 * `null`, gdy w miesiącu nie ma żadnej opłaconej faktury z wpłatą > 0 —
 * karta pokazuje wtedy `PAID_EMPTY_STATE`, nigdy „0 zł”.
 */
export async function paidThisMonth(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const environment = requireConfiguredKsefEnvironment();
  const { start, endExclusive, monthKey } = warsawMonthBounds(now);
  // `paid_at` to znacznik czasu. Okno w UTC poszerzone o dobę z każdej
  // strony, dokładny miesiąc w Warszawie liczy filtr niżej.
  const windowStart = `${addDaysToIsoDate(start, -1) ?? start}T00:00:00.000Z`;
  const windowEnd = `${addDaysToIsoDate(endExclusive, 1) ?? endExclusive}T00:00:00.000Z`;

  const rows = await readCompletePages('Nie można odczytać wpłat', (from, to) => supabase
    .from('invoices')
    .select(`${RECEIVABLE_BASE_COLUMNS}, paid_at`, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .gte('paid_at', windowStart)
    .lt('paid_at', windowEnd)
    .order('id', { ascending: true })
    .range(from, to));

  const inMonth = rows.filter((row) => {
    if (!row.paid_at) return false;
    const paidAt = new Date(row.paid_at);
    return !Number.isNaN(paidAt.getTime()) && todayInWarsaw(paidAt).slice(0, 7) === monthKey;
  });
  if (inMonth.some((row) => row.ksef_environment === null || !KNOWN_ENVIRONMENTS.has(row.ksef_environment))) {
    throw new Error(ENVIRONMENT_ERROR);
  }

  let sum = 0;
  let paidInvoices = 0;
  for (const row of inMonth) {
    if (row.ksef_environment !== environment) continue;
    // Wpłata w obcej walucie nie wchodzi do sumy w złotych (jak `isPlnOrUnset` należności).
    if (row.currency !== null && row.currency !== 'PLN') continue;
    const amount = Number(row.paid_amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    sum += amount;
    paidInvoices += 1;
  }
  return paidInvoices > 0 ? roundToCents(sum) : null;
}
