import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania, sesja 31: `/share-target` (zdjęcie albo PDF udostępniony
 * z telefonu) przyjmował każdy plik do 10 MiB i zapisywał go w pełnej
 * rozdzielczości. Odczyt (OCR) przyjmuje obraz do 10 MB po zakodowaniu
 * base64, czyli ok. 7,5 MB pliku, więc zdjęcie 7,5–10 MB padało dopiero
 * w workerze, z angielskim błędem API. Ciało ponad 10 MiB proxy ucinało po
 * cichu, a `req.formData()` rzucał (500).
 *
 * Teraz: zdjęcie do 7 MB, PDF do 10 MB, odmowa po `Content-Length` przed
 * odczytem ciała, limit liczby wgrań, a klient trafia na Koszty z polskim
 * komunikatem (pasek Flo z `?paragon=` nie jest dziś nigdzie wyświetlany).
 *
 * Prawdziwa trasa, prawdziwe bramki i limit (w pamięci procesu, bez Redisa);
 * atrapy tylko dla sesji, bazy, magazynu plików i kolejki.
 */

const mocks = vi.hoisted(() => ({
  user: { id: 'u-share' } as { id: string } | null,
  uploads: [] as Array<{ mime: string; size: number }>,
  enqueue: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: mocks.enqueue }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) } }),
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => {
  const actual = await orig<typeof import('@/lib/supabase/auth-context')>();
  return {
    ...actual,
    requireUserAndActiveOrg: async () => {
      if (!mocks.user) throw new actual.ActionAuthError('Niezalogowany');
      return { user: mocks.user, tenantId: 'ten-share', supabase: {}, role: 'owner' };
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
    mocks.uploads.push({ mime, size: buffer.byteLength });
    return 'r2/key';
  },
  deleteExpensePhoto: vi.fn(),
}));

import { POST } from '@/app/share-target/route';

const ORIGIN = 'https://faktway.test';
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46];
const PDF = [...Buffer.from('%PDF-1.7\n', 'latin1')];

function file(signature: number[], size: number, name: string, type: string): File {
  const bytes = new Uint8Array(size);
  bytes.set(signature);
  return new File([bytes], name, { type });
}

/** Żądanie jak z przeglądarki: multipart z polem `photo` i prawdziwym `Content-Length`. */
async function shareRequest(photo: File): Promise<NextRequest> {
  const form = new FormData();
  form.set('title', 'Paragon');
  form.set('photo', photo);
  const encoded = new Request(`${ORIGIN}/share-target`, { method: 'POST', body: form });
  const body = await encoded.arrayBuffer();
  return new NextRequest(`${ORIGIN}/share-target`, {
    method: 'POST',
    body,
    headers: {
      'content-type': encoded.headers.get('content-type')!,
      'content-length': String(body.byteLength),
    },
  });
}

function location(res: Response): URL {
  expect(res.status).toBe(303);
  return new URL(res.headers.get('location')!);
}

let userSeq = 0;
beforeEach(() => {
  userSeq += 1;
  // Każdy test z innym klientem: limit wgrań liczy się w pamięci procesu.
  mocks.user = { id: `u-share-${userSeq}` };
  mocks.uploads = [];
  mocks.enqueue.mockReset();
});

describe('/share-target — limity pliku (sesja 31)', () => {
  it('PDF 9 MB przechodzi jak dotąd: odczyt w kolejce, wątek z identyfikatorem', async () => {
    const res = await POST(await shareRequest(file(PDF, 9_000_000, 'faktura.pdf', 'application/pdf')));

    const to = location(res);
    expect(to.pathname).toBe('/flo');
    expect(to.searchParams.get('paragon')).toBe('ocr-1');
    expect(mocks.uploads).toEqual([{ mime: 'application/pdf', size: 9_000_000 }]);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it('zdjęcie 5 MB przechodzi (poniżej progu odczytu)', async () => {
    const res = await POST(await shareRequest(file(JPG, 5_000_000, 'IMG_1.jpg', 'image/jpeg')));

    expect(location(res).searchParams.get('paragon')).toBe('ocr-1');
    expect(mocks.uploads).toEqual([{ mime: 'image/jpeg', size: 5_000_000 }]);
  });

  it('zdjęcie 7,2 MB → Koszty z komunikatem „za duże”, bez zapisu i bez odczytu w kolejce', async () => {
    const res = await POST(await shareRequest(file(JPG, 7_200_000, 'IMG_2.jpg', 'image/jpeg')));

    const to = location(res);
    expect(to.pathname).toBe('/expenses');
    expect(to.searchParams.get('udostepnienie')).toBe('za-duze');
    expect(to.searchParams.get('rodzaj')).toBe('zdjecie');
    expect(to.searchParams.get('rozmiar')).toBe('7200000');
    expect(mocks.uploads).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('ciało ponad limitem → odmowa po Content-Length, ciało nieodczytane', async () => {
    let pulled = false;
    // highWaterMark 0: strumień nie woła pull sam przy tworzeniu, więc pull = ktoś czyta ciało.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const req = new NextRequest(`${ORIGIN}/share-target`, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { 'content-type': 'multipart/form-data; boundary=----x', 'content-length': '12000000' },
    } as ConstructorParameters<typeof NextRequest>[1]);

    const to = location(await POST(req));

    expect(to.pathname).toBe('/expenses');
    expect(to.searchParams.get('udostepnienie')).toBe('za-duze');
    expect(to.searchParams.get('rozmiar')).toBe('12000000');
    expect(pulled).toBe(false);
    expect(mocks.uploads).toEqual([]);
  });

  it('limit wgrań: po 30 plikach w 10 minut kolejny wraca z komunikatem, bez zapisu', async () => {
    for (let i = 0; i < 30; i += 1) {
      const ok = await POST(await shareRequest(file(JPG, 1000, `IMG_${i}.jpg`, 'image/jpeg')));
      expect(location(ok).searchParams.get('paragon')).toBe('ocr-1');
    }
    mocks.uploads = [];

    const to = location(await POST(await shareRequest(file(JPG, 1000, 'IMG_31.jpg', 'image/jpeg'))));

    expect(to.pathname).toBe('/expenses');
    expect(to.searchParams.get('udostepnienie')).toBe('limit');
    expect(Number(to.searchParams.get('za'))).toBeGreaterThan(0);
    expect(mocks.uploads).toEqual([]);
  });

  it('bez sesji → logowanie jak dotąd, bez zapisu', async () => {
    mocks.user = null;

    const to = location(await POST(await shareRequest(file(JPG, 1000, 'IMG.jpg', 'image/jpeg'))));

    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('redirect')).toBe('/flo');
    expect(mocks.uploads).toEqual([]);
  });

  it('pusty plik → „brak zdjęcia” jak dotąd', async () => {
    const to = location(await POST(await shareRequest(new File([], 'pusty.jpg', { type: 'image/jpeg' }))));

    expect(to.pathname).toBe('/flo');
    expect(to.searchParams.get('paragon')).toBe('brak-zdjecia');
  });
});
