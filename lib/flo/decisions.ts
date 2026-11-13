/**
 * Pamięć decyzji i wyciszanie rodzajów spraw (krok 12 planu agenta FLO).
 *
 * PO CO: agent, który wraca z tym samym pytaniem po trzecim „nie”, uczy
 * ludzi ignorowania wszystkich powiadomień — także tych trafnych. Dwa
 * odrzucenia z rzędu znaczą „nie pisz mi o tym”, i tyle.
 *
 * WYCISZENIE JEST SPRAWDZANE PRZED UTWORZENIEM PROPOZYCJI, nie przy
 * wyświetlaniu. Inaczej baza puchłaby od kart, których nikt nigdy nie
 * zobaczy, a licznik trafności w trybie cichym liczyłby propozycje, które
 * i tak były niewidoczne.
 *
 * `dismissed` to licznik ODRZUCEŃ Z RZĘDU, nie suma z całego życia konta:
 * przyjęcie propozycji tego rodzaju zeruje go. Ktoś, kto raz odrzucił,
 * potem skorzystał, a po pół roku odrzucił znowu, nie zasługuje na ciszę —
 * zasługuje na nią ten, kto mówi „nie” dwa razy pod rząd.
 */

import { floDb, type FloDbClient, type FloDecisionRow } from '@/lib/flo/db-types';
import { readAllByKey } from '@/lib/pagination/keyset';
import type { FloProposalKind } from '@/types/flo';

/**
 * DWA POZIOMY CISZY (plan FLO 2, K2.16 — poprawka z 23.09.2026).
 *
 * Do tej pory był jeden: rodzaj. „Nie chcę reguły akurat u Adobe" kliknięte
 * dwa razy przy DWÓCH RÓŻNYCH sprzedawcach wyciszało całe W-03 na kwartał —
 * klient odpowiadał o dwóch konkretnych sprawach, a agent rozumiał to jako
 * „nie pytaj mnie o nic tego rodzaju". Ten sam błąd dotyczył „Jeszcze nie"
 * w K-01 (dwie różne faktury) i „Nigdy więcej takich" w W-04.
 *
 * Od teraz:
 *
 * | Poziom | Co ucisza | Kiedy |
 * |---|---|---|
 * | SPRAWA | jedną fakturę, jednego sprzedawcę, jeden miesiąc | dwa odrzucenia TEJ SAMEJ sprawy |
 * | RODZAJ | wszystkie karty tego rodzaju | „Nigdy więcej takich" — jasna prośba |
 * | TŁUM | rodzaj, tymczasowo | odrzucenie WIELU różnych spraw tego rodzaju w krótkim czasie |
 *
 * ZAPIS BEZ MIGRACJI: sprawa mieszka w tej samej tabeli co rodzaj, pod
 * kluczem tematu karty (`topic_key`), który zawsze zaczyna się od nazwy
 * rodzaju i dwukropka (`expense.rule:Adobe`). Kolumna `kind` jest zwykłym
 * TEXT-em bez ograniczeń, a klucz główny `(tenant_id, kind)` daje dokładnie
 * tę unikalność, której potrzebujemy.
 */

/** Po tylu odrzuceniach z rzędu agent milknie — w sprawie albo w rodzaju. */
export const MUTE_AFTER_DISMISSALS = 2;

/**
 * Ile RÓŻNYCH spraw jednego rodzaju musi zostać odrzuconych, żeby uznać, że
 * klientowi nie podoba się sam rodzaj, a nie poszczególne sprawy.
 *
 * Trzy to jeszcze przypadek („akurat te trzy faktury"), pięć to już seria,
 * której nikt nie klika przypadkiem.
 */
export const CROWD_MUTE_SUBJECTS = 4;

/** W jakim oknie liczymy te odrzucenia. */
export const CROWD_WINDOW_DAYS = 30;

/** Na jak długo. Kwartał to dość, żeby sytuacja klienta zdążyła się zmienić. */
export const MUTE_DAYS = 90;

export type FloDecision = 'accepted' | 'dismissed';

export interface DecisionState {
  accepted: number;
  dismissed: number;
  mutedUntil: string | null;
}

// ═══════════════════════════════════════════════════════════════
// Reguła (funkcja czysta — całe sedno, testowalne bez bazy)
// ═══════════════════════════════════════════════════════════════

export function nextDecisionState(
  current: DecisionState | null,
  decision: FloDecision,
  now: Date = new Date(),
): DecisionState {
  const state: DecisionState = current ?? {
    accepted: 0,
    dismissed: 0,
    mutedUntil: null,
  };

  if (decision === 'accepted') {
    return {
      accepted: state.accepted + 1,
      // Seria odrzuceń przerwana — licznik od zera.
      dismissed: 0,
      // Skoro klient właśnie z tego skorzystał, cisza traci sens.
      mutedUntil: null,
    };
  }

  const dismissed = state.dismissed + 1;
  const shouldMute = dismissed >= MUTE_AFTER_DISMISSALS;

  return {
    accepted: state.accepted,
    dismissed,
    mutedUntil: shouldMute
      ? new Date(now.getTime() + MUTE_DAYS * 86_400_000).toISOString()
      : state.mutedUntil,
  };
}

export function isMutedAt(
  state: DecisionState | null,
  now: Date = new Date(),
): boolean {
  const until = state?.mutedUntil;
  return typeof until === 'string' && Date.parse(until) > now.getTime();
}

// ═══════════════════════════════════════════════════════════════
// Cisza: sprawa, rodzaj, tłum — funkcja czysta
// ═══════════════════════════════════════════════════════════════

/** Wiersz pamięci decyzji: rodzaj ALBO pojedyncza sprawa (klucz tematu). */
export interface DecisionRow {
  kind: string;
  accepted: number;
  dismissed: number;
  muted_until: string | null;
  last_at: string;
}

export type SilenceReason = 'kind' | 'subject' | 'crowd';

export type SilenceVerdict =
  | { silenced: false }
  | { silenced: true; reason: SilenceReason };

/**
 * Czy agent ma milczeć w tej konkretnej sprawie — całe sedno poprawki.
 *
 * Kolejność sprawdzeń jest treścią: najpierw jasna prośba o ciszę w rodzaju,
 * potem cisza w tej sprawie, na końcu wniosek z zachowania (tłum). Dwie
 * pierwsze wynikają z tego, co człowiek powiedział wprost; trzecia jest
 * naszym domysłem, więc ma być ostatnia i ma sama wygasać.
 */
export function silenceVerdict(
  rows: readonly DecisionRow[],
  kind: string,
  topicKey: string,
  now: Date = new Date(),
): SilenceVerdict {
  const stateOf = (key: string): DecisionState | null => {
    const row = rows.find((r) => r.kind === key);
    return row
      ? { accepted: row.accepted, dismissed: row.dismissed, mutedUntil: row.muted_until }
      : null;
  };

  if (isMutedAt(stateOf(kind), now)) return { silenced: true, reason: 'kind' };
  if (isMutedAt(stateOf(topicKey), now)) {
    return { silenced: true, reason: 'subject' };
  }

  // Tłum: wiele RÓŻNYCH spraw tego rodzaju odrzuconych w jednym oknie.
  // Liczymy sprawy, nie kliknięcia — dwa odrzucenia tej samej faktury to
  // jedna sprawa, o której klient powiedział to samo dwa razy.
  const cutoff = now.getTime() - CROWD_WINDOW_DAYS * 86_400_000;
  const prefix = `${kind}:`;
  const dismissedSubjects = rows.filter(
    (row) =>
      row.kind.startsWith(prefix) &&
      row.dismissed > 0 &&
      Date.parse(row.last_at) > cutoff,
  ).length;

  return dismissedSubjects >= CROWD_MUTE_SUBJECTS
    ? { silenced: true, reason: 'crowd' }
    : { silenced: false };
}

// ═══════════════════════════════════════════════════════════════
// Zapis i odczyt
// ═══════════════════════════════════════════════════════════════

export async function recordDecision(
  tenantId: string,
  kind: string,
  decision: FloDecision,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<DecisionState> {
  const current = await readState(tenantId, kind, db);
  const next = nextDecisionState(current, decision, now);

  const { error } = await db.from('flo_decisions').upsert(
    {
      tenant_id: tenantId,
      kind,
      accepted: next.accepted,
      dismissed: next.dismissed,
      muted_until: next.mutedUntil,
      last_at: now.toISOString(),
    },
    { onConflict: 'tenant_id,kind' },
  );

  if (error) throw new Error(error.message);
  return next;
}

/**
 * Wyciszenie na życzenie — przycisk „nigdy więcej takich”.
 *
 * Osobne od `recordDecision`, bo to nie jest drugie odrzucenie z rzędu,
 * tylko jasna prośba. Czekanie z ciszą do kolejnego razu byłoby ignorowaniem
 * tego, co człowiek właśnie powiedział.
 */
export async function muteKind(
  tenantId: string,
  kind: string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<void> {
  const current = await readState(tenantId, kind, db);
  const { error } = await db.from('flo_decisions').upsert(
    {
      tenant_id: tenantId,
      kind,
      accepted: current?.accepted ?? 0,
      dismissed: Math.max(current?.dismissed ?? 0, MUTE_AFTER_DISMISSALS),
      muted_until: new Date(
        now.getTime() + MUTE_DAYS * 86_400_000,
      ).toISOString(),
      last_at: now.toISOString(),
    },
    { onConflict: 'tenant_id,kind' },
  );
  if (error) throw new Error(error.message);
}

/** Przywrócenie z ekranu ustawień — cisza musi być odwracalna. */
export async function unmuteKind(
  tenantId: string,
  kind: string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<void> {
  const { error } = await db
    .from('flo_decisions')
    .upsert(
      {
        tenant_id: tenantId,
        kind,
        dismissed: 0,
        muted_until: null,
        last_at: now.toISOString(),
      },
      { onConflict: 'tenant_id,kind' },
    );
  if (error) throw new Error(error.message);
}

export async function isMuted(
  tenantId: string,
  kind: FloProposalKind | string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<boolean> {
  return isMutedAt(await readState(tenantId, kind, db), now);
}

/**
 * Wyciszone RODZAJE — do ekranu ustawień (tor interfejsu, krok 21).
 *
 * Wiersze pojedynczych spraw mieszkają w tej samej tabeli, więc trzeba je
 * odsiać: klucz tematu ma dwukropek, nazwa rodzaju nigdy. Bez tego ekran
 * ustawień pokazywałby klientowi „expense.rule:Adobe" jako rodzaj sprawy.
 */
export async function listMutedKinds(
  tenantId: string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<string[]> {
  const rows = await readMuted(tenantId, now, db);
  return rows.filter((row) => !row.kind.includes(':')).map((row) => row.kind);
}

/** Wyciszone pojedyncze sprawy — klucze tematów kart. */
export async function listMutedSubjects(
  tenantId: string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<Array<{ topicKey: string; mutedUntil: string }>> {
  const rows = await readMuted(tenantId, now, db);
  return rows
    .filter((row) => row.kind.includes(':'))
    .map((row) => ({ topicKey: row.kind, mutedUntil: String(row.muted_until) }));
}

async function readMuted(
  tenantId: string,
  now: Date,
  db: FloDbClient,
): Promise<Array<{ kind: string; muted_until: string | null }>> {
  const nowIso = now.toISOString();
  // Stronami po `kind`, jak `readDecisionRows` — wyciszonych spraw bywa
  // ponad 1000, a PostgREST ucina odpowiedź bez błędu.
  return readAllByKey<{ kind: string; muted_until: string | null }>(
    'wyciszenia Flo',
    (row) => row.kind,
    (afterKind, limit) => {
      let query = db
        .from('flo_decisions')
        .select('kind, muted_until')
        .eq('tenant_id', tenantId)
        .gt('muted_until', nowIso);
      if (afterKind !== null) query = query.gt('kind', afterKind);
      return query.order('kind', { ascending: true }).limit(limit);
    },
  );
}

// ═══════════════════════════════════════════════════════════════
// Cisza: odczyt i zapis
// ═══════════════════════════════════════════════════════════════

/**
 * Jeden odczyt zamiast dwóch: wiersze rodzaju i spraw tego konta.
 *
 * Wierszy jest tyle, ile rodzajów plus spraw, o których klient coś
 * powiedział. Wiersz sprawy nie znika, więc u firmy, która od miesięcy
 * odrzuca karty, są ich tysiące. Produkcja ucina każdą odpowiedź PostgREST
 * do 1000 wierszy bez błędu (`PGRST_DB_MAX_ROWS`), a jedno zapytanie
 * gubiło wtedy resztę i wyciszony rodzaj wracał (sesja 29 planu
 * skalowania). Dlatego stronami po `kind` (klucz główny w obrębie firmy);
 * błąd na dowolnej stronie to wyjątek, nie krótsza lista.
 */
export async function readDecisionRows(
  tenantId: string,
  db: FloDbClient = floDb(),
): Promise<DecisionRow[]> {
  return readAllByKey<DecisionRow>(
    'pamięć decyzji Flo',
    (row) => row.kind,
    (afterKind, limit) => {
      let query = db
        .from('flo_decisions')
        .select('kind, accepted, dismissed, muted_until, last_at')
        .eq('tenant_id', tenantId);
      if (afterKind !== null) query = query.gt('kind', afterKind);
      return query.order('kind', { ascending: true }).limit(limit);
    },
  );
}

/** Czy agent ma milczeć w tej sprawie — odczyt plus reguła. */
export async function isSilenced(
  tenantId: string,
  kind: string,
  topicKey: string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<SilenceVerdict> {
  return silenceVerdict(await readDecisionRows(tenantId, db), kind, topicKey, now);
}

/**
 * Zapis odpowiedzi „nie" — na poziomie SPRAWY, nie rodzaju.
 *
 * Klucz tematu identyfikuje sprawę (faktura, sprzedawca, miesiąc), więc
 * dwa „nie" o tej samej sprawie uciszają właśnie ją. Odpowiedzi o różnych
 * sprawach zbiera dopiero reguła tłumu.
 */
export async function recordSubjectDismissal(
  tenantId: string,
  topicKey: string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<DecisionState> {
  return recordDecision(tenantId, topicKey, 'dismissed', now, db);
}

/**
 * Cisza w jednej sprawie na życzenie — bez czekania na drugie „nie".
 *
 * To samo co `muteKind`, tylko kluczem jest temat karty. Osobna nazwa, bo
 * `muteKind(tenant, 'expense.rule:Adobe')` czytałoby się jak pomyłka.
 */
export async function muteSubject(
  tenantId: string,
  topicKey: string,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<void> {
  return muteKind(tenantId, topicKey, now, db);
}

async function readState(
  tenantId: string,
  kind: string,
  db: FloDbClient,
): Promise<DecisionState | null> {
  const { data, error } = await db
    .from('flo_decisions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as FloDecisionRow;
  return {
    accepted: row.accepted,
    dismissed: row.dismissed,
    mutedUntil: row.muted_until,
  };
}
