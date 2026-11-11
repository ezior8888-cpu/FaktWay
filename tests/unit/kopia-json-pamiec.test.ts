import { gunzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { utworzAtrape, uuidNr, type Wiersz } from '../helpers/kopia-json-atrapa';

/**
 * Plan skalowania 3000, sesja 12 (JOB-02, poprawka po przeglądzie): kopia
 * skleja wiersze w napis i przekazuje go do gzip. Gdy napis rósł do końca
 * strony (500 wierszy), szeroka tabela dawała w pamięci workera jeden napis
 * wielkości całej strony i drugą jego kopię w buforze. Paczka do gzip ma
 * mieć stałą górną granicę, niezależną od szerokości wierszy.
 */

const state = vi.hoisted(() => ({
  atrapa: null as null | { admin: unknown },
  wgrane: [] as Buffer[],
  zapisy: [] as number[],
}));

vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>();
  return {
    ...zlib,
    createGzip: (...args: Parameters<typeof zlib.createGzip>) => {
      const gzip = zlib.createGzip(...args);
      const write = gzip.write.bind(gzip) as (chunk: Buffer, ...rest: unknown[]) => boolean;
      (gzip as unknown as { write: typeof write }).write = (chunk, ...rest) => {
        state.zapisy.push(chunk.length);
        return write(chunk, ...rest);
      };
      return gzip;
    },
  };
});
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => state.atrapa!.admin,
}));
vi.mock('@/lib/backup/r2-backup-client', () => ({
  buildSnapshotKey: () => ({ full: 'backups/db/2026/11/11-010000.json.gz', relative: 'db/2026/11/11-010000.json.gz' }),
  uploadSnapshot: async (_key: string, body: Uint8Array) => {
    state.wgrane.push(Buffer.from(body));
  },
}));

import { createDbSnapshot, SNAPSHOT_WRITE_CHUNK_BYTES } from '@/lib/backup/db-snapshot';

beforeEach(() => {
  state.wgrane = [];
  state.zapisy = [];
});

describe('kopia JSON: paczka do gzip ma stałą górną granicę', () => {
  it('strona szerokich wierszy idzie do gzip kawałkami, a plik zostaje kompletny', async () => {
    const pole = 'x'.repeat(20 * 1024);
    const wiersze: Wiersz[] = Array.from({ length: 500 }, (_, i) => ({ id: uuidNr(i + 1), ocr_text: pole }));
    state.atrapa = utworzAtrape({ tabele: { expenses: wiersze } });

    const wynik = await createDbSnapshot({ kind: 'daily', now: new Date('2026-11-11T01:00:00Z') });

    expect(wynik.complete).toBe(true);
    // Granica paczki plus najwyżej jeden wiersz (wiersz nie jest dzielony).
    expect(Math.max(...state.zapisy)).toBeLessThanOrEqual(SNAPSHOT_WRITE_CHUNK_BYTES + 21 * 1024);
    const plik = JSON.parse(gunzipSync(state.wgrane[0]!).toString('utf8')) as { tables: Record<string, Wiersz[]> };
    expect(plik.tables.expenses).toHaveLength(500);
  });
});
