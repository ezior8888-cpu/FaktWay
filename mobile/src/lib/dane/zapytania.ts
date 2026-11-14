/**
 * Odczyty z bazy na telefonie (plan aplikacji 4.3: „odczyty prosto z
 * Supabase klientem aplikacji; chroni je RLS”). Każde zapytanie niesie token
 * sesji i nagłówek `x-active-org`: baza daje wtedy `get_current_tenant_id()`
 * tylko przy aktywnym członkostwie (00037), jak strona. Dodatkowo filtr
 * `tenant_id`, jak w zapytaniach strony.
 */
import { czytajZBazy } from '@/lib/api/polaczenie';
import type { Wynik } from '@/lib/api/rdzen';
import {
  fakturaZBazy,
  KOLUMNY_FAKTURY,
  KOLUMNY_SKRZYNKI,
  KOLUMNY_WYDATKU,
  LIMIT_LISTY,
  skrzynkaZBazy,
  wydatekZBazy,
  type PowiazanyWydatek,
  type WierszFaktury,
  type WierszSkrzynki,
  type WierszWydatku,
} from '@/lib/dane/mapowanie';
import { supabase } from '@/lib/supabase';
import type { Faktura, FakturaKosztowa, Koszt } from '@/dane-przykladowe';

/** Nagłówek firmy dla PostgREST (`ACTIVE_ORG_HEADER` strony, małymi literami jak w `lib/supabase/active-org.ts`). */
const NAGLOWEK_FIRMY = 'x-active-org';

/** Kawałki listy id do filtra `in`: adres zapytania PostgREST ma limit długości (jak `ID_CHUNK` strony). */
const KAWALEK_ID = 100;

function klient() {
  if (!supabase) throw new Error('Brak klienta Supabase');
  return supabase;
}

export type WynikListy<T> = Wynik<{ lista: T[]; pelna: boolean }>;

/** Najnowsze faktury wystawione (jak lista strony: od ostatnio utworzonej) z pozycjami. */
export async function pobierzFaktury(firma: string): Promise<WynikListy<Faktura>> {
  const wynik = await czytajZBazy<WierszFaktury[]>((token, sygnal) =>
    klient()
      .from('invoices')
      .select(KOLUMNY_FAKTURY)
      .eq('tenant_id', firma)
      .eq('direction', 'outgoing')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(LIMIT_LISTY)
      .setHeader('Authorization', `Bearer ${token}`)
      .setHeader(NAGLOWEK_FIRMY, firma)
      .abortSignal(sygnal)
      .returns<WierszFaktury[]>(),
  );
  if (!wynik.ok) return wynik;
  return { ok: true, status: wynik.status, dane: { lista: wynik.dane.map(fakturaZBazy), pelna: wynik.dane.length < LIMIT_LISTY } };
}

/** Wydatki powiązane z fakturami ze skrzynki; błąd daje `null` (status „—”), nie chowa listy. */
async function wydatkiSkrzynki(firma: string, idFaktur: string[]): Promise<PowiazanyWydatek[] | null> {
  const wszystkie: PowiazanyWydatek[] = [];
  for (let i = 0; i < idFaktur.length; i += KAWALEK_ID) {
    const kawalek = idFaktur.slice(i, i + KAWALEK_ID);
    const wynik = await czytajZBazy<PowiazanyWydatek[]>((token, sygnal) =>
      klient()
        .from('expenses')
        .select('id, ksef_invoice_id, is_reviewed')
        .eq('tenant_id', firma)
        .in('ksef_invoice_id', kawalek)
        .setHeader('Authorization', `Bearer ${token}`)
        .setHeader(NAGLOWEK_FIRMY, firma)
        .abortSignal(sygnal)
        .returns<PowiazanyWydatek[]>(),
    );
    if (!wynik.ok) return null;
    wszystkie.push(...wynik.dane);
  }
  return wszystkie;
}

/** Skrzynka KSeF: faktury kosztowe od najnowszej przyjętej w KSeF (jak strona). */
export async function pobierzSkrzynke(firma: string): Promise<WynikListy<FakturaKosztowa>> {
  const wynik = await czytajZBazy<WierszSkrzynki[]>((token, sygnal) =>
    klient()
      .from('invoices')
      .select(KOLUMNY_SKRZYNKI)
      .eq('tenant_id', firma)
      .eq('direction', 'incoming')
      .order('ksef_accepted_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(LIMIT_LISTY)
      .setHeader('Authorization', `Bearer ${token}`)
      .setHeader(NAGLOWEK_FIRMY, firma)
      .abortSignal(sygnal)
      .returns<WierszSkrzynki[]>(),
  );
  if (!wynik.ok) return wynik;
  const wydatki = wynik.dane.length > 0 ? await wydatkiSkrzynki(firma, wynik.dane.map((w) => w.id)) : [];
  return { ok: true, status: wynik.status, dane: { lista: skrzynkaZBazy(wynik.dane, wydatki), pelna: wynik.dane.length < LIMIT_LISTY } };
}

/**
 * Wydatki (M9): najnowsze według daty dokumentu, jak lista kosztów strony
 * (`expenses` w `(koszty)/expenses`), wszystkie źródła (zdjęcie, KSeF, ręcznie, import).
 */
export async function pobierzWydatki(firma: string): Promise<WynikListy<Koszt>> {
  const wynik = await czytajZBazy<WierszWydatku[]>((token, sygnal) =>
    klient()
      .from('expenses')
      .select(KOLUMNY_WYDATKU)
      .eq('tenant_id', firma)
      .order('issue_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(LIMIT_LISTY)
      .setHeader('Authorization', `Bearer ${token}`)
      .setHeader(NAGLOWEK_FIRMY, firma)
      .abortSignal(sygnal)
      .returns<WierszWydatku[]>(),
  );
  if (!wynik.ok) return wynik;
  return { ok: true, status: wynik.status, dane: { lista: wynik.dane.map(wydatekZBazy), pelna: wynik.dane.length < LIMIT_LISTY } };
}
