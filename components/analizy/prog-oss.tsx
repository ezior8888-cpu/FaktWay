import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { saleInvoicesOf } from '@/lib/analytics-finance/sales';
import { assertAcceptedEnvironmentKnown } from '@/lib/dashboard/monthly-figures';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { fetchSettledAdvancesTotals } from '@/lib/invoices/settled-advances';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { licznikOss, type SprzedazDlaOss, type WynikProguOss } from '@/lib/oss/prog';
import type { PageContext } from '@/lib/supabase/page-context';

import { ProgOssKarta } from './prog-oss-karta';

const COLUMNS =
  'id, issue_date, internal_number, net_total, gross_total, invoice_kind, advance_invoice_ids, currency, buyer_nip, buyer_data, is_b2c, origin, invoice_type';

function parties(buyerData: unknown): { countryCode: string | null; vatUe: string | null; nip: string | null } {
  const b = buyerData && typeof buyerData === 'object' && !Array.isArray(buyerData) ? (buyerData as Record<string, unknown>) : {};
  const address = b.address && typeof b.address === 'object' ? (b.address as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return { countryCode: text(address.countryCode), vatUe: text(b.vatUeNumber), nip: text(b.nip) };
}

/**
 * Licznik progu OSS (krok 9.4): faktury sprzedaży z roku bieżącego i
 * poprzedniego, te same strażniki co karty analiz (przyjęte w KSeF, aktywne
 * środowisko), ale BEZ strażnika "tylko PLN": faktura walutowa bez kursu
 * jest liczona osobno i pokazana na ekranie. Faktury nie przechowują kursu,
 * więc `rateToPln` jest na razie zawsze `null`. Błąd odczytu nie wywraca strony.
 */
export async function ProgOss({ supabase, tenantId, now }: { supabase: PageContext['supabase']; tenantId: string; now: Date }) {
  const year = Number(todayInWarsaw(now).slice(0, 4));
  let wynik: WynikProguOss;
  try {
    const environment = requireConfiguredKsefEnvironment();
    const from = `${year - 1}-01-01`;
    const toExclusive = `${year + 1}-01-01`;
    await assertAcceptedEnvironmentKnown(supabase, tenantId, from, toExclusive);
    const rows = await readCompletePages('Nie można odczytać faktur sprzedaży', (start, end) => supabase
      .from('invoices')
      .select(COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .gte('issue_date', from)
      .lt('issue_date', toExclusive)
      .order('id', { ascending: true })
      .range(start, end));
    const settled = rows.length > 0 ? await fetchSettledAdvancesTotals(supabase, tenantId, rows) : new Map();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const sales: SprzedazDlaOss[] = saleInvoicesOf(rows, settled).map((inv) => {
      const p = parties(inv.buyer_data);
      return {
        id: inv.id,
        issueDate: inv.issueDate,
        net: inv.net,
        kind: inv.kind,
        currency: byId.get(inv.id)?.currency ?? null,
        rateToPln: null,
        countryCode: p.countryCode,
        isB2c: inv.is_b2c,
        buyerNip: inv.buyer_nip ?? p.nip,
        vatUe: p.vatUe,
      };
    });
    wynik = licznikOss(sales, { year });
  } catch {
    return null;
  }
  return <ProgOssKarta wynik={wynik} />;
}
