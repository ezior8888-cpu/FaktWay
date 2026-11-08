/**
 * Atrapy klienta w pamięci, które zwracają całe wiersze, nie znają aliasów ze ścieżką
 * JSON w `select` (`alias:kolumna->klucz->>pole`, np. `fa3_paid_date:fa3_data->parsed->>paidDate`
 * z `lib/dashboard/inflows.ts`). Ta funkcja dopisuje do wiersza wartość spod takiej ścieżki
 * (brak wartości = `null`, jak PostgREST), żeby test importu z FA(3) widział `fa3_paid_date`.
 * Pełna atrapa z rzutowaniem kolumn: `tests/helpers/fake-postgrest.ts`.
 */
export function withJsonAliases(columns: string, row: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const part of columns.split(',').map((p) => p.trim())) {
    const match = /^(\w+):(\w+)((?:->>?\w+)+)$/.exec(part);
    if (!match) continue;
    let value: unknown = row[match[2]!];
    for (const key of match[3]!.split(/->>?/).filter(Boolean)) {
      value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
    }
    extra[match[1]!] = value ?? null;
  }
  return Object.keys(extra).length > 0 ? { ...row, ...extra } : row;
}
