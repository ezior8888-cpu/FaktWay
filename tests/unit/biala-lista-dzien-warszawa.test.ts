import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FZ-003 (żelazny filtr, reguła data-warszawa): „dzisiaj” przy Białej Liście
 * VAT to dzień w Polsce, nie w UTC. Do naprawy domyślna data zapytania do
 * wykazu i dzień porównania z datą wykreślenia brały
 * `new Date().toISOString().slice(0, 10)`. Między 0:00 a 1:00 (zimą) albo
 * 2:00 (latem) czasu polskiego sprawdzenie szło więc z datą wczorajszą,
 * a wykreślenie z VAT od dziś nie dawało ostrzeżenia.
 *
 * Ścieżka prawdziwa: `checkNipInWhitelist` i `validateNipCached`; atrapy tylko
 * dla HTTP (fetch), Redisa i bazy.
 */

const state = vi.hoisted(() => ({
  urls: [] as string[],
  subject: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/cache', () => ({
  cached: async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
  cacheDel: vi.fn(async () => undefined),
  cacheSet: vi.fn(async () => undefined),
  cacheKeys: { nipValidation: (nip: string, cc: string) => `nip:${cc}:${nip}` },
  TTL_SECONDS: { nipValidation: 86400 },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        gt: () => q,
        update: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      });
      return q;
    },
  }),
}));

import { validateNipCached } from '@/lib/validation/cache';
import { checkNipInWhitelist } from '@/lib/validation/whitelist-client';

const NIP = '1234567890';

beforeEach(() => {
  state.urls = [];
  state.subject = { name: 'Firma Testowa', nip: NIP, statusVat: 'Czynny', accountNumbers: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      state.urls.push(url);
      return new Response(JSON.stringify({ result: { subject: state.subject } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  // Tylko zegar: setTimeout (limit czasu zapytania) zostaje prawdziwy.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Biała Lista: dzisiaj to dzień w Polsce (FZ-003)', () => {
  it.each([
    ['zimą (CET), 0:30 12.11', '2026-11-11T23:30:00Z', '2026-11-12'],
    ['latem (CEST), 0:30 16.07', '2026-07-15T22:30:00Z', '2026-07-16'],
  ])('zapytanie bez daty idzie z dzisiejszym dniem w Polsce: %s', async (_opis, teraz, dzisWPolsce) => {
    vi.setSystemTime(new Date(teraz));
    const wynik = await checkNipInWhitelist(NIP);
    expect(wynik.success).toBe(true);
    expect(state.urls).toHaveLength(1);
    expect(new URL(state.urls[0]).searchParams.get('date')).toBe(dzisWPolsce);
  });

  it('podana data idzie do wykazu bez zmian', async () => {
    vi.setSystemTime(new Date('2026-11-11T23:30:00Z'));
    await checkNipInWhitelist(NIP, '2026-11-10');
    expect(new URL(state.urls[0]).searchParams.get('date')).toBe('2026-11-10');
  });

  it('wykreślenie z VAT od dziś daje ostrzeżenie także zaraz po północy', async () => {
    vi.setSystemTime(new Date('2026-11-11T23:30:00Z'));
    state.subject = { name: 'Firma Testowa', nip: NIP, statusVat: 'Niezarejestrowany', removalDate: '2026-11-12', accountNumbers: [] };
    const wynik = await validateNipCached(NIP, 'PL');
    expect(wynik.warning).toBe('Wykreślony z VAT od 2026-11-12');
  });

  it('wykreślenie od jutra nie daje ostrzeżenia', async () => {
    vi.setSystemTime(new Date('2026-11-11T23:30:00Z'));
    state.subject = { name: 'Firma Testowa', nip: NIP, statusVat: 'Czynny', removalDate: '2026-11-13', accountNumbers: [] };
    const wynik = await validateNipCached(NIP, 'PL');
    expect(wynik.warning).toBeUndefined();
  });
});
