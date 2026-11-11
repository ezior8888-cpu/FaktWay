/**
 * Dane ekranu VAT (plan księgowości JDG, K6): sprzedaż i koszty miesiąca
 * z tego samego odczytu co eksport JPK_V7M (`fetchInvoicesForExport`), ale
 * klientem z sesji, więc przez RLS firmy. Kwoty liczy `vat.ts`.
 *
 * Nadwyżka z poprzedniej deklaracji (P_39): P_62 deklaracji za poprzedni
 * miesiąc przyjętej przez MF z FaktWay, a bez niej kwota wpisana przez
 * klienta (z deklaracji złożonej poza FaktWay; także 0 zł), a bez niej P_62
 * rozliczenia VAT za poprzedni miesiąc zatwierdzonego w „Ten miesiąc” (K7.1),
 * a bez niego P_39 z zatwierdzonego rozliczenia VAT tego miesiąca (kwota
 * wpisana przy zatwierdzeniu). Poprzedni miesiąc ma pierwszeństwo przed
 * migawką tego: jego korekta zmienia P_39, więc ten miesiąc dostaje nową
 * wersję. Bez żadnej z nich kwot nie ma (fail-closed): zgadnięte 0 zł
 * zawyżyłoby VAT do wpłaty.
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchInvoicesForExport, type FetchedInvoiceData } from '@/lib/exports/data-fetcher';
import { exportScopeFor } from '@/lib/exports/export-scope';
import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import type { createAdminClient } from '@/lib/supabase/admin';

import { vatMiesiaca, type VatMiesiaca } from './vat';
import { czytajWpisyKpir, czytajWpisyReczne, NAZWY_RODZAJOW_WPISU, type RodzajWpisu } from './wpisy-reczne';
import { srodowiskoMf } from './wysylka-jpk/certyfikaty';
import { czytajWysylki, nadwyzkaPrzyjetej, type Wysylka } from './wysylka-jpk/zapis';

export type ZrodloNadwyzki = 'mf' | 'klient' | 'zatwierdzone' | 'ten_miesiac';

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
  'Nie udało się odczytać faktur, kosztów albo rozliczeń miesiąca, więc nie pokazujemy kwot VAT. Strona spróbuje ponownie przy następnym otwarciu.';

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
  let zatwierdzone: NadwyzkiZatwierdzone;
  let przychodyReczne: PrzychodReczny[];
  try {
    [zwolnienie, dane, wysylki, zatwierdzone, przychodyReczne] = await Promise.all([
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
      nadwyzkiZatwierdzone(client, tenantId, poprzedni, miesiac),
      czytajPrzychodyReczne(client, tenantId, from, to),
    ]);
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'ksiegowosc.vat' }, extra: { tenantId, miesiac } });
    return { ok: false, komunikat: BLAD_ODCZYTU_VAT };
  }
  if (isSubjectiveVatExemption(zwolnienie)) {
    return { ok: false, komunikat: 'Firma korzysta ze zwolnienia z VAT (art. 113), więc nie składa JPK_V7M.', zwolniona: true };
  }
  // F11-A1: sprzedaż z wpisów ręcznych (raport z kasy, inny dowód) nie ma
  // stawki VAT, a JPK_V7M jej nie wykazuje, więc kwoty VAT byłyby zaniżone.
  if (przychodyReczne.length > 0) {
    return { ok: false, komunikat: komunikatPrzychodowRecznych(miesiac, przychodyReczne) };
  }

  const srodowisko = srodowiskoMf();
  const zMf = srodowisko ? nadwyzkaPrzyjetej(wysylki, `${poprzedni}-01`, srodowisko) : null;
  const nadwyzka: { zl: number; zrodlo: ZrodloNadwyzki } | null =
    zMf !== null
      ? { zl: zMf, zrodlo: 'mf' }
      : nadwyzkaKlienta !== null
        ? { zl: nadwyzkaKlienta, zrodlo: 'klient' }
        : zZatwierdzonych(zatwierdzone);

  return {
    ok: true,
    miesiac,
    dane,
    nadwyzka,
    wynik: nadwyzka ? vatMiesiaca({ sprzedaz: dane.issuedInvoices, koszty: dane.expenses }, nadwyzka.zl) : null,
    wysylki: wysylki.filter((w) => w.okres === `${miesiac}-01`),
  };
}

interface NadwyzkiZatwierdzone {
  /** P_62 zatwierdzonego rozliczenia VAT za poprzedni miesiąc (pełne złote). */
  poprzedni: number | null;
  /** P_39 zatwierdzonego rozliczenia VAT tego miesiąca (pełne złote). */
  tenMiesiac: number | null;
  /** Czas zatwierdzenia (`zatwierdzone_o`) wersji, z której wzięto kwotę; brak = nieznany. */
  poprzedniO?: string | null;
  tenMiesiacO?: string | null;
}

const czas = (o: string | null | undefined) => (typeof o === 'string' ? Date.parse(o) : Number.NaN);

/**
 * F11-A6: z dwóch zatwierdzeń wygrywa nowsze. P_62 poprzedniego miesiąca
 * zatwierdzonego później to zmiana danych tamtego miesiąca; P_39 wpisane
 * przy późniejszym zatwierdzeniu tego miesiąca to nowsza wiedza klienta (np.
 * korekta deklaracji poza FaktWay). Do 11.11 P_62 wygrywało zawsze. Bez czasów
 * obu zatwierdzeń kolejność jak dotąd: najpierw poprzedni miesiąc.
 * Przyjęte, do potwierdzenia przy scalaniu.
 */
function zZatwierdzonych(z: NadwyzkiZatwierdzone): { zl: number; zrodlo: ZrodloNadwyzki } | null {
  if (z.poprzedni !== null && z.tenMiesiac !== null && czas(z.tenMiesiacO) > czas(z.poprzedniO)) {
    return { zl: z.tenMiesiac, zrodlo: 'ten_miesiac' };
  }
  if (z.poprzedni !== null) return { zl: z.poprzedni, zrodlo: 'zatwierdzone' };
  if (z.tenMiesiac !== null) return { zl: z.tenMiesiac, zrodlo: 'ten_miesiac' };
  return null;
}

/** Grosze z migawki na pełne złote; kwota z groszami albo ujemna to brak (bez zgadywania). */
const pelneZlote = (gr: unknown) => (typeof gr === 'number' && Number.isInteger(gr) && gr >= 0 && gr % 100 === 0 ? gr / 100 : null);

/**
 * Kwoty z zatwierdzonych rozliczeń VAT (K7.1, najwyższa wersja każdego
 * miesiąca), jednym zapytaniem o poprzedni i ten miesiąc. Przed 00168 tabeli
 * nie ma: to brak, nie awaria.
 */
async function nadwyzkiZatwierdzone(client: SupabaseClient, tenantId: string, poprzedni: string, miesiac: string): Promise<NadwyzkiZatwierdzone> {
  const { data, error } = await client
    .from('tax_settlements')
    .select('okres, wersja, migawka, zatwierdzone_o')
    .eq('tenant_id', tenantId)
    .eq('rodzaj', 'vat')
    .in('okres', [`${poprzedni}-01`, `${miesiac}-01`])
    .order('wersja', { ascending: false });
  if (error) {
    // Przed wgraniem 00168: Postgres 42P01, PostgREST PGRST205.
    if (error.code === '42P01' || error.code === 'PGRST205') return { poprzedni: null, tenMiesiac: null };
    throw new Error(`Nie można odczytać rozliczeń VAT: ${error.message}`);
  }
  type Wiersz = {
    okres: string;
    zatwierdzone_o?: string | null;
    migawka?: { wejscia?: { nadwyzkaNaNastepnyGr?: unknown; nadwyzkaPoprzedniaGr?: unknown } } | null;
  };
  const wiersze = (data ?? []) as Wiersz[];
  const najnowsza = (okres: string) => wiersze.find((w) => w.okres === okres);
  const wPoprzednim = najnowsza(`${poprzedni}-01`);
  const wTym = najnowsza(`${miesiac}-01`);
  return {
    poprzedni: pelneZlote(wPoprzednim?.migawka?.wejscia?.nadwyzkaNaNastepnyGr),
    tenMiesiac: pelneZlote(wTym?.migawka?.wejscia?.nadwyzkaPoprzedniaGr),
    poprzedniO: wPoprzednim?.zatwierdzone_o ?? null,
    tenMiesiacO: wTym?.zatwierdzone_o ?? null,
  };
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

interface PrzychodReczny {
  rodzaj: RodzajWpisu;
  dokument: string;
}

/**
 * Wpisy ręczne przychodu z dniem w [od, do]: ewidencja ryczałtu (wpisy ze
 * stawką) i KPiR (kolumny 7 i 8). Koszty z wpisów KPiR nie zaniżają podatku
 * należnego, więc tu ich nie ma. Brak tabeli albo kolumny przed migracjami
 * 00167 i 00171 to brak wpisów (tak czytają `czytajWpisy*`); inny błąd rzuca.
 */
async function czytajPrzychodyReczne(client: SupabaseClient, tenantId: string, od: string, doDnia: string): Promise<PrzychodReczny[]> {
  const [ewidencja, kpir] = await Promise.all([
    czytajWpisyReczne(client, tenantId, od, doDnia),
    czytajWpisyKpir(client, tenantId, od, doDnia),
  ]);
  return [
    ...ewidencja.map((w) => ({ rodzaj: w.rodzaj, dokument: w.dokument })),
    ...kpir.filter((w) => w.kolumna === 'k7' || w.kolumna === 'k8').map((w) => ({ rodzaj: w.rodzaj, dokument: w.dokument })),
  ];
}

/**
 * Brak VAT przy wpisach ręcznych przychodu (F11-A1): nazwy pierwszych trzech
 * wpisów i co zrobić. Takiej sprzedaży FaktWay nie wykazuje w JPK_V7M, a bez
 * niej podatek należny byłby zaniżony.
 */
export function komunikatPrzychodowRecznych(miesiac: string, wpisy: readonly PrzychodReczny[]): string {
  const lista = wpisy
    .slice(0, 3)
    .map((w) => `„${NAZWY_RODZAJOW_WPISU[w.rodzaj]} ${w.dokument}”`)
    .join(', ');
  const reszta = wpisy.length > 3 ? ` i ${wpisy.length - 3} kolejne` : '';
  return (
    `W ewidencji za ${monthLabel(miesiac)} są wpisy ręczne przychodu: ${lista}${reszta}. ` +
    'Sprzedaży spoza faktur (np. z kasy rejestrującej) FaktWay nie wykazuje w JPK_V7M, więc nie pokazujemy kwot VAT, żeby nie zaniżyć podatku należnego. ' +
    'JPK_V7M za ten miesiąc przygotuj poza FaktWay, np. z księgową. Jeśli wpis nie jest sprzedażą opodatkowaną VAT, napisz do nas.'
  );
}

