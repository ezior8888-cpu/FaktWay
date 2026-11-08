'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { monthLabel, monthRange } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import { NAZWY_ROZLICZEN } from '@/lib/ksiegowosc/ten-miesiac';
import {
  aktualne,
  czytajTenMiesiac,
  doZatwierdzenia,
  KOLUMNY_ROZLICZENIA,
  miesiacZakonczony,
  PO_KONCU_MIESIACA,
  skrot,
  stabilnyJson,
  zWierszaRozliczenia,
} from '@/lib/ksiegowosc/ten-miesiac-dane';
import { wejsciaZaplatyRecznej, zaplataRecznaSchema, type ZaplataRecznaWejscie } from '@/lib/ksiegowosc/zaplata-reczna';
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

export type WynikZatwierdzenia = { success: true; nowe: number } | { success: false; error: string };
export type WynikZaplaty = { success: true } | { success: false; error: string; pole?: string };

const NIEDOSTEPNE = 'Rozliczenie miesiąca nie jest jeszcze dostępne dla tej firmy.';
const BLAD = 'Nie udało się zapisać i nic się nie zmieniło. Można spróbować jeszcze raz.';
const ZMIANA_OD_OTWARCIA =
  'Dane miesiąca zmieniły się od otwarcia strony, więc nic nie zatwierdziliśmy. Strona pokazuje teraz aktualne kwoty do sprawdzenia.';
const STRONA = '/reports/ten-miesiac';

async function wlaczony(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, 'ten_miesiac')).wlaczony;
  } catch {
    return false;
  }
}

const skrotSchema = z.string().regex(/^[0-9a-f]{64}$/);
const zatwierdzenieSchema = z.object({
  miesiac: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  /** Skróty pozycji z ekranu, z którego kliknięto „Zatwierdź”. */
  skroty: z
    .object({
      ryczalt: skrotSchema.optional(),
      pit: skrotSchema.optional(),
      zus_spoleczne: skrotSchema.optional(),
      zdrowotna: skrotSchema.optional(),
      vat: skrotSchema.optional(),
    })
    .strict(),
  /** P_39 wpisane na ekranie (K7.1): akcja liczy VAT z tą samą nadwyżką, którą widział klient. */
  nadwyzkaVat: z.number().int().min(0).max(1e13).nullable().optional(),
});

export async function zatwierdzMiesiacAction(wejscie: z.input<typeof zatwierdzenieSchema>): Promise<WynikZatwierdzenia> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = zatwierdzenieSchema.safeParse(wejscie);
  if (!parsed.success) return { success: false, error: BLAD };
  const { miesiac, skroty, nadwyzkaVat } = parsed.data;
  if (!miesiacZakonczony(miesiac, todayInWarsaw())) return { success: false, error: PO_KONCU_MIESIACA };

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczony(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  const dane = await czytajTenMiesiac(client, ctx.tenantId, miesiac, { nadwyzkaVat: nadwyzkaVat ?? null });
  if (!dane.ok) return { success: false, error: dane.braki[0] ?? BLAD };

  const ostatnie = aktualne(dane.rozliczenia);
  const doZapisu = doZatwierdzenia(dane);
  if (doZapisu.some((p) => skroty[p.rodzaj] !== p.wejsciaHash)) {
    revalidatePath(STRONA);
    return { success: false, error: ZMIANA_OD_OTWARCIA };
  }
  if (doZapisu.length === 0) {
    revalidatePath(STRONA);
    return { success: true, nowe: 0 };
  }
  const nowe = doZapisu.map((p) => ({
    tenant_id: ctx.tenantId,
    okres: `${miesiac}-01`,
    rodzaj: p.rodzaj,
    wersja: (ostatnie.get(p.rodzaj)?.wersja ?? 0) + 1,
    kwota_gr: p.kwotaGr,
    termin: p.termin?.faktyczny ?? monthRange(miesiac).to,
    migawka: {
      wejscia: p.wejscia,
      szczegoly: p.szczegoly ?? null,
      spoleczneBezFpGr: p.spoleczneBezFpGr ?? 0,
      wynik: { kwotaGr: p.kwotaGr, termin: p.termin },
    },
    parametry_wersja: dane.parametryWersja,
    wejscia_hash: p.wejsciaHash,
  }));

  // `tax_settlements` dojdzie do types/database.ts po wgraniu 00168 (typy z produkcji).
  const { error } = await client.from('tax_settlements').insert(nowe);
  if (error) {
    if (error.code === '23505') {
      return { success: false, error: 'Ktoś właśnie zatwierdził ten miesiąc; po odświeżeniu strony widać aktualną wersję.' };
    }
    return { success: false, error: BLAD };
  }

  await logAudit({
    action: 'tax_settlement.approved',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'tax_settlement',
    metadata: {
      miesiac,
      parametryWersja: dane.parametryWersja,
      rozliczenia: nowe.map((n) => ({ rodzaj: n.rodzaj, wersja: n.wersja, kwotaGr: n.kwota_gr, termin: n.termin })),
    },
  });
  revalidatePath(STRONA);
  return { success: true, nowe: nowe.length };
}

const zaplataSchema = z.object({
  id: z.string().uuid(),
  zaplacone: z.boolean(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

export async function oznaczZaplaconeAction(wejscie: z.input<typeof zaplataSchema>): Promise<WynikZaplaty> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const parsed = zaplataSchema.safeParse(wejscie);
  if (!parsed.success) return { success: false, error: BLAD };
  const { id, zaplacone, data } = parsed.data;
  if (zaplacone && (!data || data > todayInWarsaw())) {
    return { success: false, error: 'Data zapłaty nie może być późniejsza niż dziś.' };
  }

  const client = ctx.supabase as unknown as SupabaseClient;
  if (!(await wlaczony(client, ctx.tenantId))) return { success: false, error: NIEDOSTEPNE };

  const { data: wiersz, error: bladOdczytu } = await client
    .from('tax_settlements')
    .select(KOLUMNY_ROZLICZENIA)
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (bladOdczytu) return { success: false, error: BLAD };
  if (!wiersz) return { success: false, error: 'Tego rozliczenia nie ma na liście.' };
  const rozliczenie = zWierszaRozliczenia(wiersz as Parameters<typeof zWierszaRozliczenia>[0]);
  if (zaplacone && data && data < `${rozliczenie.miesiac}-01`) {
    return { success: false, error: `Data zapłaty nie może być wcześniejsza niż miesiąc rozliczenia (${monthLabel(rozliczenie.miesiac)}).` };
  }

  const { error } = await client
    .from('tax_settlements')
    .update({ status: zaplacone ? 'zaplacone' : 'zatwierdzone', zaplacone_o: zaplacone ? data : null })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId);
  if (error) return { success: false, error: BLAD };

  await logAudit({
    action: zaplacone ? 'tax_settlement.paid' : 'tax_settlement.unpaid',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'tax_settlement',
    entityId: id,
    metadata: {
      miesiac: rozliczenie.miesiac,
      rodzaj: rozliczenie.rodzaj,
      nazwa: NAZWY_ROZLICZEN[rozliczenie.rodzaj],
      wersja: rozliczenie.wersja,
      kwotaGr: rozliczenie.kwotaGr,
      zaplaconeO: zaplacone ? data : null,
      opis: zaplacone && data ? `zapłacono ${formatIsoDatePl(data)}` : 'cofnięto zapłatę',
    },
  });
  revalidatePath(STRONA);
  return { success: true };
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
  const dzis = todayInWarsaw();
  if (z.dataZaplaty > dzis) return { success: false, error: 'Data zapłaty nie może być późniejsza niż dziś.', pole: 'dataZaplaty' };
  if (z.zaMiesiac >= dzis.slice(0, 7)) {
    return { success: false, error: 'Składki za miesiąc w trakcie zapisuje się po jego zakończeniu.', pole: 'zaMiesiac' };
  }

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

