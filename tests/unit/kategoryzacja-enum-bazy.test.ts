import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATEGORIZATION_METHODS } from '@/lib/categorization/rule-engine';

/**
 * Ustalenie 738u1 (obchód M9, 14.11.2026): klasyfikator zwracał
 * `rule_global_nip` i `rule_global_keyword`, których enum
 * `categorization_method` z 00034 nie znał, więc koszt dopasowany regułą
 * globalną nie zapisywał się. Typecheck tego nie łapie (klient serwisowy jest
 * bez typów bazy), a test na bazie (tests/rls-kategoryzacja-reguly-globalne)
 * biegnie tylko w jobie CI „RLS isolation”. Ten test czyta enum z migracji:
 * CREATE TYPE z 00034 plus każde ALTER TYPE ... ADD VALUE.
 */

const DIR = join(process.cwd(), 'supabase/migrations');

function enumFromMigrations(): Set<string> {
  const values = new Set<string>();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(DIR, file), 'utf8').replace(/--[^\n]*/g, '');
    const created = /CREATE\s+TYPE\s+(?:public\.)?categorization_method\s+AS\s+ENUM\s*\(([^)]*)\)/i.exec(sql);
    for (const v of created?.[1].matchAll(/'([^']+)'/g) ?? []) values.add(v[1]);
    const added = /ALTER\s+TYPE\s+(?:public\.)?categorization_method\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;
    for (const v of sql.matchAll(added)) values.add(v[1]);
  }
  return values;
}

describe('categorization_method: kod a enum w bazie', () => {
  it('każda wartość, którą może zwrócić klasyfikator, jest w enum z migracji', () => {
    const inDatabase = enumFromMigrations();
    expect(inDatabase.size).toBeGreaterThanOrEqual(6);
    expect(CATEGORIZATION_METHODS.filter((m) => !inDatabase.has(m))).toEqual([]);
  });
});
