/**
 * Warunki płatności kosztu z pliku FA(3) w archiwum firmy (krok 3.4, część 1).
 * Woła je tylko zadanie `auto-categorize-inbox` (klucz serwisowy), po
 * archiwizacji pliku (`archiveInboxInvoiceXml`).
 *
 * Ponowienie od zera (worker wykonuje cały handler jeszcze raz):
 *  - odczyt jest tylko odczytem, więc można go powtarzać;
 *  - zapis przy istniejącym koszcie ma warunek `payment_terms IS NULL`, więc
 *    warunki trafiają na koszt raz i nigdy nie nadpisują wcześniejszego odczytu;
 *  - dzień zapłaty z pliku dochodzi tylko razem z tym pierwszym zapisem i tylko
 *    przy `paid_at IS NULL`, więc nie przykryje „Oznacz jako zapłacone”
 *    ani cofnięcia klienta.
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decodeKsefXml } from '@/lib/import/ksef-xml-archive';
import { downloadFromR2 } from '@/lib/storage/r2';

import { czytajWarunkiPlatnosci, kolumnyPlatnosci, type WarunkiPlatnosciKosztu } from './platnosc-kosztu';

export type OdczytWarunkowPlatnosci =
  | { stan: 'odczytano'; warunki: WarunkiPlatnosciKosztu }
  /** Faktura nie ma pliku w archiwum: nie ma czego czytać (rozstrzygnięte). */
  | { stan: 'brak-pliku' }
  /** Chwilowy błąd bazy albo magazynu: znacznik skrzynki zostaje, cron ponowi. */
  | { stan: 'blad' };

export async function wczytajWarunkiPlatnosciKsef(
  supabase: SupabaseClient,
  params: { tenantId: string; invoiceId: string },
): Promise<OdczytWarunkowPlatnosci> {
  const { tenantId, invoiceId } = params;
  try {
    const { data: row, error } = await supabase
      .from('invoices')
      .select('id, xml_storage_path')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error || !row) return { stan: 'blad' };
    const path = typeof row.xml_storage_path === 'string' ? row.xml_storage_path.trim() : '';
    if (!path) return { stan: 'brak-pliku' };
    const xml = decodeKsefXml(await downloadFromR2(path, tenantId));
    return { stan: 'odczytano', warunki: czytajWarunkiPlatnosci(xml) };
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'expenses.payment-terms' }, extra: { invoiceId } });
    return { stan: 'blad' };
  }
}

/** Warunki na koszcie, który już istnieje (koszt powstał, zanim plik dał się odczytać). */
export async function zapiszWarunkiNaKoszcie(
  supabase: SupabaseClient,
  params: { tenantId: string; invoiceId: string; warunki: WarunkiPlatnosciKosztu },
): Promise<{ zapisano: boolean }> {
  const { tenantId, invoiceId, warunki } = params;
  const { paid_at: zaplaconoDnia, ...kolumny } = kolumnyPlatnosci(warunki, new Date().toISOString());

  const zapisz = async (patch: Record<string, unknown>, bezZaplaty: boolean): Promise<boolean> => {
    let query = supabase
      .from('expenses')
      .update(patch)
      .eq('tenant_id', tenantId)
      .eq('ksef_invoice_id', invoiceId)
      .is('payment_terms', null);
    if (bezZaplaty) query = query.is('paid_at', null);
    const { data, error } = await query.select('id');
    if (error) throw new Error(`Nie można zapisać warunków płatności kosztu: ${error.message}`);
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  };

  // Dzień zapłaty z pliku w tym samym UPDATE co warunki: po udanym zapisie
  // ponowienie nie ma już czego dopisać (payment_terms nie jest NULL).
  if (zaplaconoDnia && await zapisz({ ...kolumny, paid_at: zaplaconoDnia }, true)) {
    return { zapisano: true };
  }
  return { zapisano: await zapisz(kolumny, false) };
}
