/**
 * Odczyt danych ewidencji przychodów za rok (plan księgowości JDG, K3).
 * Liczy `zbudujEwidencje` z `ewidencja.ts`; tu są tylko zapytania, z tymi
 * samymi filtrami co KPiR (`lib/reports/kpir-data.ts`, PLAN-FINORA §2.4):
 * faktury `outgoing` przyjęte w aktywnym środowisku KSeF, sumy przez
 * `readCompletePages`, zaliczki przez `fetchSettledAdvancesNet`.
 *
 * Okno wystawienia sięga 60 dni za koniec roku: faktura z 10 stycznia za
 * sprzedaż z 28 grudnia to przychód roku poprzedniego
 * (`MAX_SALE_DAYS_AFTER_ISSUE`, jak licznik limitu VAT).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import type { RateLookup } from '@/lib/flo/nbp';
import { addDaysToIsoDate } from '@/lib/format/warsaw-date';
import { MAX_SALE_DAYS_AFTER_ISSUE } from '@/lib/invoices/sale-date';
import { fetchSettledAdvancesNet } from '@/lib/invoices/settled-advances';
import { assertAcceptedInvoiceEnvironmentComplete } from '@/lib/ksef/accounting-provenance';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  dzienPrzychodu,
  kluczKursu,
  zbudujEwidencje,
  type Ewidencja,
  type FakturaEwidencji,
  type KursPrzychodu,
  type RodzajFaktury,
  type WpisReczny,
} from '@/lib/ksiegowosc/ewidencja';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { czytajWersjeProfilu, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { czytajWpisyReczne } from '@/lib/ksiegowosc/wpisy-reczne';
import { nbpRateForCost } from '@/lib/nbp/client';

/**
 * `wpisy`: wszystkie wpisy ręczne roku, także te, które ewidencja odrzuciła
 * brakiem (do usunięcia na liście); `wersje`: profil do podpowiedzi stawki.
 */
export type WynikEwidencji =
  | { ok: true; ewidencja: Ewidencja; wpisy: WpisReczny[]; wersje: WersjaProfilu[] }
  | { ok: false; komunikat: string };

export interface OpcjeOdczytu {
  /** Kurs NBP sprzed dnia przychodu; domyślnie API NBP (`nbpRateForCost`). */
  kurs?: (waluta: string, dzien: string) => Promise<RateLookup>;
}

export const KOMUNIKAT_SRODOWISKO =
  'Część przyjętych faktur z tego okresu nie ma zapisanego środowiska KSeF, więc ewidencji nie liczymy, ' +
  'żeby nie pomieszać faktur testowych z prawdziwymi. Sprawdzimy to po zgłoszeniu w Pomocy.';
export const KOMUNIKAT_ODCZYT =
  'Nie udało się odczytać danych ewidencji, więc nie pokazujemy niepełnych kwot. Strona spróbuje ponownie przy następnym otwarciu.';

const KOLUMNY_FAKTURY =
  'id, internal_number, issue_date, sale_date, net_total, invoice_kind, invoice_type, advance_invoice_ids, ' +
  'currency, ksef_number, buyer_data, fp:fa3_data->ksefMarkers->>fp';
const KAWALEK = 100;

interface WierszFaktury {
  id: string;
  internal_number: string | null;
  issue_date: string;
  sale_date: string | null;
  net_total: number | string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  advance_invoice_ids: string[] | null;
  currency: string | null;
  ksef_number: string | null;
  buyer_data: unknown;
  fp: string | boolean | null;
}

interface WierszPozycji {
  id: string;
  invoice_id: string;
  net_amount: number | string | null;
  ryczalt_rate: number | string | null;
}

const doGroszy = (zl: number | string | null | undefined) => Math.round(Number(zl ?? 0) * 100);

/**
 * Kwoty przychodu liczy się jak w KPiR (`kpirRevenueNet`): tylko `final`
 * odejmuje rozliczone zaliczki. Typ z importu (KOR, ZAL) decyduje o dniu
 * korekty i o uwadze.
 */
export function rodzajFaktury(kind: string | null, type: string | null): RodzajFaktury {
  const typ = (type ?? '').toUpperCase();
  if (kind === 'correction' || typ.startsWith('KOR')) return 'korekta';
  if (kind === 'final') return 'rozliczenie';
  if (kind === 'advance' || typ === 'ZAL') return 'zaliczka';
  return 'zwykla';
}

/** K_6 i K_7: polski NIP albo numer VAT UE; nabywca bez identyfikatora podatkowego zostaje pusty. */
export function kontrahentJpk(buyer: unknown): FakturaEwidencji['kontrahent'] {
  const b = (buyer && typeof buyer === 'object' ? buyer : {}) as { nip?: unknown; vatUeNumber?: unknown };
  const nip = typeof b.nip === 'string' ? b.nip.replace(/\D/g, '') : '';
  if (nip.length === 10) return { kraj: 'PL', identyfikator: nip };
  const ue = typeof b.vatUeNumber === 'string' ? b.vatUeNumber.replace(/[\s.-]/g, '').toUpperCase() : '';
  const m = /^([A-Z]{2})([0-9A-Z+*]{2,48})$/.exec(ue);
  // VIES pisze Grecję jako EL, a słownik krajów MF ma GR.
  if (m) return { kraj: m[1] === 'EL' ? 'GR' : m[1], identyfikator: m[2] };
  return { kraj: null, identyfikator: null };
}

function kawalki<T>(lista: readonly T[]): T[][] {
  const wynik: T[][] = [];
  for (let i = 0; i < lista.length; i += KAWALEK) wynik.push(lista.slice(i, i + KAWALEK));
  return wynik;
}

async function pozycje(client: SupabaseClient, ids: readonly string[], tylkoZeStawka: boolean): Promise<WierszPozycji[]> {
  const wynik: WierszPozycji[] = [];
  for (const kawalek of kawalki(ids)) {
    wynik.push(
      ...(await readCompletePages<WierszPozycji>('ewidencja: pozycje faktur', (from, to) => {
        let q = client
          .from('invoice_line_items')
          .select('id, invoice_id, net_amount, ryczalt_rate', { count: 'exact' })
          .in('invoice_id', kawalek);
        if (tylkoZeStawka) q = q.not('ryczalt_rate', 'is', null);
        return q.order('id', { ascending: true }).range(from, to);
      })),
    );
  }
  return wynik;
}

/**
 * Pozycje tylko dla faktur, w których choć jedna pozycja ma własną stawkę.
 * Dziś żadna ścieżka wystawiania jej nie zapisuje, więc zwykle to jedno puste
 * zapytanie na 100 faktur.
 */
async function pozycjeZeStawkami(
  client: SupabaseClient,
  ids: readonly string[],
): Promise<Map<string, NonNullable<FakturaEwidencji['pozycje']>>> {
  const zeStawka = [...new Set((await pozycje(client, ids, true)).map((p) => p.invoice_id))];
  const mapa = new Map<string, NonNullable<FakturaEwidencji['pozycje']>>();
  for (const p of await pozycje(client, zeStawka, false)) {
    const lista = mapa.get(p.invoice_id) ?? [];
    lista.push({ nettoGr: doGroszy(p.net_amount), stawkaRyczaltu: p.ryczalt_rate });
    mapa.set(p.invoice_id, lista);
  }
  return mapa;
}

async function kursy(
  faktury: readonly FakturaEwidencji[],
  rok: number,
  kurs: NonNullable<OpcjeOdczytu['kurs']>,
): Promise<Map<string, KursPrzychodu>> {
  const potrzebne = new Map<string, { waluta: string; dzien: string }>();
  for (const f of faktury) {
    const dzien = dzienPrzychodu(f);
    if (f.waluta === 'PLN' || dzien.slice(0, 4) !== String(rok)) continue;
    potrzebne.set(kluczKursu(f.waluta, dzien), { waluta: f.waluta, dzien });
  }
  const mapa = new Map<string, KursPrzychodu>();
  for (const [klucz, { waluta, dzien }] of potrzebne) {
    try {
      const wynik = await kurs(waluta, dzien);
      mapa.set(
        klucz,
        wynik.found
          ? { znaleziony: true, mid: wynik.rate.mid, tabela: wynik.rate.tableNo, dataTabeli: wynik.rate.effectiveDate }
          : { znaleziony: false },
      );
    } catch (e) {
      console.error('[ewidencja] kurs NBP', waluta, dzien, e instanceof Error ? e.message : e);
      mapa.set(klucz, { znaleziony: false });
    }
  }
  return mapa;
}

function zWierszaFaktury(
  w: WierszFaktury,
  rozliczone: ReadonlyMap<string, number>,
  zeStawkami: ReadonlyMap<string, NonNullable<FakturaEwidencji['pozycje']>>,
): FakturaEwidencji {
  const numer = (w.internal_number ?? w.ksef_number ?? '').replace(/\s+/g, ' ').trim() || 'faktura bez numeru';
  return {
    id: w.id,
    numer,
    dataWystawienia: w.issue_date,
    dataSprzedazy: w.sale_date,
    rodzaj: rodzajFaktury(w.invoice_kind, w.invoice_type),
    nettoGr: doGroszy(w.net_total),
    waluta: (w.currency ?? 'PLN').trim().toUpperCase() || 'PLN',
    numerKsef: w.ksef_number,
    fp: w.fp === true || w.fp === 'true',
    kontrahent: kontrahentJpk(w.buyer_data),
    rozliczoneZaliczkiGr: doGroszy(rozliczone.get(w.id)),
    pozycje: zeStawkami.get(w.id) ?? null,
  };
}

export async function czytajEwidencje(
  client: SupabaseClient,
  tenantId: string,
  rok: number,
  opcje: OpcjeOdczytu = {},
): Promise<WynikEwidencji> {
  const od = `${rok}-01-01`;
  const koniecRoku = `${rok}-12-31`;
  const doWystawienia = addDaysToIsoDate(koniecRoku, MAX_SALE_DAYS_AFTER_ISSUE) ?? koniecRoku;

  let srodowisko;
  try {
    srodowisko = requireConfiguredKsefEnvironment();
    await assertAcceptedInvoiceEnvironmentComplete(client, {
      tenantId,
      periodStart: od,
      periodEnd: doWystawienia,
      direction: 'outgoing',
      environment: srodowisko,
    });
  } catch (e) {
    console.error('[ewidencja] środowisko KSeF', e instanceof Error ? e.message : e);
    return { ok: false, komunikat: KOMUNIKAT_SRODOWISKO };
  }

  try {
    const wiersze = await readCompletePages<WierszFaktury>('ewidencja: faktury', async (from, to) => {
      const wynik = await client
        .from('invoices')
        .select(KOLUMNY_FAKTURY, { count: 'exact' })
        .eq('tenant_id', tenantId)
        .eq('direction', 'outgoing')
        .eq('ksef_status', 'accepted')
        .eq('ksef_environment', srodowisko)
        .gte('issue_date', od)
        .lte('issue_date', doWystawienia)
        .order('id', { ascending: true })
        .range(from, to);
      return { data: wynik.data as WierszFaktury[] | null, count: wynik.count, error: wynik.error };
    });

    const [rozliczone, zeStawkami, wersje, wpisy] = await Promise.all([
      fetchSettledAdvancesNet(client, tenantId, wiersze),
      pozycjeZeStawkami(client, wiersze.map((w) => w.id)),
      czytajWersjeProfilu(client, tenantId),
      czytajWpisyReczne(client, tenantId, od, koniecRoku),
    ]);
    const faktury = wiersze.map((w) => zWierszaFaktury(w, rozliczone, zeStawkami));

    return {
      ok: true,
      ewidencja: zbudujEwidencje({
        rok,
        faktury,
        wpisy,
        wersje,
        kursy: await kursy(faktury, rok, opcje.kurs ?? nbpRateForCost),
        progNajmuGr: parametryRoku(rok)?.ryczalt.liczby.progStawki8_5.wartosc ?? null,
      }),
      wpisy,
      wersje,
    };
  } catch (e) {
    console.error('[ewidencja] odczyt', e instanceof Error ? e.message : e);
    return { ok: false, komunikat: KOMUNIKAT_ODCZYT };
  }
}
