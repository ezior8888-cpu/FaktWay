import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Sesja 21 planu skalowania (DB-02, DB-V02): cron uzgadniania co 15 minut
 * czytał pełne `ksef_lifecycle_violations()`, choć używa tylko I1 i I5.
 * Najdroższy blok to I3 (wszystkie przyjęte faktury wychodzące, predykat
 * UPO wiersz po wierszu). 00186 dodaje `ksef_lifecycle_violations_without_i3()`:
 * to samo ciało bez bloku I3, nic poza tym. Strażnik pilnuje, żeby obie
 * funkcje się nie rozjechały: zmiana pełnej bez lekkiej (albo odwrotnie)
 * psuje ten test. Wynik na bazie sprawdza tests/rls-indeksy-cronow-produkty.test.ts.
 *
 * Tu też statycznie: `ksef_upo_expected` po 00186 da się wkleić w zapytanie
 * (SQL, bez SET, bez SECURITY DEFINER, bez podzapytania w ciele). Planista
 * nie wkleja funkcji z `SET search_path` ani z podzapytaniem, więc I3
 * i upo-retry-stale liczyły ją osobno dla każdej przyjętej faktury.
 */

const DIR = join(process.cwd(), 'supabase/migrations');
const FULL = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ksef_lifecycle_violations\s*\(/i;
const LIGHT = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ksef_lifecycle_violations_without_i3\s*\(/i;
const PREDICATE = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ksef_upo_expected\s*\(/i;
const MIGRATION = '00186_cron_indexes_products_unique.sql';

const stripComments = (sql: string) => sql.replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
const migrations = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: stripComments(readFileSync(join(DIR, file), 'utf8')) }));

/** Najnowsza definicja: od `CREATE OR REPLACE` do końca ciała `$$;`. */
function latestDefinition(pattern: RegExp): { file: string; definition: string } {
  const last = migrations.filter((m) => pattern.test(m.sql)).at(-1);
  if (!last) throw new Error(`brak definicji ${pattern}`);
  const start = last.sql.search(pattern);
  return { file: last.file, definition: last.sql.slice(start, last.sql.indexOf('$$;', start) + 3) };
}

const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();

function parts(definition: string) {
  const open = definition.indexOf('$$');
  const header = normalized(definition.slice(0, open));
  const body = definition.slice(open + 2, definition.lastIndexOf('$$'));
  const blocks = body.split(/RETURN\s+QUERY/i).map(normalized);
  return { header, blocks };
}

describe('ksef_lifecycle_violations_without_i3 = pełna funkcja bez I3', () => {
  const full = parts(latestDefinition(FULL).definition);
  const light = parts(latestDefinition(LIGHT).definition);

  it('pełna funkcja ma dokładnie jeden blok I3 (sanity)', () => {
    expect(full.blocks.filter((b) => b.startsWith("SELECT 'I3'::text"))).toHaveLength(1);
  });

  it('nagłówek ten sam (zwracane kolumny, STABLE, SECURITY DEFINER, pusta ścieżka)', () => {
    expect(light.header).toBe(full.header.replace('public.ksef_lifecycle_violations()', 'public.ksef_lifecycle_violations_without_i3()'));
  });

  it('bloki znak w znak jak w pełnej, w tej samej kolejności, bez I3 (I3K zostaje)', () => {
    expect(light.blocks).toEqual(full.blocks.filter((b) => !b.startsWith("SELECT 'I3'::text")));
    expect(light.blocks.some((b) => b.startsWith("SELECT 'I3K'::text"))).toBe(true);
  });

  it('tylko service_role woła lekką funkcję', () => {
    const { file } = latestDefinition(LIGHT);
    const sql = migrations.find((m) => m.file === file)!.sql;
    expect(normalized(sql)).toContain('REVOKE ALL ON FUNCTION public.ksef_lifecycle_violations_without_i3() FROM PUBLIC, anon, authenticated;');
    expect(normalized(sql)).toContain('GRANT EXECUTE ON FUNCTION public.ksef_lifecycle_violations_without_i3() TO service_role;');
  });
});

describe('ksef_upo_expected po 00186: da się wkleić w zapytanie', () => {
  const { file, definition } = latestDefinition(PREDICATE);
  const header = normalized(definition.slice(0, definition.indexOf('$$')));
  const body = normalized(definition.slice(definition.indexOf('$$') + 2, definition.lastIndexOf('$$')));

  it('najnowsza definicja jest w 00186', () => {
    expect(file).toBe(MIGRATION);
  });

  it('SQL, STABLE, SECURITY INVOKER, bez SET', () => {
    expect(header).toMatch(/LANGUAGE sql/i);
    expect(header).toMatch(/\bSTABLE\b/i);
    expect(header).toMatch(/SECURITY INVOKER/i);
    expect(header).not.toMatch(/\bSET\b/i);
  });

  it('ciało to jedno wyrażenie bez podzapytania, nazwy z prefiksem schematu', () => {
    expect(body).toMatch(/^SELECT /);
    const expression = body.slice('SELECT '.length).replace(/IS\s+(NOT\s+)?DISTINCT\s+FROM/gi, '');
    expect(expression).not.toMatch(/\b(SELECT|EXISTS|FROM)\b/i);
    expect(body).toContain('public.ksef_upo_expected_submission(');
  });
});

describe(`${MIGRATION}: bezpieczna do wgrania jedną transakcją`, () => {
  const raw = readFileSync(join(DIR, MIGRATION), 'utf8').replace(/\r\n/g, '\n');
  const code = stripComments(raw);
  const outsideBodies = code.replace(/\$\$[\s\S]*?\$\$/g, '');

  it('własna transakcja i limit czekania na blokadę', () => {
    expect(code).toMatch(/^BEGIN;$/m);
    expect(code).toMatch(/^COMMIT;$/m);
    expect(code).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('bez CONCURRENTLY (wgraj-migracje.sh puszcza plik w jednej transakcji)', () => {
    expect(code).not.toMatch(/CONCURRENTLY/i);
  });

  it('bez DROP, DELETE, TRUNCATE i zmian danych', () => {
    expect(outsideBodies).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
  });

  it('nazwy nowych indeksów nie są zajęte we wcześniejszych migracjach (IF NOT EXISTS pominąłby indeks po cichu)', () => {
    const created = [...code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]!);
    expect(created).toHaveLength(9);
    const earlier = migrations.filter((m) => m.file < MIGRATION);
    const taken = created.filter((name) => earlier.some((m) => new RegExp(`\\bINDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b`, 'i').test(m.sql)));
    expect(taken).toEqual([]);
  });

  it('nagłówek ma zapytanie liczące duble produktów i sposób ich rozwiązania', () => {
    const header = raw.slice(0, raw.indexOf('BEGIN;'));
    expect(header).toMatch(/WGRANIE: przed wdrożeniem, poza godzinami pracy/);
    expect(header).toMatch(/GROUP BY tenant_id/);
    expect(header).toMatch(/HAVING count\(\*\) > 1/);
  });
});
