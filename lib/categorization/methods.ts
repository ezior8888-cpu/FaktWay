/**
 * Wartości `categorization_method` (bez zależności serwerowych, więc także
 * dla komponentów klienta).
 *
 * Joby zapisują wynik klasyfikatora wprost do kolumny enum
 * `expenses.categorization_method` (process-ocr, auto-categorize-inbox),
 * a klient serwisowy nie ma typów bazy, więc typecheck wartości spoza enum nie
 * złapie. `rule_global_nip` i `rule_global_keyword` od 06.05.2026 były poza
 * enum (00034) i koszt dopasowany regułą globalną nie zapisywał się
 * (ustalenie 738u1, 00205). Nowa wartość: najpierw `ALTER TYPE ... ADD VALUE`
 * w migracji, potem tutaj. Pilnują tego tests/unit/kategoryzacja-enum-bazy.test.ts
 * (lista w migracjach) i tests/rls-kategoryzacja-reguly-globalne.test.ts
 * (zapis na bazie).
 */
export const CATEGORIZATION_METHODS = [
  'rule_nip',
  'rule_keyword',
  'rule_global_nip',
  'rule_global_keyword',
  'learned',
  'ml_heuristic',
  'ai_claude',
  'manual',
] as const;

export type CategorizationMethod = (typeof CATEGORIZATION_METHODS)[number];

/**
 * Kategorię ustawił automat (reguła albo model), nie klient: formularz kosztu
 * pokazuje wtedy ramkę „Auto-kategoryzacja”. Poza zbiorem: `manual` (kategoria
 * domyślna albo wpis klienta) i `learned` (reguła firmy z jej poprawki albo
 * zgody w FLO), bez zmian od 05.2026.
 */
const AUTO_METHODS: ReadonlySet<string> = new Set<CategorizationMethod>([
  'rule_nip',
  'rule_keyword',
  'rule_global_nip',
  'rule_global_keyword',
  'ml_heuristic',
  'ai_claude',
]);

export function isAutoCategorized(method: string | null | undefined): boolean {
  return method != null && AUTO_METHODS.has(method);
}
