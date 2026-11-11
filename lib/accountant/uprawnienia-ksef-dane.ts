/**
 * Dane sekcji „Uprawnienie dla biura rachunkowego w KSeF” (Ustawienia,
 * zakładka Księgowa; krok 6.2, część 4): flaga, środowisko KSeF, połączenie
 * firmy z KSeF i lista z `ksef_permission_grants` (00195) kluczem sesji (RLS:
 * tylko właściciel aktywnej firmy). Tabela dojdzie do `types/database.ts` po
 * wgraniu migracji (typy z produkcji, AGENTS.md), do tego czasu klient bez typów.
 *
 * Flaga `ksefPermissionsEnabled` to WŁĄCZNIK: brak wiersza albo błąd odczytu
 * daje `null`, czyli sekcji nie ma (`getGlobalFlag`). Brak tabeli przed
 * wgraniem 00195 to „po najbliższej aktualizacji”, inny błąd odczytu to błąd
 * listy: formularz się nie pokazuje, bo stan uprawnień jest nieznany.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getGlobalFlag } from '@/lib/feature-flags/global-flags';
import { configuredKsefEnvironment, hasConfiguredKsefProof } from '@/lib/ksef/claim-environment';

import { wierszZBazy, type SekcjaUprawnien, type UprawnienieBiura } from './uprawnienia-ksef';

/** Biur jednej firmy jest kilka; 50 to zapas na długą historię. */
const LIMIT_WIERSZY = 50;

/** Brak tabeli: PostgREST (schema cache) albo Postgres. */
const BRAK_TABELI = new Set(['PGRST205', '42P01']);

export const KOLUMNY_UPRAWNIEN =
  'id, ksef_environment, subject_nip, subject_name, scopes, can_delegate, status, operation_references, ' +
  'ksef_status_code, ksef_status_description, error_code, claimed_at, checked_at, granted_at, revoked_at';

export async function wczytajSekcjeUprawnien(supabase: unknown, tenantId: string): Promise<SekcjaUprawnien | null> {
  if (!(await getGlobalFlag('ksefPermissionsEnabled'))) return null;
  const teraz = new Date().toISOString();
  const srodowisko = configuredKsefEnvironment();
  if (!srodowisko) {
    return { srodowisko: null, polaczono: false, nipFirmy: null, lista: { rodzaj: 'wiersze', wiersze: [] }, teraz };
  }
  const db = supabase as SupabaseClient;

  const { data: firma } = await db
    .from('tenants')
    .select('nip, has_ksef_credentials, ksef_verified_at, ksef_verified_environment')
    .eq('id', tenantId)
    .maybeSingle();
  const f = (firma ?? null) as {
    nip?: unknown;
    has_ksef_credentials?: unknown;
    ksef_verified_at?: unknown;
    ksef_verified_environment?: unknown;
  } | null;
  const polaczono =
    f?.has_ksef_credentials === true &&
    hasConfiguredKsefProof(
      typeof f.ksef_verified_at === 'string' ? f.ksef_verified_at : null,
      typeof f.ksef_verified_environment === 'string' ? f.ksef_verified_environment : null,
    );

  const { data, error } = await db
    .from('ksef_permission_grants')
    .select(KOLUMNY_UPRAWNIEN)
    .eq('tenant_id', tenantId)
    .eq('ksef_environment', srodowisko)
    .order('created_at', { ascending: false })
    .limit(LIMIT_WIERSZY);

  let lista: SekcjaUprawnien['lista'];
  if (error) {
    const kod = String((error as { code?: unknown }).code);
    if (!BRAK_TABELI.has(kod)) console.error('[uprawnienia-ksef] odczyt listy', kod);
    lista = BRAK_TABELI.has(kod) ? { rodzaj: 'niedostepna' } : { rodzaj: 'blad' };
  } else {
    // Lista kolumn ze stałej: typy PostgREST jej nie rozbiorą, więc wiersz czytamy jako rekord.
    const wiersze = ((data ?? []) as unknown as Record<string, unknown>[])
      .map(wierszZBazy)
      .filter((w): w is UprawnienieBiura => w !== null);
    lista = { rodzaj: 'wiersze', wiersze };
  }

  return {
    srodowisko,
    polaczono,
    nipFirmy: typeof f?.nip === 'string' ? f.nip : null,
    lista,
    teraz,
  };
}
