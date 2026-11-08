import { createAdminClient } from '@/lib/supabase/admin';

/**
 * `DataWytworzeniaFa` faktury: przy pierwszym generowaniu zapisana w
 * `invoices.xml_generated_at`, przy ponowieniach odczytana stamtąd — ten sam
 * XML przy każdej próbie (AUD-46). Zapis warunkowy (`IS NULL`), więc dwie
 * równoległe próby dostaną tę samą chwilę.
 *
 * Bez zapisanej chwili rzuca: to zwykły, ponawialny błąd sprzed zapisu pliku.
 * C-12: plik próby jest niezmienny. Chwila bieżąca przy awarii bazy dałaby plik
 * z t1, a ponowienie odczytałoby t2, więc bajty tej próby różniłyby się już zawsze.
 */
export async function claimXmlGeneratedAt(
  tenantId: string,
  invoiceId: string,
  now: Date = new Date(),
): Promise<Date> {
  const admin = createAdminClient();
  // Wynik zapisu nie rozstrzyga: liczy się to, co odczytamy niżej.
  await admin
    .from('invoices')
    .update({ xml_generated_at: now.toISOString() } as never)
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .is('xml_generated_at' as never, null)
    .select('id')
    .maybeSingle();
  const { data, error } = await admin
    .from('invoices')
    .select('xml_generated_at' as never)
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Nie można odczytać xml_generated_at faktury: ${error.message}`);
  const stored = (data as { xml_generated_at?: string | null } | null)?.xml_generated_at;
  const parsed = stored ? new Date(stored) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error('Nie udało się zapisać xml_generated_at faktury');
  }
  return parsed;
}
