'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { monthLabel, monthRange } from '@/lib/expenses/month';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import { NAZWY_ROZLICZEN } from '@/lib/ksiegowosc/ten-miesiac';
import { skrot, stabilnyJson } from '@/lib/ksiegowosc/ten-miesiac-dane';
import {
  oznaczZaplacone,
  zaplataSchema,
  zatwierdzenieSchema,
  zatwierdzMiesiac,
  type WynikZaplaty,
  type WynikZatwierdzenia,
} from '@/lib/ksiegowosc/ten-miesiac-zapis';
import { bladDatyZaplatyRecznej, wejsciaZaplatyRecznej, zaplataRecznaSchema, type ZaplataRecznaWejscie } from '@/lib/ksiegowosc/zaplata-reczna';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Akcje „Ten miesiąc” (plan księgowości JDG, K4, D6): zatwierdzenie miesiąca
 * i oznaczenie zapłaty. Owner/admin, za wyłącznikiem (obszar `ten_miesiac`),
 * klientem z sesji; każda zmiana trafia do audit_logs.
 *
 * Ponowienie: zatwierdzenie liczy szkic od nowa na serwerze i zapisuje tylko
 * rozliczenia, których skrót różni się od ostatniej wersji, więc drugi klik
 * z tymi samymi danymi niczego nie dopisuje; dwa równoległe kliknięcia
 * zatrzymuje UNIQUE wersji. Zatwierdza się tylko to, co użytkownik widział:
 * skrót inny niż na ekranie to odmowa i odświeżenie. Oznaczenie zapłaty
 * ustawia stan (także na starszej wersji, żeby dało się poprawić datę),
 * więc powtórzone daje ten sam wynik.
 *
 * Zapłata spoza wyliczenia (K7.2, D15) dopisuje wersję rozliczenia z kwotą
 * z PUE ZUS i od razu ją oznacza jako zapłaconą. Nie ma klucza: drugi klik
 * dopisuje kolejną wersję, a odliczenie liczy tylko przyrost ponad najwyższą
 * zapłaconą wersję tego okresu (`przyrostyZaplat`), więc kwota się nie dubluje.
 */

export type { WynikZatwierdzenia, WynikZaplaty } from '@/lib/ksiegowosc/ten-miesiac-zapis';

const NIEDOSTEPNE = 'Rozliczenie miesiąca nie jest jeszcze dostępne dla tej firmy.';
const BLAD = 'Nie udało się zapisać i nic się nie zmieniło. Można spróbować jeszcze raz.';
const STRONA = '/reports/ten-miesiac';

async function wlaczony(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, 'ten_miesiac')).wlaczony;
  } catch {
    return false;
  }
}

export async function zatwierdzMiesiacAction(wejscie: z.input<typeof zatwierdzenieSchema>): Promise<WynikZatwierdzenia> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  // Wyliczenie, skróty, zapis wersji i audyt: `lib/ksiegowosc/ten-miesiac-zapis.ts` (to samo dla telefonu).
  return zatwierdzMiesiac({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

export async function oznaczZaplaconeAction(wejscie: z.input<typeof zaplataSchema>): Promise<WynikZaplaty> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  return oznaczZaplacone({ client: ctx.supabase as unknown as SupabaseClient, tenantId: ctx.tenantId, userId: ctx.user.id }, wejscie);
}

/**
 * Zapłata spoza wyliczenia (K7.2, D15): składki za okres, którego moduł nie
 * liczy, z kwotą z PUE ZUS. Wersja rozliczenia z `migawka.reczna`, zaraz
 * potem oznaczona jako zapłacona w podanym dniu.
 */
export async function dodajZaplateRecznaAction(wejscie: ZaplataRecznaWejscie): Promise<WynikZaplaty> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = zaplataRecznaSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? BLAD, pole: issue?.path.join('.') };
  }
  const z = parsed.data;
  const bladDaty = bladDatyZaplatyRecznej(z, todayInWarsaw());
  if (bladDaty) return { success: false, ...bladDaty };

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczony(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  const okres = `${z.zaMiesiac}-01`;
  const { data: ostatnia, error: bladOdczytu } = await client
    .from('tax_settlements')
    .select('wersja')
    .eq('tenant_id', ctx.tenantId)
    .eq('okres', okres)
    .eq('rodzaj', z.rodzaj)
    .order('wersja', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (bladOdczytu) return { success: false, error: BLAD };
  const wersja = ((ostatnia as { wersja?: number } | null)?.wersja ?? 0) + 1;
  const termin = terminDla({ rodzaj: 'zus', rok: Number(z.zaMiesiac.slice(0, 4)), miesiac: Number(z.zaMiesiac.slice(5, 7)) });
  const wejscia = wejsciaZaplatyRecznej(z);

  const { data: nowa, error: bladZapisu } = await client
    .from('tax_settlements')
    .insert({
      tenant_id: ctx.tenantId,
      okres,
      rodzaj: z.rodzaj,
      wersja,
      kwota_gr: z.kwotaGr,
      termin: termin?.faktyczny ?? monthRange(z.zaMiesiac).to,
      migawka: {
        reczna: true,
        wejscia,
        szczegoly: { zrodlo: 'PUE ZUS' },
        spoleczneBezFpGr: z.bezFpGr,
        wynik: { kwotaGr: z.kwotaGr, termin },
      },
      parametry_wersja: 'reczna',
      wejscia_hash: skrot(stabilnyJson({ miesiac: z.zaMiesiac, rodzaj: z.rodzaj, kwotaGr: z.kwotaGr, wejscia })),
    })
    .select('id')
    .single();
  if (bladZapisu || !nowa) {
    if (bladZapisu?.code === '23505') return { success: false, error: 'Ktoś właśnie zapisał rozliczenie tego okresu; po odświeżeniu strony można spróbować jeszcze raz.' };
    return { success: false, error: BLAD };
  }
  const id = (nowa as { id: string }).id;
  const { error: bladZaplaty } = await client
    .from('tax_settlements')
    .update({ status: 'zaplacone', zaplacone_o: z.dataZaplaty })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId);

  await logAudit({
    action: 'tax_settlement.manual_paid',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'tax_settlement',
    entityId: id,
    metadata: {
      zaMiesiac: z.zaMiesiac,
      rodzaj: z.rodzaj,
      nazwa: NAZWY_ROZLICZEN[z.rodzaj],
      wersja,
      kwotaGr: z.kwotaGr,
      spoleczneBezFpGr: z.bezFpGr,
      zaplaconeO: bladZaplaty ? null : z.dataZaplaty,
    },
  });
  revalidatePath(STRONA);
  if (bladZaplaty) {
    return {
      success: false,
      error: `Kwota za ${monthLabel(z.zaMiesiac)} jest zapisana, ale bez daty zapłaty. Datę ustawia się przy tej zapłacie na liście zapłat spoza wyliczenia.`,
    };
  }
  return { success: true };
}

