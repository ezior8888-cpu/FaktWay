import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.4, część 1: akcje „Pobierz archiwum” i link do pobrania. Tylko
 * właściciel i administrator, wpis w `audit_logs`, okres w pełnych miesiącach
 * do bieżącego, limit z bazy (wyzwalacz 00178) i jedno aktywne zlecenie na
 * okres zamienione na komunikat; link podpisany tylko do gotowej, niewygasłej
 * paczki tej firmy.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  insertResult: { data: { id: 'a1' } as Row | null, error: null as Row | null },
  order: null as Row | null,
  inserted: [] as Row[],
  deleted: [] as string[],
  send: vi.fn(),
  audit: vi.fn(),
  sign: vi.fn(),
  ActionAuthError: class ActionAuthError extends Error {},
}));

function session() {
  return {
    from(table: string) {
      expect(table).toBe('document_archives');
      const conds: Array<[string, unknown]> = [];
      const q = {
        insert: (row: Row) => {
          h.inserted.push(row);
          return { select: () => ({ single: async () => h.insertResult }) };
        },
        delete: () => ({
          eq: (_k: string, id: string) => ({ eq: () => ({ eq: async () => (h.deleted.push(id), { error: null }) }) }),
        }),
        select: () => q,
        eq: (k: string, v: unknown) => (conds.push([k, v]), q),
        maybeSingle: async () => ({ data: h.order && conds.every(([k, v]) => h.order![k] === v) ? h.order : null, error: null }),
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: h.ActionAuthError,
  requireOrgRole: async (roles: string[]) => {
    if (!roles.includes(h.role)) throw new h.ActionAuthError('Niewystarczające uprawnienia');
    return { supabase: session(), user: { id: 'u1' }, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: h.role };
  },
}));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: h.send }));
vi.mock('@/lib/audit/log', () => ({ logAudit: h.audit }));
vi.mock('@/lib/storage/r2', () => ({ getSignedInvoiceUrl: h.sign }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { getDocumentArchiveLinkAction, requestDocumentArchiveAction } from '@/app/actions/archiwum';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A1 = '0178cccc-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  h.role = 'owner';
  h.inserted = [];
  h.deleted = [];
  h.insertResult = { data: { id: A1 }, error: null };
  h.send.mockResolvedValue({ ids: ['job-1'] });
  h.sign.mockResolvedValue('https://magazyn.example.test/podpisany');
  h.order = {
    id: A1, tenant_id: T, status: 'completed', file_key: `exports/${T}/archiwum/${A1}/Archiwum.zip`,
    expires_at: '2026-11-16T12:00:00Z', kind: 'archive', period_start: '2026-01-01', period_end: '2026-03-31',
  };
});

describe('zlecenie archiwum', () => {
  it('członek firmy bez roli właściciela albo administratora: odmowa bez zapisu i bez zadania', async () => {
    h.role = 'member';
    const result = await requestDocumentArchiveAction({ kind: 'archive', from: '2026-01', to: '2026-03' });
    expect(result).toEqual({ success: false, error: 'Archiwum może zlecić właściciel albo administrator firmy.' });
    expect(h.inserted).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('właściciel: zlecenie na pełne miesiące, zadanie w tle i wpis w audit_logs', async () => {
    const result = await requestDocumentArchiveAction({ kind: 'audit', from: '2026-01', to: '2026-03' });
    expect(result).toEqual({ success: true, id: A1 });
    expect(h.inserted).toEqual([{ tenant_id: T, kind: 'audit', period_start: '2026-01-01', period_end: '2026-03-31' }]);
    expect(h.send).toHaveBeenCalledWith({ name: 'archive/document.requested', data: { archiveId: A1 } });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'document_archive.requested', tenantId: T, userId: 'u1', entityId: A1,
      metadata: { kind: 'audit', periodStart: '2026-01-01', periodEnd: '2026-03-31' },
    }));
  });

  it.each([
    ['miesiąc z przyszłości', { from: '2026-11', to: '2026-12' }],
    ['więcej niż 12 miesięcy', { from: '2025-01', to: '2026-01' }],
    ['koniec przed początkiem', { from: '2026-03', to: '2026-01' }],
    ['zły format', { from: '2026-1', to: '2026-03' }],
  ])('zły okres (%s): odmowa bez zapisu', async (_name, period) => {
    const result = await requestDocumentArchiveAction({ kind: 'archive', ...period });
    expect(result.success).toBe(false);
    expect(h.inserted).toEqual([]);
  });

  it('limit z bazy: komunikat wyzwalacza z godziną, bez zadania', async () => {
    h.insertResult = { data: null, error: { code: 'P0001', hint: 'document_archive_rate_limit', message: 'Kolejną paczkę można zlecić po 13:10.' } };
    const result = await requestDocumentArchiveAction({ kind: 'archive', from: '2026-01', to: '2026-03' });
    expect(result).toEqual({ success: false, error: 'Kolejną paczkę można zlecić po 13:10.' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('aktywne zlecenie na ten okres (indeks częściowy): komunikat zamiast drugiej paczki', async () => {
    h.insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "document_archives_one_active"' } };
    const result = await requestDocumentArchiveAction({ kind: 'archive', from: '2026-01', to: '2026-03' });
    expect(result).toEqual({ success: false, error: 'Paczka za ten okres jest już w przygotowaniu. Wyślemy e-mail, gdy będzie gotowa.' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('zadanie nie wyszło: zlecenie usunięte, żeby nie blokowało okresu', async () => {
    h.send.mockRejectedValueOnce(new Error('pg-boss down'));
    const result = await requestDocumentArchiveAction({ kind: 'archive', from: '2026-01', to: '2026-03' });
    expect(result.success).toBe(false);
    expect(h.deleted).toEqual([A1]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('link do pobrania paczki', () => {
  it('gotowa paczka: link podpisany na 5 minut i wpis w audit_logs', async () => {
    const result = await getDocumentArchiveLinkAction(A1);
    expect(result).toEqual({ success: true, url: 'https://magazyn.example.test/podpisany' });
    expect(h.sign).toHaveBeenCalledWith(`exports/${T}/archiwum/${A1}/Archiwum.zip`, T, 300);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'document_archive.downloaded', tenantId: T, entityId: A1 }));
  });

  it('wygasła paczka: odmowa z datą i wyjściem, bez linku', async () => {
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    const result = await getDocumentArchiveLinkAction(A1);
    expect(result).toEqual({ success: false, error: 'Link do tej paczki wygasł 16.11.2026. Zleć paczkę ponownie.' });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('członek firmy bez roli: odmowa bez linku', async () => {
    h.role = 'member';
    const result = await getDocumentArchiveLinkAction(A1);
    expect(result.success).toBe(false);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('paczka w przygotowaniu albo klucz spoza katalogu firmy: bez linku', async () => {
    h.order = { ...h.order!, status: 'generating', file_key: null };
    expect(await getDocumentArchiveLinkAction(A1)).toEqual({ success: false, error: 'Paczka nie jest jeszcze gotowa.' });
    h.order = { ...h.order!, status: 'completed', file_key: 'exports/inna-firma/archiwum/x.zip' };
    expect((await getDocumentArchiveLinkAction(A1)).success).toBe(false);
    expect(h.sign).not.toHaveBeenCalled();
  });
});
