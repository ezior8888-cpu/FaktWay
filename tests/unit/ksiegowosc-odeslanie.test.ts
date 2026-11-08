import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Odesłanie ze starego raportu `/reports/kpir` do księgi modułu (plan
 * księgowości JDG, K8, decyzja D20): firma z modułem ma jedną księgę, firma
 * bez modułu raport bez zmian. Atrapy dla wyłącznika i profilu.
 */

const PROFIL: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'skala',
  stawkaDomyslna: null,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: false,
  nrsZus: null,
  najem: false,
};

const mocks = vi.hoisted(() => ({ wlaczony: true, kpirWKodzie: true, wersje: [] as unknown[] | null }));

vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }),
  statusObszaru: (obszar: string) => ({ wlaczony: obszar !== 'kpir' || mocks.kpirWKodzie }),
}));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => {
    if (mocks.wersje === null) throw new Error('odczyt');
    return mocks.wersje;
  },
}));

const { odeslanieDoKsiegi } = await import('@/lib/ksiegowosc/odeslanie');
const client = {} as import('@supabase/supabase-js').SupabaseClient;

beforeEach(() => {
  mocks.wlaczony = true;
  mocks.kpirWKodzie = true;
  mocks.wersje = [PROFIL];
});

describe('odesłanie ze starego raportu KPiR (K8, D20)', () => {
  it('skala albo liniowy w pilotażu: KPiR modułu w zakładce „Ewidencja”, z adresem miesiąca', async () => {
    expect(await odeslanieDoKsiegi(client, 't1', '2026-10')).toEqual({
      tekst: expect.stringContaining('KPiR według wzoru od 2026 r.'),
      adres: '/reports/ewidencja?month=10&year=2026',
    });
  });

  it('ryczałt: ewidencja przychodów; bez modułu, bez ustawień albo przy błędzie odczytu: nic (raport bez zmian)', async () => {
    mocks.wersje = [{ ...PROFIL, forma: 'ryczalt', stawkaDomyslna: 1200 }];
    expect(await odeslanieDoKsiegi(client, 't1', '2026-10')).toMatchObject({ tekst: expect.stringContaining('ewidencję przychodów') });
    mocks.wlaczony = false;
    expect(await odeslanieDoKsiegi(client, 't1', '2026-10')).toBeNull();
    mocks.wlaczony = true;
    mocks.wersje = [];
    expect(await odeslanieDoKsiegi(client, 't1', '2026-10')).toBeNull();
    mocks.wersje = null;
    expect(await odeslanieDoKsiegi(client, 't1', '2026-10')).toBeNull();
  });

  it('obszar `kpir` zablokowany w kodzie: przy skali bez odesłania (KPiR modułu nie działa)', async () => {
    mocks.kpirWKodzie = false;
    expect(await odeslanieDoKsiegi(client, 't1', '2026-10')).toBeNull();
  });
});
