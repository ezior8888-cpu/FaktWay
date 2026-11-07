/**
 * Wysyłki JPK w bazie (`jpk_submissions`, migracja 00170; plan księgowości
 * JDG, K6). Wiersz powstaje przed wysłaniem, a każda zmiana stanu idzie
 * z warunkiem na stan poprzedni, więc dwa równoległe odświeżenia statusu
 * nie zapiszą wyniku dwa razy. Danych autoryzujących ani pliku tu nie ma.
 *
 * Klient z sesji (RLS: odczyt członkowie firmy, zapis owner/admin).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { SrodowiskoMf } from './certyfikaty';

export type StanZapisu = 'wysylanie' | 'w_toku' | 'przyjeta' | 'odrzucona' | 'przerwana';

/** Część deklaracyjna w pełnych złotych (P_62 to P_39 następnego miesiąca). */
export interface DeklaracjaVat {
  P_38: number;
  P_39: number;
  P_48: number;
  P_51: number;
  P_62: number;
}

export interface Wysylka {
  id: string;
  /** Pierwszy dzień miesiąca. */
  okres: string;
  cel: 1 | 2;
  srodowisko: SrodowiskoMf;
  skrotPliku: string;
  deklaracja: DeklaracjaVat;
  stan: StanZapisu;
  numerReferencyjny: string | null;
  statusKod: number | null;
  statusOpis: string | null;
  upoSciezka: string | null;
  blad: string | null;
  utworzonoO: string;
  wyslanoO: string | null;
  zakonczonoO: string | null;
}

/** Wiersz „wysylanie” starszy niż tyle minut to przerwana wysyłka (zapis w 00170). */
export const PRZERWANA_PO_MIN = 15;

const KOLUMNY =
  'id, okres, cel, srodowisko, skrot_pliku, deklaracja, stan, numer_referencyjny, status_kod, status_opis, upo_sciezka, blad, utworzono_o, wyslano_o, zakonczono_o';

interface Wiersz {
  id: string;
  okres: string;
  cel: number;
  srodowisko: SrodowiskoMf;
  skrot_pliku: string;
  deklaracja: DeklaracjaVat;
  stan: StanZapisu;
  numer_referencyjny: string | null;
  status_kod: number | null;
  status_opis: string | null;
  upo_sciezka: string | null;
  blad: string | null;
  utworzono_o: string;
  wyslano_o: string | null;
  zakonczono_o: string | null;
}

function zWiersza(w: Wiersz): Wysylka {
  return {
    id: w.id,
    okres: w.okres,
    cel: w.cel === 2 ? 2 : 1,
    srodowisko: w.srodowisko,
    skrotPliku: w.skrot_pliku,
    deklaracja: w.deklaracja,
    stan: w.stan,
    numerReferencyjny: w.numer_referencyjny,
    statusKod: w.status_kod,
    statusOpis: w.status_opis,
    upoSciezka: w.upo_sciezka,
    blad: w.blad,
    utworzonoO: w.utworzono_o,
    wyslanoO: w.wyslano_o,
    zakonczonoO: w.zakonczono_o,
  };
}

/** Wysyłki JPK_V7M za podane okresy, od najnowszej. */
export async function czytajWysylki(client: SupabaseClient, tenantId: string, okresy: readonly string[]): Promise<Wysylka[]> {
  const { data, error } = await client
    .from('jpk_submissions')
    .select(KOLUMNY)
    .eq('tenant_id', tenantId)
    .eq('rodzaj', 'JPK_V7M')
    .in('okres', [...okresy])
    .order('utworzono_o', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Nie udało się odczytać wysyłek JPK: ${error.message}`);
  return ((data ?? []) as Wiersz[]).map(zWiersza);
}

export async function czytajWysylke(client: SupabaseClient, tenantId: string, id: string): Promise<Wysylka | null> {
  const { data, error } = await client.from('jpk_submissions').select(KOLUMNY).eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw new Error(`Nie udało się odczytać wysyłki JPK: ${error.message}`);
  return data ? zWiersza(data as Wiersz) : null;
}

/** P_62 najnowszej przyjętej przez MF deklaracji (tego środowiska) za okres albo null. */
export function nadwyzkaPrzyjetej(wysylki: readonly Wysylka[], okres: string, srodowisko: SrodowiskoMf): number | null {
  const przyjeta = wysylki
    .filter((w) => w.okres === okres && w.stan === 'przyjeta' && w.srodowisko === srodowisko)
    .sort((a, b) => (b.zakonczonoO ?? '').localeCompare(a.zakonczonoO ?? ''))[0];
  return przyjeta ? przyjeta.deklaracja.P_62 : null;
}

/** Zamyka jako „przerwana” wysyłkę, która utknęła przed numerem referencyjnym (wyjście z blokady 00170). */
export async function zamknijPrzerwane(client: SupabaseClient, tenantId: string, okres: string, teraz: Date = new Date()): Promise<void> {
  const granica = new Date(teraz.getTime() - PRZERWANA_PO_MIN * 60_000).toISOString();
  const { error } = await client
    .from('jpk_submissions')
    .update({ stan: 'przerwana', blad: 'Wysyłka przerwana przed numerem referencyjnym MF.', zakonczono_o: teraz.toISOString() })
    .eq('tenant_id', tenantId)
    .eq('okres', okres)
    .eq('rodzaj', 'JPK_V7M')
    .eq('stan', 'wysylanie')
    .lt('utworzono_o', granica);
  if (error) throw new Error(`Nie udało się zamknąć przerwanej wysyłki JPK: ${error.message}`);
}

/** Nowa wysyłka w stanie „wysylanie”; `w_toku`, gdy za ten okres jedna już trwa (indeks z 00170). */
export async function zalozWysylke(
  client: SupabaseClient,
  tenantId: string,
  w: { okres: string; cel: 1 | 2; srodowisko: SrodowiskoMf; skrotPliku: string; deklaracja: DeklaracjaVat },
): Promise<{ id: string } | 'w_toku'> {
  const { data, error } = await client
    .from('jpk_submissions')
    .insert({ tenant_id: tenantId, okres: w.okres, rodzaj: 'JPK_V7M', cel: w.cel, srodowisko: w.srodowisko, skrot_pliku: w.skrotPliku, deklaracja: w.deklaracja })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') return 'w_toku';
    throw new Error(`Nie udało się zapisać wysyłki JPK: ${error.message}`);
  }
  return { id: (data as { id: string }).id };
}

export type ZmianaWysylki = Partial<{
  stan: StanZapisu;
  numer_referencyjny: string;
  status_kod: number | null;
  status_opis: string | null;
  upo_sciezka: string;
  blad: string | null;
  wyslano_o: string;
  sprawdzono_o: string;
  zakonczono_o: string;
}>;

/** Zmiana stanu z warunkiem na stan poprzedni; false, gdy ktoś zdążył wcześniej. */
export async function zmienWysylke(client: SupabaseClient, id: string, zeStanu: StanZapisu, zmiana: ZmianaWysylki): Promise<boolean> {
  const z = { ...zmiana };
  if (z.status_opis) z.status_opis = z.status_opis.slice(0, 1000);
  if (z.blad) z.blad = z.blad.slice(0, 1000);
  const { data, error } = await client.from('jpk_submissions').update(z).eq('id', id).eq('stan', zeStanu).select('id');
  if (error) throw new Error(`Nie udało się zapisać stanu wysyłki JPK: ${error.message}`);
  return (data ?? []).length > 0;
}
