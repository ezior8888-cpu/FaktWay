import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Krok 6.4, część 1: zadanie `archive.document.requested` na prawdziwym
 * runnerze. Worker pg-boss ponawia CAŁY handler (bez pamięci kroków), więc
 * idempotencja stoi w bazie i u dostawcy: plik pod stałym kluczem zlecenia
 * z zapisem warunkowym, gotowość tylko ze stanu `generating`, powiadomienie
 * ze znacznikiem `notified_at` i kluczem idempotencji Resend.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  order: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  build: vi.fn(),
  upload: vi.fn(),
  stat: vi.fn(),
  email: vi.fn(),
}));

/** Atrapa `document_archives`: UPDATE z warunkami eq/in/is, jak PostgREST. */
function admin() {
  return {
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'wlasciciel@example.test' } }, error: null }) } },
    from(table: string) {
      expect(table).toBe('document_archives');
      let patch: Row | null = null;
      const conds: Array<(r: Row) => boolean> = [];
      const q = {
        select: () => q,
        update: (p: Row) => ((patch = p), q),
        eq: (k: string, v: unknown) => (conds.push((r) => r[k] === v), q),
        in: (k: string, v: unknown[]) => (conds.push((r) => v.includes(r[k])), q),
        is: (k: string, v: unknown) => (conds.push((r) => (r[k] ?? null) === v), q),
        maybeSingle: async () => {
          const row = h.order;
          if (!row || !conds.every((c) => c(row))) return { data: null, error: null };
          if (patch) {
            Object.assign(row, patch);
            h.updates.push(patch);
          }
          return { data: { ...row }, error: null };
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: admin }));
vi.mock('@/lib/archiwum/paczka', async (orig) => ({ ...(await orig<object>()), buildArchivePackage: h.build }));
vi.mock('@/lib/storage/r2', () => ({ uploadToR2IfAbsent: h.upload, statR2Object: h.stat }));
vi.mock('@/lib/email/send', () => ({ sendEmail: h.email }));

import { onDocumentArchiveExhausted, runDocumentArchive } from '@/lib/jobs/runners/document-archive';
import { ArchiveTooLargeError } from '@/lib/archiwum/paczka';

const T = '0178aaaa-0000-4000-8000-000000000001';
const ID = '0178bbbb-0000-4000-8000-000000000001';
const KEY = `exports/${T}/archiwum/${ID}/Archiwum_1234567890_2026-03-01_2026-03-31.zip`;
const ctx = { step: { run: (_n: string, fn: () => unknown) => fn() }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, attempt: 0 } as unknown as JobContext;

beforeEach(() => {
  vi.clearAllMocks();
  h.updates = [];
  h.order = {
    id: ID, tenant_id: T, kind: 'archive', period_start: '2026-03-01', period_end: '2026-03-31', status: 'pending',
    requested_by: 'user-1', file_key: null, notified_at: null, expires_at: null,
  };
  h.build.mockResolvedValue({ fileName: 'Archiwum_1234567890_2026-03-01_2026-03-31.zip', zip: Buffer.from('ZIP'), filesCount: 6, missing: [] });
  h.upload.mockResolvedValue(true);
  h.email.mockResolvedValue({ sent: true });
});

describe('zadanie archiwum: ponowienie od zera', () => {
  it('pierwsze wykonanie: plik pod kluczem zlecenia, gotowość z wygaśnięciem, jeden e-mail z kluczem', async () => {
    await runDocumentArchive({ archiveId: ID }, ctx);

    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.upload).toHaveBeenCalledWith(KEY, Buffer.from('ZIP'), 'application/zip', { 'files-count': '6', 'missing-count': '0' });
    expect(h.order).toMatchObject({ status: 'completed', file_key: KEY, size_bytes: 3, files_count: 6, missing_count: 0 });
    const done = h.order!;
    expect(new Date(String(done.expires_at)).getTime() - new Date(String(done.finished_at)).getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(h.email).toHaveBeenCalledTimes(1);
    expect(h.email.mock.calls[0]![0]).toMatchObject({ to: 'wlasciciel@example.test', idempotencyKey: `document-archive/${ID}/ready` });
    expect(String(h.email.mock.calls[0]![0].html)).not.toMatch(/[—–]/);
    expect(done.notified_at).toEqual(expect.any(String));
  });

  it('ponowienie po zapisie pliku, a przed gotowością: bez drugiego pliku, liczby z zapisanego obiektu', async () => {
    // Pierwsza próba zapisała plik i padła przed UPDATE: wiersz został w „generating”.
    h.order!.status = 'generating';
    h.upload.mockResolvedValue(false);
    h.stat.mockResolvedValue({ sizeBytes: 2048, metadata: { 'files-count': '5', 'missing-count': '1' } });

    await runDocumentArchive({ archiveId: ID }, ctx);

    expect(h.stat).toHaveBeenCalledWith(KEY, T);
    expect(h.order).toMatchObject({ status: 'completed', size_bytes: 2048, files_count: 5, missing_count: 1 });
    expect(h.email).toHaveBeenCalledTimes(1);
  });

  it('ponowienie gotowej i powiadomionej paczki nie składa, nie zapisuje i nie wysyła nic drugi raz', async () => {
    await runDocumentArchive({ archiveId: ID }, ctx);
    await runDocumentArchive({ archiveId: ID }, ctx);

    expect(h.build).toHaveBeenCalledTimes(1);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.email).toHaveBeenCalledTimes(1);
  });

  it('błąd poczty po gotowości: ponowienie nie składa paczki drugi raz, a e-mail idzie z tym samym kluczem', async () => {
    h.email.mockRejectedValueOnce(new Error('Resend error: 500'));
    await expect(runDocumentArchive({ archiveId: ID }, ctx)).rejects.toThrow('Resend error');
    expect(h.order).toMatchObject({ status: 'completed', notified_at: null });

    await runDocumentArchive({ archiveId: ID }, ctx);

    expect(h.build).toHaveBeenCalledTimes(1);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.email).toHaveBeenCalledTimes(2);
    expect(h.email.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([`document-archive/${ID}/ready`, `document-archive/${ID}/ready`]);
    expect(h.order!.notified_at).toEqual(expect.any(String));
  });

  it('zlecenie zamknięte jako nieudane (utknięte) nie składa paczki przy spóźnionym wykonaniu', async () => {
    h.order!.status = 'failed';
    await runDocumentArchive({ archiveId: ID }, ctx);
    expect(h.build).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.email).not.toHaveBeenCalled();
  });

  it('po wyczerpaniu prób: „nieudana” z powodem dla człowieka, tylko z aktywnego stanu', async () => {
    h.order!.status = 'generating';
    await onDocumentArchiveExhausted(new ArchiveTooLargeError(), { archiveId: ID });
    expect(h.order).toMatchObject({ status: 'failed', error_message: new ArchiveTooLargeError().message });

    h.order!.status = 'generating';
    await onDocumentArchiveExhausted(new Error('ECONNRESET'), { archiveId: ID });
    expect(h.order!.error_message).toBe('Nie udało się przygotować paczki. Zleć ją ponownie albo napisz do nas.');

    // Gotowej paczki wyczerpanie prób (np. poczty) nie psuje.
    h.order!.status = 'completed';
    await onDocumentArchiveExhausted(new Error('Resend error'), { archiveId: ID });
    expect(h.order!.status).toBe('completed');
  });
});
