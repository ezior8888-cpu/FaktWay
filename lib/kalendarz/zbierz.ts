/**
 * Składanie zdarzeń kalendarza dla firmy (krok 7.3). Klient z kluczem
 * serwisowym, bo trasa jest publiczna i nie ma sesji: dostęp wyznacza token,
 * a zakres danych ten plik (jedna firma, `tenantId` z funkcji bazy).
 *
 * Każda sekcja ma własną obsługę błędu: awaria należności nie zabiera
 * terminów podatku, a kalendarz bez jednej sekcji jest lepszy niż 500, po
 * którym aplikacja kalendarza pokaże klientowi pusty widok. Błąd trafia do
 * Sentry. Zaległe faktury sprzed ponad 30 dni nie wchodzą do kalendarza:
 * wpis sprzed miesięcy to szum, a od zaległości jest lista należności.
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getReceivables } from '@/lib/dashboard/receivables';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { addDaysToIsoDate } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { czytajWersjeProfilu } from '@/lib/ksiegowosc/profil';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';

import type { ZdarzenieIcal } from './ical';
import { zdarzeniaCykliczne, zdarzeniaNaleznosci, zdarzeniaTerminow } from './zdarzenia';

/** Ile dni wstecz pokazujemy zaległe płatności. */
const DNI_ZALEGLOSCI = 30;
/** Ile najbliższych faktur cyklicznych. */
const LIMIT_CYKLICZNYCH = 24;

async function sekcja(nazwa: string, tenantId: string, praca: () => Promise<ZdarzenieIcal[]>): Promise<ZdarzenieIcal[]> {
  try {
    return await praca();
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'kalendarz.ical', sekcja: nazwa }, extra: { tenantId } });
    return [];
  }
}

export async function zbierzZdarzenia(
  admin: SupabaseClient,
  tenantId: string,
  teraz: Date = new Date(),
): Promise<ZdarzenieIcal[]> {
  const dzis = todayInWarsaw(teraz);
  const granicaZaleglosci = addDaysToIsoDate(dzis, -DNI_ZALEGLOSCI) ?? dzis;

  const [naleznosci, cykliczne, terminy] = await Promise.all([
    sekcja('naleznosci', tenantId, async () => {
      const wynik = await getReceivables(admin as unknown as Parameters<typeof getReceivables>[0], tenantId, teraz);
      return zdarzeniaNaleznosci(
        wynik.byInvoice.filter((p) => p.paymentDueDate !== null && p.paymentDueDate >= granicaZaleglosci),
      );
    }),
    sekcja('cykliczne', tenantId, async () => {
      const { data, error } = await admin
        .from('recurring_invoices')
        .select('id, name, next_run_date')
        .eq('tenant_id', tenantId)
        .eq('active', true)
        .gte('next_run_date', dzis)
        .order('next_run_date', { ascending: true })
        .limit(LIMIT_CYKLICZNYCH);
      if (error) throw new Error(`Nie można odczytać faktur cyklicznych: ${error.message}`);
      return zdarzeniaCykliczne((data ?? []) as { id: string; name: string; next_run_date: string }[]);
    }),
    sekcja('terminy', tenantId, async () => {
      // Moduł księgowości za wyłącznikiem: bez niego klient nie zobaczy terminów, których ekranu nie ma.
      if (!(await czyKsiegowoscWlaczona(admin, tenantId, 'terminy')).wlaczony) return [];
      const wersje = await czytajWersjeProfilu(admin, tenantId);
      const platnikVat =
        statusObszaru('vat').wlaczony && !isSubjectiveVatExemption(await readTenantVatExemption(admin, tenantId));
      return zdarzeniaTerminow({ dzis, wersje, platnikVat });
    }),
  ]);

  return [...naleznosci, ...cykliczne, ...terminy];
}
