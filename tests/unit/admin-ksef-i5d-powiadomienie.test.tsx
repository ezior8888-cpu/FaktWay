import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR B, przegląd #1/#4: tabela „Czekają na decyzję klienta (I5D)”
 * w `/admin/ksef` pokazuje, czy klient dostał powiadomienie o tym numerze
 * KSeF oryginału (K). Automat wysyła je raz, a niedostarczonego nic nie
 * ponawia — operator musi zobaczyć „nie” bez otwierania każdej karty, żeby
 * użyć „Przypomnij klientowi”.
 *
 * Prawdziwe: strona `app/admin/ksef/page.tsx`, podział I5D i wiersze tabeli
 * (`lib/admin/ksef-lifecycle.ts`). Atrapy: `requireAdmin`, odczyt strażnika
 * i faktur `failed` (RPC), tabela `audit_logs` w pamięci.
 */

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  violations: [] as Array<Record<string, unknown>>,
  auditLogs: [] as Array<Record<string, unknown>>,
  failAuditRead: false,
  queries: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
}));

/** Klient serwisowy: tylko `audit_logs` w pamięci; każde `from()` zapisane w `m.queries`. */
function client() {
  return {
    from(table: string) {
      const query = { table, filters: [] as Array<[string, string, unknown]> };
      m.queries.push(query);
      const tests: Array<(r: Row) => boolean> = [];
      let max = Infinity;
      const execute = () => {
        if (table === 'audit_logs' && m.failAuditRead) return { data: null, error: { code: 'XX000', message: 'db down' } };
        const source = table === 'audit_logs' ? m.auditLogs : [];
        const rows = source.filter((r) => tests.every((t) => t(r))).slice(0, max);
        return { data: rows.map((r) => structuredClone(r)), error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { query.filters.push(['eq', k, v]); tests.push((r) => r[k] === v); return q; },
        in: (k: string, vs: unknown[]) => { query.filters.push(['in', k, vs]); tests.push((r) => vs.includes(r[k])); return q; },
        order: () => q,
        limit: (n: number) => { max = n; return q; },
        then: <A, B>(ok: (v: ReturnType<typeof execute>) => A, fail?: (e: unknown) => B) => Promise.resolve(execute()).then(ok, fail),
      };
      return q;
    },
  };
}

vi.mock('@/lib/auth/admin-guard', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin-1', email: 'admin@faktflow.test' })) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client() }));
vi.mock('@/lib/admin/ksef-lifecycle', async (orig) => ({
  ...await orig<typeof import('@/lib/admin/ksef-lifecycle')>(),
  listLifecycleViolations: vi.fn(async () => m.violations),
  listFailedInvoices: vi.fn(async () => ({ counts: [], rows: [] })),
}));

import AdminKsefPage from '@/app/admin/ksef/page';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_T = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const K_A = '1234567890-20261001-0100A0B0C0D0-1A';
const K_B = '1234567890-20261002-0200A0B0C0D0-2B';
const K_OLD = '1234567890-20260915-0300A0B0C0D0-3C';
const ACTION = 'invoice.ksef_duplicate_decision_notified';

const i5d = (invoiceId: string, number: string, k: string, env = 'test') => ({
  invariant: 'I5D', label: 'I5D', invoiceId, tenantId: T, tenantName: 'Firma Testowa', internalNumber: number,
  ksefStatus: 'failed',
  detail: { reason: 'no-own-file', env, original_ksef_number: k, attempted_at: '2026-10-07T08:00:00.000Z' },
});
const notice = (invoiceId: string, k: string, createdAt: string, extra: Row = {}): Row => ({
  tenant_id: T, action: ACTION, entity_type: 'invoice', entity_id: invoiceId, created_at: createdAt,
  metadata: { original_ksef_number: k, via: 'auto', emailed: true, push_sent: 0 },
  ...extra,
});
const when = (iso: string) =>
  new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function render(): Promise<string> {
  return renderToStaticMarkup(await AdminKsefPage({ searchParams: Promise.resolve({}) }));
}
/** Wiersz tabeli z danym numerem faktury (HTML od `<tr` do `</tr>`). */
function rowOf(html: string, number: string): string {
  const row = html.split('<tr').find((chunk) => chunk.includes(`>${number}<`));
  if (!row) throw new Error(`Brak wiersza ${number}`);
  return row.slice(0, row.indexOf('</tr>'));
}
const auditQueries = () => m.queries.filter((q) => q.table === 'audit_logs');

beforeEach(() => {
  m.violations = [i5d(A, 'FV/2026/10/A', K_A), i5d(B, 'FV/2026/10/B', K_B)];
  m.auditLogs = [];
  m.failAuditRead = false;
  m.queries = [];
});

describe('Tabela I5D: kolumna „Powiadomienie klienta” (przegląd PR B, #1/#4)', () => {
  it('liczy powiadomienia o bieżącym K jednym odczytem dla wszystkich wierszy; bez powiadomienia — „nie”', async () => {
    m.auditLogs = [
      notice(A, K_A, '2026-10-07T09:00:00.000Z'),
      notice(A, K_A, '2026-10-08T10:30:00.000Z', { metadata: { original_ksef_number: K_A, via: 'operator', reminder: 1 } }),
      // Ślad o innym K (wcześniejszy oryginał) i ślad cudzej firmy się nie liczą.
      notice(B, K_OLD, '2026-10-01T09:00:00.000Z'),
      notice(B, K_B, '2026-10-07T09:00:00.000Z', { tenant_id: OTHER_T }),
      // Inna akcja w audit_logs o tej samej fakturze.
      notice(B, K_B, '2026-10-07T09:00:00.000Z', { action: 'invoice.ksef_requeue' }),
    ];

    const html = await render();

    expect(html).toContain('Powiadomienie klienta');
    expect(rowOf(html, 'FV/2026/10/A')).toContain(`tak, 2 × · ostatnie ${when('2026-10-08T10:30:00.000Z')}`);
    expect(rowOf(html, 'FV/2026/10/B')).toContain('>nie<');
    expect(auditQueries()).toHaveLength(1);
    expect(auditQueries()[0]!.filters).toContainEqual(['in', 'entity_id', [A, B]]);
    expect(auditQueries()[0]!.filters).toContainEqual(['eq', 'action', ACTION]);
  });

  it('błąd odczytu śladu → „nie wiadomo” (nie „nie”), strona działa dalej', async () => {
    m.failAuditRead = true;

    const html = await render();

    expect(rowOf(html, 'FV/2026/10/A')).toContain('nie wiadomo');
    expect(rowOf(html, 'FV/2026/10/A')).not.toContain('>nie<');
    expect(rowOf(html, 'FV/2026/10/B')).toContain('nie wiadomo');
  });

  it('bez faktur I5D — bez odczytu audit_logs', async () => {
    m.violations = [];

    const html = await render();

    expect(html).toContain('Brak faktur czekających na decyzję klienta.');
    expect(auditQueries()).toEqual([]);
  });
});
