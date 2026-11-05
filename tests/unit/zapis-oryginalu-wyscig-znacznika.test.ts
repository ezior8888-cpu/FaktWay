import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordKsefDuplicateCheck } from '@/lib/ksef/submission-log';

/**
 * D-A4-1b-3 PR C, rozstrzygnięcia commitu 3, fix 5 (INV-25, INV-26):
 * `release_ksef_original_review` i `flag_ksef_original_recheck` (SQL, pod blokadą
 * wiersza) dopisują `importGate.release` albo `recheckNeeded` do znacznika
 * `original_check` MIĘDZY odczytem a zapisem `recordKsefDuplicateCheck`.
 * Zapis runnera musi je zachować (ponowny odczyt i scalenie), a nie nadpisać
 * starszym obrazem. Baza w pamięci liczy filtry po ścieżkach JSON (`->`, `->>`)
 * jak PostgREST, więc warunek zapisu naprawdę działa — wspólna atrapa
 * `ksef-pelna-sciezka` traktuje takie `.is()` jako zawsze prawdziwe.
 */
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Wywoływane raz, po pierwszym odczycie znacznika — „równoległy” zapis SQL. */
  race: null as null | ((row: Record<string, unknown>) => void),
}));

vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient: memory } = await import('./helpers/baza-w-pamieci');
  return {
    createAdminClient: () => {
      const client = memory(m.tables);
      return {
        from: (table: string) => {
          const q = client.from(table) as unknown as {
            update: (...a: unknown[]) => unknown;
            then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise<unknown>;
          };
          let isRead = true;
          const origUpdate = q.update;
          q.update = (...a: unknown[]) => { isRead = false; return origUpdate.apply(q, a); };
          const origThen = q.then;
          q.then = (ok, fail) => origThen.call(q, (v: unknown) => {
            if (table === 'ksef_submissions' && isRead && m.race) {
              const race = m.race;
              m.race = null;
              race(m.tables.ksef_submissions![0]!);
            }
            return ok(v);
          }, fail);
          return q;
        },
      };
    },
  };
});

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const K = '5260001246-20260928-0100A0B0C0D0-1A';
const SHA = 'ab'.repeat(32);
const RELEASE = { at: '2026-10-05T12:00:00.000Z', via: 'operator', actorUserId: '99999999-9999-4999-8999-999999999999', note: 'Plik sprawdzony z klientem.' };
const RECHECK = { kind: 'gate-drift', at: '2026-10-06T08:00:00.000Z' };
const GATE = { v: 1, rules: 1, kind: 'review', problems: ['currency'], preview: null };
const base = {
  v: 1, env: 'test', checkedAt: '2026-10-05T08:00:00.000Z', reason: 'faktflow-original', sha256: SHA,
  archivePath: `${T}/ksef-import/${K}.xml`, sizeBytes: 2048, summary: null, sameContentExceptHeader: false,
  ownHistory: false, acquiredAt: null, httpStatus: null, knownInvoice: null, recheck: null,
};
const failedFetch = {
  v: 1, env: 'test', checkedAt: '2026-10-07T08:00:00.000Z', reason: 'download-pending', sha256: null, archivePath: null,
  sizeBytes: null, summary: null, sameContentExceptHeader: null, ownHistory: null, acquiredAt: null, httpStatus: 503,
  knownInvoice: null, recheck: null,
} as const;
const sameVerdict = { ...base, checkedAt: '2026-10-07T08:00:00.000Z', importGate: GATE } as const;

const seed = (check: Record<string, unknown>) => {
  m.tables = { ksef_submissions: [{ id: 'row-1', tenant_id: T, invoice_id: ID, status: 'sent', original_ksef_number: K,
    attempted_at: '2026-10-01T10:00:00.000Z', original_check: structuredClone(check) }] };
};
const marker = () => m.tables.ksef_submissions![0]!.original_check as Record<string, unknown>;
const record = async (check: unknown) => {
  await recordKsefDuplicateCheck({ tenantId: T, invoiceId: ID, originalKsefNumber: K, check: check as never });
};
const sqlDopisujeOddanie = (row: Record<string, unknown>) => {
  const c = structuredClone(row.original_check) as Record<string, Record<string, unknown>>;
  c.importGate!.release = RELEASE;
  row.original_check = c;
};

beforeEach(() => { m.race = null; });

describe('recordKsefDuplicateCheck: zapis nie gubi równoległego zapisu SQL (PR C fix 5)', () => {
  it('oddanie zapisane między odczytem a zapisem, nieudane pobranie: oddanie zostaje', async () => {
    seed({ ...base, importGate: GATE });
    m.race = sqlDopisujeOddanie;
    await record(failedFetch);
    expect((marker().importGate as Record<string, unknown>).release).toEqual(RELEASE);
    expect(marker().recheck).toMatchObject({ httpStatus: 503 });
  });

  it('oddanie zapisane w trakcie, nowy werdykt tego samego pliku z tą samą oceną review: oddanie przechodzi', async () => {
    seed({ ...base, importGate: GATE });
    m.race = sqlDopisujeOddanie;
    await record(sameVerdict);
    expect((marker().importGate as Record<string, unknown>).release).toEqual(RELEASE);
    expect(marker().checkedAt).toBe('2026-10-07T08:00:00.000Z');
  });

  it('recheckNeeded zapisany w trakcie, nieudane pobranie: recheckNeeded zostaje', async () => {
    seed({ ...base, importGate: GATE });
    m.race = (row) => { row.original_check = { ...structuredClone(row.original_check) as Record<string, unknown>, recheckNeeded: RECHECK }; };
    await record(failedFetch);
    expect(marker().recheckNeeded).toEqual(RECHECK);
  });

  it('bez wyścigu: zapis jak dotąd (kontrola)', async () => {
    seed({ ...base, importGate: GATE });
    await record(failedFetch);
    expect(marker().recheck).toMatchObject({ httpStatus: 503 });
    expect(marker()).not.toHaveProperty('recheckNeeded');
  });
});
