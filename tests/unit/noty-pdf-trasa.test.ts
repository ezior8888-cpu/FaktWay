import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * GET /api/noty/[id]/pdf (krok 2.9, część 1): PDF wystawionej noty dla
 * członka aktywnej firmy. Firma ze zweryfikowanego członkostwa, odczyt
 * klientem z sesji (RLS 00193); szkic nie ma PDF, nota innej firmy to 404.
 */

const TENANT = 'ten-1';
const NOTA = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const SZKIC = '6e1f9b9d-8b4c-4a72-8e3f-2d5c6b7a8f91';
const OBCA = '7f2a0cae-9c5d-4b83-9f40-3e6d7c8b9a02';

const m = vi.hoisted(() => ({ ctx: vi.fn(), client: vi.fn(), sentry: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: m.ctx }));
vi.mock('@/lib/supabase/server', () => ({ createClient: m.client }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.sentry }));

import { GET } from '@/app/api/noty/[id]/pdf/route';

const strona = { name: 'Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };

function nota(extra: Row = {}): Row {
  return {
    id: NOTA, tenant_id: TENANT, kind: 'debit', status: 'issued', number: 'NO/3/2026', issue_date: '2026-11-11',
    title: 'Kara umowna', items: [{ description: 'Kara', amount: 100 }], total: 100, currency: 'PLN',
    contractor_id: null, counterparty: strona, issuer: strona, related_document: null, due_date: null,
    bank_account: null, issued_at: '2026-11-11T09:30:00.000Z', created_at: '2026-11-11T09:00:00.000Z', ...extra,
  };
}

let db: MemoryDb;

function get(id: string) {
  return GET(new Request(`http://localhost/api/noty/${id}/pdf`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = memoryDb({
    accounting_notes: [
      nota(),
      nota({ id: SZKIC, status: 'draft', number: null, issuer: null, issued_at: null }),
      nota({ id: OBCA, tenant_id: 'ten-2' }),
    ],
  });
  m.ctx.mockResolvedValue({ ok: true, userId: 'u-1', tenantId: TENANT, role: 'member' });
  m.client.mockResolvedValue(fakeSupabase(db));
});

describe('GET /api/noty/[id]/pdf', () => {
  it('wystawiona nota firmy: PDF z numerem w nazwie pliku, bez pamięci podręcznej', async () => {
    const res = await get(NOTA);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="nota-NO-3-2026.pdf"');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('szkic: 409 z komunikatem, bez PDF', async () => {
    const res = await get(SZKIC);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/wystaw/i);
  });

  it('nota innej firmy: 404', async () => {
    expect((await get(OBCA)).status).toBe(404);
  });

  it('bez sesji: 401 bez odczytu bazy', async () => {
    m.ctx.mockResolvedValue({ ok: false, status: 401, error: 'not_authenticated' });
    expect((await get(NOTA)).status).toBe(401);
    expect(m.client).not.toHaveBeenCalled();
  });

  it('identyfikator spoza wzoru: 404 bez odczytu bazy', async () => {
    expect((await get('nie-uuid')).status).toBe(404);
    expect(m.client).not.toHaveBeenCalled();
  });
});
