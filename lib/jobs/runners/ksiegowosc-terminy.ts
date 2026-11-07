/**
 * `cron.ksiegowosc-terminy` (plan księgowości JDG, K5, sekcja 9): codziennie
 * o 08:00 przypomina firmom w pilotażu o terminach ryczałtu i składek ZUS,
 * 5 i 1 dzień przed terminem, jeśli rozliczenie nie ma oznaczonej zapłaty.
 * Push do członków firmy i mail do właściciela.
 *
 * Idempotencja: `tax_notifications` (etap `termin-N:RRRR-MM-DD`), wpis przed
 * wysyłką; mail ma klucz idempotencji Resend z tym samym etapem. Ponowienie
 * od zera pomija przypomnienia „sent”; błąd jednej firmy nie zatrzymuje
 * pozostałych, a zadanie kończy się błędem, żeby kolejka je ponowiła.
 *
 * Przypomina się tylko o formie, którą moduł liczy (ryczałt, K4); skala
 * i liniowy dojdą w K7.
 *
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTerminRozliczeniaEmail } from '@/lib/email/send';
import { monthRange } from '@/lib/expenses/month';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { JobContext } from '@/lib/jobs/registry';
import { firmyWPilotazu, wlasciciel, zajmij, zamknij } from '@/lib/ksiegowosc/powiadomienia';
import { czytajWersjeProfilu, wersjaNa } from '@/lib/ksiegowosc/profil';
import { niezaplacone, terminyNaDzis, trescTerminu, type TerminNaDzis } from '@/lib/ksiegowosc/przypomnienia';
import { BLAD_ODCZYTU_ROZLICZEN, czytajTenMiesiac } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { sendPushToTenant } from '@/lib/push/sender';
import { createAdminClient } from '@/lib/supabase/admin';

import type { WynikFirmy } from './ksiegowosc-miesiac';

export async function przypomnijOTerminie(admin: SupabaseClient, tenantId: string, t: TerminNaDzis): Promise<WynikFirmy> {
  if (!(await czyKsiegowoscWlaczona(admin, tenantId, 'terminy')).wlaczony) return 'pominiete';
  const profil = wersjaNa(await czytajWersjeProfilu(admin, tenantId), monthRange(t.miesiac).to);
  if (!profil || profil.forma !== 'ryczalt') return 'pominiete';

  const dane = await czytajTenMiesiac(admin, tenantId, t.miesiac);
  // Bez odczytu zapłat nie wiadomo, co jest zapłacone: ponowienie zamiast przypomnienia „bez zapłaty”.
  if (!dane.ok && dane.braki.includes(BLAD_ODCZYTU_ROZLICZEN)) throw new Error(`Nie udało się odczytać rozliczeń firmy ${tenantId} za ${t.miesiac}`);
  const pozycje = niezaplacone({ grupy: t.grupy, rozliczenia: dane.rozliczenia, pozycje: dane.ok ? dane.pozycje : null, profil });
  if (pozycje.length === 0) return 'pominiete';

  if ((await zajmij(admin, tenantId, t.miesiac, t.etap)) === 'duplikat') return 'duplikaty';
  const tresc = trescTerminu({ miesiac: t.miesiac, termin: t.termin, dni: t.dni, pozycje });
  try {
    // Mail przed pushem: ma klucz idempotencji Resend, więc ponowienie po błędzie
    // pusha go nie zdubluje, a push wychodzi dopiero, gdy reszta się udała.
    const odbiorca = await wlasciciel(admin, tenantId);
    const mail = odbiorca
      ? await sendTerminRozliczeniaEmail(
          odbiorca.email,
          { tytul: tresc.tytul, tresc: tresc.tresc, rok: Number(t.miesiac.slice(0, 4)), adres: tresc.adres },
          { userId: odbiorca.userId, idempotencyKey: `ksiegowosc/${tenantId}/${t.miesiac}/${t.etap}` },
        )
      : null;
    const push = await sendPushToTenant(tenantId, 'ksiegowosc', {
      title: tresc.tytul,
      body: tresc.tresc,
      url: tresc.adres,
      tag: `ksiegowosc-${t.miesiac}-${t.etap}`,
    });
    await zamknij(admin, tenantId, t.miesiac, t.etap, {
      status: 'sent',
      wynik: { push: push.sent, mail: mail?.sent ?? false, ...(mail && !mail.sent ? { mailPowod: mail.reason ?? null } : {}) },
    });
  } catch (e) {
    await zamknij(admin, tenantId, t.miesiac, t.etap, { status: 'failed', blad: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    throw e;
  }
  return 'wyslane';
}

export async function runKsiegowoscTerminy({ step, logger }: JobContext) {
  const dzis = todayInWarsaw();
  const plan = terminyNaDzis(dzis);
  if (plan.length === 0) return { dzis, terminy: 0 };

  const admin = createAdminClient() as unknown as SupabaseClient;
  const firmy = await step.run('firmy-w-pilotazu', () => firmyWPilotazu(admin));
  const licznik: Record<WynikFirmy, number> = { wyslane: 0, pominiete: 0, duplikaty: 0 };
  let doPonowienia = 0;
  for (const tenantId of firmy) {
    for (const t of plan) {
      try {
        licznik[await step.run(`${t.etap}-${t.miesiac}-${tenantId}`, () => przypomnijOTerminie(admin, tenantId, t))]++;
      } catch (e) {
        doPonowienia++;
        Sentry.captureException(e, { tags: { area: 'ksiegowosc.terminy' }, extra: { tenantId, miesiac: t.miesiac, etap: t.etap } });
      }
    }
  }

  logger.info('ksiegowosc-terminy', { dzis, terminy: plan.length, firmy: firmy.length, ...licznik, doPonowienia });
  if (doPonowienia > 0) throw new Error(`ksiegowosc-terminy: ${doPonowienia} przypomnień do ponowienia`);
  return { dzis, terminy: plan.length, firmy: firmy.length, ...licznik };
}
