'use server';

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { logAudit, logAuditWithResult } from '@/lib/audit/log';
import { wczytajKosztyDoPliku } from '@/lib/expenses/do-zaplaty-dane';
import { rekordElixir } from '@/lib/expenses/elixir0';
import { zakodujPlikElixir } from '@/lib/expenses/elixir0-kodowanie';
import {
  LIMIT_PRZELEWOW_W_PLIKU,
  nazwaPlikuPrzelewow,
  POWODY,
  powodBleduWykazu,
  powodBrakuDowodu,
  powodPozaWykazem,
  type KandydatPrzelewu,
  type PlikPrzelewowResult,
  type PominietyKoszt,
  type PrzelewWPliku,
} from '@/lib/expenses/plik-przelewow';
import { planPlikuPrzelewow, sumaPrzelewow } from '@/lib/expenses/plik-przelewow-plan';
import { readTenantBankAccount } from '@/lib/expenses/rachunek-firmy';
import { EXPENSE_PAYMENT_ROLES } from '@/lib/expenses/zaplata-kosztu';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';
import { checkBankAccountAssignment } from '@/lib/validation/whitelist-client';

/**
 * „Pobierz plik przelewów” z listy „Do zapłaty” (plan kompletnej aplikacji,
 * krok 3.4, część 2). Klucz sesji (RLS), role jak przy zapłacie kosztu
 * (księgowa ma wgląd). Plik Elixir-0 w Windows-1250 wraca jako base64 razem
 * z podsumowaniem: co weszło, co zostało poza plikiem i dlaczego.
 *
 * Biała lista (RP-BL-01): każdy koszt ponad 15 000 zł brutto przechodzi
 * świeże sprawdzenie metodą `check` API MF (NIP i rachunek, dzień w Polsce).
 * Do pliku wchodzi tylko po „TAK” i po zapisie dowodu (`requestId`)
 * w `audit_logs`; „NIE”, każdy błąd API i nieudany zapis dowodu zostawiają go
 * poza plikiem z komunikatem (fail-closed).
 *
 * Ponowienie (dwuklik, odświeżenie): akcja niczego nie zmienia w kosztach,
 * więc drugie wywołanie daje nowy plik i nowe sprawdzenie z nowym dowodem
 * w audycie. Zapłata dalej idzie przez „Oznacz jako zapłacone” albo wyciąg.
 */

const idSchema = z.string().uuid();
/** Równoległe zapytania do API MF: limit jest wspólny dla serwera, więc po kilka naraz. */
const SPRAWDZENIA_NARAZ = 4;

const BLAD = 'Nie udało się przygotować pliku przelewów. Odśwież stronę i spróbuj ponownie.';
const ROLA =
  'Plik przelewów pobiera właściciel, administrator albo członek firmy. Księgowa ma tu wgląd w dane do przelewu.';
const BRAK_RACHUNKU_FIRMY =
  'Uzupełnij rachunek firmy w Ustawieniach (zakładka Firma, „Rachunek firmy”). Z niego plik zleca przelewy jako rachunek zleceniodawcy.';

async function authorized(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...EXPENSE_PAYMENT_ROLES]) };
  } catch (e) {
    if (e instanceof ActionAuthError) return { error: e.message === 'Niewystarczające uprawnienia' ? ROLA : e.message };
    throw e;
  }
}

async function poKilka<T, R>(elementy: readonly T[], naraz: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const wyniki: R[] = new Array<R>(elementy.length);
  let nastepny = 0;
  const watki = Array.from({ length: Math.min(naraz, elementy.length) }, async () => {
    while (nastepny < elementy.length) {
      const i = nastepny++;
      wyniki[i] = await fn(elementy[i]!);
    }
  });
  await Promise.all(watki);
  return wyniki;
}

type WynikSprawdzenia =
  | { wpuszczony: true; dowod: { requestId: string; dzien: string } | null }
  | { wpuszczony: false; pominiecie: Omit<PominietyKoszt, 'id' | 'sprzedawca' | 'numerFaktury'> };

async function sprawdzBialaLista(
  k: KandydatPrzelewu,
  dzis: string,
  wpis: { tenantId: string; userId: string },
): Promise<WynikSprawdzenia> {
  if (!k.bialaLista) return { wpuszczony: true, dowod: null };
  if (!/^\d{10}$/.test(k.bialaLista.nip)) {
    return { wpuszczony: false, pominiecie: { kod: 'biala_lista_nip', powod: POWODY.biala_lista_nip } };
  }
  const rachunek = k.przelew.rachunekOdbiorcy;
  const wynik = await checkBankAccountAssignment(k.bialaLista.nip, rachunek, dzis);
  const metadata = {
    nip: k.bialaLista.nip,
    rachunek,
    dzien: dzis,
    kwota: k.koszt.kwota,
    brutto: k.koszt.brutto,
    numerKsef: k.koszt.numerKsef,
    wynik: wynik.status === 'assigned' ? 'TAK' : wynik.status === 'not_assigned' ? 'NIE' : 'błąd',
    ...(wynik.status === 'error'
      ? { blad: wynik.errorCode }
      : { requestId: wynik.requestId, requestDateTime: wynik.requestDateTime }),
  };
  const zapisany = await logAuditWithResult({
    action: 'expense.whitelist_checked',
    tenantId: wpis.tenantId,
    userId: wpis.userId,
    entityType: 'expense',
    entityId: k.koszt.id,
    metadata,
  });

  if (wynik.status === 'error') {
    return { wpuszczony: false, pominiecie: { kod: 'biala_lista_blad', powod: powodBleduWykazu(wynik.error) } };
  }
  if (wynik.status === 'not_assigned') {
    // Skutek w PIT według dnia wystawienia faktury kosztowej (art. 3 Dz.U. 2026 poz. 1371), nie dnia pliku.
    const powod = powodPozaWykazem(dzis, wynik.requestId, k.koszt.sankcjaPitBialejListy);
    return { wpuszczony: false, pominiecie: { kod: 'biala_lista_poza', powod } };
  }
  if (zapisany !== true) {
    return { wpuszczony: false, pominiecie: { kod: 'biala_lista_dowod', powod: powodBrakuDowodu(wynik.requestId) } };
  }
  return { wpuszczony: true, dowod: { requestId: wynik.requestId, dzien: dzis } };
}

export async function pobierzPlikPrzelewowAction(ids: string[]): Promise<PlikPrzelewowResult> {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { success: false, error: 'Zaznacz co najmniej jeden koszt do pliku przelewów.' };
  }
  const zaznaczone = [...new Set(ids)];
  if (!zaznaczone.every((id) => idSchema.safeParse(id).success)) return { success: false, error: BLAD };
  if (zaznaczone.length > LIMIT_PRZELEWOW_W_PLIKU) {
    return {
      success: false,
      error: `Plik może mieć najwyżej ${LIMIT_PRZELEWOW_W_PLIKU} przelewów (tyle przyjmuje w jednym pliku część banków). Zaznacz mniej kosztów i pobierz kilka plików.`,
    };
  }

  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { supabase, tenantId, user } = auth.ctx;

  const srodowisko = configuredKsefEnvironment();
  if (!srodowisko) return { success: false, error: BLAD };

  let rachunekFirmy: string | null;
  try {
    rachunekFirmy = await readTenantBankAccount(supabase, tenantId);
  } catch {
    return { success: false, error: BLAD };
  }
  if (!rachunekFirmy) return { success: false, error: BRAK_RACHUNKU_FIRMY };

  const { data: firma, error: bladFirmy } = await supabase
    .from('tenants')
    .select('name, address_json')
    .eq('id', tenantId)
    .maybeSingle();
  if (bladFirmy || !firma) return { success: false, error: BLAD };
  const adres = (firma.address_json && typeof firma.address_json === 'object' ? firma.address_json : {}) as {
    addressLine1?: unknown;
    addressLine2?: unknown;
  };
  const linia = (v: unknown) => (typeof v === 'string' ? v : null);

  const dane = await wczytajKosztyDoPliku(supabase, tenantId, srodowisko, zaznaczone);
  if ('blad' in dane) {
    console.error('[plik-przelewow] odczyt kosztów', tenantId);
    return { success: false, error: BLAD };
  }

  const dzis = todayInWarsaw();
  const plan = planPlikuPrzelewow({
    wiersze: dane.wiersze,
    ids: zaznaczone,
    nadawca: { nazwa: firma.name, adres: [linia(adres.addressLine1), linia(adres.addressLine2)], rachunek: rachunekFirmy },
    dzis,
  });
  if (plan.bladNadawcy) return { success: false, error: plan.bladNadawcy };

  const sprawdzenia = await poKilka(plan.kandydaci, SPRAWDZENIA_NARAZ, (k) =>
    sprawdzBialaLista(k, dzis, { tenantId, userId: user.id }),
  );

  const pominiete = [...plan.pominiete];
  const wPliku: Array<{ k: KandydatPrzelewu; dowod: PrzelewWPliku['bialaLista'] }> = [];
  plan.kandydaci.forEach((k, i) => {
    const s = sprawdzenia[i]!;
    if (s.wpuszczony) wPliku.push({ k, dowod: s.dowod });
    else pominiete.push({ id: k.koszt.id, sprzedawca: k.koszt.sprzedawca, numerFaktury: k.koszt.numerFaktury, ...s.pominiecie });
  });
  const kolejnosc = new Map(zaznaczone.map((id, i) => [id, i]));
  pominiete.sort((a, b) => (kolejnosc.get(a.id) ?? 0) - (kolejnosc.get(b.id) ?? 0));

  const przelewy: PrzelewWPliku[] = wPliku.map(({ k, dowod }) => ({
    id: k.koszt.id,
    sprzedawca: k.koszt.sprzedawca,
    numerFaktury: k.koszt.numerFaktury,
    kwota: k.koszt.kwota,
    dataWykonania: k.przelew.dataWykonania,
    mpp: k.przelew.mpp,
    bialaLista: dowod,
  }));
  const podsumowanie = {
    nazwaPliku: null as string | null,
    dzien: dzis,
    liczba: przelewy.length,
    suma: sumaPrzelewow(wPliku.map(({ k }) => k.przelew)),
    mpp: przelewy.filter((p) => p.mpp).length,
    przelewy,
    pominiete,
  };
  if (wPliku.length === 0) return { success: true, plik: null, podsumowanie };

  let bajty: Uint8Array;
  try {
    bajty = zakodujPlikElixir(wPliku.map(({ k }) => rekordElixir(k.przelew)));
  } catch (e) {
    console.error('[plik-przelewow] kodowanie', tenantId, e instanceof Error ? e.message : 'nieznany');
    return { success: false, error: BLAD };
  }
  const nazwa = nazwaPlikuPrzelewow(dzis);

  await logAudit({
    action: 'expense.transfer_file_created',
    tenantId,
    userId: user.id,
    entityType: 'expense',
    metadata: {
      plik: nazwa,
      sha256: createHash('sha256').update(bajty).digest('hex'),
      rachunekNadawcy: rachunekFirmy,
      liczba: przelewy.length,
      sumaGrosze: wPliku.reduce((s, { k }) => s + k.przelew.kwotaGrosze, 0),
      przelewy: wPliku.map(({ k, dowod }) => ({
        id: k.koszt.id,
        kwotaGrosze: k.przelew.kwotaGrosze,
        dataWykonania: k.przelew.dataWykonania,
        mpp: k.przelew.mpp,
        requestId: dowod?.requestId ?? null,
      })),
      pominiete: pominiete.map((p) => ({ id: p.id, kod: p.kod })),
    },
  });

  return {
    success: true,
    plik: { nazwa, base64: Buffer.from(bajty).toString('base64') },
    podsumowanie: { ...podsumowanie, nazwaPliku: nazwa },
  };
}
