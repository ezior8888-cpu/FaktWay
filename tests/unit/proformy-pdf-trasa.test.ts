import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * GET /api/proformy/[id]/pdf (krok 2.4): PDF wystawionej proformy albo oferty
 * dla członka aktywnej firmy. Firma ze zweryfikowanego członkostwa, odczyt
 * klientem z sesji (RLS 00198); szkic nie ma PDF, dokument innej firmy to 404.
 */

const TENANT = 'ten-1';
const DOKUMENT = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const SZKIC = '6e1f9b9d-8b4c-4a72-8e3f-2d5c6b7a8f91';
const OBCY = '7f2a0cae-9c5d-4b83-9f40-3e6d7c8b9a02';

const m = vi.hoisted(() => ({ ctx: vi.fn(), client: vi.fn(), sentry: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: m.ctx }));
vi.mock('@/lib/supabase/server', () => ({ createClient: m.client }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.sentry }));

import { GET } from '@/app/api/proformy/[id]/pdf/route';

const strona = { name: 'Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };

function dokument(extra: Row = {}): Row {
  return {
    id: DOKUMENT, tenant_id: TENANT, kind: 'offer', status: 'issued', number: 'OF/3/2026', issue_date: '2026-11-11',
    valid_until: '2026-12-11',
    items: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23', netAmount: 100, vatAmount: 23, grossAmount: 123 }],
    net_total: 100, vat_total: 23, gross_total: 123, currency: 'PLN', contractor_id: null, counterparty: strona, issuer: strona,
    payment_method: null, payment_due_date: null, bank_account: null, notes: null,
    issued_at: '2026-11-11T09:30:00.000Z', created_at: '2026-11-11T09:00:00.000Z', ...extra,
  };
}

let db: MemoryDb;

function get(id: string) {
  return GET(new Request(`http://localhost/api/proformy/${id}/pdf`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = memoryDb({
    sales_quotes: [
      dokument(),
      dokument({ id: SZKIC, status: 'draft', number: null, issuer: null, issued_at: null }),
      dokument({ id: OBCY, tenant_id: 'ten-2' }),
    ],
  });
  m.ctx.mockResolvedValue({ ok: true, userId: 'u-1', tenantId: TENANT, role: 'member' });
  m.client.mockResolvedValue(fakeSupabase(db));
});

describe('GET /api/proformy/[id]/pdf', () => {
  it('wystawiony dokument firmy: PDF z rodzajem i numerem w nazwie pliku, bez pamięci podręcznej', async () => {
    const res = await get(DOKUMENT);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="oferta-OF-3-2026.pdf"');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('szkic: 409 z komunikatem, bez PDF', async () => {
    const res = await get(SZKIC);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/wystaw/i);
  });

  it('dokument innej firmy: 404', async () => {
    expect((await get(OBCY)).status).toBe(404);
  });

  it('bez sesji: 401 bez odczytu bazy', async () => {
    m.ctx.mockResolvedValue({ ok: false, status: 401, error: 'not_authenticated' });
    expect((await get(DOKUMENT)).status).toBe(401);
    expect(m.client).not.toHaveBeenCalled();
  });

  it('identyfikator spoza wzoru: 404 bez odczytu bazy', async () => {
    expect((await get('nie-uuid')).status).toBe(404);
    expect(m.client).not.toHaveBeenCalled();
  });
});
