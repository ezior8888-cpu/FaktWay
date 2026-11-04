import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P3 (PLAN-FINORA §5): „Pobierz PDF zaznaczonych” — tryb `?ids=` paczki PDF.
 * Endpoint czyta faktury klientem admina (omija RLS), więc granica firmy jest
 * w zapytaniu: `tenant_id` + `id IN (...)`. Obca faktura w zaznaczeniu daje
 * 404 bez wskazania, która, i bez wygenerowania czegokolwiek.
 */

type Row = { id: string; tenant_id: string; direction: string; internal_number: string };

const s = vi.hoisted(() => ({
  tenant: 'ten-a',
  rows: [] as Row[],
  calls: [] as Array<[string, unknown[]]>,
  pdf: vi.fn(),
  zip: vi.fn(),
  quota: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({
  resolveApiUserAndActiveOrg: async () => ({ ok: true, userId: 'u-1', tenantId: s.tenant, role: 'owner' }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: s.quota }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: s.pdf }));
vi.mock('@/lib/exports/zip-packager', () => ({ packageZip: s.zip }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      s.calls.push(['from', [table]]);
      const preds: Array<(r: Row) => boolean> = [];
      const q = {
        select: (...a: unknown[]) => { s.calls.push(['select', a]); return q; },
        eq: (k: keyof Row, v: string) => { s.calls.push(['eq', [k, v]]); preds.push((r) => r[k] === v); return q; },
        gte: (...a: unknown[]) => { s.calls.push(['gte', a]); return q; },
        lte: (...a: unknown[]) => { s.calls.push(['lte', a]); return q; },
        in: (k: keyof Row, v: string[]) => { s.calls.push(['in', [k, v]]); preds.push((r) => v.includes(r[k])); return q; },
        limit: async (n: number) => {
          s.calls.push(['limit', [n]]);
          return { data: s.rows.filter((r) => preds.every((p) => p(r))).slice(0, n), error: null };
        },
      };
      return q;
    },
  }),
}));

import { GET } from '@/app/api/invoices/batch-pdf/route';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const B1 = '33333333-3333-4333-8333-333333333333';
const IN1 = '44444444-4444-4444-8444-444444444444';

const req = (qs: string) => new Request(`https://app.example.test/api/invoices/batch-pdf?${qs}`);
const called = (m: string) => s.calls.filter(([n]) => n === m).map(([, a]) => a);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

beforeEach(() => {
  s.tenant = 'ten-a';
  s.calls.length = 0;
  s.rows = [
    { id: A1, tenant_id: 'ten-a', direction: 'outgoing', internal_number: 'FV/1' },
    { id: A2, tenant_id: 'ten-a', direction: 'outgoing', internal_number: 'FV/2' },
    { id: B1, tenant_id: 'ten-b', direction: 'outgoing', internal_number: 'FV/OBCA' },
    { id: IN1, tenant_id: 'ten-a', direction: 'incoming', internal_number: 'ZAKUP/1' },
  ];
  s.pdf.mockReset().mockImplementation(async (id: string) => ({ success: true, pdf: Buffer.from(`%PDF ${id}`), filename: `${id}.pdf` }));
  s.zip.mockReset().mockResolvedValue(Buffer.from('zip'));
  s.quota.mockReset().mockResolvedValue({ allowed: true, remaining: 2, retryAfter: 0 });
});

describe('paczka PDF zaznaczonych faktur (?ids=)', () => {
  it('własne faktury: ZIP z PDF każdej, w kolejności zaznaczenia', async () => {
    const res = await GET(req(`ids=${A2},${A1}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(s.pdf.mock.calls).toEqual([[A2, 'ten-a'], [A1, 'ten-a']]);
    expect(s.zip.mock.calls[0]![0].map((f: { filename: string }) => f.filename)).toEqual([`${A2}.pdf`, `${A1}.pdf`]);
  });

  it('zapytanie zawężone do firmy, kierunku i zaznaczonych id', async () => {
    await GET(req(`ids=${A1},${A2}`));
    expect(called('eq')).toEqual(expect.arrayContaining([['tenant_id', 'ten-a'], ['direction', 'outgoing']]));
    expect(called('in')).toEqual([['id', [A1, A2]]]);
    expect(called('gte')).toEqual([]);
  });

  it('obca faktura w zaznaczeniu → 404 not_found, nic nie generujemy', async () => {
    const res = await GET(req(`ids=${A1},${B1}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(s.pdf).not.toHaveBeenCalled();
    expect(s.zip).not.toHaveBeenCalled();
  });

  it('sama obca faktura → 404, PDF obcej firmy nie powstaje', async () => {
    const res = await GET(req(`ids=${B1}`));
    expect(res.status).toBe(404);
    expect(s.pdf).not.toHaveBeenCalledWith(B1, expect.anything());
  });

  it('faktura zakupowa w zaznaczeniu → 404 (ten sam warunek kierunku co tryb miesiąca)', async () => {
    const res = await GET(req(`ids=${A1},${IN1}`));
    expect(res.status).toBe(404);
    expect(s.pdf).not.toHaveBeenCalled();
  });

  it('powtórzone id liczone raz; wielkie litery normalizowane', async () => {
    const res = await GET(req(`ids=${A1},${A1.toUpperCase()},${A2}`));
    expect(res.status).toBe(200);
    expect(called('in')).toEqual([['id', [A1, A2]]]);
    expect(s.pdf).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['zły format uuid', 'ids=nie-uuid'],
    ['uuid z doklejonym filtrem', `ids=${A1})or(tenant_id.neq.x`],
    ['puste ids', 'ids='],
    ['same przecinki', 'ids=,,'],
  ])('%s → 400 invalid_ids, bez zapytania do bazy', async (_label, qs) => {
    const res = await GET(req(qs));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_ids' });
    expect(called('from')).toEqual([]);
    expect(s.pdf).not.toHaveBeenCalled();
  });

  it('więcej niż 100 id → 400 invalid_ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => uuid(i + 1)).join(',');
    const res = await GET(req(`ids=${ids}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_ids' });
    expect(called('from')).toEqual([]);
  });

  it('dokładnie 100 id przechodzi walidację', async () => {
    s.rows = Array.from({ length: 100 }, (_, i) => ({ id: uuid(i + 1), tenant_id: 'ten-a', direction: 'outgoing', internal_number: `FV/${i}` }));
    const res = await GET(req(`ids=${s.rows.map((r) => r.id).join(',')}`));
    expect(res.status).toBe(200);
    expect(s.pdf).toHaveBeenCalledTimes(100);
  });

  it('oba tryby naraz → 400', async () => {
    const res = await GET(req(`ids=${A1}&from=2026-09-01&to=2026-09-30`));
    expect(res.status).toBe(400);
    expect(called('from')).toEqual([]);
  });

  it('bez żadnego trybu → 400 invalid_range (jak dotąd)', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_range' });
  });

  it('tryb zaznaczonych podlega temu samemu limitowi paczek firmy', async () => {
    s.quota.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 120 });
    const res = await GET(req(`ids=${A1}`));
    expect(res.status).toBe(429);
    expect(s.quota).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'batch_pdf', identifier: 'ten-a' }));
    expect(s.pdf).not.toHaveBeenCalled();
  });

  it('tryb miesiąca działa bez zmian', async () => {
    const res = await GET(req('from=2026-09-01&to=2026-09-30'));
    expect(res.status).toBe(200);
    expect(called('gte')).toEqual([['issue_date', '2026-09-01']]);
    expect(called('lte')).toEqual([['issue_date', '2026-09-30']]);
    expect(called('in')).toEqual([]);
  });
});
