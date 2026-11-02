import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getActiveOrgIdFromCookies: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/active-org', () => ({
  getActiveOrgIdFromCookies: mocks.getActiveOrgIdFromCookies,
}));
vi.mock('@/components/invoices/correction-form', () => ({
  CorrectionInvoiceForm: ({ parentInvoices, tenantId }: { parentInvoices: Array<{ internal_number: string }>; tenantId: string }) =>
    `firma:${tenantId} ${parentInvoices.map((invoice) => invoice.internal_number).join(',')}`,
}));

import NewCorrectionPage from '@/app/(dashboard)/invoices/new/correction/page';

const rows = [
  { id: '1', tenant_id: 'tenant-a', internal_number: 'PROD-A', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'regular', ksef_environment: 'production', ksef_number: 'prod-1', issue_date: '2026-09-01' },
  { id: '2', tenant_id: 'tenant-a', internal_number: 'TEST-A', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'regular', ksef_environment: 'test', ksef_number: 'test-2', issue_date: '2026-09-01' },
  { id: '3', tenant_id: 'tenant-a', internal_number: 'LEGACY-A', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'regular', ksef_environment: null, ksef_number: 'legacy-3', issue_date: '2026-09-01' },
  { id: '4', tenant_id: 'tenant-b', internal_number: 'PROD-B', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'regular', ksef_environment: 'production', ksef_number: 'prod-4', issue_date: '2026-09-01' },
  { id: '5', tenant_id: 'tenant-a', internal_number: 'NO-NUMBER', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'regular', ksef_environment: 'production', ksef_number: null, issue_date: '2026-09-01' },
  // K4: rodzic z otwartą korektą znika z listy; z odrzuconą — zostaje.
  { id: '6', tenant_id: 'tenant-a', internal_number: 'PROD-OPEN-KOR', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'regular', ksef_environment: 'production', ksef_number: 'prod-6', issue_date: '2026-09-02' },
  { id: '7', tenant_id: 'tenant-a', internal_number: 'PROD-REJECTED-KOR', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'regular', ksef_environment: 'production', ksef_number: 'prod-7', issue_date: '2026-09-03' },
  { id: '60', tenant_id: 'tenant-a', internal_number: 'KOR-6', direction: 'outgoing', ksef_status: 'failed', invoice_kind: 'correction', ksef_environment: 'production', ksef_number: null, issue_date: '2026-09-05', parent_invoice_id: '6' },
  { id: '70', tenant_id: 'tenant-a', internal_number: 'KOR-7', direction: 'outgoing', ksef_status: 'rejected', invoice_kind: 'correction', ksef_environment: 'production', ksef_number: null, issue_date: '2026-09-05', parent_invoice_id: '7' },
];
let reads: number;
const from = vi.fn(() => {
  reads++;
  const filters: Array<(row: typeof rows[number]) => boolean> = [];
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => {
      filters.push((row) => row[key as keyof typeof row] === value);
      return chain;
    },
    not: (key: string, operator: string, value: unknown) => {
      if (operator !== 'is' || value !== null) throw new Error('Unexpected PostgREST filter');
      filters.push((row) => row[key as keyof typeof row] !== null);
      return chain;
    },
    order: () => chain,
    limit: async () => ({ data: rows.filter((row) => filters.every((filter) => filter(row))) }),
  };
  return chain;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'production');
  reads = 0;
  mocks.getActiveOrgIdFromCookies.mockResolvedValue('tenant-a');
  mocks.createClient.mockResolvedValue({ from });
});
afterEach(() => vi.unstubAllEnvs());

it('lists only current-tenant accepted parents with PROD provenance and KSeF number', async () => {
  const html = renderToStaticMarkup(await NewCorrectionPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('PROD-A');
  expect(html).not.toMatch(/TEST-A|LEGACY-A|PROD-B|NO-NUMBER/);
  // UX-01: firma listy idzie do formularza — zapis korekty sprawdzi, że to wciąż aktywna firma.
  expect(html).toContain('firma:tenant-a ');
  // Dwa odczyty: rodzice + korekty firmy (K4 — rodzic z otwartą korektą nie jest kandydatem).
  expect(reads).toBe(2);
});

it('K4: parent with an open correction is not offered again; a rejected correction does not block', async () => {
  const html = renderToStaticMarkup(await NewCorrectionPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('PROD-REJECTED-KOR');
  expect(html).not.toContain('PROD-OPEN-KOR');
  expect(html).not.toMatch(/KOR-6|KOR-7/);
});

it('does not read invoices without an active organization', async () => {
  mocks.getActiveOrgIdFromCookies.mockResolvedValue(null);
  const html = renderToStaticMarkup(await NewCorrectionPage({ searchParams: Promise.resolve({}) }));
  expect(html).not.toContain('PROD-A');
  expect(reads).toBe(0);
});

it('rejects an unset environment before listing invoices', async () => {
  vi.stubEnv('KSEF_ENV', '');
  await expect(NewCorrectionPage({ searchParams: Promise.resolve({}) }))
    .rejects.toThrow('not safely configured');
  expect(reads).toBe(0);
});
