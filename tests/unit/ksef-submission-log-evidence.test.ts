import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));

import { findOpenKsefSubmission } from '@/lib/ksef/submission-log';

/**
 * C-12: uzgodnienie po referencji bierze skrót XML z tego samego wpisu `sent`,
 * co numery referencyjne — to z nim runner porównuje plik w magazynie
 * (`xml-dowod-runner.test.ts`). Część testów ze szkicu #190.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);

type Submission = {
  tenant_id: string;
  invoice_id: string;
  status: string;
  session_reference_number: string | null;
  invoice_reference_number: string | null;
  request_payload_hash: string | null;
  attempted_at: string;
};
const SENT: Submission = {
  tenant_id: TENANT,
  invoice_id: INVOICE,
  status: 'sent',
  session_reference_number: 'S-ORIGINAL',
  invoice_reference_number: 'I-ORIGINAL',
  request_payload_hash: HASH,
  attempted_at: '2026-10-01T10:00:00Z',
};
let rows: Submission[];
let selected: string[];
let queryFilters: Array<[string, unknown]>;

function database() {
  return {
    from() {
      const filters: Array<[keyof Submission, unknown]> = [];
      const q = {
        select: (fields: string) => {
          selected.push(fields);
          return q;
        },
        eq: (key: keyof Submission, value: unknown) => {
          filters.push([key, value]);
          queryFilters.push([key, value]);
          return q;
        },
        not: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          const found = rows
            .filter((row) => filters.every(([key, value]) => row[key] === value))
            .sort((a, b) => b.attempted_at.localeCompare(a.attempted_at));
          return { data: found[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
}

beforeEach(() => {
  rows = [{ ...SENT }];
  selected = [];
  queryFilters = [];
  mocks.admin.mockReturnValue(database());
});

describe('ksef_submissions: skrót tej samej próby co numery referencyjne', () => {
  it('uzgodnienie zwraca skrót z ostatniego otwartego wpisu tej firmy i faktury', async () => {
    rows = [
      { ...SENT, request_payload_hash: 'b'.repeat(64), attempted_at: '2026-09-30T10:00:00Z' },
      { ...SENT, tenant_id: 'other', request_payload_hash: 'c'.repeat(64), attempted_at: '2026-10-03T10:00:00Z' },
      { ...SENT, invoice_id: 'other', request_payload_hash: 'd'.repeat(64), attempted_at: '2026-10-04T10:00:00Z' },
      { ...SENT },
    ];

    await expect(findOpenKsefSubmission(TENANT, INVOICE)).resolves.toMatchObject({
      sessionReferenceNumber: 'S-ORIGINAL',
      invoiceReferenceNumber: 'I-ORIGINAL',
      payloadHash: HASH,
    });
    expect(selected[0]).toContain('request_payload_hash');
    expect(queryFilters).toContainEqual(['tenant_id', TENANT]);
    expect(queryFilters).toContainEqual(['invoice_id', INVOICE]);
  });

  it('wpis bez skrótu zwraca referencje, ale skrótu nie wymyśla', async () => {
    rows = [{ ...SENT, request_payload_hash: null }];
    await expect(findOpenKsefSubmission(TENANT, INVOICE)).resolves.toMatchObject({
      invoiceReferenceNumber: 'I-ORIGINAL',
      payloadHash: null,
    });
  });

  it('brak otwartej próby oznacza brak wyniku', async () => {
    rows = [{ ...SENT, status: 'accepted' }];
    await expect(findOpenKsefSubmission(TENANT, INVOICE)).resolves.toBeNull();
  });
});
