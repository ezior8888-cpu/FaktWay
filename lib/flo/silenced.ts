/**
 * Lista wyciszeń do ekranu ustawień (plan FLO 2, K2.16 — druga połowa).
 *
 * CO TU NAPRAWIAMY. Ekran „Wyciszone sprawy" czytał `flo_prefs.muted_kinds`
 * — tablicę, której NIC nigdy nie zapisywało. Prawdziwa cisza mieszka
 * w `flo_decisions` i nigdy się tam nie pokazywała, a przycisk „Przywróć"
 * nie przywracał niczego. Klient miał ekran, który zawsze mówił „nic nie
 * jest wyciszone", nawet gdy agent milczał w pięciu sprawach.
 *
 * DWA RODZAJE WPISÓW, bo cisza ma dwa poziomy (patrz `decisions.ts`):
 * cały rodzaj („Nigdy więcej takich") i pojedyncza sprawa (dwa „nie"
 * o tej samej fakturze). Sprawa pokazuje się TYTUŁEM OSTATNIEJ KARTY, a nie
 * kluczem z bazy: „Nowak zapłacił za fakturę 5/2026?" zamiast
 * „payment.confirm:8f3a…".
 *
 * Reguła tłumu (cztery różne sprawy w miesiąc) NIE ma tu wpisu i to jest
 * świadome: nie zapisujemy jej nigdzie, bo sama wygasa razem z oknem.
 * Pokazanie klienta czegoś, czego nie da się przywrócić przyciskiem, byłoby
 * gorsze od niepokazania.
 */

import { isMutedAt, type DecisionRow } from '@/lib/flo/decisions';

export interface SilencedEntry {
  /** Klucz do przywrócenia: nazwa rodzaju albo klucz tematu sprawy. */
  key: string;
  kind: string;
  /** `true` = cały rodzaj, `false` = jedna sprawa. */
  wholeKind: boolean;
  /** Co klient przeczyta. */
  label: string;
  /** Rodzaj po ludzku — przy sprawie jako podpis. */
  kindLabel: string;
  mutedUntil: string;
}

/** Rodzaj z klucza tematu: `payment.confirm:8f3a` → `payment.confirm`. */
export function kindOfKey(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
}

/**
 * Zamienia wiersze pamięci decyzji na listę dla ekranu — funkcja czysta.
 *
 * Najpierw całe rodzaje, potem sprawy: wyciszenie całej funkcji jest
 * ważniejszą informacją niż jedna faktura, o którą agent nie pyta.
 */
export function buildSilencedList(input: {
  rows: readonly DecisionRow[];
  /** Tytuł ostatniej karty w danej sprawie — klucz tematu → tytuł. */
  titles: ReadonlyMap<string, string>;
  labelOfKind: (kind: string) => string;
  now?: Date;
}): SilencedEntry[] {
  const now = input.now ?? new Date();

  return input.rows
    .filter((row) => isListed(row, now))
    .map((row) => {
      const kind = kindOfKey(row.kind);
      const wholeKind = row.kind === kind;
      const kindLabel = input.labelOfKind(kind);

      return {
        key: row.kind,
        kind,
        wholeKind,
        // Sprawa bez tytułu zdarzy się, gdy karta zdążyła zniknąć z bazy —
        // wtedy lepiej powiedzieć „jedna sprawa" niż pokazać klucz.
        label: wholeKind
          ? kindLabel
          : (input.titles.get(row.kind) ?? `${kindLabel}: jedna sprawa`),
        kindLabel,
        mutedUntil: String(row.muted_until),
      };
    })
    .sort((a, b) => {
      if (a.wholeKind !== b.wholeKind) return a.wholeKind ? -1 : 1;
      return a.label.localeCompare(b.label, 'pl');
    });
}

/**
 * Klucze spraw, które lista pokaże, czyli tylko te, którym potrzebny jest
 * tytuł karty. Pamięć decyzji trzyma też sprawy bez trwającej ciszy (jedno
 * „nie”, cisza wygasła, karta przyjęta), a tych bywa tysiące.
 */
export function silencedSubjectKeys(rows: readonly DecisionRow[], now: Date): string[] {
  return rows
    .filter((row) => row.kind !== kindOfKey(row.kind) && isListed(row, now))
    .map((row) => row.kind);
}

/** Czy wiersz trafia na listę: cisza trwa w chwili `now`. Jedna reguła dla listy i dla tytułów. */
function isListed(row: DecisionRow, now: Date): boolean {
  return isMutedAt(
    { accepted: row.accepted, dismissed: row.dismissed, mutedUntil: row.muted_until },
    now,
  );
}
