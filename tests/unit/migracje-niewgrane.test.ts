import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { headerOf, missingMigrations, whenToApply } from '@/scripts/ci/migracje-niewgrane.mjs';

/**
 * Blokada wdrożenia z `obrazy.yml` (plan usprawnień 3.1): migracja z repo bez
 * wpisu w `schema_migrations` zatrzymuje wdrożenie, chyba że nagłówek każe
 * wgrać ją PO wdrożeniu.
 */

const PRZED = '-- 00170: nowa tabela\n-- KIEDY WGRAĆ: PRZED wdrożeniem.\nCREATE TABLE x (id int);\n';
const PO = '-- 00171: odbiera uprawnienie\n-- KIEDY WGRAĆ: PO wdrożeniu (stary kod jeszcze pisze).\nREVOKE ALL ON x FROM anon;\n';
const BEZ = '-- 00172: coś\nCREATE TABLE y (id int);\n';

describe('migracje-niewgrane', () => {
  it('czyta tylko nagłówek, nie komentarze w środku pliku', () => {
    const sql = '-- nagłówek\nCREATE TABLE x (id int);\n-- PO wdrożeniu (to nie nagłówek)\n';
    expect(headerOf(sql)).toBe('-- nagłówek');
    expect(whenToApply(sql)).toBe('przed');
  });

  it.each([
    [PRZED, 'przed'],
    [PO, 'po'],
    [BEZ, 'przed'],
    ['-- PRZED wdrożeniem albo bez wdrożenia\nSELECT 1;\n', 'przed'],
    ['-- PO wdrożeniu, nie przed wdrożeniem\nSELECT 1;\n', 'przed'],
    ['-- dane po wdrożeniu webu\nSELECT 1;\n', 'przed'],
  ])('kolejność z nagłówka %#', (sql, expected) => {
    expect(whenToApply(sql)).toBe(expected);
  });

  it('dzieli niewgrane na „przed” (blokada) i „po” (lista na koniec)', () => {
    const files = [
      { file: '00169_stara.sql', sql: PRZED },
      { file: '00170_x.sql', sql: PRZED },
      { file: '00171_y.sql', sql: PO },
      { file: '00172_z.sql', sql: BEZ },
      { file: 'README.md', sql: '' },
    ];
    expect(missingMigrations(files, ['00169'])).toEqual({
      before: ['00170_x.sql', '00172_z.sql'],
      after: ['00171_y.sql'],
    });
  });

  it('migracje z repo: „PO wdrożeniu” mają tylko te, które tak mówią w nagłówku', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir)
      .filter((f) => /^\d{5}_.+\.sql$/.test(f))
      .map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') }));
    const { after } = missingMigrations(files, []);
    // Nowa migracja „PO wdrożeniu” dopisuje się tutaj świadomie.
    expect(after).toEqual(['00128_ksef_expense_full_update_guard.sql', '00132_ksef_lifecycle_guard_tighten.sql']);
    expect(missingMigrations(files, files.map(({ file }) => file.slice(0, 5)))).toEqual({ before: [], after: [] });
  });

  describe('CLI', () => {
    const run = (state: unknown) => {
      const dir = mkdtempSync(join(tmpdir(), 'migracje-'));
      writeFileSync(join(dir, '00170_x.sql'), PRZED);
      writeFileSync(join(dir, '00171_y.sql'), PO);
      const statePath = join(dir, 'stan.json');
      writeFileSync(statePath, JSON.stringify(state));
      try {
        const stdout = execFileSync('node', ['scripts/ci/migracje-niewgrane.mjs', dir, statePath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out: stdout };
      } catch (error) {
        const e = error as { status: number; stdout: string; stderr: string };
        return { code: e.status, out: `${e.stdout}${e.stderr}` };
      }
    };

    it('niewgrana „przed” zatrzymuje wdrożenie', () => {
      const result = run({ migrations: ['00169'] });
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/Niewgrana migracja „przed wdrożeniem”: 00170_x\.sql/);
    });

    it('tylko „po” przepuszcza i wypisuje, co wgrać po wdrożeniu', () => {
      const result = run({ migrations: ['00170'] });
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/Wgraj PO tym wdrożeniu: 00171_y\.sql/);
    });

    it('pusta lista z bazy to brak odczytu, nie zgoda', () => {
      expect(run({ migrations: [] }).code).toBe(1);
      expect(run({ error: 'database' }).code).toBe(1);
    });
  });
});
