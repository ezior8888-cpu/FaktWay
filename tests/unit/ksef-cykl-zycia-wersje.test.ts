import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Strażnik wersji `ksef_lifecycle_violations()` (00155, decyzja Bartosza
 * 22.10.2026; punkt 3 krytyki). Funkcja jest przepisywana w całości przy
 * każdej zmianie (`CREATE OR REPLACE`) — kolejna wersja skopiowana ze
 * starszego pliku zgubiłaby po cichu:
 *   - I3 przez predykat `ksef_upo_expected(i)` (historia z KSeF nie ma UPO),
 *   - I5D (00148: faktura czeka na decyzję klienta przy 440).
 * Dlatego każda redefinicja po 00148 musi zawierać oba. PR C (00156, dawniej
 * rezerwacja 00149) bierze ciało z 00155 — pilnuje tego też przypadek „15.” w
 * tests/unit/zapis-oryginalu-migracja.test.ts (rejestr: docs/koordynacja/CLAUDE-DO-CODEXA.md).
 */

const DIR = join(process.cwd(), 'supabase/migrations');
const BEFORE_PREDICATE = new Set(['00131', '00136', '00148']);
const REDEFINES = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ksef_lifecycle_violations\s*\(/i;

const redefinitions = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, version: f.slice(0, 5), sql: readFileSync(join(DIR, f), 'utf8') }))
  .filter((m) => REDEFINES.test(m.sql.replace(/--[^\n]*/g, '')));

describe('ksef_lifecycle_violations — każda wersja po 00148', () => {
  it('znane wersje sprzed predykatu i 00155 są na liście (sanity)', () => {
    const versions = redefinitions.map((m) => m.version);
    for (const v of BEFORE_PREDICATE) expect(versions).toContain(v);
    expect(versions).toContain('00155');
  });

  it.each(redefinitions.filter((m) => !BEFORE_PREDICATE.has(m.version)).map((m) => [m.file, m.sql] as const))(
    '%s woła ksef_upo_expected(i) w I3 i zachowuje I5D',
    (_file, sql) => {
      expect(sql).toContain('public.ksef_upo_expected(i)');
      expect(sql).toContain("'I5D'");
    },
  );

  it('00155: I3 wymaga UPO tylko przez predykat; reszta ciała jak w 00148', () => {
    const body = (version: string) => {
      const sql = redefinitions.find((m) => m.version === version)!.sql;
      const start = sql.search(REDEFINES);
      return sql.slice(start, sql.indexOf('$$;', start));
    };
    const normalized = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    const before = normalized(body('00148'));
    const after = normalized(body('00155'));
    const oldI3 = 'OR NOT EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id) );';
    const newI3 = 'OR (public.ksef_upo_expected(i) AND NOT EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id)) );';
    expect(before).toContain(oldI3);
    expect(after).toBe(before.replace(oldI3, newI3));
  });

  it('00155: bez DROP, DELETE, TRUNCATE i zmian danych', () => {
    const sql = readFileSync(join(DIR, '00155_ksef_history_sync.sql'), 'utf8')
      .replace(/--[^\n]*/g, '')
      .replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
  });
});
