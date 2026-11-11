'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { zglosAlarmy } from '@/lib/bezpieczniki/alarm';
import { odmowaJpkEwp, sprawdzJpkEwp } from '@/lib/bezpieczniki/jpk-ewp';
import { odmowaJpkPkpir, sprawdzJpkPkpir } from '@/lib/bezpieczniki/jpk-pkpir';
import { redactXsdMessage } from '@/lib/exports/jpk-schema-check';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { brakiOkresu, sumyOkresu, wierszeOkresu } from '@/lib/ksiegowosc/ewidencja';
import { czytajEwidencje } from '@/lib/ksiegowosc/ewidencja-dane';
import { celZlozenia, generujJpkEwp, nazwaPlikuJpkEwp } from '@/lib/ksiegowosc/jpk-ewp';
import { validateJpkEwp, validateJpkPkpir } from '@/lib/ksiegowosc/jpk-ewp-walidator';
import { generujJpkPkpir, nazwaPlikuJpkPkpir } from '@/lib/ksiegowosc/jpk-pkpir';
import { brakiKpirOkresu, sumyKpir, wierszeKpirOkresu } from '@/lib/ksiegowosc/kpir';
import { KOLUMNY_SPISU, spisSchema, spisyPliku, zWierszaSpisu, type SpisWejscie } from '@/lib/ksiegowosc/spis-z-natury';
import { czytajKpir } from '@/lib/ksiegowosc/kpir-dane';
import { czytajWersjeProfilu, NAZWY_FORM, wersjaNa } from '@/lib/ksiegowosc/profil';
import {
  doWierszaWpisu,
  doWierszaWpisuKpir,
  KOLUMNY_WPISU,
  KOLUMNY_WPISU_KPIR,
  wpisKpirSchema,
  wpisSchema,
  zWierszaWpisu,
  zWierszaWpisuKpir,
  type WpisKpirWejscie,
  type WpisWejscie,
} from '@/lib/ksiegowosc/wpisy-reczne';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Akcje ewidencji przychodów (plan księgowości JDG, K3): wpisy ręczne
 * (dodanie i usunięcie, owner/admin, z audytem) i pobranie pliku JPK_EWP(4).
 * Od K7 także KPiR przy skali i liniowym: wpis ręczny z kolumną KPiR (00171)
 * i plik JPK_PKPIR(3).
 * Wszystko za wyłącznikiem modułu (obszar `ewidencja`) i klientem z sesji.
 *
 * Ponowienie: dodanie nie ma klucza, więc podwójne kliknięcie dałoby dwa
 * wpisy; przycisk jest zablokowany na czas zapisu, a nadmiarowy wpis widać
 * na liście i usuwa się go z wpisem w audycie. Usunięcie drugi raz kończy
 * się komunikatem „wpis już nie istnieje”. Pobranie nie zmienia danych.
 */

export type WynikWpisu = { success: true } | { success: false; error: string; pole?: string };
export type WynikPobrania = { success: true; xml: string; nazwa: string } | { success: false; error: string; pole?: string };

const NIEDOSTEPNE = 'Ewidencja przychodów nie jest jeszcze dostępna dla tej firmy.';
const KPIR_NIEDOSTEPNA = 'KPiR w module księgowości jest chwilowo niedostępna dla tej firmy.';
/** KPiR (K7): obszar `ewidencja` (globalny stop, flaga firmy) i blokada w kodzie obszaru `kpir`. */
const kpirWlaczona = async (client: SupabaseClient, tenantId: string) => statusObszaru('kpir').wlaczony && (await wlaczona(client, tenantId));
const BLAD_ZAPISU = 'Nie udało się zapisać wpisu i nic się nie zmieniło. Można spróbować jeszcze raz.';
const BLAD_USUNIECIA = 'Nie udało się usunąć wpisu i nic się nie zmieniło. Można spróbować jeszcze raz.';
const PROFIL_TEKST = 'Ustawienia są w Księgowości, w zakładce „Ustawienia podatkowe”.';

async function wlaczona(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, 'ewidencja')).wlaczony;
  } catch {
    return false;
  }
}

export async function dodajWpisRecznyAction(wejscie: WpisWejscie): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  const parsed = wpisSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy wpis.', pole: issue?.path.join('.') };
  }
  const wpis = parsed.data;
  if (wpis.dataPrzychodu > todayInWarsaw()) {
    return { success: false, error: 'Data przychodu nie może być późniejsza niż dziś.', pole: 'dataPrzychodu' };
  }

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczona(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  let wersje;
  try {
    wersje = await czytajWersjeProfilu(client, ctx.tenantId);
  } catch {
    return { success: false, error: BLAD_ZAPISU };
  }
  const wersja = wersjaNa(wersje, wpis.dataPrzychodu);
  const kiedy = formatIsoDatePl(wpis.dataPrzychodu);
  if (!wersja) {
    return {
      success: false,
      error: `Bez ustawień podatkowych na ${kiedy} wpis nie trafi do ewidencji. ${PROFIL_TEKST}`,
      pole: 'dataPrzychodu',
    };
  }
  if (wersja.forma !== 'ryczalt') {
    return {
      success: false,
      error: `${kiedy} forma opodatkowania to ${NAZWY_FORM[wersja.forma].toLowerCase()}, więc wpis nie należy do ewidencji przychodów.`,
      pole: 'dataPrzychodu',
    };
  }

  // `ledger_manual_entries` dojdzie do types/database.ts po wgraniu 00167 (typy z produkcji).
  const { data, error } = await client
    .from('ledger_manual_entries')
    .insert(doWierszaWpisu(ctx.tenantId, wpis))
    .select(KOLUMNY_WPISU)
    .single();
  if (error || !data) return { success: false, error: BLAD_ZAPISU };

  const zapisany = zWierszaWpisu(data as Parameters<typeof zWierszaWpisu>[0]);
  await logAudit({
    action: 'ledger_entry.created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_manual_entry',
    entityId: zapisany.id,
    metadata: { wpis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function usunWpisRecznyAction(id: string): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: BLAD_USUNIECIA };

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczona(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  const { data, error } = await client
    .from('ledger_manual_entries')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    // Cały wiersz: wpis KPiR (K7, 00171) ma kolumnę zamiast stawki, a audyt pokazuje, co usunięto.
    .select('*');
  if (error) return { success: false, error: BLAD_USUNIECIA };
  const usuniety = (data ?? [])[0] as (Parameters<typeof zWierszaWpisu>[0] & { kolumna?: string | null }) | undefined;
  if (!usuniety) return { success: false, error: 'Tego wpisu już nie ma na liście.' };

  await logAudit({
    action: 'ledger_entry.deleted',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_manual_entry',
    entityId: id,
    metadata: { wpis: { ...zWierszaWpisu(usuniety), ...(usuniety.kolumna ? { kolumna: usuniety.kolumna } : {}) } },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

const pobranieSchema = z.object({
  rok: z.number().int().min(2026).max(2100),
  doMiesiaca: z.number().int().min(1).max(12),
  imie: z.string().trim().min(1, 'Brak imienia.').max(30, 'Imię ma w JPK najwyżej 30 znaków.'),
  nazwisko: z.string().trim().min(1, 'Brak nazwiska.').max(81, 'Nazwisko ma w JPK najwyżej 81 znaków.'),
  dataUrodzenia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Brak daty urodzenia.')
    .refine((v) => v >= '1900-01-01' && v < todayInWarsaw(), { message: 'To nie jest poprawna data urodzenia.' }),
});

/** Ostatni dzień miesiąca: dzień 0 następnego miesiąca w UTC, bez strefy serwera. */
function koniecMiesiaca(rok: number, miesiac: number): string {
  return new Date(Date.UTC(rok, miesiac, 0)).toISOString().slice(0, 10);
}

export async function pobierzJpkEwpAction(wejscie: z.input<typeof pobranieSchema>): Promise<WynikPobrania> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin', 'accountant']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = pobranieSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowe dane do pliku.', pole: issue?.path.join('.') };
  }
  const { rok, doMiesiaca, imie, nazwisko, dataUrodzenia } = parsed.data;

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczona(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  const dzis = todayInWarsaw();
  const od = `${rok}-01-01`;
  if (od > dzis) return { success: false, error: `Rok ${rok} jeszcze się nie zaczął, więc nie ma z niego ewidencji.` };
  const koniec = koniecMiesiaca(rok, doMiesiaca);
  const doDnia = koniec < dzis ? koniec : dzis;

  const wynik = await czytajEwidencje(client, ctx.tenantId, rok);
  if (!wynik.ok) return { success: false, error: wynik.komunikat };
  const braki = brakiOkresu(wynik.ewidencja, od, doDnia);
  if (braki.length > 0) {
    const reszta = braki.length > 1 ? ` Braków w tym okresie jest ${braki.length}; lista jest w ewidencji.` : '';
    return { success: false, error: `Plik JPK_EWP nie powstanie, dopóki ewidencja ma braki. ${braki[0].komunikat}${reszta}` };
  }
  const wiersze = wierszeOkresu(wynik.ewidencja, od, doDnia);
  if (wiersze.length === 0) {
    return {
      success: false,
      error: `W ewidencji nie ma wpisów od ${formatIsoDatePl(od)} do ${formatIsoDatePl(doDnia)}, więc plik JPK_EWP byłby pusty.`,
    };
  }

  const [{ data: firma }, kodUrzedu] = await Promise.all([
    client.from('tenants').select('nip').eq('id', ctx.tenantId).maybeSingle(),
    readTenantTaxOffice(client, ctx.tenantId).catch(() => null),
  ]);
  const nip = String((firma as { nip?: unknown } | null)?.nip ?? '').replace(/\D/g, '');
  if (!/^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/.test(nip)) {
    return { success: false, error: 'Plik JPK_EWP potrzebuje poprawnego NIP firmy. NIP jest w Ustawieniach, w danych firmy.' };
  }
  if (!kodUrzedu) {
    return { success: false, error: 'Plik JPK_EWP potrzebuje urzędu skarbowego firmy. Urząd ustawia się w Ustawieniach, w części Księgowa.' };
  }

  const cel = celZlozenia(od, doDnia, dzis);
  const xml = generujJpkEwp({ od, do: doDnia, celZlozenia: cel, kodUrzedu, podatnik: { nip, imie, nazwisko, dataUrodzenia }, wiersze });
  const kontrola = await validateJpkEwp(xml);
  if (!kontrola.valid) {
    console.error('[jpk_ewp] niezgodny ze schematem', ctx.tenantId, kontrola.errors.slice(0, 20).map(redactXsdMessage));
    return {
      success: false,
      error:
        'Plik JPK_EWP nie przeszedł kontroli schematu Ministerstwa Finansów, więc go nie wydajemy. ' +
        'Szczegóły są w naszych logach i sprawdzimy dane z tego okresu.',
    };
  }
  // Strażnik (żelazny filtr F13): sumy kontrolne pliku po XSD. Plik z alarmem
  // nie trafia do klienta i nie ma audytu pobrania; operator dostaje alarm.
  const alarmy = sprawdzJpkEwp(xml, doDnia.slice(0, 7));
  if (alarmy.length > 0) {
    zglosAlarmy(alarmy, { tenantId: ctx.tenantId, straznik: 'jpk-ewp' });
    return { success: false, error: odmowaJpkEwp(alarmy[0].kod) };
  }

  const sumy = sumyOkresu(wiersze);
  await logAudit({
    action: 'jpk_ewp.downloaded',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'jpk_ewp',
    // Bez entityId: audit_logs.entity_id to uuid, a okres jest w metadata.
    // Bez imienia, nazwiska i daty urodzenia: tych danych nie zapisujemy (jak w D9).
    metadata: { od, do: doDnia, celZlozenia: cel, liczbaWierszy: sumy.liczbaWierszy, sumaGr: sumy.razemGr },
  });
  return { success: true, xml, nazwa: nazwaPlikuJpkEwp(nip, od, doDnia) };
}

export async function dodajWpisKpirAction(wejscie: WpisKpirWejscie): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = wpisKpirSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy wpis.', pole: issue?.path.join('.') };
  }
  const wpis = parsed.data;
  if (wpis.dataPrzychodu > todayInWarsaw()) {
    return { success: false, error: 'Data zdarzenia nie może być późniejsza niż dziś.', pole: 'dataPrzychodu' };
  }
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  let wersje;
  try {
    wersje = await czytajWersjeProfilu(client, ctx.tenantId);
  } catch {
    return { success: false, error: BLAD_ZAPISU };
  }
  const wersja = wersjaNa(wersje, wpis.dataPrzychodu);
  const kiedy = formatIsoDatePl(wpis.dataPrzychodu);
  if (!wersja) {
    return { success: false, error: `Bez ustawień podatkowych na ${kiedy} wpis nie trafi do KPiR. ${PROFIL_TEKST}`, pole: 'dataPrzychodu' };
  }
  if (wersja.forma === 'ryczalt') {
    return { success: false, error: `${kiedy} forma opodatkowania to ryczałt, więc wpis należy do ewidencji przychodów, nie do KPiR.`, pole: 'dataPrzychodu' };
  }

  const { data, error } = await client.from('ledger_manual_entries').insert(doWierszaWpisuKpir(ctx.tenantId, wpis)).select(KOLUMNY_WPISU_KPIR).single();
  if (error || !data) return { success: false, error: BLAD_ZAPISU };
  const zapisany = zWierszaWpisuKpir(data as Parameters<typeof zWierszaWpisuKpir>[0]);
  await logAudit({
    action: 'ledger_entry.kpir_created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_manual_entry',
    entityId: zapisany.id,
    metadata: { wpis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function pobierzJpkPkpirAction(wejscie: z.input<typeof pobranieSchema>): Promise<WynikPobrania> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin', 'accountant']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = pobranieSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowe dane do pliku.', pole: issue?.path.join('.') };
  }
  const { rok, doMiesiaca, imie, nazwisko, dataUrodzenia } = parsed.data;
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  const dzis = todayInWarsaw();
  const od = `${rok}-01-01`;
  if (od > dzis) return { success: false, error: `Rok ${rok} jeszcze się nie zaczął, więc nie ma z niego KPiR.` };
  const koniec = koniecMiesiaca(rok, doMiesiaca);
  const doDnia = koniec < dzis ? koniec : dzis;

  const wynik = await czytajKpir(client, ctx.tenantId, rok);
  if (!wynik.ok) return { success: false, error: wynik.komunikat };
  const braki = brakiKpirOkresu(wynik.kpir, od, doDnia);
  if (braki.length > 0) {
    const reszta = braki.length > 1 ? ` Braków w tym okresie jest ${braki.length}; lista jest w KPiR.` : '';
    return { success: false, error: `Plik JPK_PKPIR nie powstanie, dopóki KPiR ma braki. ${braki[0].komunikat}${reszta}` };
  }
  const wiersze = wierszeKpirOkresu(wynik.kpir, od, doDnia);
  if (wiersze.length === 0) {
    return { success: false, error: `W KPiR nie ma wpisów od ${formatIsoDatePl(od)} do ${formatIsoDatePl(doDnia)}, więc plik JPK_PKPIR byłby pusty.` };
  }

  const [{ data: firma }, kodUrzedu] = await Promise.all([
    client.from('tenants').select('nip').eq('id', ctx.tenantId).maybeSingle(),
    readTenantTaxOffice(client, ctx.tenantId).catch(() => null),
  ]);
  const nip = String((firma as { nip?: unknown } | null)?.nip ?? '').replace(/\D/g, '');
  if (!/^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/.test(nip)) {
    return { success: false, error: 'Plik JPK_PKPIR potrzebuje poprawnego NIP firmy. NIP jest w Ustawieniach, w danych firmy.' };
  }
  if (!kodUrzedu) {
    return { success: false, error: 'Plik JPK_PKPIR potrzebuje urzędu skarbowego firmy. Urząd ustawia się w Ustawieniach, w części Księgowa.' };
  }

  const cel = celZlozenia(od, doDnia, dzis);
  const spis = spisyPliku(wynik.spisy, od, doDnia);
  const xml = generujJpkPkpir({ od, do: doDnia, celZlozenia: cel, kodUrzedu, podatnik: { nip, imie, nazwisko, dataUrodzenia }, wiersze, spis });
  const kontrola = await validateJpkPkpir(xml);
  if (!kontrola.valid) {
    console.error('[jpk_pkpir] niezgodny ze schematem', ctx.tenantId, kontrola.errors.slice(0, 20).map(redactXsdMessage));
    return {
      success: false,
      error:
        'Plik JPK_PKPIR nie przeszedł kontroli schematu Ministerstwa Finansów, więc go nie wydajemy. ' +
        'Szczegóły są w naszych logach i sprawdzimy dane z tego okresu.',
    };
  }
  // Strażnik (żelazny filtr F13): sumy kontrolne i kolumny „razem” pliku po XSD.
  // Plik z alarmem nie trafia do klienta i nie ma audytu pobrania; operator dostaje alarm.
  const alarmy = sprawdzJpkPkpir(xml, doDnia.slice(0, 7));
  if (alarmy.length > 0) {
    zglosAlarmy(alarmy, { tenantId: ctx.tenantId, straznik: 'jpk-pkpir' });
    return { success: false, error: odmowaJpkPkpir(alarmy[0].kod) };
  }
  const sumy = sumyKpir(wiersze);
  await logAudit({
    action: 'jpk_pkpir.downloaded',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'jpk_pkpir',
    // Bez imienia, nazwiska i daty urodzenia: tych danych nie zapisujemy (jak w D9).
    metadata: {
      od,
      do: doDnia,
      celZlozenia: cel,
      liczbaWierszy: sumy.liczbaWierszy,
      przychodGr: sumy.przychodGr,
      kosztyGr: sumy.kosztyGr,
      spisPoczatekGr: spis.poczatekGr,
      spisKoniecGr: spis.koniecGr,
    },
  });
  return { success: true, xml, nazwa: nazwaPlikuJpkPkpir(nip, od, doDnia) };
}

/** Spis z natury (K7.4, D19): data, wartość i opis; owner/admin, za obszarem `kpir`, z audytem. */
export async function dodajSpisAction(wejscie: SpisWejscie): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = spisSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowy spis.', pole: issue?.path.join('.') };
  }
  const spis = parsed.data;
  if (spis.data > todayInWarsaw()) return { success: false, error: 'Data spisu nie może być późniejsza niż dziś.', pole: 'data' };
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  const { data, error } = await client
    .from('ledger_inventory_counts')
    .insert({ tenant_id: ctx.tenantId, data: spis.data, kwota_gr: spis.kwota, opis: spis.opis })
    .select(KOLUMNY_SPISU)
    .single();
  if (error?.code === '23505') {
    return { success: false, error: 'Spis z tego dnia już jest; poprawka to usunięcie spisu i dodanie nowego.', pole: 'data' };
  }
  if (error || !data) return { success: false, error: BLAD_ZAPISU };
  const zapisany = zWierszaSpisu(data as Parameters<typeof zWierszaSpisu>[0]);
  await logAudit({
    action: 'ledger_inventory.created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_inventory_count',
    entityId: zapisany.id,
    metadata: { spis: zapisany },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

export async function usunSpisAction(id: string): Promise<WynikWpisu> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  if (!z.string().uuid().safeParse(id).success) return { success: false, error: BLAD_USUNIECIA };
  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await kpirWlaczona(client, ctx.tenantId))) return { success: false, error: KPIR_NIEDOSTEPNA };

  const { data, error } = await client.from('ledger_inventory_counts').delete().eq('id', id).eq('tenant_id', ctx.tenantId).select(KOLUMNY_SPISU);
  if (error) return { success: false, error: BLAD_USUNIECIA };
  const usuniety = (data ?? [])[0];
  if (!usuniety) return { success: false, error: 'Tego spisu już nie ma na liście.' };
  await logAudit({
    action: 'ledger_inventory.deleted',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'ledger_inventory_count',
    entityId: id,
    metadata: { spis: zWierszaSpisu(usuniety as Parameters<typeof zWierszaSpisu>[0]) },
  });
  revalidatePath('/reports/ewidencja');
  return { success: true };
}

