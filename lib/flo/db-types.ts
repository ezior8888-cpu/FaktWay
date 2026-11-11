/**
 * Typy wierszy i dostęp do tabel agenta FLO (migracja 00061).
 *
 * DLACZEGO RĘCZNIE, A NIE Z `types/database.ts`: w tym projekcie plik z
 * typami bazy regeneruje się osobno, ręcznie, po wgraniu migracji na
 * produkcję — a my musimy pisać kod, zanim to nastąpi. Ta sama konwencja
 * co w `lib/support/conversations.ts`: własne interfejsy wierszy plus
 * rzutowanie klienta administracyjnego przez `unknown`.
 *
 * Po regeneracji `types/database.ts` ten plik można zwęzić do samych aliasów
 * — ale nie trzeba, bo kształt tabel jest tu udokumentowany razem z tym,
 * dlaczego kolumny wyglądają tak, a nie inaczej.
 *
 * WSZYSTKO IDZIE PRZEZ KLIENTA ADMINISTRACYJNEGO. Tabele mają REVOKE na
 * INSERT/UPDATE/DELETE dla roli `authenticated` — zapis wykonuje worker
 * (cron `flo.tick`) i akcje serwerowe PO weryfikacji `auth.getUser()`.
 * Odczyt po stronie klienta idzie normalnym torem, przez RLS.
 */

import { createAdminClient } from '@/lib/supabase/admin';

// ═══════════════════════════════════════════════════════════════
// Wiersze
// ═══════════════════════════════════════════════════════════════

/** Stany propozycji — zgodne z CHECK w migracji 00061. */
export type FloProposalStatus =
  | 'open'
  | 'approved'
  | 'executing'
  | 'done'
  | 'expired'
  | 'dismissed'
  | 'blocked';

/**
 * Powód zniknięcia propozycji z wątku.
 *
 * `undone` I `stale` SĄ TU PO TO, ŻEBY PANEL OPERATORA NIE KŁAMAŁ. Bez nich
 * cofnięcie zapisywało się nieodróżnialnie od zwykłego odrzucenia
 * (`dismissed`/`not_now`), a blokada re-walidacyjna nieodróżnialnie od
 * wygaśnięcia z braku decyzji — więc obie metryki pokazywały zero niezależnie
 * od tego, co naprawdę działo się na produkcji.
 *
 * Kolumna w bazie jest zwykłym TEXT-em bez CHECK-a (migracja 00061), więc
 * nowe wartości nie wymagają migracji — ale wymagają, żeby ten typ był
 * jedynym miejscem, z którego się je bierze.
 */
export type FloDismissedReason =
  | 'not_now'
  | 'never'
  /**
   * „Skończyliśmy współpracę z TYM kontrahentem" (K2.16) — cisza w jednej
   * sprawie, nie w całym rodzaju. Osobna wartość, bo panel operatora inaczej
   * nie odróżni „klient nie chce tej funkcji" od „ta jedna relacja się
   * skończyła", a to są dwa różne wnioski o produkcie.
   */
  | 'never_subject'
  | 'auto_expired'
  /** Re-walidacja odmówiła wykonania: dane zmieniły się po pokazaniu karty. */
  | 'stale'
  /** Człowiek cofnął wykonaną czynność w oknie dziesięciu minut. */
  | 'undone';

/**
 * `kind` jest tu `string`, nie `FloProposalKind` — w bazie to kolumna TEXT
 * i wartość mogła tam trafić ze starszej wersji kodu. Walidujemy strażnikiem
 * `isFloProposalKind` przy odczycie, zamiast udawać, że baza gwarantuje typ.
 */
export interface FloProposalRow {
  id: string;
  tenant_id: string;
  kind: string;
  topic_key: string;
  status: FloProposalStatus;
  priority: number;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  evidence: Array<{ label: string; href: string }>;
  fingerprint: string;
  expires_at: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  executed_at: string | null;
  dismissed_reason: FloDismissedReason | null;
}

export interface FloProposalInsert {
  id?: string;
  tenant_id: string;
  kind: string;
  topic_key: string;
  status?: FloProposalStatus;
  priority?: number;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  evidence?: Array<{ label: string; href: string }>;
  fingerprint: string;
  expires_at: string;
  created_at?: string;
  approved_at?: string | null;
  approved_by?: string | null;
  executed_at?: string | null;
  dismissed_reason?: FloDismissedReason | null;
}

/**
 * Żeton zgody. `snapshot` to dokładnie to, co człowiek widział, klikając —
 * przy reklamacji „ja tego nie wysyłałem" to jest dowód.
 */
export interface FloApprovalRow {
  id: string;
  proposal_id: string;
  tenant_id: string;
  user_id: string;
  snapshot: Record<string, unknown>;
  created_at: string;
  consumed_at: string | null;
  expires_at: string;
}

export interface FloApprovalInsert {
  id?: string;
  proposal_id: string;
  tenant_id: string;
  user_id: string;
  snapshot: Record<string, unknown>;
  created_at?: string;
  consumed_at?: string | null;
  expires_at?: string;
}

export interface FloDecisionRow {
  tenant_id: string;
  kind: string;
  accepted: number;
  dismissed: number;
  muted_until: string | null;
  last_at: string;
}

export interface FloDecisionInsert {
  tenant_id: string;
  kind: string;
  accepted?: number;
  dismissed?: number;
  muted_until?: string | null;
  last_at?: string;
}

/**
 * Ustawienia agenta. Cztery kanały plus profil podatkowy — i ani jednego
 * pola więcej. W szczególności NIE MA tu poziomu autonomii: zachowanie
 * agenta jest identyczne u każdego klienta.
 */
export interface FloPrefsRow {
  tenant_id: string;
  push_enabled: boolean;
  email_enabled: boolean;
  quiet_from: string;
  quiet_to: string;
  muted_kinds: string[];
  tax_profile: {
    form: 'skala' | 'liniowy' | 'ryczalt' | 'nieznana';
    vat: boolean;
    period: 'M' | 'K';
    startedOn: string | null;
    ryczaltRate?: number | null;
  } | null;
  updated_at: string;
}

export type FloPrefsInsert = Partial<FloPrefsRow> & { tenant_id: string };

export interface FloUsageRow {
  tenant_id: string;
  day: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

export type FloUsageInsert = Partial<FloUsageRow> & {
  tenant_id: string;
  day: string;
};

/** Przełącznik funkcji per konto (migracja 00066). */
export interface FloKindFlagRow {
  tenant_id: string;
  kind: string;
  enabled: boolean;
  reason: string | null;
  updated_at: string;
}

export type FloKindFlagInsert = Omit<FloKindFlagRow, 'updated_at'> & {
  updated_at?: string;
};

/** Etap wdrożenia kanarkowego per rodzaj (migracja 00067). */
export interface FloRolloutRow {
  kind: string;
  stage: number;
  stage_since: string | null;
  complaints: number;
  halted: boolean;
  halt_reason: string | null;
  updated_at: string;
}

export type FloRolloutInsert = Partial<FloRolloutRow> & { kind: string };

export interface FloShadowRow {
  id: string;
  tenant_id: string;
  kind: string;
  proposal: Record<string, unknown>;
  actual: Record<string, unknown> | null;
  matched: boolean | null;
  created_at: string;
}

export interface FloShadowInsert {
  id?: string;
  tenant_id: string;
  kind: string;
  proposal: Record<string, unknown>;
  actual?: Record<string, unknown> | null;
  matched?: boolean | null;
  created_at?: string;
}

// ═══════════════════════════════════════════════════════════════
// Minimalny, typowany dostęp do tabel
// ═══════════════════════════════════════════════════════════════

/**
 * Kształt odpowiedzi PostgREST. Konwencja projektu: sprawdzamy `error`,
 * nigdy nie zakładamy, że `data` jest niepuste.
 */
export interface FloResult<T> {
  data: T;
  error: { message: string } | null;
  /** Liczba wierszy — tylko gdy zapytanie o nią poprosiło (`count: 'exact'`), inaczej `null`. */
  count?: number | null;
}

/**
 * Łańcuch filtrów. Świadomie okrojony do tego, czego agent naprawdę używa —
 * pełne typy PostgREST przyjdą z regeneracją `types/database.ts`.
 * Rozszerza `PromiseLike`, bo builder Supabase jest „thenable”: `await`
 * na łańcuchu zwraca listę wierszy.
 */
export interface FloFilter<Row> extends PromiseLike<FloResult<Row[] | null>> {
  eq(column: string, value: string | number | boolean): FloFilter<Row>;
  neq(column: string, value: string | number | boolean): FloFilter<Row>;
  not(column: string, operator: 'like', value: string): FloFilter<Row>;
  in(column: string, values: readonly (string | number)[]): FloFilter<Row>;
  is(column: string, value: null | boolean): FloFilter<Row>;
  lt(column: string, value: string | number): FloFilter<Row>;
  lte(column: string, value: string | number): FloFilter<Row>;
  gt(column: string, value: string | number): FloFilter<Row>;
  gte(column: string, value: string | number): FloFilter<Row>;
  order(column: string, opts?: { ascending?: boolean }): FloFilter<Row>;
  limit(count: number): FloFilter<Row>;
  /** Stronicowanie — granice włączne, jak w PostgREST. */
  range(from: number, to: number): FloFilter<Row>;
  maybeSingle(): Promise<FloResult<Row | null>>;
  single(): Promise<FloResult<Row>>;
}

/** Zapis bez filtrów (insert/upsert) — z opcjonalnym odczytem wyniku. */
export interface FloMutation<Row> extends PromiseLike<FloResult<null>> {
  select(columns?: string): FloFilter<Row>;
}

/** Zapis z filtrami (update/delete). */
export interface FloFilteredMutation<Row>
  extends PromiseLike<FloResult<null>> {
  eq(column: string, value: string | number | boolean): FloFilteredMutation<Row>;
  in(
    column: string,
    values: readonly (string | number)[],
  ): FloFilteredMutation<Row>;
  is(column: string, value: null | boolean): FloFilteredMutation<Row>;
  lt(column: string, value: string | number): FloFilteredMutation<Row>;
  lte(column: string, value: string | number): FloFilteredMutation<Row>;
  // `gt` jest potrzebne do atomowego zużycia żetonu zgody: warunek „jeszcze
  // nie wygasł” musi być częścią tego samego UPDATE-u, a nie osobnym
  // sprawdzeniem przed nim (inaczej między jednym a drugim mieści się wyścig).
  gt(column: string, value: string | number): FloFilteredMutation<Row>;
  select(columns?: string): FloFilter<Row>;
}

export interface FloTableClient<Row, Insert> {
  select(columns?: string): FloFilter<Row>;
  insert(rows: Insert | Insert[]): FloMutation<Row>;
  upsert(
    rows: Insert | Insert[],
    opts?: { onConflict?: string },
  ): FloMutation<Row>;
  /**
   * `count: 'exact'` — baza odda w `count` liczbę zmienionych wierszy bez
   * odsyłania ich samych. Tak liczy wygaszanie kart (FLO-01).
   */
  update(
    patch: Partial<Insert>,
    opts?: { count?: 'exact' },
  ): FloFilteredMutation<Row>;
  delete(): FloFilteredMutation<Row>;
}

/** Klient ograniczony do tabel agenta — nic więcej nie jest widoczne. */
export interface FloDbClient {
  from(
    table: 'flo_proposals',
  ): FloTableClient<FloProposalRow, FloProposalInsert>;
  from(
    table: 'flo_approvals',
  ): FloTableClient<FloApprovalRow, FloApprovalInsert>;
  from(
    table: 'flo_decisions',
  ): FloTableClient<FloDecisionRow, FloDecisionInsert>;
  from(table: 'flo_prefs'): FloTableClient<FloPrefsRow, FloPrefsInsert>;
  from(table: 'flo_usage'): FloTableClient<FloUsageRow, FloUsageInsert>;
  from(table: 'flo_shadow'): FloTableClient<FloShadowRow, FloShadowInsert>;
  from(
    table: 'flo_kind_flags',
  ): FloTableClient<FloKindFlagRow, FloKindFlagInsert>;
  from(table: 'flo_rollout'): FloTableClient<FloRolloutRow, FloRolloutInsert>;
  /** Atomowe dodanie zużycia AI (00105, AUD-116). */
  rpc(
    fn: 'flo_record_usage',
    args: {
      p_tenant_id: string;
      p_day: string;
      p_input_tokens: number;
      p_output_tokens: number;
      p_cost_usd: number;
    },
  ): PromiseLike<{ error: { message: string } | null }>;
}

/**
 * Klient administracyjny zawężony do tabel agenta.
 *
 * Rzutowanie przez `unknown` jest świadome: `types/database.ts` nie zna
 * jeszcze tabel z migracji 00061, więc bez tego kroku każde zapytanie
 * kończyłoby się błędem typów. Zawężenie do tabel agenta sprawia, że tym
 * rzutowaniem nie da się przypadkiem sięgnąć do faktur ani do kontrahentów.
 */
export function floDb(): FloDbClient {
  return createAdminClient() as unknown as FloDbClient;
}
