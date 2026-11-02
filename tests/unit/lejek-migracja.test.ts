import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Strażnik tekstu migracji 00161 (pełna weryfikacja na bazie:
 * tests/rls-lejek-analityka.test.ts w jobie RLS). AGENTS.md: nagłówek mówi,
 * kiedy wgrać i jaki UPDATE dotyka istniejących wierszy, bez DROP i TRUNCATE.
 */

const FILE = 'supabase/migrations/00161_analytics_consent_funnel.sql';
const sql = readFileSync(FILE, 'utf8');
const header = sql.split('\n').filter((line) => line.startsWith('--')).join('\n');
const outsideBodies = sql.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, '');

describe('migracja 00161', () => {
  it('nagłówek: kolejność przed wdrożeniem, opis UPDATE i zapytanie liczące dotknięte wiersze', () => {
    expect(header).toMatch(/PRZED wdrożeniem/);
    expect(header).toMatch(/UPDATE/);
    expect(header).toMatch(/SELECT count\(/);
  });

  it('bez operacji niszczących, a jedyny UPDATE danych to uzupełnienie daty pierwszej faktury', () => {
    expect(outsideBodies).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
    const updates = [...outsideBodies.matchAll(/\bUPDATE\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(updates).toEqual(['tenants']);
    expect(outsideBodies).toMatch(/first_invoice_accepted_at IS NULL/);
    // Tylko faktury wystawione w FaktWay: bez historii z KSeF i bez importu z pliku.
    expect(outsideBodies).toMatch(/i\.origin = 'app'/);
  });

  it('funkcje serwisowe tylko dla service_role, zapis zgody tylko dla zalogowanego', () => {
    for (const fn of ['admin_funnel_weekly(integer, text)', 'analytics_tenant_owner(uuid)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
    }
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_analytics_consent(text, timestamptz) FROM PUBLIC, anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_analytics_consent(text, timestamptz) TO authenticated;');
  });

  it('klient nie czyta ani nie pisze nowych kolumn users wprost: uprawnienia kolumnowe jak w 00112', () => {
    expect(sql).toContain('REVOKE SELECT, UPDATE ON public.users FROM anon, authenticated;');
    expect(sql).toMatch(/column_name NOT IN \('analytics_consent', 'analytics_consent_at', 'signup_source'\)/);
  });

  it('każda kolumna users dodana po 00161 dostaje jawne uprawnienia (inaczej klient jej nie przeczyta)', () => {
    const dir = 'supabase/migrations';
    const later = readdirSync(dir).filter((f) => /^\d{5}_/.test(f) && f > '00161_analytics_consent_funnel.sql' && f < '00200');
    for (const file of later) {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      const added = [...text.matchAll(/ALTER TABLE (?:public\.)?users[^;]*?ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
      for (const column of added) {
        expect(text, `${file}: kolumna ${column}`).toMatch(new RegExp(`GRANT [^;]*\\b${column}\\b[^;]*ON (?:public\\.)?users TO authenticated`, 'i'));
      }
    }
  });

  it('rejestr numerów migracji ma wiersz 00161', () => {
    const registry = readFileSync('docs/koordynacja/CLAUDE-DO-CODEXA.md', 'utf8');
    expect(registry).toMatch(/\| 00161 \|[^\n]*analytics_consent_funnel/);
  });

  it('test na bazie jest w konfiguracji jobu RLS', () => {
    expect(readFileSync('vitest.rls.config.ts', 'utf8')).toContain('tests/rls-lejek-analityka.test.ts');
  });
});
