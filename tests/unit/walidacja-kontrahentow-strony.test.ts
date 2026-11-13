import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * „Sprawdź wszystkich kontrahentów” (walidacja zbiorcza) przy ponad 1000
 * kontrahentach — sesja 29 planu skalowania, część 2.
 *
 * Akcja czytała listę kontrahentów z NIP-em jednym zapytaniem. Produkcja
 * ucina każdą odpowiedź PostgREST do 1000 wierszy bez błędu
 * (`PGRST_DB_MAX_ROWS`), więc biuro rachunkowe z 1500 kontrahentami
 * dostawało „sprawdzono 1000”, a reszty nikt nie sprawdzał. Do tego błąd
 * zapytania był pomijany i kończył się komunikatem „Brak kontrahentów”.
 */

const s = vi.hoisted(() => ({
  contractors: [] as Array<{ id: string; tenant_id: string; nip: string | null }>,
  failOnSelect: null as number | null,
  selects: 0,
  sendJob: vi.fn(async () => ({ ids: ['job-1'] })),
}));

const MAX_ROWS = 1000;
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('@/lib/validation/cache', () => ({ validateNipCached: vi.fn(), validateMultipleNips: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: s.sendJob }));
vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireUserAndActiveOrg: async () => ({
    user: { id: 'u1' },
    tenantId: T,
    role: 'owner',
    supabase: {
      from(table: string) {
        if (table !== 'contractors') throw new Error(`atrapa zna tylko contractors, nie ${table}`);
        const preds: Array<(row: (typeof s.contractors)[number]) => boolean> = [];
        let ordered = false;
        let limit: number | null = null;
        const q = {
          select: () => q,
          eq(column: 'tenant_id', value: string) {
            preds.push((row) => row[column] === value);
            return q;
          },
          not(column: 'nip', operator: 'is', value: null) {
            if (operator !== 'is' || value !== null) throw new Error('atrapa zna tylko not(…, is, null)');
            preds.push((row) => row[column] !== null);
            return q;
          },
          gt(column: 'id', value: string) {
            preds.push((row) => row[column] > value);
            return q;
          },
          order(column: string) {
            if (column !== 'id') throw new Error(`atrapa sortuje tylko po id, nie ${column}`);
            ordered = true;
            return q;
          },
          limit(count: number) {
            limit = count;
            return q;
          },
          then(ok: (value: unknown) => unknown, fail?: (error: unknown) => unknown) {
            s.selects += 1;
            if (s.failOnSelect === s.selects) {
              return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(ok, fail);
            }
            let hits = s.contractors.filter((row) => preds.every((pred) => pred(row)));
            if (ordered) hits = [...hits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            if (limit !== null) hits = hits.slice(0, limit);
            return Promise.resolve({ data: hits.slice(0, MAX_ROWS).map((row) => ({ ...row })), error: null }).then(ok, fail);
          },
        };
        return q;
      },
    },
  }),
}));

import { bulkValidateContractorsAction } from '@/app/actions/validation';

/** uuid małymi literami; kolejność wstawiania inna niż kolejność `id`, jak sterta w Postgresie. */
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const heapOrder = (count: number) => Array.from({ length: count }, (_, i) => ((i * 7919) % count) + 1);

function contractors(count: number, patch: { nip?: string | null; tenant_id?: string } = {}) {
  return heapOrder(count).map((n) => ({ id: uuid(n), tenant_id: T, nip: `5260${String(n).padStart(6, '0')}`, ...patch }));
}

beforeEach(() => {
  s.contractors = [];
  s.failOnSelect = null;
  s.selects = 0;
  s.sendJob.mockClear();
});

describe('walidacja zbiorcza ponad 1000 kontrahentów', () => {
  it('1500 kontrahentów z NIP-em: job dostaje wszystkich 1500', async () => {
    const withNip = contractors(1500);
    const noNip = contractors(40).map((row) => ({ ...row, id: uuid(5000 + Number.parseInt(row.id.slice(0, 8), 16)), nip: null }));
    const otherFirm = contractors(30).map((row) => ({ ...row, id: uuid(9000 + Number.parseInt(row.id.slice(0, 8), 16)), tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    s.contractors = [...otherFirm, ...withNip, ...noNip];

    const out = await bulkValidateContractorsAction();

    expect(out).toEqual({ success: true, jobId: 'job-1', total: 1500 });
    expect(s.sendJob).toHaveBeenCalledTimes(1);
    const event = (s.sendJob.mock.calls[0] as unknown as [{ data: { contractorIds: string[]; tenantId: string } }])[0];
    expect(event.data.tenantId).toBe(T);
    expect(new Set(event.data.contractorIds)).toEqual(new Set(withNip.map((row) => row.id)));
    expect(event.data.contractorIds).toHaveLength(1500);
  });

  it.each([1, 2])('błąd odczytu na stronie %i: jasny komunikat, bez joba i bez „Brak kontrahentów”', async (page) => {
    s.contractors = contractors(1500);
    s.failOnSelect = page;

    const out = await bulkValidateContractorsAction();

    expect(out.success).toBe(false);
    expect(!out.success && out.error).toMatch(/Nie udało się odczytać listy kontrahentów/);
    expect(s.sendJob).not.toHaveBeenCalled();
  });

  it('bez kontrahentów z NIP-em: „Brak kontrahentów do walidacji”, bez joba', async () => {
    s.contractors = contractors(3, { nip: null });

    await expect(bulkValidateContractorsAction()).resolves.toEqual({ success: false, error: 'Brak kontrahentów do walidacji' });
    expect(s.sendJob).not.toHaveBeenCalled();
  });
});
