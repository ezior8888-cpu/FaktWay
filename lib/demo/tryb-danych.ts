import 'server-only';

import { getTenantKsefProof } from '@/lib/dashboard-shell-data';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { KSEF_HISTORY_CERTIFICATE_ERRORS } from '@/lib/ksef/history-sync/client-pause';
import { asHistoryClient } from '@/lib/ksef/history-sync/db';
import type { PageContext } from '@/lib/supabase/page-context';
import type { KsefEnvironment } from '@/types/ksef';

import { DEMO_TENANT, analizyDemoSupabase } from './analizy-przykladowe';

/**
 * Tryb danych stron z kartami (PLAN-PRAWDZIWE-DANE §4, §5.1) — JEDNO miejsce
 * decyzji „przykład czy prawda” i jedyny moduł spoza `lib/demo/`, który wolno
 * importować (granica §5.2: reguła ESLint + `tests/unit/dane-granica.test.ts`).
 *
 * - `przyklad` — firma nie potwierdziła KSeF w bieżącym środowisku (stany A, H):
 *   karty czytają atrapę bazy z danymi przykładowymi;
 * - `synchronizacja` — potwierdziła, a historia sprzedaży z KSeF dopiero się
 *   pobiera (stan B, reguła Z4): karty czytają PRAWDZIWE dane (nigdy
 *   przykład); tryb pozwala tylko pustemu stanowi karty powiedzieć
 *   „Pobieramy faktury z KSeF…” zamiast „Wystaw fakturę”;
 * - `prawdziwe` — wszystko inne (C, D, B', E, G, G', G'').
 *
 * Kierunek bezpieczny: każdy błąd odczytu i brak konfiguracji środowiska
 * kończą się prawdziwymi danymi (D4) — przykład u zweryfikowanej firmy jest
 * gorszy niż pusty pulpit u niezweryfikowanej.
 */

export type TrybDanych = 'przyklad' | 'synchronizacja' | 'prawdziwe';

/**
 * Szczegół stanu z tabeli §4. D to C z pustymi danymi — rozpoznają go karty;
 * F to zasada (tryb liczony dla `ctx.tenantId`), nie osobny wynik.
 *
 * - `A` brak weryfikacji · `H` weryfikacja z innego środowiska → przykład;
 * - `B` historia sprzedaży się pobiera → synchronizacja;
 * - `B'` pobieranie wstrzymane przez klienta · `E` błąd certyfikatu
 *   (wygasł, brak poświadczeń, brak uprawnień) · `C` gotowe → prawdziwe;
 * - `G` błąd odczytu dowodu · `G'` błąd odczytu `ksef_history_sync`
 *   · `G''` brak `KSEF_ENV` → prawdziwe.
 */
export type StanDanych = 'A' | 'B' | "B'" | 'C' | 'E' | 'G' | "G'" | "G''" | 'H';

/** `tenants.ksef_verified_at` i `ksef_verified_environment` firmy (D3). */
export interface DowodKsef {
  verifiedAt: string | null;
  verifiedEnvironment: string | null;
}

/** Kolumny `ksef_history_sync` czytane sesją klienta (GRANT SELECT dla `authenticated`, 00155). */
export interface StrumienHistorii {
  direction: 'outgoing' | 'incoming';
  created_at: string;
  backfill_completed_at: string | null;
  client_paused_at: string | null;
  last_error_code: string | null;
}

export interface WejscieTrybu {
  /** `configuredKsefEnvironment()`; `null` = brak albo zła konfiguracja (G''). */
  srodowisko: KsefEnvironment | null;
  /** Dowód KSeF firmy; `'blad'` = wyjątek przy odczycie albo brak firmy (G). */
  dowod: DowodKsef | 'blad';
  /** Strumienie firmy w `srodowisko`; `'blad'` = błąd odczytu (G'); `null` = nie czytano. */
  strumienie: readonly StrumienHistorii[] | 'blad' | null;
  now: Date;
}

export interface WynikTrybu {
  tryb: TrybDanych;
  stan: StanDanych;
}

/** Z4: bez strumienia sprzedaży stan B trwa najwyżej tyle po weryfikacji. */
export const OKNO_STARTU_SYNCHRONIZACJI_MS = 2 * 60 * 60 * 1000;

const KOLUMNY_STRUMIENI = 'direction, created_at, backfill_completed_at, client_paused_at, last_error_code';

const BLEDY_CERTYFIKATU: readonly string[] = KSEF_HISTORY_CERTIFICATE_ERRORS;

/**
 * Czy dowód potwierdza KSeF w bieżącym środowisku — ta sama reguła co
 * `hasConfiguredKsefProof` (`lib/ksef/claim-environment.ts`), tylko ze
 * środowiskiem podanym wprost (czysta funkcja; zgodność pilnuje T3).
 */
function dowodZgodny(dowod: DowodKsef, srodowisko: KsefEnvironment): boolean {
  return Boolean(dowod.verifiedAt) && dowod.verifiedEnvironment === srodowisko;
}

/** Czysta reguła z §4 (kolejność warunków = pierwszeństwo stanów). */
export function rozstrzygnijTryb(w: WejscieTrybu): WynikTrybu {
  if (!w.srodowisko) return { tryb: 'prawdziwe', stan: "G''" };
  if (w.dowod === 'blad') return { tryb: 'prawdziwe', stan: 'G' };
  if (!w.dowod.verifiedAt) return { tryb: 'przyklad', stan: 'A' };
  if (!dowodZgodny(w.dowod, w.srodowisko)) return { tryb: 'przyklad', stan: 'H' };
  if (w.strumienie === 'blad') return { tryb: 'prawdziwe', stan: "G'" };

  // Tylko strumień sprzedaży: zakupy czekają na HWM skrzynki i nie przedłużają B (Z4).
  const sprzedaz = w.strumienie?.find((s) => s.direction === 'outgoing') ?? null;
  if (sprzedaz) {
    if (sprzedaz.last_error_code && BLEDY_CERTYFIKATU.includes(sprzedaz.last_error_code)) {
      return { tryb: 'prawdziwe', stan: 'E' };
    }
    if (sprzedaz.backfill_completed_at) return { tryb: 'prawdziwe', stan: 'C' };
    if (sprzedaz.client_paused_at) return { tryb: 'prawdziwe', stan: "B'" };
    return { tryb: 'synchronizacja', stan: 'B' };
  }

  const odWeryfikacji = w.now.getTime() - Date.parse(w.dowod.verifiedAt);
  if (odWeryfikacji < OKNO_STARTU_SYNCHRONIZACJI_MS) return { tryb: 'synchronizacja', stan: 'B' };
  return { tryb: 'prawdziwe', stan: 'C' };
}

/** Kontekst strony potrzebny do decyzji: klient sesji, firma i użytkownik. */
export type KontekstStrony = Pick<PageContext, 'supabase' | 'tenantId'> & {
  user: Pick<PageContext['user'], 'id'>;
};

export interface TrybFirmy extends WynikTrybu {
  /** `ksef_verified_at` zgodny z bieżącym środowiskiem; inaczej `null`. */
  verifiedAt: string | null;
  /**
   * Od kiedy koszty z KSeF są pełne — podpis „KSeF od DD.MM” przy kosztach
   * (Z9). Karty liczą też faktury zakupu z historii KSeF (E10, D-K), więc
   * zastrzeżenie trwa tylko, dopóki strumień zakupów nie skończy zaległości:
   * wtedy `verifiedAt` (Skrzynka ma komplet od weryfikacji), po zaległości
   * i przed weryfikacją — `null`. Błąd odczytu strumieni (G') zostawia
   * zastrzeżenie — nie wiemy, że historia jest pełna.
   */
  kosztyKsefOd: string | null;
}

export interface KontekstDanych extends TrybFirmy {
  /** `tryb === 'przyklad'` — plakietka „Dane przykładowe” tam, gdzie już jest. */
  demo: boolean;
  /** Prawdziwy klient sesji albo atrapa z danymi przykładowymi. */
  supabase: PageContext['supabase'];
  /** Prawdziwa firma albo `DEMO_TENANT`. */
  tenantId: string;
  /** Jedno „teraz” dla wszystkich kart strony. */
  nowIso: string;
}

async function odczytajDowod(ctx: KontekstStrony): Promise<DowodKsef | 'blad'> {
  try {
    return (await getTenantKsefProof(ctx.user.id, ctx.tenantId)) ?? 'blad';
  } catch {
    return 'blad';
  }
}

/**
 * Lekki odczyt stanu historii (§4): jedno zapytanie sesją klienta (RLS), bez
 * pełnego `readKsefHistorySyncStatus` — ten zostaje dla `/import-danych`.
 */
async function odczytajStrumienie(
  ctx: KontekstStrony,
  srodowisko: KsefEnvironment,
): Promise<readonly StrumienHistorii[] | 'blad'> {
  try {
    const { data, error } = await asHistoryClient(ctx.supabase)
      .from('ksef_history_sync')
      .select(KOLUMNY_STRUMIENI)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', srodowisko);
    if (error) return 'blad';
    return (data ?? []) as StrumienHistorii[];
  } catch {
    return 'blad';
  }
}

/** Czy strumień zakupów skończył zaległość — faktury zakupu z KSeF są w bazie od `history_floor`. */
function historiaZakupowPelna(strumienie: readonly StrumienHistorii[] | 'blad' | null): boolean {
  return Array.isArray(strumienie)
    && strumienie.some((s) => s.direction === 'incoming' && s.backfill_completed_at !== null);
}

/**
 * Tryb danych firmy `ctx.tenantId` bez podmiany klienta — dla miejsc, które
 * potrzebują tylko decyzji (KPiR, kafel Skrzynki). Strumieni historii nie
 * czyta, gdy wynik i tak jest przesądzony (A, H, G, G'').
 */
export async function trybDanych(ctx: KontekstStrony, now: Date): Promise<TrybFirmy> {
  const srodowisko = configuredKsefEnvironment();
  if (!srodowisko) {
    return { ...rozstrzygnijTryb({ srodowisko, dowod: 'blad', strumienie: null, now }), verifiedAt: null, kosztyKsefOd: null };
  }

  const dowod = await odczytajDowod(ctx);
  const zweryfikowana = dowod !== 'blad' && dowodZgodny(dowod, srodowisko);
  const strumienie = zweryfikowana ? await odczytajStrumienie(ctx, srodowisko) : null;
  const verifiedAt = zweryfikowana ? dowod.verifiedAt : null;
  return {
    ...rozstrzygnijTryb({ srodowisko, dowod, strumienie, now }),
    verifiedAt,
    kosztyKsefOd: verifiedAt && !historiaZakupowPelna(strumienie) ? verifiedAt : null,
  };
}

/**
 * Jedyne wejście stron do danych kart: tryb firmy i klient, z którego karty
 * czytają — prawdziwy (sesja, RLS) albo, w trybie `przyklad`, atrapa bazy
 * z danymi przykładowymi czytana tymi samymi loaderami (D5).
 */
export async function kontekstDanych(ctx: KontekstStrony, now: Date): Promise<KontekstDanych> {
  const tryb = await trybDanych(ctx, now);
  const nowIso = now.toISOString();
  if (tryb.tryb === 'przyklad') {
    return {
      ...tryb,
      demo: true,
      supabase: analizyDemoSupabase(now, configuredKsefEnvironment() ?? 'production'),
      tenantId: DEMO_TENANT,
      nowIso,
    };
  }
  return { ...tryb, demo: false, supabase: ctx.supabase, tenantId: ctx.tenantId, nowIso };
}

/** Księga przykładowa KPiR (stan A, H) — przez granicę §5.2, jak atrapa. */
export { kpirPrzykladowe } from './kpir-przykladowe';
