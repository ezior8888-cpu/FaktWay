/**
 * Dane ekranu VAT (plan księgowości JDG, K6): sprzedaż i koszty miesiąca
 * z tego samego odczytu co eksport JPK_V7M (`fetchInvoicesForExport`), ale
 * klientem z sesji, więc przez RLS firmy. Kwoty liczy `vat.ts`.
 *
 * Nadwyżka z poprzedniej deklaracji (P_39): P_62 deklaracji za poprzedni
 * miesiąc przyjętej przez MF z FaktWay, a bez niej kwota wpisana przez
 * klienta (z deklaracji złożonej poza FaktWay; także 0 zł), a bez niej P_62
 * rozliczenia VAT za poprzedni miesiąc zatwierdzonego w „Ten miesiąc” (K7.1).
 * Bez żadnej z nich kwot nie ma (fail-closed): zgadnięte 0 zł zawyżyłoby VAT
 * do wpłaty.
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchInvoicesForExport, type FetchedInvoiceData } from '@/lib/exports/data-fetcher';
import { exportScopeFor } from '@/lib/exports/export-scope';
import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import type { createAdminClient } from '@/lib/supabase/admin';

import { vatMiesiaca, type VatMiesiaca } from './vat';
import { srodowiskoMf } from './wysylka-jpk/certyfikaty';
import { czytajWysylki, nadwyzkaPrzyjetej, type Wysylka } from './wysylka-jpk/zapis';

export type ZrodloNadwyzki = 'mf' | 'klient' | 'zatwierdzone';

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
  | {
      ok: false;
      komunikat: string;
      /** Zwolnienie podmiotowe (art. 113): VAT nie dotyczy firmy, to nie błąd odczytu. */
      zwolniona?: true;
    };

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
  // FIR-01: zakres jak eksport JPK_V7M (cała sprzedaż z korektami i koszty).
  const scope = exportScopeFor('jpk_v7m');
  let zwolnienie: string | null;
  let dane: FetchedInvoiceData;
  let wysylki: Wysylka[];
  let zatwierdzona: number | null;
  try {
    [zwolnienie, dane, wysylki, zatwierdzona] = await Promise.all([
      readTenantVatExemption(client, tenantId),
      fetchInvoicesForExport(
        {
          tenantId,
          periodStart: from,
          periodEnd: to,
          direction: scope.invoiceDirection,
          includeCorrections: scope.includeCorrections,
          includeExpenses: scope.includeExpenses,
        },
        client as unknown as ReturnType<typeof createAdminClient>,
      ),
      czytajWysylki(client, tenantId, [`${miesiac}-01`, `${poprzedni}-01`]),
      nadwyzkaZatwierdzona(client, tenantId, poprzedni),
    ]);
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'ksiegowosc.vat' }, extra: { tenantId, miesiac } });
    return { ok: false, komunikat: BLAD_ODCZYTU_VAT };
  }
  if (isSubjectiveVatExemption(zwolnienie)) {
    return { ok: false, komunikat: 'Firma korzysta ze zwolnienia z VAT (art. 113), więc nie składa JPK_V7M.', zwolniona: true };
  }

  const srodowisko = srodowiskoMf();
  const zMf = srodowisko ? nadwyzkaPrzyjetej(wysylki, `${poprzedni}-01`, srodowisko) : null;
  const nadwyzka: { zl: number; zrodlo: ZrodloNadwyzki } | null =
    zMf !== null
      ? { zl: zMf, zrodlo: 'mf' }
      : nadwyzkaKlienta !== null
        ? { zl: nadwyzkaKlienta, zrodlo: 'klient' }
        : zatwierdzona !== null
          ? { zl: zatwierdzona, zrodlo: 'zatwierdzone' }
          : null;

  return {
    ok: true,
    miesiac,
    dane,
    nadwyzka,
    wynik: nadwyzka ? vatMiesiaca({ sprzedaz: dane.issuedInvoices, koszty: dane.expenses }, nadwyzka.zl) : null,
    wysylki: wysylki.filter((w) => w.okres === `${miesiac}-01`),
  };
}

/**
 * P_62 rozliczenia VAT za miesiąc zatwierdzonego w „Ten miesiąc” (K7.1,
 * najwyższa wersja), w pełnych złotych. Przed 00168 tabeli nie ma: to brak,
 * nie awaria. Kwota z groszami albo ujemna w migawce to też brak.
 */
async function nadwyzkaZatwierdzona(client: SupabaseClient, tenantId: string, miesiac: string): Promise<number | null> {
  const { data, error } = await client
    .from('tax_settlements')
    .select('wersja, migawka')
    .eq('tenant_id', tenantId)
    .eq('okres', `${miesiac}-01`)
    .eq('rodzaj', 'vat')
    .order('wersja', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Przed wgraniem 00168: Postgres 42P01, PostgREST PGRST205.
    if (error.code === '42P01' || error.code === 'PGRST205') return null;
    throw new Error(`Nie można odczytać rozliczeń VAT: ${error.message}`);
  }
  const gr = (data as { migawka?: { wejscia?: { nadwyzkaNaNastepnyGr?: unknown } } } | null)?.migawka?.wejscia?.nadwyzkaNaNastepnyGr;
  return typeof gr === 'number' && Number.isInteger(gr) && gr >= 0 && gr % 100 === 0 ? gr / 100 : null;
}

/** P_39 z adresu strony (`?nadwyzka=`): pełne złote, bez znaku; inaczej null. */
export function nadwyzkaZAdresu(wartosc: string | undefined): number | null {
  return wartosc !== undefined && /^\d{1,13}$/.test(wartosc) ? Number(wartosc) : null;
}

/** Komunikat, gdy nadwyżka z poprzedniej deklaracji jest nieznana. */
export function brakNadwyzki(miesiac: string): string {
  return (
    `Do wyliczenia VAT za ${monthLabel(miesiac)} potrzebna jest nadwyżka z deklaracji za ${monthLabel(shiftMonth(miesiac, -1))} ` +
    '(pole P_62 tamtej deklaracji, także 0 zł).'
  );
}
