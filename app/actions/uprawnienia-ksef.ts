'use server';

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  BLAD_NAZWY,
  BLAD_NIP,
  biuroWZdaniu,
  komunikatBledu,
  komunikatNadane,
  komunikatStatusu,
  komunikatWToku,
  nadanieUprawnieniaSchema,
  NAZWY_ZAKRESOW,
  nazwyUprawnien,
  opisDlaKsef,
  rodzajStatusuOperacji,
  stanDlaKlienta,
  UPRAWNIENIA_ZAKRESU,
  UWAGA_PRZEKAZANIE,
  wierszZBazy,
  zakresZUprawnien,
  type Biuro,
  type NadanieWejscie,
  type StanUprawnienia,
  type UprawnienieKsef,
  type WynikUprawnienia,
  type Zakres,
} from '@/lib/accountant/uprawnienia-ksef';
import { KOLUMNY_UPRAWNIEN } from '@/lib/accountant/uprawnienia-ksef-dane';
import { logAudit } from '@/lib/audit/log';
import { requireCodeForAccessGrant } from '@/lib/auth/access-grant-mfa';
import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import type { KsefAuth } from '@/lib/ksef/auth';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { KsefApiError } from '@/lib/ksef/client';
import {
  aktywneUprawnieniaBiura,
  klasyfikujBladUprawnien,
  nadajUprawnieniaBiuru,
  NiepoprawnaOdpowiedzUprawnien,
  odbierzUprawnienieBiura,
  stanOperacjiUprawnien,
  type StanOperacjiKsef,
} from '@/lib/ksef/uprawnienia';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { ActionAuthError, requireUserAndActiveOrg, type AuthContext } from '@/lib/supabase/auth-context';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * „Nadaj uprawnienie w KSeF”, „Sprawdź stan” i „Odbierz” w Ustawieniach,
 * zakładka Księgowa (plan kompletnej aplikacji, krok 6.2, część 4; R1): biuro
 * rachunkowe dostaje po NIP-ie uprawnienie do faktur firmy w KSeF
 * (InvoiceRead, opcjonalnie InvoiceWrite) bez logowania właściciela do
 * Aplikacji Podatnika. Tylko właściciel; za flagą `ksefPermissionsEnabled`.
 *
 * Kolejność nadania: formularz (ten sam schemat co w przeglądarce) → aktywna
 * firma zgodna z formularzem i rola właściciela → flaga → krok kodu (jak link
 * dla księgowej) → `KSEF_ENV` → rezerwacja w bazie (RPC 00195) → poświadczenia
 * KSeF firmy → lista aktywnych uprawnień biura w KSeF → nadanie tylko tego,
 * czego brakuje → numer operacji w bazie → jedno sprawdzenie statusu.
 *
 * KSeF z akcji, nie z joba (to samo rozumowanie co identyfikator zbiorczy,
 * #603): nadanie i odebranie nie są idempotentne, a worker pg-boss przy
 * ponowieniu wykonuje cały handler od nowa, więc wysłałby prośbę drugi raz.
 * Akcja robi każdy krok raz, a ponowienie to świadome kliknięcie właściciela,
 * które zaczyna od rezerwacji i od listy uprawnień w KSeF. Poświadczenia czyta
 * `getTenantKsefCredentials` (klucz serwisowy) dopiero po roli, kroku kodu
 * i rezerwacji, jak akcja certyfikatu trzyma certyfikat w procesie aplikacji.
 *
 * Ponowienie (dwuklik, druga karta, odświeżenie, ponowne kliknięcie):
 *  - przed rezerwacją: nic nie zapisane, kolejne kliknięcie robi to samo;
 *  - rezerwacja: jeden wiersz na biuro w firmie i środowisku (UNIQUE): nadane
 *    i w toku nie dostają nowej próby, próba młodsza niż 5 minut to „właśnie
 *    trwa”, przerwana (restart) jest do przejęcia po 5 minutach;
 *  - po nadaniu w KSeF, przed zapisem numeru: przejęta próba najpierw pyta KSeF
 *    o aktywne uprawnienia biura, więc nie nada drugi raz tego, co KSeF przyjął;
 *  - brak odpowiedzi KSeF na nadanie (timeout, sieć, 5xx): „nie nadano” z kodem;
 *    kolejne kliknięcie znów zaczyna od listy z KSeF;
 *  - sprawdzenie statusu to odczyt: można je powtarzać bez skutków w KSeF.
 */

const SCIEZKA = '/settings/accountant';

const TEKSTY = {
  rola: 'Uprawnienia w KSeF nadaje i odbiera tylko właściciel firmy.',
  wylaczona:
    'Nadawanie uprawnień w KSeF z FaktWay nie jest jeszcze włączone. Uprawnienie dla biura nadasz albo odbierzesz w Aplikacji Podatnika KSeF.',
  flagaBlad: 'Nie udało się sprawdzić, czy nadawanie uprawnień w KSeF jest włączone. Spróbuj ponownie za chwilę.',
  srodowisko:
    'FaktWay nie ma teraz bezpiecznie ustawionego środowiska KSeF, więc nie wysłał prośby. Spróbuj ponownie później albo napisz do pomocy FaktWay.',
  migracja:
    'Nadawanie uprawnień w KSeF będzie dostępne po najbliższej aktualizacji FaktWay. Do tego czasu uprawnienie nadasz w Aplikacji Podatnika KSeF.',
  zapis: 'Nie udało się zapisać prośby o uprawnienie w KSeF. Spróbuj ponownie za chwilę.',
  odczyt: 'Nie udało się odczytać uprawnienia z listy firmy. Spróbuj ponownie za chwilę.',
  kodKrok: 'Nadanie uprawnienia w KSeF wymaga potwierdzenia kodem z aplikacji.',
  nieZnaleziono: 'Nie znaleziono tego uprawnienia na liście firmy. Odśwież stronę.',
  inneSrodowisko:
    'To uprawnienie dotyczy innego środowiska KSeF niż to, z którym FaktWay teraz pracuje, więc nie da się go tu sprawdzić ani odebrać.',
  wybor: 'Nie udało się przygotować prośby o uprawnienie. Odśwież stronę i spróbuj ponownie.',
  ownNip: 'To NIP Twojej firmy. Uprawnienie nadaje się biuru rachunkowemu, więc wpisz NIP biura.',
} as const;

const PONOW_NADANIE = 'FaktWay najpierw sprawdzi w KSeF, czy uprawnienie już jest, i nie nada go drugi raz.';

const idSchema = z.string().uuid();

/** Funkcje z 00195: `types/database.ts` generujemy z produkcji po wgraniu migracji (AGENTS.md). */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface UprawnieniaRpc {
  rpc(
    fn: 'claim_ksef_permission_grant',
    args: { p_environment: KsefEnvironment; p_subject_nip: string; p_subject_name: string; p_scopes: string[]; p_can_delegate: boolean },
  ): RpcResult;
  rpc(fn: 'claim_ksef_permission_revoke', args: { p_id: string; p_environment: KsefEnvironment }): RpcResult;
  rpc(
    fn: 'finish_ksef_permission_attempt',
    args: {
      p_id: string;
      p_attempt: string;
      p_status: StanUprawnienia;
      p_references: string[];
      p_ksef_code: number | null;
      p_ksef_description: string | null;
      p_error_code: string | null;
      p_detail: string | null;
    },
  ): RpcResult;
  rpc(
    fn: 'record_ksef_permission_check',
    args: {
      p_id: string;
      p_references: string[];
      p_status: StanUprawnienia;
      p_ksef_code: number | null;
      p_ksef_description: string | null;
      p_error_code: string | null;
    },
  ): RpcResult;
}

/** Funkcji albo tabeli nie ma (kod wdrożony przed 00195): PostgREST albo Postgres. */
const BRAK_FUNKCJI = new Set(['PGRST202', '42883']);
const BRAK_TABELI = new Set(['PGRST205', '42P01']);

interface Proba {
  id: string;
  attempt: string;
}

/** Wiersz z operacją w toku: numery operacji z bazy i zakres do listy z KSeF. */
interface OperacjaWToku {
  id: string;
  refs: string[];
  nip: string;
  zakres: Zakres;
  przekazanie: boolean;
}

interface Wynik {
  kodKsef?: number | null;
  opisKsef?: string | null;
  kodBledu?: string | null;
}

function zglos(error: unknown, kod: string, tenantId: string): void {
  if (error instanceof NiepoprawnaOdpowiedzUprawnien) {
    // Surowa odpowiedź tylko do audytu w bazie, nie do Sentry.
    Sentry.captureMessage('KSeF: odpowiedź o uprawnieniach spoza schematu', {
      level: 'error',
      tags: { area: 'ksef.permissions' },
      extra: { tenantId, operacja: error.operacja },
    });
    return;
  }
  Sentry.captureException(error, { tags: { area: 'ksef.permissions' }, extra: { tenantId, kod } });
}

async function wlasciciel(firma?: string): Promise<{ ctx: AuthContext } | { blad: string }> {
  try {
    const ctx = await requireUserAndActiveOrg(firma === undefined ? undefined : { expectedTenantId: firma });
    if (ctx.role !== 'owner') return { blad: TEKSTY.rola };
    return { ctx };
  } catch (e) {
    if (e instanceof ActionAuthError) return { blad: e.message };
    throw e;
  }
}

/** `null`: włączone; inaczej odmowa. Błąd odczytu włącznika to odmowa (fail-closed). */
async function bramkaFlagi(): Promise<string | null> {
  try {
    return (await getGlobalFlagForExecution('ksefPermissionsEnabled')) ? null : TEKSTY.wylaczona;
  } catch {
    return TEKSTY.flagaBlad;
  }
}

function bladRpc(error: { code?: string; message: string }): WynikUprawnienia {
  const kod = error.code ?? '';
  if (BRAK_FUNKCJI.has(kod)) return { success: false, error: TEKSTY.migracja };
  if (kod === '42501' && /code_step_required/.test(error.message)) return { success: false, error: TEKSTY.kodKrok, mfaStepUp: true };
  if (kod === '42501') return { success: false, error: TEKSTY.rola };
  console.error('[uprawnienia-ksef] rpc', kod);
  return { success: false, error: TEKSTY.zapis };
}

/** Wynik bieżącej próby (żeton). `false`: zapis się nie udał, próba czeka na przejęcie po 5 minutach. */
async function zakoncz(
  rpc: UprawnieniaRpc,
  proba: Proba,
  status: StanUprawnienia,
  pola: Wynik & { refs?: string[]; szczegol?: string | null } = {},
): Promise<boolean> {
  const { data, error } = await rpc.rpc('finish_ksef_permission_attempt', {
    p_id: proba.id,
    p_attempt: proba.attempt,
    p_status: status,
    p_references: pola.refs ?? [],
    p_ksef_code: pola.kodKsef ?? null,
    p_ksef_description: pola.opisKsef ?? null,
    p_error_code: pola.kodBledu ?? null,
    p_detail: pola.szczegol ?? null,
  });
  const zapisano = !error && (data as { status?: unknown } | null)?.status === 'saved';
  if (!zapisano) console.error('[uprawnienia-ksef] zapis wyniku', error?.code ?? (data as { code?: unknown } | null)?.code);
  return zapisano;
}

/** Wynik sprawdzenia operacji w toku (te same numery operacji). Błąd zapisu: kolejne sprawdzenie powtórzy. */
async function zapiszSprawdzenie(rpc: UprawnieniaRpc, w: OperacjaWToku, status: StanUprawnienia, pola: Wynik = {}): Promise<void> {
  const { data, error } = await rpc.rpc('record_ksef_permission_check', {
    p_id: w.id,
    p_references: w.refs,
    p_status: status,
    p_ksef_code: pola.kodKsef ?? null,
    p_ksef_description: pola.opisKsef ?? null,
    p_error_code: pola.kodBledu ?? null,
  });
  if (error || (data as { status?: unknown } | null)?.status !== 'saved') {
    console.error('[uprawnienia-ksef] zapis sprawdzenia', error?.code ?? (data as { code?: unknown } | null)?.code);
  }
}

const szczegolBledu = (error: unknown) =>
  error instanceof NiepoprawnaOdpowiedzUprawnien ? `${error.operacja}: ${error.otrzymano ?? 'brak treści'}` : null;

async function porazka(
  rpc: UprawnieniaRpc,
  proba: Proba,
  rodzaj: 'nadanie' | 'odebranie',
  error: unknown,
  tenantId: string,
  biuro: Biuro,
): Promise<WynikUprawnienia> {
  const k = klasyfikujBladUprawnien(error);
  await zakoncz(rpc, proba, rodzaj === 'nadanie' ? 'grant_failed' : 'revoke_failed', { kodBledu: k.kod, szczegol: szczegolBledu(error) });
  if (k.techniczny) zglos(error, k.kod, tenantId);
  return { success: false, error: komunikatBledu(k.kod, rodzaj, biuro, { kodKsef: null, opisKsef: null, retryAfterMs: k.retryAfterMs }) };
}

/** Sprawdzenie się nie udało (sieć, KSeF): stan bez zmian. Zaraz po wysłaniu to dalej „w toku”. */
function bezSprawdzenia(error: unknown, rodzaj: 'nadanie' | 'odebranie', biuro: Biuro, tenantId: string, poWyslaniu: boolean): WynikUprawnienia {
  const k = klasyfikujBladUprawnien(error);
  if (k.techniczny) zglos(error, k.kod, tenantId);
  if (poWyslaniu) {
    return {
      success: true,
      stan: rodzaj === 'nadanie' ? 'grant_in_progress' : 'revoke_in_progress',
      komunikat:
        `KSeF przyjął ${rodzaj} uprawnienia dla ${biuroWZdaniu(biuro)}, ale wyniku nie udało się teraz sprawdzić. ` +
        'Kliknij „Sprawdź stan” za chwilę.',
    };
  }
  return { success: false, error: komunikatBledu(k.kod, 'sprawdzenie', biuro, { kodKsef: null, opisKsef: null, retryAfterMs: k.retryAfterMs }) };
}

async function sprawdzNadanie(
  rpc: UprawnieniaRpc,
  ksef: KsefAuth,
  tenantId: string,
  env: KsefEnvironment,
  w: OperacjaWToku,
  biuro: Biuro,
  poWyslaniu: boolean,
): Promise<WynikUprawnienia> {
  const uprawnienia = UPRAWNIENIA_ZAKRESU[w.zakres];
  let stan: StanOperacjiKsef;
  try {
    stan = await stanOperacjiUprawnien(ksef, { tenantId, env, numer: w.refs[0]! });
  } catch (error) {
    if (!(error instanceof KsefApiError && error.status === 410)) return bezSprawdzenia(error, 'nadanie', biuro, tenantId, poWyslaniu);
    // Wynik operacji wygasł (KSeF trzyma go 30 dni): decyduje lista aktywnych uprawnień biura.
    let aktywne;
    try {
      aktywne = await aktywneUprawnieniaBiura(ksef, { tenantId, env, nip: w.nip, uprawnienia });
    } catch (bladListy) {
      return bezSprawdzenia(bladListy, 'nadanie', biuro, tenantId, poWyslaniu);
    }
    if (uprawnienia.every((u) => aktywne.some((a) => a.uprawnienie === u))) {
      await zapiszSprawdzenie(rpc, w, 'granted');
      return { success: true, stan: 'granted', komunikat: komunikatNadane(w, biuro) };
    }
    await zapiszSprawdzenie(rpc, w, 'grant_failed', { kodBledu: 'operation_expired' });
    return { success: false, error: komunikatBledu('operation_expired', 'nadanie', biuro, { kodKsef: null, opisKsef: null, retryAfterMs: null }) };
  }

  const rodzaj = rodzajStatusuOperacji(stan.kod);
  if (rodzaj === 'w_toku') {
    await zapiszSprawdzenie(rpc, w, 'grant_in_progress', { kodKsef: stan.kod, opisKsef: stan.opis });
    return { success: true, stan: 'grant_in_progress', komunikat: komunikatWToku('nadanie', biuro) };
  }
  if (rodzaj === 'sukces') {
    await zapiszSprawdzenie(rpc, w, 'granted', { kodKsef: stan.kod, opisKsef: stan.opis });
    return { success: true, stan: 'granted', komunikat: komunikatNadane(w, biuro) };
  }
  await zapiszSprawdzenie(rpc, w, 'grant_failed', { kodKsef: stan.kod, opisKsef: stan.opis, kodBledu: `status_${stan.kod}` });
  return { success: false, error: komunikatStatusu(stan.kod, stan.opis, 'nadanie', biuro) };
}

async function sprawdzOdebranie(
  rpc: UprawnieniaRpc,
  ksef: KsefAuth,
  tenantId: string,
  env: KsefEnvironment,
  w: OperacjaWToku,
  biuro: Biuro,
  poWyslaniu: boolean,
): Promise<WynikUprawnienia> {
  let wToku = false;
  let odmowa: StanOperacjiKsef | null = null;
  for (const numer of w.refs) {
    try {
      const stan = await stanOperacjiUprawnien(ksef, { tenantId, env, numer });
      const rodzaj = rodzajStatusuOperacji(stan.kod);
      if (rodzaj === 'w_toku') wToku = true;
      else if (rodzaj === 'porazka' && odmowa === null) odmowa = stan;
    } catch (error) {
      // Wynik wygasł (410): decyduje lista aktywnych uprawnień niżej.
      if (error instanceof KsefApiError && error.status === 410) continue;
      return bezSprawdzenia(error, 'odebranie', biuro, tenantId, poWyslaniu);
    }
  }
  if (wToku) {
    await zapiszSprawdzenie(rpc, w, 'revoke_in_progress', { kodKsef: 100 });
    return { success: true, stan: 'revoke_in_progress', komunikat: komunikatWToku('odebranie', biuro) };
  }

  let aktywne;
  try {
    aktywne = await aktywneUprawnieniaBiura(ksef, { tenantId, env, nip: w.nip, uprawnienia: UPRAWNIENIA_ZAKRESU[w.zakres] });
  } catch (error) {
    return bezSprawdzenia(error, 'odebranie', biuro, tenantId, poWyslaniu);
  }
  if (aktywne.length === 0) {
    await zapiszSprawdzenie(rpc, w, 'revoked', { kodKsef: 200 });
    return { success: true, stan: 'revoked', komunikat: `Uprawnienie w KSeF dla ${biuroWZdaniu(biuro)} jest odebrane.` };
  }
  await zapiszSprawdzenie(rpc, w, 'revoke_failed', {
    kodKsef: odmowa?.kod ?? null,
    opisKsef: odmowa?.opis ?? null,
    kodBledu: odmowa ? `status_${odmowa.kod}` : 'still_active',
  });
  const zostalo = nazwyUprawnien(aktywne.map((a) => a.uprawnienie));
  return {
    success: false,
    error: odmowa
      ? `${komunikatStatusu(odmowa.kod, odmowa.opis, 'odebranie', biuro)} W KSeF zostało: ${zostalo}.`
      : `Nie udało się odebrać całego uprawnienia dla ${biuroWZdaniu(biuro)}: w KSeF zostało ${zostalo}. ` +
        'Kliknij „Ponów odebranie”, a jeśli to się powtórzy, odbierz je w Aplikacji Podatnika KSeF.',
  };
}

// ─── nadanie ────────────────────────────────────────────────────────────

export async function nadajUprawnienieKsefAction(wejscie: NadanieWejscie): Promise<WynikUprawnienia> {
  const parsed = nadanieUprawnieniaSchema.safeParse(wejscie);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? TEKSTY.wybor };
  const dane = parsed.data;

  const dostep = await wlasciciel(dane.firma);
  if ('blad' in dostep) return { success: false, error: dostep.blad };
  const { ctx } = dostep;
  const flaga = await bramkaFlagi();
  if (flaga) return { success: false, error: flaga };
  // Dostęp osoby trzeciej do faktur firmy: sesja po biometrii na koncie z 2FA potrzebuje kodu.
  const krok = await requireCodeForAccessGrant(ctx.supabase, ctx.user.id, 'Nadanie uprawnienia w KSeF');
  if (krok) return krok;
  const env = configuredKsefEnvironment();
  if (!env) return { success: false, error: TEKSTY.srodowisko };

  const biuro: Biuro = { nazwa: dane.nazwa, nip: dane.nip };
  const uprawnienia = UPRAWNIENIA_ZAKRESU[dane.zakres];
  const rpc = ctx.supabase as unknown as UprawnieniaRpc;
  const rezerwacja = await rpc.rpc('claim_ksef_permission_grant', {
    p_environment: env,
    p_subject_nip: dane.nip,
    p_subject_name: dane.nazwa,
    p_scopes: [...uprawnienia],
    p_can_delegate: dane.przekazanie,
  });
  if (rezerwacja.error) return bladRpc(rezerwacja.error);
  const r = (rezerwacja.data ?? {}) as { status?: unknown; id?: unknown; attempt?: unknown; code?: unknown; scopes?: unknown };
  switch (r.status) {
    case 'claimed':
      break;
    case 'already_granted': {
      const zakres = zakresZUprawnien(r.scopes) ?? dane.zakres;
      return {
        success: true,
        stan: 'granted',
        komunikat:
          `${biuroWZdaniu(biuro)} ma już uprawnienie w KSeF: ${NAZWY_ZAKRESOW[zakres].toLowerCase()}. ` +
          'Żeby zmienić zakres, odbierz uprawnienie i nadaj je ponownie.',
      };
    }
    case 'awaiting_ksef':
      return { success: true, stan: 'grant_in_progress', komunikat: komunikatWToku('nadanie', biuro) };
    case 'in_progress':
      return { success: false, error: `Nadanie uprawnienia dla ${biuroWZdaniu(biuro)} właśnie trwa. Odśwież stronę za chwilę.` };
    case 'revoke_in_progress':
      return {
        success: false,
        error:
          `Odbieranie uprawnienia dla ${biuroWZdaniu(biuro)} jeszcze trwa. Kliknij „Sprawdź stan” przy biurze; ` +
          'gdy odbieranie się zakończy, uprawnienie można nadać ponownie.',
      };
    case 'refused':
      if (r.code === 'own_nip') return { success: false, error: TEKSTY.ownNip };
      if (r.code === 'invalid_nip') return { success: false, error: BLAD_NIP };
      if (r.code === 'invalid_name') return { success: false, error: BLAD_NAZWY };
      return { success: false, error: TEKSTY.wybor };
    default:
      console.error('[uprawnienia-ksef] rezerwacja nadania', r.status);
      return { success: false, error: TEKSTY.zapis };
  }
  if (typeof r.id !== 'string' || typeof r.attempt !== 'string') return { success: false, error: TEKSTY.zapis };
  const proba: Proba = { id: r.id, attempt: r.attempt };

  let ksef: KsefAuth;
  try {
    ksef = await getTenantKsefCredentials(ctx.tenantId);
  } catch (error) {
    return porazka(rpc, proba, 'nadanie', error, ctx.tenantId, biuro);
  }

  // Najpierw KSeF: biuro mogło już mieć te uprawnienia (Aplikacja Podatnika, przerwana próba).
  let brakujace: UprawnienieKsef[];
  let inaczejPrzekazane: boolean;
  try {
    const aktywne = await aktywneUprawnieniaBiura(ksef, { tenantId: ctx.tenantId, env, nip: dane.nip, uprawnienia });
    brakujace = uprawnienia.filter((u) => !aktywne.some((a) => a.uprawnienie === u));
    // Tego samego uprawnienia KSeF nie nada drugi raz, więc inny `canDelegate` zostaje, jaki jest.
    inaczejPrzekazane = aktywne.some((a) => a.przekazanie !== dane.przekazanie);
  } catch (error) {
    return porazka(rpc, proba, 'nadanie', error, ctx.tenantId, biuro);
  }
  const uwaga = inaczejPrzekazane ? ` ${UWAGA_PRZEKAZANIE}` : '';
  if (brakujace.length === 0) {
    await zakoncz(rpc, proba, 'granted', { kodBledu: inaczejPrzekazane ? 'delegate_mismatch' : null, szczegol: 'already_active' });
    revalidatePath(SCIEZKA);
    return {
      success: true,
      stan: 'granted',
      komunikat:
        `Uprawnienie w KSeF dla ${biuroWZdaniu(biuro)} było już nadane (na przykład w Aplikacji Podatnika KSeF). ` +
        `FaktWay dopisał je do listy.${uwaga}`,
    };
  }

  let numer: string;
  try {
    numer = await nadajUprawnieniaBiuru(ksef, {
      tenantId: ctx.tenantId,
      env,
      nip: dane.nip,
      nazwa: dane.nazwa,
      uprawnienia: brakujace,
      przekazanie: dane.przekazanie,
      opis: opisDlaKsef(dane.nazwa),
    });
  } catch (error) {
    return porazka(rpc, proba, 'nadanie', error, ctx.tenantId, biuro);
  }

  const zapisano = await zakoncz(rpc, proba, 'grant_in_progress', { refs: [numer], szczegol: brakujace.join(',') });
  if (!zapisano) {
    // KSeF przyjął nadanie: błąd zapisu nie może zamienić się w „nie nadano”. Numer zostaje w audycie.
    await logAudit({
      action: 'accountant.ksef_permission_grant_sent',
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      entityType: 'ksef_permission_grant',
      entityId: proba.id,
      metadata: {
        subjectNip: dane.nip,
        subjectName: dane.nazwa,
        scopes: [...uprawnienia],
        sent: brakujace,
        canDelegate: dane.przekazanie,
        environment: env,
        references: [numer],
        zapisany: false,
      },
    });
    Sentry.captureMessage('Uprawnienie KSeF: nadanie przyjęte bez zapisu w bazie', {
      level: 'warning',
      tags: { area: 'ksef.permissions' },
      extra: { tenantId: ctx.tenantId, id: proba.id },
    });
    revalidatePath(SCIEZKA);
    return {
      success: true,
      stan: 'grant_in_progress',
      komunikat:
        `KSeF przyjął nadanie uprawnienia dla ${biuroWZdaniu(biuro)} (numer operacji ${numer}), ale FaktWay nie zapisał go ` +
        `na liście. Za kilka minut kliknij „Ponów” przy biurze: ${PONOW_NADANIE}`,
    };
  }

  // Jedno sprawdzenie od razu: KSeF często kończy operację w chwilę.
  const wynik = await sprawdzNadanie(
    rpc,
    ksef,
    ctx.tenantId,
    env,
    { id: proba.id, refs: [numer], nip: dane.nip, zakres: dane.zakres, przekazanie: dane.przekazanie },
    biuro,
    true,
  );
  revalidatePath(SCIEZKA);
  // Część zakresu była już w KSeF z innym ustawieniem przekazania: klient dowiaduje się od razu.
  return wynik.success && uwaga ? { ...wynik, komunikat: `${wynik.komunikat}${uwaga}` } : wynik;
}

// ─── sprawdzenie stanu ──────────────────────────────────────────────────

export async function sprawdzUprawnienieKsefAction(id: string): Promise<WynikUprawnienia> {
  if (!idSchema.safeParse(id).success) return { success: false, error: TEKSTY.nieZnaleziono };
  const dostep = await wlasciciel();
  if ('blad' in dostep) return { success: false, error: dostep.blad };
  const { ctx } = dostep;
  const flaga = await bramkaFlagi();
  if (flaga) return { success: false, error: flaga };
  const env = configuredKsefEnvironment();
  if (!env) return { success: false, error: TEKSTY.srodowisko };

  // Kluczem sesji (RLS): wiersz obcej firmy wygląda jak brak wiersza.
  const { data, error } = await (ctx.supabase as unknown as SupabaseClient)
    .from('ksef_permission_grants')
    .select(KOLUMNY_UPRAWNIEN)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    const kod = String((error as { code?: unknown }).code);
    if (BRAK_TABELI.has(kod)) return { success: false, error: TEKSTY.migracja };
    console.error('[uprawnienia-ksef] odczyt wiersza', kod);
    return { success: false, error: TEKSTY.odczyt };
  }
  const surowy = (data ?? null) as Record<string, unknown> | null;
  const w = surowy ? wierszZBazy(surowy) : null;
  if (!surowy || !w) return { success: false, error: TEKSTY.nieZnaleziono };
  if (surowy.ksef_environment !== env) return { success: false, error: TEKSTY.inneSrodowisko };
  const biuro: Biuro = { nazwa: w.nazwa, nip: w.nip };

  if (w.stan !== 'grant_in_progress' && w.stan !== 'revoke_in_progress') {
    return { success: true, stan: w.stan, komunikat: stanDlaKlienta(w, new Date()).opis };
  }
  const refs = Array.isArray(surowy.operation_references)
    ? (surowy.operation_references as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  if (refs.length === 0) return { success: false, error: TEKSTY.odczyt };

  let ksef: KsefAuth;
  try {
    ksef = await getTenantKsefCredentials(ctx.tenantId);
  } catch (bladPoswiadczen) {
    const k = klasyfikujBladUprawnien(bladPoswiadczen);
    if (k.techniczny) zglos(bladPoswiadczen, k.kod, ctx.tenantId);
    return { success: false, error: komunikatBledu(k.kod, 'sprawdzenie', biuro, { kodKsef: null, opisKsef: null, retryAfterMs: null }) };
  }

  const rpc = ctx.supabase as unknown as UprawnieniaRpc;
  const operacja: OperacjaWToku = { id: w.id, refs, nip: w.nip, zakres: w.zakres, przekazanie: w.przekazanie };
  const wynik =
    w.stan === 'grant_in_progress'
      ? await sprawdzNadanie(rpc, ksef, ctx.tenantId, env, operacja, biuro, false)
      : await sprawdzOdebranie(rpc, ksef, ctx.tenantId, env, operacja, biuro, false);
  revalidatePath(SCIEZKA);
  return wynik;
}

// ─── odebranie ──────────────────────────────────────────────────────────

export async function odbierzUprawnienieKsefAction(id: string): Promise<WynikUprawnienia> {
  if (!idSchema.safeParse(id).success) return { success: false, error: TEKSTY.nieZnaleziono };
  // Odebranie zmniejsza dostęp osoby trzeciej: bez kroku kodu, jak cofnięcie linku dla księgowej.
  const dostep = await wlasciciel();
  if ('blad' in dostep) return { success: false, error: dostep.blad };
  const { ctx } = dostep;
  const flaga = await bramkaFlagi();
  if (flaga) return { success: false, error: flaga };
  const env = configuredKsefEnvironment();
  if (!env) return { success: false, error: TEKSTY.srodowisko };

  const rpc = ctx.supabase as unknown as UprawnieniaRpc;
  const rezerwacja = await rpc.rpc('claim_ksef_permission_revoke', { p_id: id, p_environment: env });
  if (rezerwacja.error) return bladRpc(rezerwacja.error);
  const r = (rezerwacja.data ?? {}) as {
    status?: unknown;
    id?: unknown;
    attempt?: unknown;
    code?: unknown;
    row_status?: unknown;
    subject_nip?: unknown;
    subject_name?: unknown;
    scopes?: unknown;
  };
  if (r.status === 'refused') {
    if (r.code === 'not_found') return { success: false, error: TEKSTY.nieZnaleziono };
    if (r.code === 'env_mismatch') return { success: false, error: TEKSTY.inneSrodowisko };
    return { success: false, error: TEKSTY.wybor };
  }
  if (typeof r.subject_nip !== 'string' || typeof r.subject_name !== 'string') {
    console.error('[uprawnienia-ksef] rezerwacja odebrania', r.status);
    return { success: false, error: TEKSTY.zapis };
  }
  const biuro: Biuro = { nazwa: r.subject_name, nip: r.subject_nip };
  switch (r.status) {
    case 'claimed':
      break;
    case 'already_revoked':
      return { success: true, stan: 'revoked', komunikat: `Uprawnienie w KSeF dla ${biuroWZdaniu(biuro)} jest już odebrane.` };
    case 'awaiting_ksef':
      return { success: true, stan: 'revoke_in_progress', komunikat: komunikatWToku('odebranie', biuro) };
    case 'in_progress':
      return { success: false, error: `Odbieranie uprawnienia dla ${biuroWZdaniu(biuro)} właśnie trwa. Odśwież stronę za chwilę.` };
    case 'not_granted':
      if (r.row_status === 'grant_in_progress' || r.row_status === 'grant_pending') {
        return {
          success: false,
          error:
            `Nadanie uprawnienia dla ${biuroWZdaniu(biuro)} jeszcze się nie zakończyło. Kliknij „Sprawdź stan”; ` +
            'odebrać je można, gdy KSeF skończy nadawanie.',
        };
      }
      return { success: false, error: `Uprawnienie dla ${biuroWZdaniu(biuro)} nie jest nadane, więc nie ma czego odbierać.` };
    default:
      console.error('[uprawnienia-ksef] rezerwacja odebrania', r.status);
      return { success: false, error: TEKSTY.zapis };
  }
  const zakres = zakresZUprawnien(r.scopes);
  if (typeof r.id !== 'string' || typeof r.attempt !== 'string' || !zakres) return { success: false, error: TEKSTY.zapis };
  const proba: Proba = { id: r.id, attempt: r.attempt };

  let ksef: KsefAuth;
  try {
    ksef = await getTenantKsefCredentials(ctx.tenantId);
  } catch (error) {
    return porazka(rpc, proba, 'odebranie', error, ctx.tenantId, biuro);
  }

  // Odbieramy to, co KSeF ma dziś aktywne (także nadane w Aplikacji Podatnika), w zakresie z listy.
  let aktywne;
  try {
    aktywne = await aktywneUprawnieniaBiura(ksef, { tenantId: ctx.tenantId, env, nip: biuro.nip, uprawnienia: UPRAWNIENIA_ZAKRESU[zakres] });
  } catch (error) {
    return porazka(rpc, proba, 'odebranie', error, ctx.tenantId, biuro);
  }
  if (aktywne.length === 0) {
    await zakoncz(rpc, proba, 'revoked', { kodBledu: 'not_found_in_ksef' });
    revalidatePath(SCIEZKA);
    return {
      success: true,
      stan: 'revoked',
      komunikat: komunikatBledu('not_found_in_ksef', 'odebranie', biuro, { kodKsef: null, opisKsef: null, retryAfterMs: null }),
    };
  }

  const refs: string[] = [];
  let bladOdebrania: unknown = null;
  for (const a of aktywne) {
    try {
      refs.push(await odbierzUprawnienieBiura(ksef, { tenantId: ctx.tenantId, env, idUprawnienia: a.id }));
    } catch (error) {
      bladOdebrania = error;
      break;
    }
  }
  if (refs.length === 0) return porazka(rpc, proba, 'odebranie', bladOdebrania, ctx.tenantId, biuro);
  const k = bladOdebrania === null ? null : klasyfikujBladUprawnien(bladOdebrania);
  if (k?.techniczny) zglos(bladOdebrania, k.kod, ctx.tenantId);

  const zapisano = await zakoncz(rpc, proba, 'revoke_in_progress', {
    refs,
    kodBledu: k?.kod ?? null,
    szczegol: aktywne.map((a) => a.uprawnienie).join(','),
  });
  if (!zapisano) {
    await logAudit({
      action: 'accountant.ksef_permission_revoke_sent',
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      entityType: 'ksef_permission_grant',
      entityId: proba.id,
      metadata: { subjectNip: biuro.nip, subjectName: biuro.nazwa, environment: env, references: refs, zapisany: false },
    });
    Sentry.captureMessage('Uprawnienie KSeF: odebranie przyjęte bez zapisu w bazie', {
      level: 'warning',
      tags: { area: 'ksef.permissions' },
      extra: { tenantId: ctx.tenantId, id: proba.id },
    });
    revalidatePath(SCIEZKA);
    return {
      success: true,
      stan: 'revoke_in_progress',
      komunikat:
        `KSeF przyjął odebranie uprawnienia dla ${biuroWZdaniu(biuro)} (numery operacji ${refs.join(', ')}), ale FaktWay nie ` +
        'zapisał tego na liście. Za kilka minut kliknij „Ponów odebranie”: FaktWay najpierw sprawdzi w KSeF, co jest jeszcze aktywne.',
    };
  }

  const wynik = await sprawdzOdebranie(
    rpc,
    ksef,
    ctx.tenantId,
    env,
    { id: proba.id, refs, nip: biuro.nip, zakres, przekazanie: false },
    biuro,
    true,
  );
  revalidatePath(SCIEZKA);
  // Drugie odebranie odrzucone: przyczyna z KSeF mówi więcej niż „zostało aktywne”.
  if (!wynik.success && k) {
    return { success: false, error: komunikatBledu(k.kod, 'odebranie', biuro, { kodKsef: null, opisKsef: null, retryAfterMs: k.retryAfterMs }) };
  }
  return wynik;
}
