import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readTablePages, type SnapshotReadClient } from '@/lib/backup/db-snapshot';
import { SKIP_TABLES } from '@/lib/backup/snapshot-tables';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * Plan skalowania 3000, sesja 12 (QAL-01): nocna kopia czyta tabele stronami
 * po kluczu, przez prawdziwy PostgREST kluczem serwisowym, jak runner.
 *
 * Testy jednostkowe (`tests/unit/kopia-json-stronicowanie.test.ts`) idą przez
 * atrapę, która naśladuje zapis filtrów. Tu sprawdzamy, że PostgREST rozumie
 * go tak samo:
 *
 *   - klucz złożony: `tenant_id >= X` i `or=(tenant_id.gt."X",and(…))`
 *     z wartościami w cudzysłowach, także z przecinkiem, kropką, nawiasem,
 *     cudzysłowem, ukośnikiem wstecznym i znakiem nowej linii,
 *   - klucz pojedynczy: zwykły filtr `gt`, wartość dosłownie,
 *   - każda tabela `public` poza SKIP_TABLES czyta się swoim kluczem (nowa
 *     tabela bez `id` i bez wpisu w SNAPSHOT_KEYS wywala ten test, nie kopię).
 *
 * Dane: firma `ORG` z wierszami `flo_decisions` i wiersze `flo_rollout`
 * z przedrostkiem `PREFIX`, usuwane przed i po testach.
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);
const reader = admin as unknown as SnapshotReadClient;

const ORG = '5e512000-0000-4000-8000-000000000012';
const PREFIX = 'test.kopia_json.';

/** Wartości z każdym znakiem, który w `or=(…)` PostgREST coś znaczy. */
const TRUDNE = [
  'a,b',
  'a.b',
  'a:b',
  'nawias (1)',
  'or(a.eq.1,b.eq.2)',
  'cytat "w środku"',
  'ukośnik \\ wsteczny',
  'ukośnik na końcu \\',
  'nowa\nlinia',
  ' spacja z przodu',
  'zwykły',
  'Zwykły',
  'ąę',
];

async function cleanUp(): Promise<void> {
  await admin.from('flo_decisions').delete().eq('tenant_id', ORG);
  await admin.from('tenants').delete().eq('id', ORG);
  await admin.from('flo_rollout').delete().like('kind', `${PREFIX}%`);
}

describe.skipIf(!hasDatabase)('nocna kopia JSON: stronicowanie po kluczu przez PostgREST (QAL-01)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    if (!hasDatabase) return;
    await cleanUp();
    const { error: tenantError } = await admin
      .from('tenants')
      .insert({ id: ORG, nip: '9480000120', name: 'Firma Kopia JSON' });
    expect(tenantError).toBeNull();
    const { error: decisionsError } = await admin
      .from('flo_decisions')
      .insert(TRUDNE.map((kind) => ({ tenant_id: ORG, kind })));
    expect(decisionsError).toBeNull();
    const { error: rolloutError } = await admin
      .from('flo_rollout')
      .insert(TRUDNE.map((value) => ({ kind: `${PREFIX}${value}` })));
    expect(rolloutError).toBeNull();
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanUp();
  });

  it('klucz złożony (tenant_id, kind): każdy wiersz firmy dokładnie raz, strony po 2', async () => {
    const kinds: string[] = [];
    for await (const page of readTablePages(reader, 'flo_decisions', ['tenant_id', 'kind'], 2)) {
      expect(page.length).toBeLessThanOrEqual(2);
      for (const row of page) if (row.tenant_id === ORG) kinds.push(String(row.kind));
    }
    expect(kinds).toHaveLength(TRUDNE.length);
    expect([...kinds].sort()).toEqual([...TRUDNE].sort());
  });

  it('klucz pojedynczy (kind): każdy wiersz dokładnie raz, strony po 3', async () => {
    const kinds: string[] = [];
    for await (const page of readTablePages(reader, 'flo_rollout', ['kind'], 3)) {
      expect(page.length).toBeLessThanOrEqual(3);
      for (const row of page) {
        const kind = String(row.kind);
        if (kind.startsWith(PREFIX)) kinds.push(kind.slice(PREFIX.length));
      }
    }
    expect(kinds).toHaveLength(TRUDNE.length);
    expect([...kinds].sort()).toEqual([...TRUDNE].sort());
  });

  it('każda tabela public poza SKIP_TABLES czyta się swoim kluczem i daje tyle wierszy, ile ma', async () => {
    const { data, error } = await admin.rpc('list_public_tables');
    expect(error).toBeNull();
    const tables = ((data ?? []) as Array<{ table_name: string }>)
      .map((row) => row.table_name)
      .filter((table) => !SKIP_TABLES.has(table))
      .sort();
    expect(tables.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const table of tables) {
      try {
        let read = 0;
        for await (const page of readTablePages(reader, table)) read += page.length;
        const { count, error: countError } = await admin
          .from(table)
          .select('*', { count: 'exact', head: true });
        if (countError) problems.push(`${table}: count: ${countError.message}`);
        else if (count !== read) problems.push(`${table}: odczyt ${read}, w tabeli ${count}`);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : `${table}: ${String(err)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
