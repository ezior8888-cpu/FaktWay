/**
 * `cron.ksiegowosc-miesiac` (plan księgowości JDG, K5, sekcja 9): 1-3. dnia
 * miesiąca o 07:00 liczy rozliczenie za poprzedni miesiąc każdej firmy
 * w pilotażu i wysyła push „rozliczenie jest wyliczone”. Firma bez kwot
 * (brak profilu, parametry czekają na księgową, D7) nie dostaje nic.
 *
 * Szkic nie trafia do bazy (00168), więc idempotencję trzyma
 * `tax_notifications` (etap `wyliczone`): trzy dni uruchomień i ponowienia
 * dają jeden push. Ponowienie od zera pomija firmy z wpisem „sent”; błąd
 * jednej firmy nie zatrzymuje pozostałych, a zadanie kończy się błędem,
 * żeby kolejka je ponowiła.
 *
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { shiftMonth } from '@/lib/expenses/month';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { JobContext } from '@/lib/jobs/registry';
import { firmyWPilotazu, zajmij, zamknij } from '@/lib/ksiegowosc/powiadomienia';
import { trescWyliczenia } from '@/lib/ksiegowosc/przypomnienia';
import { czytajTenMiesiac } from '@/lib/ksiegowosc/ten-miesiac-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { sendPushToTenant } from '@/lib/push/sender';
import { createAdminClient } from '@/lib/supabase/admin';

export type WynikFirmy = 'wyslane' | 'pominiete' | 'duplikaty';

export async function powiadomOWyliczeniu(admin: SupabaseClient, tenantId: string, miesiac: string): Promise<WynikFirmy> {
  if (!(await czyKsiegowoscWlaczona(admin, tenantId, 'terminy')).wlaczony) return 'pominiete';
  const dane = await czytajTenMiesiac(admin, tenantId, miesiac);
  if (!dane.ok) return 'pominiete';
  // Kwota zero (np. składki w uldze na start) nie trafia do treści.
  const pozycje = dane.pozycje.flatMap((p) => (p.ok && p.kwotaGr > 0 ? [{ rodzaj: p.rodzaj, kwotaGr: p.kwotaGr }] : []));
  if (pozycje.length === 0) return 'pominiete';

  if ((await zajmij(admin, tenantId, miesiac, 'wyliczone')) === 'duplikat') return 'duplikaty';
  const tresc = trescWyliczenia({ miesiac, pozycje });
  try {
    const push = await sendPushToTenant(tenantId, 'ksiegowosc', {
      title: tresc.tytul,
      body: tresc.tresc,
      url: tresc.adres,
      // Ten sam tag: powtórzony push zastępuje poprzedni, zamiast dzwonić drugi raz.
      tag: `ksiegowosc-${miesiac}-wyliczone`,
    });
    await zamknij(admin, tenantId, miesiac, 'wyliczone', { status: 'sent', wynik: { push: push.sent } });
  } catch (e) {
    await zamknij(admin, tenantId, miesiac, 'wyliczone', { status: 'failed', blad: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    throw e;
  }
  return 'wyslane';
}

export async function runKsiegowoscMiesiac({ step, logger }: JobContext) {
  const admin = createAdminClient() as unknown as SupabaseClient;
  const miesiac = shiftMonth(todayInWarsaw().slice(0, 7), -1);
  const firmy = await step.run('firmy-w-pilotazu', () => firmyWPilotazu(admin));

  const licznik: Record<WynikFirmy, number> = { wyslane: 0, pominiete: 0, duplikaty: 0 };
  let doPonowienia = 0;
  for (const tenantId of firmy) {
    try {
      licznik[await step.run(`wyliczone-${tenantId}`, () => powiadomOWyliczeniu(admin, tenantId, miesiac))]++;
    } catch (e) {
      doPonowienia++;
      Sentry.captureException(e, { tags: { area: 'ksiegowosc.miesiac' }, extra: { tenantId, miesiac } });
    }
  }

  logger.info('ksiegowosc-miesiac', { miesiac, firmy: firmy.length, ...licznik, doPonowienia });
  if (doPonowienia > 0) throw new Error(`ksiegowosc-miesiac: ${doPonowienia} firm do ponowienia`);
  return { miesiac, firmy: firmy.length, ...licznik };
}
