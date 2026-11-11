import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania, sesja 31 (LIM-08, HOR-V1, CPU-06; decyzja Bartosza 03.11,
 * wariant b): PDF kosztu i CSV importu ponad 1 MB nie przechodziły, bo Server
 * Action przyjmuje najwyżej 1 MiB. Teraz idą osobnymi trasami
 * `/api/uploads/expense` i `/api/uploads/import`, z własnym limitem
 * `Content-Length` (odmowa przed odczytem ciała), limitem liczby wgrań na
 * osobę w firmie i budżetem bajtów w procesie — bez globalnego
 * `serverActions.bodySizeLimit`.
 *
 * Trasy są poza proxy (`tests/unit/wgrywanie-proxy-matcher.test.ts`), więc
 * same sprawdzają Origin, sesję, 2FA, firmę i przerwę techniczną. Prawdziwe
 * trasy, bramka i limit (w pamięci procesu, bez Redisa); atrapy tylko dla
 * sesji, bazy, magazynu plików i kolejki.
 */

const mocks = vi.hoisted(() => ({
  auth: null as null | { kind: 'ok'; userId: string } | { kind: 'deny'; message: string },
  authCalls: 0,
  maintenance: false,
  expenseUploads: [] as Array<{ mime: string; size: number }>,
  importUploads: [] as Array<{ tenantId: string; name: string; size: number }>,
  importInserts: [] as Record<string, unknown>[],
  enqueue: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: mocks.enqueue }));
vi.mock('@/lib/feature-flags/maintenance', () => ({
  MAINTENANCE_PATH: '/przerwa-techniczna',
  isMaintenanceMode: async () => mocks.maintenance,
}));

function rlsClient() {
  return {
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        insert: (row: Record<string, unknown>) => {
          mocks.importInserts.push(row);
          return q;
        },
        update: () => q,
        select: () => q,
        eq: () => q,
        single: async () => ({ data: { id: 'job-1' }, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      });
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', async (orig) => {
  const actual = await orig<typeof import('@/lib/supabase/auth-context')>();
  return {
    ...actual,
    requireUserAndActiveOrg: async () => {
      mocks.authCalls += 1;
      const auth = mocks.auth;
      if (!auth) throw new actual.ActionAuthError('Niezalogowany');
      if (auth.kind === 'deny') throw new actual.ActionAuthError(auth.message);
      return { user: { id: auth.userId }, tenantId: 'org-1', supabase: rlsClient(), role: 'member' };
    },
  };
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        insert: () => q,
        update: () => q,
        delete: () => q,
        select: () => q,
        eq: () => q,
        single: async () => ({ data: { id: 'ocr-1' }, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      });
      return q;
    },
  }),
}));
vi.mock('@/lib/storage/expenses', async (orig) => ({
  ...(await orig<typeof import('@/lib/storage/expenses')>()),
  uploadExpensePhoto: async (_t: string, _id: string, buffer: Buffer, mime: string) => {
    mocks.expenseUploads.push({ mime, size: buffer.byteLength });
    return 'r2/expense';
  },
  deleteExpensePhoto: vi.fn(),
}));
vi.mock('@/lib/import/file-storage', () => ({
  uploadImportFile: async (tenantId: string, _job: string, name: string, buffer: Buffer) => {
    mocks.importUploads.push({ tenantId, name, size: buffer.byteLength });
    return 'imports/org-1/job-1/plik.csv';
  },
}));

import { POST as postExpense } from '@/app/api/uploads/expense/route';
import { POST as postImport } from '@/app/api/uploads/import/route';
import {
  readUploadForm,
  reserveUploadBytes,
  UPLOAD_BYTES_IN_FLIGHT_LIMIT,
  UPLOADS_IN_FLIGHT_PER_CALLER,
} from '@/lib/uploads/server';

/** Rezerwacja w imieniu kogoś innego niż klient testu (inna firma). */
function reserveAsOther(bytes: number, caller = 'org-obca:u-obcy') {
  const slot = reserveUploadBytes(bytes, caller);
  if (!slot.ok) throw new Error(`rezerwacja odrzucona: ${slot.reason}`);
  return slot.release;
}

const ORIGIN = 'https://faktway.test';
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46];
const PDF = [...Buffer.from('%PDF-1.7\n', 'latin1')];

function file(signature: number[], size: number, name: string, type: string): File {
  const bytes = new Uint8Array(size);
  bytes.set(signature);
  return new File([bytes], name, { type });
}

/** Żądanie jak z `fetch` w przeglądarce: multipart, `Content-Length`, `Origin` tej samej strony. */
async function request(
  path: string,
  fields: Record<string, string | File>,
  headers: Record<string, string | null> = {},
): Promise<NextRequest> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const encoded = new Request(`${ORIGIN}${path}`, { method: 'POST', body: form });
  const body = await encoded.arrayBuffer();
  const all: Record<string, string | null> = {
    'content-type': encoded.headers.get('content-type')!,
    'content-length': String(body.byteLength),
    origin: ORIGIN,
    host: 'faktway.test',
    ...headers,
  };
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    body,
    headers: Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null)),
  });
}

/** Ciało, które pamięta, czy ktoś je czytał. */
function watchedRequest(path: string, headers: Record<string, string>) {
  const state = { pulled: false };
  // highWaterMark 0: strumień nie woła pull sam przy tworzeniu, więc pull = ktoś czyta ciało.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled = true;
      controller.enqueue(new Uint8Array(16));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const req = new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { origin: ORIGIN, host: 'faktway.test', ...headers },
  } as ConstructorParameters<typeof NextRequest>[1]);
  return { req, state };
}

async function json(res: Response): Promise<{ success: boolean; error?: string; ocrJobId?: string; importJobId?: string }> {
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(res.headers.get('cache-control')).toContain('no-store');
  return res.json();
}

const pdf = (size: number) => file(PDF, size, 'faktura.pdf', 'application/pdf');
const csv = (size: number) => new File([new Uint8Array(size).fill(0x41)], 'faktury-2025.csv', { type: 'text/csv' });
const importFields = (f: File, extra: Record<string, string> = {}) => ({ file: f, source: 'fakturownia_csv', tenantId: 'org-1', ...extra });

let seq = 0;
beforeEach(() => {
  seq += 1;
  // Każdy test z innym klientem: limit wgrań liczy się w pamięci procesu.
  mocks.auth = { kind: 'ok', userId: `u-${seq}` };
  mocks.authCalls = 0;
  mocks.maintenance = false;
  mocks.expenseUploads = [];
  mocks.importUploads = [];
  mocks.importInserts = [];
  mocks.enqueue.mockReset();
});

describe('POST /api/uploads/expense', () => {
  it('PDF 3 MB przechodzi: zapis, odczyt w kolejce, identyfikator zadania', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(3_000_000) }));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true, ocrJobId: 'ocr-1' });
    expect(mocks.expenseUploads).toEqual([{ mime: 'application/pdf', size: 3_000_000 }]);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it('PDF dokładnie 10 MB przechodzi', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(10_000_000) }));

    expect(res.status).toBe(200);
    expect(mocks.expenseUploads).toEqual([{ mime: 'application/pdf', size: 10_000_000 }]);
  });

  it('Content-Length ponad limit → 413 z komunikatem, przed sesją i bez odczytu ciała', async () => {
    const { req, state } = watchedRequest('/api/uploads/expense', {
      'content-type': 'multipart/form-data; boundary=----x',
      'content-length': '10500000',
    });

    const res = await postExpense(req);

    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain('10,5 MB');
    expect(body.error).toContain('najwyżej 10 MB');
    expect(state.pulled).toBe(false);
    expect(mocks.authCalls).toBe(0);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('bez Content-Length (ciało porcjami, np. HTTP/2 przez odwrotne proxy) mały plik przechodzi', async () => {
    const real = await request('/api/uploads/expense', { photo: pdf(3000) });
    const bytes = new Uint8Array(await real.arrayBuffer());
    const req = new NextRequest(real.url, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += 1000) controller.enqueue(bytes.slice(at, at + 1000));
          controller.close();
        },
      }),
      duplex: 'half',
      headers: { 'content-type': real.headers.get('content-type')!, origin: ORIGIN, host: 'faktway.test' },
    } as ConstructorParameters<typeof NextRequest>[1]);

    const res = await postExpense(req);

    expect(res.status).toBe(200);
    expect(mocks.expenseUploads).toEqual([{ mime: 'application/pdf', size: 3000 }]);
  });

  it('bez Content-Length i ponad limit → 413, odczyt staje tuż za limitem ciała', async () => {
    const CHUNK = 256 * 1024;
    let delivered = 0;
    const req = new NextRequest(`${ORIGIN}/api/uploads/expense`, {
      method: 'POST',
      // highWaterMark 0: kolejna porcja dopiero, gdy ktoś czyta — licznik to bajty odczytane.
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          delivered += CHUNK;
          controller.enqueue(new Uint8Array(CHUNK));
          if (delivered >= 30_000_000) controller.close();
        },
      }, { highWaterMark: 0 }),
      duplex: 'half',
      headers: { 'content-type': 'multipart/form-data; boundary=----x', origin: ORIGIN, host: 'faktway.test' },
    } as ConstructorParameters<typeof NextRequest>[1]);

    const res = await postExpense(req);

    expect(res.status).toBe(413);
    expect((await json(res)).error).toContain('10 MB');
    expect(delivered).toBeLessThan(10_065_536 + 3 * CHUNK);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it.each(['abc', '-1', '1e6', '12.5', ''])('Content-Length „%s” → 411, bez odczytu ciała', async (value) => {
    const { req, state } = watchedRequest('/api/uploads/expense', {
      'content-type': 'multipart/form-data; boundary=----x',
      'content-length': value,
    });

    expect((await postExpense(req)).status).toBe(411);
    expect(state.pulled).toBe(false);
  });

  it('ciało inne niż multipart → 415, bez odczytu', async () => {
    const { req, state } = watchedRequest('/api/uploads/expense', { 'content-type': 'application/json', 'content-length': '16' });

    expect((await postExpense(req)).status).toBe(415);
    expect(state.pulled).toBe(false);
  });

  it('Origin innej strony → 403, przed sesją i bez zapisu', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }, { origin: 'https://zla-strona.test' }));

    expect(res.status).toBe(403);
    expect((await json(res)).success).toBe(false);
    expect(mocks.authCalls).toBe(0);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('Origin „null” (piaskownica, plik lokalny) → 403', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }, { origin: 'null' }));

    expect(res.status).toBe(403);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('Origin tej samej strony za odwrotnym proxy (x-forwarded-host) przechodzi', async () => {
    const res = await postExpense(await request(
      '/api/uploads/expense',
      { photo: pdf(1000) },
      { origin: 'https://faktway.pl', host: 'faktway-web:3000', 'x-forwarded-host': 'faktway.pl' },
    ));

    expect(res.status).toBe(200);
  });

  it('bez nagłówka Origin (nie przeglądarka) przechodzi jak w Server Actions', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }, { origin: null }));

    expect(res.status).toBe(200);
  });

  it('bez sesji → 401 z komunikatem, bez zapisu', async () => {
    mocks.auth = null;

    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));

    expect(res.status).toBe(401);
    expect((await json(res)).error).toMatch(/Zaloguj się/);
    expect(mocks.expenseUploads).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('2FA niedokończone → 403 z komunikatem o weryfikacji, bez zapisu', async () => {
    mocks.auth = { kind: 'deny', message: 'Wymagana weryfikacja dwuetapowa' };

    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));

    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('Wymagana weryfikacja dwuetapowa');
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('przerwa techniczna → 503, bez zapisu', async () => {
    mocks.maintenance = true;

    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));

    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatch(/przerwa techniczna/i);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('limit wgrań: po 30 plikach w 10 minut kolejny dostaje 429 z Retry-After i komunikatem', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(200);
    }
    mocks.expenseUploads = [];

    const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await json(res)).error).toMatch(/Spróbuj ponownie/);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('limit wgrań liczy się osobno dla każdej osoby', async () => {
    for (let i = 0; i < 30; i += 1) await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));
    mocks.auth = { kind: 'ok', userId: `u-${seq}-druga-osoba` };

    expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(200);
  });

  it('budżet bajtów w procesie zajęty → 503 z Retry-After, przed odczytem ciała; po zwolnieniu przechodzi', async () => {
    const release = reserveAsOther(UPLOAD_BYTES_IN_FLIGHT_LIMIT);
    try {
      const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));
      expect(res.status).toBe(503);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await json(res)).error).toMatch(/Spróbuj ponownie/);
      expect(mocks.expenseUploads).toEqual([]);
    } finally {
      release();
    }

    expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(200);
  });

  it('zajęty budżet (wina serwera) nie zjada prób z limitu wgrań', async () => {
    const release = reserveAsOther(UPLOAD_BYTES_IN_FLIGHT_LIMIT);
    try {
      for (let i = 0; i < 35; i += 1) {
        expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(503);
      }
    } finally {
      release();
    }

    expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(200);
  });

  it('błąd kolejki (5xx) oddaje próbę; plik odrzucony z winy klienta jej nie oddaje', async () => {
    mocks.enqueue.mockRejectedValue(new Error('kolejka padła'));
    for (let i = 0; i < 35; i += 1) {
      expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(500);
    }
    mocks.enqueue.mockReset();
    expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(200);

    // Plik spoza formatów (wina klienta): próba przepada jak każda inna.
    mocks.auth = { kind: 'ok', userId: `u-${seq}-zly-format` };
    const html = () => new File(['<html></html>'], 'faktura.png', { type: 'image/png' });
    for (let i = 0; i < 30; i += 1) {
      expect((await postExpense(await request('/api/uploads/expense', { photo: html() }))).status).toBe(400);
    }
    expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(429);
  });

  it(`najwyżej ${UPLOADS_IN_FLIGHT_PER_CALLER} wgrania naraz na osobę w firmie; inna osoba dalej wgrywa`, async () => {
    const mine = Array.from({ length: UPLOADS_IN_FLIGHT_PER_CALLER }, () => reserveAsOther(1000, `org-1:u-${seq}`));
    try {
      const res = await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));
      expect(res.status).toBe(429);
      expect((await json(res)).error).toMatch(/Poprzednie pliki jeszcze się wysyłają/);
      expect(mocks.expenseUploads).toEqual([]);

      mocks.auth = { kind: 'ok', userId: `u-${seq}-inna-osoba` };
      expect((await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }))).status).toBe(200);
    } finally {
      mine.forEach((release) => release());
    }
  });

  it('jedno konto nie zajmie budżetu procesu: dwie rezerwacje pełnego ciała zostawiają miejsce innym', () => {
    const caller = `org-1:u-${seq}-wolne-laczy`;
    const held = [reserveUploadBytes(null, caller), reserveUploadBytes(null, caller), reserveUploadBytes(null, caller)];
    try {
      expect(held.map((slot) => slot.ok)).toEqual([true, true, false]);
      const other = reserveUploadBytes(null, 'org-2:u-ktos');
      expect(other.ok).toBe(true);
      if (other.ok) other.release();
    } finally {
      held.forEach((slot) => slot.ok && slot.release());
    }
  });

  it('budżet zwalnia się także po odmowie i błędzie zapisu', async () => {
    await postExpense(await request('/api/uploads/expense', { photo: file(JPG, 7_200_000, 'a.jpg', 'image/jpeg') }));
    mocks.enqueue.mockRejectedValueOnce(new Error('kolejka padła'));
    await postExpense(await request('/api/uploads/expense', { photo: pdf(1000) }));

    reserveAsOther(UPLOAD_BYTES_IN_FLIGHT_LIMIT)();
    // Miejsca osoby też wróciły.
    const mine = Array.from({ length: UPLOADS_IN_FLIGHT_PER_CALLER }, () => reserveAsOther(1000, `org-1:u-${seq}`));
    mine.forEach((release) => release());
  });

  it('odczyt ciała stoi dłużej niż termin → 408, źródło przerwane, budżet do zwolnienia', async () => {
    let cancelled = false;
    const stalled = new Request(`${ORIGIN}/api/uploads/expense`, {
      method: 'POST',
      // Pierwsze bajty i cisza: klient na zawieszonym połączeniu.
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(100));
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
    } as RequestInit & { duplex: 'half' });

    const started = Date.now();
    const result = await readUploadForm(stalled, 5000, { timeoutMs: 50 });

    expect(result).toMatchObject({ ok: false, status: 408, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(cancelled).toBe(true);
  });

  it('zdjęcie 7,2 MB → 413 z progiem odczytu 7 MB, bez zapisu', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { photo: file(JPG, 7_200_000, 'IMG.jpg', 'image/jpeg') }));

    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error).toContain('7,2 MB');
    expect(body.error).toContain('7 MB');
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('zdjęcie dokładnie 7 MB przechodzi', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { photo: file(JPG, 7_000_000, 'IMG.jpg', 'image/jpeg') }));

    expect(res.status).toBe(200);
    expect(mocks.expenseUploads).toEqual([{ mime: 'image/jpeg', size: 7_000_000 }]);
  });

  it('ciało krótsze niż Content-Length (ucięte w drodze) → 400, bez zapisu', async () => {
    const { req } = watchedRequest('/api/uploads/expense', {
      'content-type': 'multipart/form-data; boundary=----x',
      'content-length': '5000',
    });

    const res = await postExpense(req);

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/Nie udało się odebrać/);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('ciało dłuższe niż Content-Length → 400, bez zapisu', async () => {
    const real = await request('/api/uploads/expense', { photo: pdf(1000) });
    const req = new NextRequest(real.url, {
      method: 'POST',
      body: await real.arrayBuffer(),
      headers: { ...Object.fromEntries(real.headers), 'content-length': '100' },
    });

    expect((await postExpense(req)).status).toBe(400);
    expect(mocks.expenseUploads).toEqual([]);
  });

  it('formularz bez pliku → 400 „Brak pliku”', async () => {
    const res = await postExpense(await request('/api/uploads/expense', { title: 'x' }));

    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('Brak pliku');
  });

  it('plik spoza obsługiwanych formatów → 400 z komunikatem, bez zapisu (AUD-105)', async () => {
    const html = new File(['<html><script>alert(1)</script></html>'], 'faktura.png', { type: 'image/png' });

    const res = await postExpense(await request('/api/uploads/expense', { photo: html }));

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/Nieobsługiwany format/);
    expect(mocks.expenseUploads).toEqual([]);
  });
});

describe('POST /api/uploads/import', () => {
  it('CSV 3 MB przechodzi: zadanie importu tej firmy, plik w magazynie, zdarzenie w kolejce', async () => {
    const res = await postImport(await request('/api/uploads/import', importFields(csv(3_000_000))));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true, importJobId: 'job-1' });
    expect(mocks.importInserts[0]).toMatchObject({
      tenant_id: 'org-1',
      triggered_by: `u-${seq}`,
      source: 'fakturownia_csv',
      source_filename: 'faktury-2025.csv',
      source_file_size: 3_000_000,
    });
    expect(mocks.importUploads).toEqual([{ tenantId: 'org-1', name: 'faktury-2025.csv', size: 3_000_000 }]);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it('CSV tuż ponad 10 MB (ciało w limicie) → 413 z komunikatem, bez zadania', async () => {
    const res = await postImport(await request('/api/uploads/import', importFields(csv(10_000_001))));

    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error).toContain('10,1 MB');
    expect(body.error).toContain('najwyżej 10 MB');
    expect(mocks.importInserts).toEqual([]);
    expect(mocks.importUploads).toEqual([]);
  });

  it('Content-Length ponad limit → 413 przed sesją i bez odczytu ciała', async () => {
    const { req, state } = watchedRequest('/api/uploads/import', {
      'content-type': 'multipart/form-data; boundary=----x',
      'content-length': '20000000',
    });

    const res = await postImport(req);

    expect(res.status).toBe(413);
    expect(state.pulled).toBe(false);
    expect(mocks.authCalls).toBe(0);
  });

  it('formularz dla innej firmy niż aktywna → 403 „Brak uprawnień”, bez zadania', async () => {
    const res = await postImport(await request('/api/uploads/import', importFields(csv(1000), { tenantId: 'org-2' })));

    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('Brak uprawnień');
    expect(mocks.importInserts).toEqual([]);
    expect(mocks.importUploads).toEqual([]);
  });

  it.each(['jpk_fa', 'ksef_history', 'inne'])('źródło „%s” → 400, bez zadania', async (source) => {
    const res = await postImport(await request('/api/uploads/import', importFields(csv(1000), { source })));

    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('Nieobsługiwane źródło pliku.');
    expect(mocks.importInserts).toEqual([]);
  });

  it('pusty plik → 400 „Plik jest pusty.”', async () => {
    const res = await postImport(await request('/api/uploads/import', importFields(csv(0))));

    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('Plik jest pusty.');
  });

  it('bez sesji → 401, bez zadania', async () => {
    mocks.auth = null;

    const res = await postImport(await request('/api/uploads/import', importFields(csv(1000))));

    expect(res.status).toBe(401);
    expect(mocks.importInserts).toEqual([]);
  });

  it('limit wgrań importu: po 10 plikach w 10 minut kolejny dostaje 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await postImport(await request('/api/uploads/import', importFields(csv(1000))))).status).toBe(200);
    }

    const res = await postImport(await request('/api/uploads/import', importFields(csv(1000))));

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
