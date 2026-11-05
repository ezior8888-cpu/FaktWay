import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  asHistoryClient,
  COUNT_TENANTS_PER_QUERY,
  KSEF_HISTORY_COUNT_GROUPS_PER_TENANT,
  loadStreamsForTenants,
  readCounts,
  STREAM_TENANTS_PER_QUERY,
} from '@/lib/ksef/history-sync/db';
import { POSTGREST_MAX_ROWS } from '@/lib/pagination/keyset';

import { historyClient, historyDb, itemRow, streamRow } from './helpers/historia-ksef-baza';

/**
 * Sesja 27 planu skalowania: cron historii KSeF czyta strumienie i liczniki
 * tylko dla bieżącej strony firm, paczkami `in.(…)`. Widok liczników nie ma
 * kolumny `id`, więc zamiast stron po kluczu odpowiedź jednej paczki musi się
 * zmieścić poniżej limitu PostgREST — rozmiar paczki wynika z CHECK
 * `ksef_history_items_status_reason` (00155). Ten test czyta CHECK z migracji:
 * nowy powód albo status bez przeliczenia paczki = czerwony test, a nie po
 * cichu ucięte liczniki.
 */

const MIGRATIONS = 'supabase/migrations';
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

/** Grupy (status, powód) na jeden kierunek według CHECK z migracji. */
function groupsPerDirection(sql: string): number {
  const start = sql.indexOf('CONSTRAINT ksef_history_items_status_reason CHECK');
  expect(start).toBeGreaterThan(-1);
  const check = sql.slice(start, sql.indexOf(', false))', start));
  const parts = check.split(/(?=status = ')/).slice(1);
  expect(parts.map((p) => /^status = '(\w+)'/.exec(p)![1]).sort()).toEqual(['blocked', 'deferred', 'imported', 'pending', 'skipped']);
  return parts.reduce((sum, part) => {
    const list = /reason_code IN \(([^)]*)\)/.exec(part)![1]!;
    const reasons = list.match(/'[a-z_]+'/g)!.length;
    return sum + reasons + (part.includes('reason_code IS NULL') ? 1 : 0);
  }, 0);
}

describe('paczka liczników a CHECK z migracji', () => {
  it('46 grup na firmę (2 kierunki × 23) i 21 firm na zapytanie — poniżej limitu 1000', () => {
    const owners = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')
      && readFileSync(`${MIGRATIONS}/${f}`, 'utf8').includes('ksef_history_items_status_reason'));
    // Zmiana CHECK w nowej migracji = przelicz KSEF_HISTORY_COUNT_GROUPS_PER_TENANT.
    expect(owners).toEqual(['00155_ksef_history_sync.sql']);
    const perDirection = groupsPerDirection(readFileSync(`${MIGRATIONS}/${owners[0]}`, 'utf8'));
    expect(perDirection).toBe(23);
    expect(KSEF_HISTORY_COUNT_GROUPS_PER_TENANT).toBe(2 * perDirection);
    expect(COUNT_TENANTS_PER_QUERY * KSEF_HISTORY_COUNT_GROUPS_PER_TENANT).toBeLessThan(POSTGREST_MAX_ROWS);
    expect(COUNT_TENANTS_PER_QUERY).toBe(21);
  });
});

describe('readCounts — paczki firm', () => {
  it('50 firm: 3 zapytania (21 + 21 + 8), każde z `tenant_id=in.(…)`, wynik kompletny', async () => {
    const tenants = Array.from({ length: 50 }, (_, i) => id(i + 1));
    const db = historyDb({ ksef_history_items: tenants.map((t, i) => itemRow({ tenant_id: t, ksef_number: `K-${i}` })) }, { maxRows: 1000 });
    const rows = await readCounts(asHistoryClient(historyClient(db)), 'test', ['pending'], tenants);
    expect(new Set(rows.map((r) => r.tenant_id)).size).toBe(50);
    const queries = db.log.filter((e) => e.table === 'ksef_history_item_counts');
    expect(queries.map((e) => e.filters.find((f) => f.startsWith('tenant_id=in.('))!.split(',').length)).toEqual([21, 21, 8]);
  });

  it('odpowiedź równa limitowi (więcej grup, niż dopuszcza CHECK) — wyjątek zamiast zaniżonych liczników', async () => {
    const tenants = Array.from({ length: COUNT_TENANTS_PER_QUERY }, (_, i) => id(i + 1));
    // 48 różnych powodów na firmę — poza CHECK, ale atrapa je zliczy jak baza.
    const items = tenants.flatMap((t, ti) => Array.from({ length: 48 }, (_, r) =>
      itemRow({ tenant_id: t, status: 'blocked', reason_code: `powod_${r}`, ksef_number: `K-${ti}-${r}` })));
    const db = historyDb({ ksef_history_items: items }, { maxRows: 1000 });
    await expect(readCounts(asHistoryClient(historyClient(db)), 'test', ['blocked'], tenants))
      .rejects.toThrow(/liczniki dziennika: 1000 grup dla 21 firm/);
  });
});

describe('loadStreamsForTenants — paczki firm', () => {
  it('250 firm: paczki po 100, oba kierunki, bez odczytu całego środowiska', async () => {
    const tenants = Array.from({ length: 250 }, (_, i) => id(i + 1));
    const streams = tenants.flatMap((t) => [streamRow({ tenant_id: t }), streamRow({ tenant_id: t, direction: 'incoming', live_hwm: null })]);
    // Strumień innej firmy w tym samym środowisku — nie wraca.
    streams.push(streamRow({ tenant_id: id(999) }));
    const db = historyDb({ ksef_history_sync: streams }, { maxRows: 1000 });
    const rows = await loadStreamsForTenants(asHistoryClient(historyClient(db)), 'test', tenants);
    expect(rows).toHaveLength(500);
    expect(rows.some((r) => r.tenant_id === id(999))).toBe(false);
    const sizes = db.log.map((e) => e.filters.find((f) => f.startsWith('tenant_id=in.('))!.split(',').length);
    expect(sizes).toEqual([STREAM_TENANTS_PER_QUERY, STREAM_TENANTS_PER_QUERY, 50]);
  });

  it('więcej niż 2 strumienie na firmę (schemat się zmienił) — wyjątek', async () => {
    const db = historyDb({ ksef_history_sync: [1, 2, 3].map(() => streamRow({ tenant_id: id(1) })) });
    await expect(loadStreamsForTenants(asHistoryClient(historyClient(db)), 'test', [id(1)]))
      .rejects.toThrow(/odczyt strumieni: 3 wierszy dla 1 firm/);
  });
});
