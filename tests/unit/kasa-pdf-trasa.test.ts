import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * PDF dowodu kasowego (GET /api/kasa/[id]/pdf) i raportu kasowego
 * (GET /api/kasa/raport/pdf) dla członka aktywnej firmy, także księgowej
 * (wgląd). Firma ze zweryfikowanego członkostwa, odczyt klientem z sesji
 * (RLS 00194); dowód innej firmy to 404, zły okres to 400 z komunikatem.
 */

const TENANT = 'ten-1';
const DOWOD = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const OBCY = '7f2a0cae-9c5d-4b83-9f40-3e6d7c8b9a02';

const m = vi.hoisted(() => ({ ctx: vi.fn(), client: vi.fn(), sentry: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({ resolveApiUserAndActiveOrg: m.ctx }));
vi.mock('@/lib/supabase/server', () => ({ createClient: m.client }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.sentry }));

import { GET as getDocument } from '@/app/api/kasa/[id]/pdf/route';
import { GET as getReport } from '@/app/api/kasa/raport/pdf/route';

const strona = { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' };

function wiersz(extra: Row = {}): Row {
  return {
    id: DOWOD, tenant_id: TENANT, kind: 'KP', number: 'KP/3/2026', issue_date: '2026-11-11', operation_date: '2026-11-10',
    amount: 100, title: 'Wpłata', counterparty: { name: 'Jan Kowalski', nip: null, addressLine1: '', addressLine2: '' },
    issuer: strona, issued_by_name: 'Anna Nowak', issued_at: '2026-11-11T09:30:00.000Z', invoice_id: null,
    invoice_number: null, payment_id: null, related_document: null, corrects_id: null, corrects_number: null,
    correction_reason: null, ...extra,
  };
}

let db: MemoryDb;

function dokument(id: string) {
  return getDocument(new Request(`http://localhost/api/kasa/${id}/pdf`), { params: Promise.resolve({ id }) });
}

function raport(query: string) {
  return getReport(new Request(`http://localhost/api/kasa/raport/pdf${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
  db = memoryDb({
    cash_documents: [wiersz(), wiersz({ id: OBCY, tenant_id: 'ten-2' })],
    tenants: [{ id: TENANT, name: 'Moja Firma', nip: '1234567890', address_json: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } }],
  });
  m.ctx.mockResolvedValue({ ok: true, userId: 'u-1', tenantId: TENANT, role: 'accountant' });
  m.client.mockResolvedValue({ ...fakeSupabase(db), rpc: m.rpc });
  m.rpc.mockResolvedValue({
    data: {
      status: 'ok',
      register: { id: 'r-1', opening_date: '2026-10-01', opening_balance: 0 },
      from: '2026-11-01',
      to: '2026-11-11',
      balance_before: 0,
      documents: [{
        id: DOWOD, kind: 'KP', number: 'KP/3/2026', operation_date: '2026-11-10', issue_date: '2026-11-11', amount: 100,
        title: 'Wpłata', counterparty_name: 'Jan Kowalski', invoice_number: null, corrects_number: null,
        corrected_by_number: null, issued_at: '2026-11-11T09:30:00.000Z',
      }],
    },
    error: null,
  });
});

describe('GET /api/kasa/[id]/pdf', () => {
  it('dowód firmy (także dla księgowej): PDF z numerem w nazwie pliku, bez pamięci podręcznej', async () => {
    const res = await dokument(DOWOD);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="KP-3-2026.pdf"');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('dowód innej firmy: 404', async () => {
    expect((await dokument(OBCY)).status).toBe(404);
  });

  it('bez sesji: 401 bez odczytu bazy', async () => {
    m.ctx.mockResolvedValue({ ok: false, status: 401, error: 'not_authenticated' });
    expect((await dokument(DOWOD)).status).toBe(401);
    expect(m.client).not.toHaveBeenCalled();
  });

  it('identyfikator spoza wzoru: 404 bez odczytu bazy', async () => {
    expect((await dokument('nie-uuid')).status).toBe(404);
    expect(m.client).not.toHaveBeenCalled();
  });
});

describe('GET /api/kasa/raport/pdf', () => {
  it('okres z adresu: RPC cash_report z datami, PDF z okresem w nazwie pliku', async () => {
    const res = await raport('?od=2026-11-01&do=2026-11-11');
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('cash_report', { p_from: '2026-11-01', p_to: '2026-11-11' });
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="raport-kasowy-2026-11-01-2026-11-11.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('zły okres: 400 z komunikatem, bez RPC', async () => {
    const res = await raport('?od=2026-11-10&do=2026-11-01');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/późniejsza/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('kasa nieotwarta: 409 z drogą wyjścia', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'ok', register: null }, error: null });
    const res = await raport('?od=2026-11-01&do=2026-11-11');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/stan początkowy/);
  });

  it('nieznany kształt odpowiedzi: 500, bez pustego raportu', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'ok', register: { id: 'r-1' } }, error: null });
    expect((await raport('?od=2026-11-01&do=2026-11-11')).status).toBe(500);
  });

  it('bez sesji: 401', async () => {
    m.ctx.mockResolvedValue({ ok: false, status: 401, error: 'not_authenticated' });
    expect((await raport('?od=2026-11-01&do=2026-11-11')).status).toBe(401);
  });
});
