'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import {
  czytajWersjeProfilu,
  doWiersza,
  KOLUMNY_PROFILU,
  profilSchema,
  sprawdzZmianeFormy,
  zWiersza,
  ZAKRES_V1_ODMOWA,
  type ZapisProfiluWejscie,
  type WersjaProfilu,
} from '@/lib/ksiegowosc/profil';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

export type ZapisProfiluWynik =
  | { success: true; wersja: WersjaProfilu }
  | { success: false; error: string; pole?: string };

const NIEDOSTEPNE = 'Ustawienia podatkowe nie są jeszcze dostępne dla tej firmy.';
// Bez trybu rozkazującego (plan, sekcja 13); przy tym błędzie w bazie nic się nie zmieniło.
const BLAD_ZAPISU = 'Nie udało się zapisać ustawień podatkowych i nic się nie zmieniło. Można spróbować jeszcze raz.';

/**
 * Zapisuje wersję profilu podatkowego od `validFrom` (nowa albo poprawka
 * wersji z tym samym dniem). Tylko właściciel i administrator, klientem
 * z sesji (RLS z 00166 też to sprawdza), za wyłącznikiem modułu (obszar
 * `ustawienia`). Zmiana trafia do `audit_logs` z wersją przed i po.
 *
 * Ponowienie po każdym kroku: odczyt i walidacja nie mają efektów; zapis to
 * upsert po (`tenant_id`, `valid_from`), więc drugi taki sam zapis daje ten
 * sam wiersz; wpis audytu przy ponowieniu powtarza się z tym samym „przed
 * i po”, co jest prawdą o dwóch kliknięciach.
 */
export async function zapiszProfilPodatkowyAction(wejscie: ZapisProfiluWejscie): Promise<ZapisProfiluWynik> {
  let ctx;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  // Poza zakresem v1 (plan, D1) moduł dałby błędne kwoty po cichu, więc zapis
  // wymaga potwierdzenia; bez profilu moduł nie liczy.
  if (wejscie.zakresV1 !== true) return { success: false, error: ZAKRES_V1_ODMOWA, pole: 'zakresV1' };

  const parsed = profilSchema.safeParse(wejscie);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { success: false, error: issue?.message ?? 'Nieprawidłowe ustawienia podatkowe.', pole: issue?.path.join('.') };
  }
  const profil = parsed.data;

  let wersje: WersjaProfilu[];
  try {
    const werdykt = await czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, 'ustawienia');
    if (!werdykt.wlaczony) return { success: false, error: NIEDOSTEPNE };
    wersje = await czytajWersjeProfilu(ctx.supabase, ctx.tenantId);
  } catch {
    // Wyjątek poza kontraktem { success:false } przewróciłby stronę w error.tsx.
    return { success: false, error: BLAD_ZAPISU };
  }

  const regula = sprawdzZmianeFormy(wersje, profil);
  if (regula) return { success: false, error: regula, pole: 'validFrom' };

  const przed = wersje.find((w) => w.validFrom === profil.validFrom) ?? null;

  // `tax_profiles` dojdzie do types/database.ts po wgraniu 00166 (typy z produkcji).
  const { data, error } = await (ctx.supabase as unknown as SupabaseClient)
    .from('tax_profiles')
    .upsert(doWiersza(ctx.tenantId, profil), { onConflict: 'tenant_id,valid_from' })
    .select(KOLUMNY_PROFILU)
    .single();

  if (error || !data) {
    // Wyzwalacz 00166 zwraca HINT. Sprawdzenie wyżej przeszło, więc wersje
    // zmieniły się w międzyczasie (np. zapis z drugiej karty).
    if (error?.hint === 'tax_profile_form_change') {
      return {
        success: false,
        error:
          'Forma opodatkowania zmienia się tylko od 1 stycznia, a ustawienia zmieniły się w międzyczasie. ' +
          'Po odświeżeniu strony widać aktualne wersje.',
        pole: 'validFrom',
      };
    }
    return { success: false, error: BLAD_ZAPISU };
  }

  const wersja = zWiersza(data as Parameters<typeof zWiersza>[0]);

  await logAudit({
    action: 'tax_profile.saved',
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    entityType: 'tax_profile',
    entityId: wersja.id,
    metadata: { validFrom: wersja.validFrom, zakresV1: true, przed, po: wersja },
  });

  revalidatePath('/reports/ustawienia-podatkowe');
  return { success: true, wersja };
}
