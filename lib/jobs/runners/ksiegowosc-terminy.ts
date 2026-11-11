/**
 * `cron.ksiegowosc-terminy` (plan księgowości JDG, K5, sekcja 9): codziennie
 * o 08:00 przypomina firmom w pilotażu o terminach ryczałtu albo zaliczki
 * PIT i składek ZUS,
 * 5 i 1 dzień przed terminem, jeśli rozliczenie nie ma oznaczonej zapłaty.
 * Push do członków firmy, mail do właściciela i wpis w dzwonku (00188).
 *
 * Idempotencja: `tax_notifications` (etap `termin-N:RRRR-MM-DD`), wpis przed
 * wysyłką; mail ma klucz idempotencji Resend z tym samym etapem. Ponowienie
 * od zera pomija przypomnienia „sent”; błąd jednej firmy nie zatrzymuje
 * pozostałych, a zadanie kończy się błędem, żeby kolejka je ponowiła.
 *
 * O ryczałcie przypomina się firmie na ryczałcie (K4), o zaliczce PIT firmie
 * na skali albo liniowym (K7); o składkach ZUS każdej; o VAT (25., K7.1)
 * płatnikowi VAT, gdy obszar `vat` jest puszczony w kodzie.
 *
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { publishAppNotification } from '@/lib/app-notifications/publish';
import { taxDeadlineNotification } from '@/lib/app-notifications/texts';
import { sendTerminRozliczeniaEmail } from '@/lib/email/send';
import { monthRange } from '@/lib/expenses/month';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { JobContext } from '@/lib/jobs/registry';
import { firmyWPilotazu, wlasciciel, zajmij, zamknij } from '@/lib/ksiegowosc/powiadomienia';
import { czytajWersjeProfilu, wersjaNa } from '@/lib/ksiegowosc/profil';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { grupyFormy, niezaplacone, terminyNaDzis, trescTerminu, type TerminNaDzis } from '@/lib/ksiegowosc/przypomnienia';
import { BLAD_ODCZYTU_ROZLICZEN, czytajTenMiesiac } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';
import { sendPushToTenant } from '@/lib/push/sender';
import { createAdminClient } from '@/lib/supabase/admin';

import type { WynikFirmy } from './ksiegowosc-miesiac';

export async function przypomnijOTerminie(admin: SupabaseClient, tenantId: string, t: TerminNaDzis): Promise<WynikFirmy> {
  if (!(await czyKsiegowoscWlaczona(admin, tenantId, 'terminy')).wlaczony) return 'pominiete';
  const profil = wersjaNa(await czytajWersjeProfilu(admin, tenantId), monthRange(t.miesiac).to);
  if (!profil) return 'pominiete';
  // Ryczałt albo zaliczka PIT (skala, liniowy, K7) według formy; składki zawsze;
  // VAT (K7.1) tylko płatnikowi VAT. Zwolnienie czytamy tylko w dniu przypomnienia o VAT.
  const wedlugFormy = grupyFormy(t.grupy, profil.forma);
  const bezVat =
    wedlugFormy.includes('vat') &&
    (!statusObszaru('vat').wlaczony || isSubjectiveVatExemption(await readTenantVatExemption(admin, tenantId)));
  const grupy = bezVat ? wedlugFormy.filter((g) => g !== 'vat') : wedlugFormy;
  if (grupy.length === 0) return 'pominiete';

  const dane = await czytajTenMiesiac(admin, tenantId, t.miesiac);
  // Bez odczytu zapłat nie wiadomo, co jest zapłacone: ponowienie zamiast przypomnienia „bez zapłaty”.
  if (!dane.ok && dane.braki.includes(BLAD_ODCZYTU_ROZLICZEN)) throw new Error(`Nie udało się odczytać rozliczeń firmy ${tenantId} za ${t.miesiac}`);
  const pozycje = niezaplacone({ grupy, rozliczenia: dane.rozliczenia, pozycje: dane.ok ? dane.pozycje : null, profil });
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
  // Dzwonek (plan kompletnej aplikacji, krok 8.1, część 2, 00188): to samo
  // przypomnienie w aplikacji, po udanej wysyłce. Fail-open: błąd zapisu idzie
  // do logu i Sentry, przypomnienie zostaje „sent” i nie jest ponawiane.
  // Ponowienie od zera kończy się wyżej jako duplikat (`zajmij`), a ten sam
  // klucz (rozliczenie i etap) i tak nie doda drugiego wpisu (UNIQUE).
  await publishAppNotification(
    taxDeadlineNotification({ tenantId, miesiac: t.miesiac, etap: t.etap, tytul: tresc.tytul, tresc: tresc.tresc, adres: tresc.adres }),
    { db: admin },
  );
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
