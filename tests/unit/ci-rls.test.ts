import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AUD-109: test izolacji firm (`tests/rls-isolation.test.ts`) nie był
 * uruchamiany w żadnym workflow — regresja RLS przeszłaby niezauważona.
 * CI ma osobny job z lokalnym Supabase i migracjami z repo.
 */

const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
  .replace(/\r\n/g, '\n');
const script = readFileSync(join(process.cwd(), 'scripts/ci/rls-local.sh'), 'utf8');

describe('CI: izolacja RLS', () => {
  it('workflow CI ma job RLS uruchamiający skrypt lokalnego Supabase', () => {
    expect(ci).toMatch(/^ {2}rls:\n/m);
    expect(ci).toContain('scripts/ci/rls-local.sh');
    expect(ci).toMatch(/supabase\/setup-cli@[0-9a-f]{40}/);
  });

  it('skrypt: schemat pg-boss przed migracjami, potem test:rls tylko na lokalnej bazie', () => {
    expect(script.indexOf("schema: 'pgboss'")).toBeLessThan(script.indexOf('supabase migration up --local'));
    expect(script).toContain('RLS_TEST_ALLOW_DESTRUCTIVE="isolated-local-database"');
    // test:rls po migracjach; po nim już tylko kontrola typów bazy (plan usprawnień 2.7).
    expect(script).toMatch(/^pnpm test:rls$/m);
    expect(script.indexOf('pnpm test:rls')).toBeGreaterThan(script.indexOf('supabase migration up --local'));
    expect(script.trim().endsWith('node scripts/ci/typy-bazy-zgodne.mjs "$GEN_TYPES" types/database.ts')).toBe(true);
  });
});
