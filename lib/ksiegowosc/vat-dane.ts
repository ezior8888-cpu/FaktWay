/**
 * Dane ekranu VAT (plan księgowości JDG, K6): sprzedaż i koszty miesiąca
 * z tego samego odczytu co eksport JPK_V7M (`fetchInvoicesForExport`), ale
 * klientem z sesji, więc przez RLS firmy. Kwoty liczy `vat.ts`.
 *
 * Nadwyżka z poprzedniej deklaracji (P_39): P_62 deklaracji za poprzedni
 * miesiąc przyjętej przez MF z FaktWay, a bez niej kwota wpisana przez
 * klienta (z deklaracji złożonej poza FaktWay; także 0 zł). Bez żadnej
 * z nich kwot nie ma (fail-closed): zgadnięte 0 zł zawyżyłoby VAT do wpłaty.
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchInvoicesForExport, type FetchedInvoiceData } from '@/lib/exports/data-fetcher';
import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import type { createAdminClient } from '@/lib/supabase/admin';

import { vatMiesiaca, type VatMiesiaca } from './vat';
import { srodowiskoMf } from './wysylka-jpk/certyfikaty';
import { czytajWysylki, nadwyzkaPrzyjetej, type Wysylka } from './wysylka-jpk/zapis';

export type ZrodloNadwyzki = 'mf' | 'klient';

export type DaneVat =
  | {
      ok: true;
      miesiac: string;
      dane: FetchedInvoiceData;
      /** P_39 w pełnych złotych i skąd jest; null: nieznana, kwot nie ma. */
      nadwyzka: { zl: number; zrodlo: ZrodloNadwyzki } | null;
      wynik: VatMiesiaca | null;
      /** Wysyłki za ten miesiąc, od najnowszej. */
      wysylki: Wysylka[];
    }
  | { ok: false; komunikat: string };

export const BLAD_ODCZYTU_VAT =
  'Nie udało się odczytać faktur i kosztów miesiąca, więc nie pokazujemy kwot VAT. Strona spróbuje ponownie przy następnym otwarciu.';

export async function czytajVat(
  client: SupabaseClient,
  tenantId: string,
  miesiac: string,
  /** P_39 wpisane przez klienta (pełne złote) albo null. */
  nadwyzkaKlienta: number | null,
): Promise<DaneVat> {
  const poprzedni = shiftMonth(miesiac, -1);
  const { from, to } = monthRange(miesiac);
  let zwolnienie: string | null;
  let dane: FetchedInvoiceData;
  let wysylki: Wysylka[];
  try {
    [zwolnienie, dane, wysylki] = await Promise.all([
      readTenantVatExemption(client, tenantId),
      fetchInvoicesForExport(
        { tenantId, periodStart: from, periodEnd: to, direction: 'issued', includeExpenses: true },
        client as unknown as ReturnType<typeof createAdminClient>,
      ),
      czytajWysylki(client, tenantId, [`${miesiac}-01`, `${poprzedni}-01`]),
    ]);
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'ksiegowosc.vat' }, extra: { tenantId, miesiac } });
    return { ok: false, komunikat: BLAD_ODCZYTU_VAT };
  }
  if (isSubjectiveVatExemption(zwolnienie)) {
    return { ok: false, komunikat: 'Firma korzysta ze zwolnienia z VAT (art. 113), więc nie składa JPK_V7M.' };
  }

  const srodowisko = srodowiskoMf();
  const zMf = srodowisko ? nadwyzkaPrzyjetej(wysylki, `${poprzedni}-01`, srodowisko) : null;
  const nadwyzka =
    zMf !== null ? { zl: zMf, zrodlo: 'mf' as const } : nadwyzkaKlienta !== null ? { zl: nadwyzkaKlienta, zrodlo: 'klient' as const } : null;

  return {
    ok: true,
    miesiac,
    dane,
    nadwyzka,
    wynik: nadwyzka ? vatMiesiaca({ sprzedaz: dane.issuedInvoices, koszty: dane.expenses }, nadwyzka.zl) : null,
    wysylki: wysylki.filter((w) => w.okres === `${miesiac}-01`),
  };
}

/** Komunikat, gdy nadwyżka z poprzedniej deklaracji jest nieznana. */
export function brakNadwyzki(miesiac: string): string {
  return (
    `Do wyliczenia VAT za ${monthLabel(miesiac)} potrzebna jest nadwyżka z deklaracji za ${monthLabel(shiftMonth(miesiac, -1))} ` +
    '(pole P_62 tamtej deklaracji, także 0 zł).'
  );
}
