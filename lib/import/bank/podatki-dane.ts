/**
 * Odczyty serwerowe dla przelewów do ZUS i urzędu skarbowego z wyciągu (plan
 * kompletnej aplikacji, krok 3.2, część 2): wyłącznik modułu, rachunki firmy
 * do rozpoznania przelewu, rozliczenia z „Ten miesiąc” i dane ekranu „Bank”.
 * Klient z sesji (RLS); `payment_imports` czytamy tylko przez RPC
 * `bank_tax_operations` (00189), bo tabela jest zamknięta dla sesji (00074).
 *
 * Moduł księgowości tylko czytamy: rachunki liczą jego funkcje
 * (`czytajWersjeProfilu`, `mikrorachunekZNip`), a wyłącznik to ten sam obszar,
 * którego używa „Zapłacone” na ekranie rozliczeń (`ten_miesiac`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { czytajWersjeProfilu } from '@/lib/ksiegowosc/profil';
import type { RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';

import {
  opisPropozycji,
  opisRozstrzygniecia,
  parseBankTaxOperationsRpc,
  propozycjaZaplaty,
  TAX_LOAD_FAILED,
  type KontaPodatkowe,
  type PrzelewyPodatkoweEkranu,
  type RozliczenieZaplaty,
} from './podatki';

/** Obszar wyłącznika: ten sam, za którym jest oznaczanie zapłat rozliczeń (`oznaczZaplaconeAction`). */
export const OBSZAR_ZAPLAT = 'ten_miesiac' as const;

/** Czy firma ma moduł z zapłatami rozliczeń. Błąd odczytu to „nie” (bez przelewów podatkowych). */
export async function zaplatyZWyciaguWlaczone(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, OBSZAR_ZAPLAT)).wlaczony;
  } catch {
    return false;
  }
}

/**
 * Rachunek składkowy ZUS ze wszystkich wersji ustawień podatkowych i mikrorachunek
 * z NIP firmy. Błąd odczytu rzuca: „nie wiem” to nie „brak rachunku”.
 */
export async function czytajKontaPodatkowe(client: SupabaseClient, tenantId: string): Promise<KontaPodatkowe> {
  const [wersje, firma] = await Promise.all([
    czytajWersjeProfilu(client, tenantId),
    client.from('tenants').select('nip').eq('id', tenantId).maybeSingle(),
  ]);
  if (firma.error) throw new Error(`Nie można odczytać NIP firmy: ${firma.error.message}`);
  const nip = String((firma.data as { nip?: unknown } | null)?.nip ?? '');
  const zus = [...new Set(wersje.map((w) => w.nrsZus).filter((nrs): nrs is string => typeof nrs === 'string' && nrs !== ''))];
  return { zus, us: nip === '' ? null : mikrorachunekZNip(nip) };
}

interface WierszRozliczenia {
  id: string;
  okres: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwota_gr: number | string;
  status: 'zatwierdzone' | 'zaplacone';
  zaplacone_o: string | null;
}

/** Wszystkie wersje rozliczeń firmy (`tax_settlements`, 00168), w całości albo błąd. */
export async function czytajRozliczeniaZaplat(client: SupabaseClient, tenantId: string): Promise<RozliczenieZaplaty[]> {
  const rows = await readCompletePages<WierszRozliczenia>('bank: rozliczenia', async (from, to) => {
    const wynik = await client
      .from('tax_settlements')
      .select('id, okres, rodzaj, wersja, kwota_gr, status, zaplacone_o', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(from, to);
    // Przed wgraniem 00168: Postgres 42P01, PostgREST PGRST205.
    if (wynik.error && (wynik.error.code === '42P01' || wynik.error.code === 'PGRST205')) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszRozliczenia[] | null, count: wynik.count, error: wynik.error };
  });
  return rows.map((w) => ({
    id: w.id,
    miesiac: w.okres.slice(0, 7),
    rodzaj: w.rodzaj,
    wersja: w.wersja,
    kwotaGr: Number(w.kwota_gr),
    status: w.status,
    zaplaconeO: w.zaplacone_o,
  }));
}

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
/** `bank_tax_operations` z 00189; do czasu typów z produkcji przez ten kształt. */
interface TaxReadRpc {
  rpc(fn: 'bank_tax_operations'): RpcResult;
}

/**
 * Dane sekcji „Zapłaty do ZUS i urzędu skarbowego”: `null`, gdy moduł jest
 * wyłączony dla firmy (sekcji nie ma, przelewów nie pokazujemy). Propozycje
 * liczy serwer przy każdym wejściu, więc rozliczenie zatwierdzone albo
 * zapłacone w międzyczasie zmienia propozycję.
 */
export async function czytajPrzelewyPodatkowe(client: SupabaseClient, tenantId: string): Promise<PrzelewyPodatkoweEkranu | null> {
  if (!(await zaplatyZWyciaguWlaczone(client, tenantId))) return null;

  const rpc = await (client as unknown as TaxReadRpc).rpc('bank_tax_operations');
  if (rpc.error) console.error('[bank] bank_tax_operations', rpc.error.code);
  const dane = rpc.error ? null : parseBankTaxOperationsRpc(rpc.data);
  if (!dane) return { ok: false, error: TAX_LOAD_FAILED };

  let rozliczenia: RozliczenieZaplaty[] | null = [];
  if (dane.pending.length > 0 || dane.decided.length > 0) {
    rozliczenia = await czytajRozliczeniaZaplat(client, tenantId).catch((error: unknown) => {
      console.error('[bank] rozliczenia do zapłat', error instanceof Error ? error.message : 'błąd');
      return null;
    });
  }

  const potwierdzone = new Map(dane.links.flatMap((link) => link.settlementIds.map((id) => [id, link.id] as const)));
  const pending = dane.pending.map((op) => {
    if (!rozliczenia) return { ...op, propozycja: null, opis: null };
    const propozycja = propozycjaZaplaty(op, rozliczenia, potwierdzone);
    return { ...op, propozycja, opis: opisPropozycji(op, propozycja) };
  });
  const poId = new Map((rozliczenia ?? []).map((r) => [r.id, r]));
  const decided = dane.decided.map((d) => ({ ...d, ...opisRozstrzygniecia(d, poId) }));
  return { ok: true, pending, pendingTotal: dane.pendingTotal, decided, bladRozliczen: rozliczenia === null };
}
