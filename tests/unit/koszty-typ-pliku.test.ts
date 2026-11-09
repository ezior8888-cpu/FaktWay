import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  uploads: [] as Array<{ mime: string }>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        insert: (row: Record<string, unknown>) => {
          mocks.inserts.push(row);
          return q;
        },
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
  uploadExpensePhoto: async (_t: string, _id: string, _b: Buffer, mime: string) => {
    mocks.uploads.push({ mime });
    return 'r2/key';
  },
  deleteExpensePhoto: vi.fn(),
}));

import { acceptExpenseDocument } from '@/lib/expenses/accept-upload';

/**
 * AUD-105: upload zdjęcia kosztu przyjmował dowolny plik i zapisywał go
 * z typem podanym przez przeglądarkę. Teraz liczy się zawartość pliku:
 * tylko formaty, które czyta OCR (JPG, PNG, GIF, WEBP, PDF), zapisane
 * z typem wykrytym po sygnaturze.
 *
 * Od sesji 31 planu skalowania ciało dawnej akcji to `acceptExpenseDocument`
 * (woła je trasa `/api/uploads/expense` i `/share-target` po bramce sesji).
 */

const upload = (fd: FormData) =>
  acceptExpenseDocument({ userId: 'u-1', tenantId: 'ten-1', file: fd.get('photo') as File });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

function form(bytes: Buffer, type: string, name = 'plik') {
  const fd = new FormData();
  fd.set('photo', new File([new Uint8Array(bytes)], name, { type }));
  return fd;
}

beforeEach(() => {
  mocks.inserts = [];
  mocks.uploads = [];
});

describe('zdjęcie kosztu — typ pliku z zawartości (AUD-105)', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPG', JPG, 'image/jpeg'],
    ['PDF', PDF, 'application/pdf'],
    ['WEBP', WEBP, 'image/webp'],
  ])('%s przyjęty i zapisany z typem z sygnatury', async (_opis, bytes, mime) => {
    const out = await upload(form(bytes, ''));

    expect(out).toMatchObject({ success: true });
    expect(mocks.uploads).toEqual([{ mime }]);
    expect(mocks.inserts[0]).toMatchObject({ source_file_mime: mime });
  });

  it('HTML podpisany jako image/png — odrzucony, bez zapisu i bez joba', async () => {
    const out = await upload(form(HTML, 'image/png', 'faktura.png'));

    expect(out).toMatchObject({ success: false });
    expect((out as { error: string }).error).toMatch(/JPG|PDF/);
    expect(mocks.inserts).toEqual([]);
    expect(mocks.uploads).toEqual([]);
  });

  it('typ z przeglądarki nie wygrywa z zawartością (JPG podpisany jako PDF)', async () => {
    await upload(form(JPG, 'application/pdf'));

    expect(mocks.uploads).toEqual([{ mime: 'image/jpeg' }]);
  });
});
