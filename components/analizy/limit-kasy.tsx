import { getSalesInvoices } from '@/lib/analytics-finance/sales';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { readTenantBusinessStart } from '@/lib/invoices/business-start';
import { limitKasy, type WynikLimituKasy } from '@/lib/kasa-fiskalna/limit';
import type { PageContext } from '@/lib/supabase/page-context';

import { LimitKasyKarta } from './limit-kasy-karta';

/**
 * Licznik limitu kasy (krok 9.3): faktury sprzedaży bieżącego roku (te same
 * strażniki co karty analiz: przyjęte w KSeF, środowisko, tylko PLN) i data
 * rozpoczęcia działalności z ustawień. Błąd odczytu nie wywraca strony.
 */
export async function LimitKasy({ supabase, tenantId, now }: { supabase: PageContext['supabase']; tenantId: string; now: Date }) {
  const year = Number(todayInWarsaw(now).slice(0, 4));
  let wynik: WynikLimituKasy;
  try {
    const [invoices, businessStartedOn] = await Promise.all([
      getSalesInvoices(supabase, tenantId, { from: `${year}-01-01`, toExclusive: `${year + 1}-01-01` }),
      readTenantBusinessStart(supabase, tenantId),
    ]);
    wynik = limitKasy(
      invoices.map((inv) => ({
        id: inv.id,
        issueDate: inv.issueDate,
        gross: inv.documentGross,
        kind: inv.kind,
        isB2c: inv.is_b2c,
        buyerNip: inv.buyer_nip,
      })),
      { year, businessStartedOn },
    );
  } catch {
    return null;
  }
  return <LimitKasyKarta wynik={wynik} />;
}
