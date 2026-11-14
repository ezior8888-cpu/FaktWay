import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { monthLabel, monthRange } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { NAZWY_ROZLICZEN } from '@/lib/ksiegowosc/ten-miesiac';
import {
  aktualne,
  czytajTenMiesiac,
  doZatwierdzenia,
  KOLUMNY_ROZLICZENIA,
  miesiacZakonczony,
  PO_KONCU_MIESIACA,
  zWierszaRozliczenia,
} from '@/lib/ksiegowosc/ten-miesiac-dane';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';

/**
 * Zapis „Ten miesiąc” (plan księgowości JDG, K4, D6): zatwierdzenie miesiąca
 * i oznaczenie zapłaty, wspólne dla akcji strony (`app/actions/ksiegowosc-ten-miesiac.ts`,
 * sesja z ciasteczek) i telefonu (`/api/mobile/v1/ksiegowosc/*`, M10b, sesja z
 * tokenu). Logika przeniesiona z akcji bez zmian. Rolę (właściciel,
 * administrator) sprawdza wywołujący; wyłącznik (obszar `ten_miesiac`) i
 * wszystkie warunki sprawdza ta funkcja. Klient to klient sesji klienta (RLS).
 *
 * Ponowienie: zatwierdzenie ze skrótami już zatwierdzonej wersji daje
 * `nowe: 0` bez zapisu (wersja jest w bazie, UNIQUE łapie wyścig, 23505);
 * zapłata ustawia ten sam stan.
 */

export interface RozliczeniaKontekst {
  client: SupabaseClient;
  tenantId: string;
  userId: string;
}

export type WynikZatwierdzenia = { success: true; nowe: number } | { success: false; error: string };
export type WynikZaplaty = { success: true } | { success: false; error: string; pole?: string };

const NIEDOSTEPNE = 'Rozliczenie miesiąca nie jest jeszcze dostępne dla tej firmy.';
const BLAD = 'Nie udało się zapisać i nic się nie zmieniło. Można spróbować jeszcze raz.';
// Zdania bez „strony”: widzi je też telefon (M10b), który po odmowie wczytuje miesiąc od nowa.
const ZMIANA_OD_OTWARCIA =
  'Dane miesiąca zmieniły się od otwarcia, więc nic nie zatwierdziliśmy. Pokazujemy teraz aktualne kwoty do sprawdzenia.';
const STRONA = '/reports/ten-miesiac';

async function wlaczony(client: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    return (await czyKsiegowoscWlaczona(client, tenantId, 'ten_miesiac')).wlaczony;
  } catch {
    return false;
  }
}

const skrotSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const zatwierdzenieSchema = z.object({
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

/** Zatwierdzenie miesiąca; rola (właściciel, administrator) sprawdzona przez wywołującego. */
export async function zatwierdzMiesiac(ctx: RozliczeniaKontekst, wejscie: z.input<typeof zatwierdzenieSchema>): Promise<WynikZatwierdzenia> {
  const parsed = zatwierdzenieSchema.safeParse(wejscie);
  if (!parsed.success) return { success: false, error: BLAD };
  const { miesiac, skroty, nadwyzkaVat } = parsed.data;
  if (!miesiacZakonczony(miesiac, todayInWarsaw())) return { success: false, error: PO_KONCU_MIESIACA };

  const client = ctx.client;
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
      return { success: false, error: 'Ktoś właśnie zatwierdził ten miesiąc; po odświeżeniu widać aktualną wersję.' };
    }
    return { success: false, error: BLAD };
  }

  await logAudit({
    action: 'tax_settlement.approved',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
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

export const zaplataSchema = z.object({
  id: z.string().uuid(),
  zaplacone: z.boolean(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

/** Zapłata rozliczenia albo jej cofnięcie; rola sprawdzona przez wywołującego. */
export async function oznaczZaplacone(ctx: RozliczeniaKontekst, wejscie: z.input<typeof zaplataSchema>): Promise<WynikZaplaty> {
  const parsed = zaplataSchema.safeParse(wejscie);
  if (!parsed.success) return { success: false, error: BLAD };
  const { id, zaplacone, data } = parsed.data;
  if (zaplacone && (!data || data > todayInWarsaw())) {
    return { success: false, error: 'Data zapłaty nie może być późniejsza niż dziś.' };
  }

  const client = ctx.client;
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
    userId: ctx.userId,
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
