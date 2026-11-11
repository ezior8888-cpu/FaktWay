'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { wczytajKosztyDoPliku } from '@/lib/expenses/do-zaplaty-dane';
import {
  IDENTYFIKATOR_TEKSTY,
  ROLE_IDENTYFIKATORA,
  sprawdzWybor,
  wTrakcie,
  type GrupaIdentyfikatora,
  type IdentyfikatorZbiorczyResult,
} from '@/lib/expenses/identyfikator-zbiorczy';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  MAKS_FAKTUR_W_IDENTYFIKATORZE,
  MIN_FAKTUR_W_IDENTYFIKATORZE,
  poprawnyIdentyfikatorZbiorczy,
} from '@/lib/invoices/identyfikator-zbiorczy';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  NiepoprawnyIdentyfikatorZKsef,
  opiszBladIdentyfikatora,
  wygenerujIdentyfikatorZbiorczy,
  type KontekstBledu,
} from '@/lib/ksef/identyfikator-zbiorczy';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { ActionAuthError, requireOrgRole, type AuthContext } from '@/lib/supabase/auth-context';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * „Identyfikator zbiorczy” przy grupie faktur jednego dostawcy na liście
 * „Do zapłaty” (plan kompletnej aplikacji, krok 1.4, część 2; RP-PLAT-02).
 *
 * Kolejność: wybór (UUID, od 2 do 500, bez powtórzeń) → rola owner/admin →
 * środowisko KSeF aplikacji → świeży odczyt kosztów kluczem sesji (RLS) i ta
 * sama lista co ekran (`sprawdzWybor`) → rezerwacja w bazie (RPC 00191) →
 * poświadczenia KSeF firmy → `POST /collective-identifiers` → zapis wyniku
 * albo porażki (RPC 00191, audyt w tej samej transakcji).
 *
 * Wywołanie KSeF idzie z akcji, a nie z joba: klient czeka na numer kilka
 * sekund, a job pg-boss przy ponowieniu wołałby nieidempotentne API jeszcze
 * raz. Poświadczenia firmy czyta `getTenantKsefCredentials` (klucz
 * serwisowy) dopiero po sprawdzeniu roli i po rezerwacji, jak akcja
 * certyfikatu trzyma certyfikat w procesie aplikacji.
 *
 * Ponowienie (dwuklik, druga karta, odświeżenie, ponowne kliknięcie):
 *  - przed rezerwacją: niczego nie zapisujemy, kolejne kliknięcie robi to samo;
 *  - rezerwacja to jeden wiersz na zestaw faktur w firmie i środowisku
 *    (UNIQUE w 00191): gotowy identyfikator wraca bez pytania KSeF, próba
 *    w toku daje „właśnie powstaje”, a przerwana (np. restart serwera po
 *    rezerwacji) po 5 minutach jest do przejęcia;
 *  - po odpowiedzi KSeF, a przed zapisem: identyfikator istnieje w KSeF; przy
 *    nieudanym zapisie klient i tak go dostaje, a audyt ma numer. Przejęta
 *    próba może wtedy dać drugi identyfikator: każdy nadany jest ważny, ale
 *    zajmuje jedno z 132 miejsc faktury;
 *  - po porażce (błąd KSeF, poświadczenia, zła odpowiedź) wiersz ma kod
 *    błędu, a kolejne kliknięcie to nowa próba.
 */

const kosztIdsSchema = z
  .array(z.string().uuid())
  .min(MIN_FAKTUR_W_IDENTYFIKATORZE)
  .max(MAKS_FAKTUR_W_IDENTYFIKATORZE)
  .refine((ids) => new Set(ids).size === ids.length);

/** Funkcje z 00191: `types/database.ts` generujemy z produkcji po wgraniu migracji (AGENTS.md). */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
interface IdentyfikatorRpc {
  rpc(
    fn: 'claim_ksef_collective_identifier',
    args: { p_environment: KsefEnvironment; p_seller_nip: string; p_ksef_numbers: string[] },
  ): RpcResult;
  rpc(fn: 'complete_ksef_collective_identifier', args: { p_id: string; p_attempt: string; p_identifier: string }): RpcResult;
  rpc(
    fn: 'fail_ksef_collective_identifier',
    args: { p_id: string; p_attempt: string; p_error_code: string; p_detail: string | null },
  ): RpcResult;
}

/** Funkcji nie ma (kod wdrożony przed 00191): PostgREST albo Postgres. */
const BRAK_FUNKCJI = new Set(['PGRST202', '42883']);

interface Proba {
  id: string;
  attempt: string;
}

async function authorized(): Promise<{ ctx: AuthContext } | { error: string }> {
  try {
    return { ctx: await requireOrgRole([...ROLE_IDENTYFIKATORA]) };
  } catch (e) {
    if (e instanceof ActionAuthError) {
      return { error: e.message === 'Niewystarczające uprawnienia' ? IDENTYFIKATOR_TEKSTY.rola : e.message };
    }
    throw e;
  }
}

/** Porażka próby z kodem; nieudany zapis zostawia wiersz „pending”, który po 5 minutach przejmie kolejne kliknięcie. */
async function zamknijPorazke(rpc: IdentyfikatorRpc, proba: Proba, kod: string, szczegol: string | null): Promise<void> {
  const { error } = await rpc.rpc('fail_ksef_collective_identifier', {
    p_id: proba.id,
    p_attempt: proba.attempt,
    p_error_code: kod,
    p_detail: szczegol,
  });
  if (error) console.error('[identyfikator-zbiorczy] zapis porażki', error.code);
}

function zglos(error: unknown, kod: string, tenantId: string): void {
  if (error instanceof NiepoprawnyIdentyfikatorZKsef) {
    Sentry.captureMessage('KSeF: identyfikator zbiorczy nie przeszedł sprawdzenia', {
      level: 'error',
      tags: { area: 'ksef.collective-identifier' },
      extra: { tenantId, powod: error.powod },
    });
    return;
  }
  Sentry.captureException(error, { tags: { area: 'ksef.collective-identifier' }, extra: { tenantId, kod } });
}

function metadaneGrupy(grupa: GrupaIdentyfikatora, srodowisko: KsefEnvironment) {
  return {
    sellerNip: grupa.nip,
    ksefNumbers: grupa.numeryKsef,
    invoiceCount: grupa.numeryKsef.length,
    environment: srodowisko,
  };
}

export async function utworzIdentyfikatorZbiorczyAction(kosztIds: string[]): Promise<IdentyfikatorZbiorczyResult> {
  const parsed = kosztIdsSchema.safeParse(kosztIds);
  if (!parsed.success) return { success: false, error: IDENTYFIKATOR_TEKSTY.wybor };
  const auth = await authorized();
  if ('error' in auth) return { success: false, error: auth.error };
  const { ctx } = auth;
  const srodowisko = configuredKsefEnvironment();
  if (!srodowisko) return { success: false, error: IDENTYFIKATOR_TEKSTY.srodowisko };

  const dane = await wczytajKosztyDoPliku(ctx.supabase, ctx.tenantId, srodowisko, parsed.data);
  if ('blad' in dane) {
    console.error('[identyfikator-zbiorczy] odczyt kosztów', dane.blad);
    return { success: false, error: IDENTYFIKATOR_TEKSTY.odczyt };
  }
  const wybor = sprawdzWybor(parsed.data, dane.wiersze, todayInWarsaw());
  if (!wybor.ok) return { success: false, error: wybor.powod };
  const { grupa } = wybor;

  const rpc = ctx.supabase as unknown as IdentyfikatorRpc;
  const rezerwacja = await rpc.rpc('claim_ksef_collective_identifier', {
    p_environment: srodowisko,
    p_seller_nip: grupa.nip,
    p_ksef_numbers: grupa.numeryKsef,
  });
  if (rezerwacja.error) {
    const kod = rezerwacja.error.code ?? '';
    if (BRAK_FUNKCJI.has(kod)) return { success: false, error: IDENTYFIKATOR_TEKSTY.migracja };
    if (kod === '42501') return { success: false, error: IDENTYFIKATOR_TEKSTY.rola };
    console.error('[identyfikator-zbiorczy] rezerwacja', kod);
    return { success: false, error: IDENTYFIKATOR_TEKSTY.zapis };
  }
  const r = (rezerwacja.data ?? {}) as { status?: unknown; id?: unknown; attempt?: unknown; identifier?: unknown; code?: unknown };
  if (r.status === 'ready') {
    const zapisany = poprawnyIdentyfikatorZbiorczy(r.identifier);
    if (!zapisany) {
      Sentry.captureMessage('Zapisany identyfikator zbiorczy nie przechodzi sprawdzenia', {
        level: 'error',
        tags: { area: 'ksef.collective-identifier' },
        extra: { tenantId: ctx.tenantId, id: r.id },
      });
      return { success: false, error: IDENTYFIKATOR_TEKSTY.bladDanych };
    }
    revalidatePath('/expenses');
    return { success: true, identyfikator: zapisany, status: 'zapisany_wczesniej', zapisany: true };
  }
  if (r.status === 'in_progress') return { success: false, error: wTrakcie(grupa) };
  if (r.status !== 'claimed' || typeof r.id !== 'string' || typeof r.attempt !== 'string') {
    console.error('[identyfikator-zbiorczy] rezerwacja', r.status, r.code);
    return { success: false, error: r.status === 'refused' ? IDENTYFIKATOR_TEKSTY.wybor : IDENTYFIKATOR_TEKSTY.zapis };
  }
  const proba: Proba = { id: r.id, attempt: r.attempt };

  const kontekst: KontekstBledu = {
    sprzedawca: grupa.sprzedawca,
    faktury: grupa.faktury.map((f) => ({ numerFaktury: f.numerFaktury, numerKsef: f.numerKsef })),
  };
  let identyfikator: string;
  try {
    const credentials = await getTenantKsefCredentials(ctx.tenantId);
    identyfikator = await wygenerujIdentyfikatorZbiorczy(credentials, {
      tenantId: ctx.tenantId,
      env: srodowisko,
      nipSprzedawcy: grupa.nip,
      numeryKsef: grupa.numeryKsef,
    });
  } catch (error) {
    const opis = opiszBladIdentyfikatora(error, kontekst);
    const szczegol = error instanceof NiepoprawnyIdentyfikatorZKsef ? `${error.powod}: ${error.otrzymano ?? 'brak pola'}` : null;
    await zamknijPorazke(rpc, proba, opis.kod, szczegol);
    if (opis.techniczny) zglos(error, opis.kod, ctx.tenantId);
    return { success: false, error: opis.komunikat };
  }

  const zapis = await rpc.rpc('complete_ksef_collective_identifier', {
    p_id: proba.id,
    p_attempt: proba.attempt,
    p_identifier: identyfikator,
  });
  const wynikZapisu = (zapis.data ?? null) as { status?: unknown; identifier?: unknown; code?: unknown } | null;
  if (!zapis.error && wynikZapisu?.status === 'ready') {
    revalidatePath('/expenses');
    return { success: true, identyfikator, status: 'utworzony', zapisany: true };
  }

  // Identyfikator jest już w KSeF: błąd zapisu nie może zamienić się w „nie powstał”.
  // Numer zostaje w audycie, a klient dostaje go teraz do skopiowania.
  const wczesniejszy = wynikZapisu?.status === 'already_ready' ? poprawnyIdentyfikatorZbiorczy(wynikZapisu.identifier) : null;
  await logAudit({
    action: 'expense.collective_identifier_created',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'collective_identifier',
    entityId: proba.id,
    metadata: {
      ...metadaneGrupy(grupa, srodowisko),
      identifier: identyfikator,
      zapisany: false,
      powod: zapis.error?.code ?? (typeof wynikZapisu?.code === 'string' ? wynikZapisu.code : String(wynikZapisu?.status ?? 'brak')),
      ...(wczesniejszy ? { zapisanyWczesniej: wczesniejszy } : {}),
    },
  });
  Sentry.captureMessage('Identyfikator zbiorczy nadany w KSeF bez zapisu w bazie', {
    level: 'warning',
    tags: { area: 'ksef.collective-identifier' },
    extra: { tenantId: ctx.tenantId, id: proba.id, kod: zapis.error?.code },
  });
  revalidatePath('/expenses');
  if (wczesniejszy) return { success: true, identyfikator: wczesniejszy, status: 'zapisany_wczesniej', zapisany: true };
  return { success: true, identyfikator, status: 'utworzony', zapisany: false };
}
