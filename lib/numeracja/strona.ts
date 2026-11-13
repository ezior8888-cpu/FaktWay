import type { SupabaseClient } from '@supabase/supabase-js';

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { loadInvoiceNumbering } from '@/lib/numeracja/baza';
import type { InvoiceNumbering } from '@/lib/numeracja/model';
import type { InvoiceKind } from '@/lib/numeracja/wzor';
import { createClient } from '@/lib/supabase/server';

/**
 * Numeracja dla strony formularza (krok 2.5): serie i podpowiedź numeru
 * rodzaju dokumentu, klientem z sesji (RLS). Błąd to `null`: formularz
 * zostaje bez podpowiedzi, jak dotąd, a zapis i tak sprawdza baza.
 * `db` podaje strona, która ma już klienta; inaczej tworzymy go tu.
 */
export async function loadNumberingForForm(
  db: unknown,
  tenantId: string,
  kind: InvoiceKind,
): Promise<InvoiceNumbering | null> {
  try {
    const client = (db ?? (await createClient())) as SupabaseClient;
    return await loadInvoiceNumbering(client, tenantId, kind, todayInWarsaw());
  } catch {
    return null;
  }
}
