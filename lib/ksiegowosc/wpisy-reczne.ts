/**
 * Wpisy ręczne ewidencji przychodów (plan księgowości JDG, K3, D5): raport
 * z kasy rejestrującej i inne dowody bez faktury z KSeF. Tabela
 * `ledger_manual_entries` (00167); ten sam schemat Zod sprawdza formularz
 * i akcję serwerową.
 *
 * Od K7 (00171) ta sama tabela trzyma wpisy KPiR przy skali i liniowym:
 * z kolumną KPiR zamiast stawki ryczałtu. Ewidencja czyta tylko wpisy ze
 * stawką, KPiR tylko wpisy z kolumną.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { STAWKI_JPK_EWP_PB, type WpisReczny } from '@/lib/ksiegowosc/ewidencja';
import { KOLUMNY_KPIR, type WpisKpir } from '@/lib/ksiegowosc/kpir';
import { PROFIL_OD_MIN } from '@/lib/ksiegowosc/profil';

export const RODZAJE_WPISU = ['raport_kasy', 'inny'] as const;
export type RodzajWpisu = (typeof RODZAJE_WPISU)[number];

export const NAZWY_RODZAJOW_WPISU: Readonly<Record<RodzajWpisu, string>> = {
  raport_kasy: 'Raport z kasy rejestrującej',
  inny: 'Inny dowód',
};

/**
 * „1 234,56”, „-12,5” albo „100” → grosze. Dokładnie, bez mnożenia float;
 * `null`, gdy to nie jest kwota z najwyżej dwoma miejscami po przecinku.
 */
export function kwotaNaGrosze(tekst: string): number | null {
  const czysty = tekst.replace(/[\s ]/g, '').replace(',', '.');
  const m = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/.exec(czysty);
  if (!m) return null;
  const grosze = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -grosze : grosze;
}

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Brak daty przychodu.');

export const wpisSchema = z.object({
  rodzaj: z.enum(RODZAJE_WPISU, { message: 'Brak rodzaju dowodu.' }),
  dataPrzychodu: data.refine((v) => v >= PROFIL_OD_MIN, { message: 'Ewidencja działa od 1 stycznia 2026 r.' }),
  dokument: z
    .string()
    .trim()
    .min(1, 'Brak numeru dowodu, np. numeru raportu z kasy.')
    .max(256, 'Numer dowodu ma najwyżej 256 znaków.'),
  /** Tekst z formularza („1 234,56”); po parsowaniu grosze. */
  kwota: z
    .string()
    .transform((v, ctx) => {
      const gr = kwotaNaGrosze(v);
      if (gr === null || gr === 0) {
        ctx.addIssue({ code: 'custom', message: 'Kwota to liczba różna od zera, z najwyżej dwoma miejscami po przecinku.' });
        return z.NEVER;
      }
      return gr;
    }),
  stawkaPb: z
    .number({ message: 'Brak stawki ryczałtu.' })
    .int()
    .refine((v) => (STAWKI_JPK_EWP_PB as readonly number[]).includes(v), { message: 'Brak stawki ryczałtu.' }),
  opis: z
    .string()
    .trim()
    .max(256, 'Opis ma najwyżej 256 znaków.')
    .nullable()
    .transform((v) => (v ? v : null)),
});

export type WpisWejscie = z.input<typeof wpisSchema>;
export type Wpis = z.output<typeof wpisSchema>;

export const KOLUMNY_WPISU = 'id, rodzaj, data_przychodu, data_wpisu, dokument, kwota_gr, stawka_pb, opis';

interface WierszWpisu {
  id: string;
  rodzaj: string;
  data_przychodu: string;
  data_wpisu: string;
  dokument: string;
  kwota_gr: number | string;
  stawka_pb: number;
  opis: string | null;
}

export function zWierszaWpisu(w: WierszWpisu): WpisReczny {
  return {
    id: w.id,
    rodzaj: w.rodzaj === 'inny' ? 'inny' : 'raport_kasy',
    dataPrzychodu: w.data_przychodu,
    dataWpisu: w.data_wpisu,
    dokument: w.dokument,
    kwotaGr: Number(w.kwota_gr),
    stawkaPb: w.stawka_pb,
    opis: w.opis,
  };
}

export function doWierszaWpisu(tenantId: string, w: Wpis) {
  return {
    tenant_id: tenantId,
    rodzaj: w.rodzaj,
    data_przychodu: w.dataPrzychodu,
    dokument: w.dokument,
    kwota_gr: w.kwota,
    stawka_pb: w.stawkaPb,
    opis: w.opis,
  };
}

function czyBrakTabeli(kod: string | undefined): boolean {
  // Przed wgraniem 00167: Postgres 42P01, PostgREST PGRST205.
  return kod === '42P01' || kod === 'PGRST205';
}

/**
 * Wpisy z dniem przychodu w [od, do], klientem z sesji (RLS). Przed wgraniem
 * 00167 brak tabeli to brak wpisów, a nie awaria; każdy inny błąd rzuca.
 */
export async function czytajWpisyReczne(
  client: SupabaseClient,
  tenantId: string,
  od: string,
  doDnia: string,
): Promise<WpisReczny[]> {
  const wiersze = await readCompletePages<WierszWpisu>('ewidencja: wpisy ręczne', async (from, to) => {
    const wynik = await client
      .from('ledger_manual_entries')
      .select(KOLUMNY_WPISU, { count: 'exact' })
      .eq('tenant_id', tenantId)
      // Wpisy KPiR (00171) nie mają stawki i nie należą do ewidencji ryczałtu.
      .not('stawka_pb', 'is', null)
      .gte('data_przychodu', od)
      .lte('data_przychodu', doDnia)
      .order('id', { ascending: true })
      .range(from, to);
    if (wynik.error && czyBrakTabeli(wynik.error.code)) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszWpisu[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.map(zWierszaWpisu);
}

/** Wpis KPiR (K7): te same pola co wpis ewidencji, z kolumną KPiR zamiast stawki. */
export const wpisKpirSchema = wpisSchema.omit({ stawkaPb: true }).extend({
  kolumna: z.enum(KOLUMNY_KPIR, { message: 'Brak kolumny KPiR.' }),
});

export type WpisKpirWejscie = z.input<typeof wpisKpirSchema>;

export const KOLUMNY_WPISU_KPIR = 'id, rodzaj, data_przychodu, dokument, kwota_gr, kolumna, opis';

interface WierszWpisuKpir {
  id: string;
  rodzaj: string;
  data_przychodu: string;
  dokument: string;
  kwota_gr: number | string;
  kolumna: WpisKpir['kolumna'];
  opis: string | null;
}

export function zWierszaWpisuKpir(w: WierszWpisuKpir): WpisKpir & { rodzaj: RodzajWpisu } {
  return {
    id: w.id,
    rodzaj: w.rodzaj === 'inny' ? 'inny' : 'raport_kasy',
    data: w.data_przychodu,
    dokument: w.dokument,
    kolumna: w.kolumna,
    kwotaGr: Number(w.kwota_gr),
    opis: w.opis,
  };
}

export function doWierszaWpisuKpir(tenantId: string, w: z.output<typeof wpisKpirSchema>) {
  return {
    tenant_id: tenantId,
    rodzaj: w.rodzaj,
    data_przychodu: w.dataPrzychodu,
    dokument: w.dokument,
    kwota_gr: w.kwota,
    kolumna: w.kolumna,
    opis: w.opis,
  };
}

/**
 * Wpisy KPiR z dniem w [od, do] (00171). Przed wgraniem 00171 nie ma kolumny
 * (42703), a przed 00167 tabeli: to brak wpisów, nie awaria.
 */
export async function czytajWpisyKpir(
  client: SupabaseClient,
  tenantId: string,
  od: string,
  doDnia: string,
): Promise<(WpisKpir & { rodzaj: RodzajWpisu })[]> {
  const wiersze = await readCompletePages<WierszWpisuKpir>('kpir: wpisy ręczne', async (from, to) => {
    const wynik = await client
      .from('ledger_manual_entries')
      .select(KOLUMNY_WPISU_KPIR, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .not('kolumna', 'is', null)
      .gte('data_przychodu', od)
      .lte('data_przychodu', doDnia)
      .order('id', { ascending: true })
      .range(from, to);
    if (wynik.error && (czyBrakTabeli(wynik.error.code) || wynik.error.code === '42703')) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszWpisuKpir[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.map(zWierszaWpisuKpir);
}
