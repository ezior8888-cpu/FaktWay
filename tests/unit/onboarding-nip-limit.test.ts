import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUD-59: wyszukiwanie firmy po NIP w onboardingu (GUS + lista firm z tym
 * NIP-em w FaktWay) nie miało limitu — zalogowany mógł seryjnie sprawdzać,
 * które firmy są klientami, i zasypywać je prośbami o dostęp. Lista jest
 * potrzebna do „poproś o dostęp”, więc zostaje; dochodzi limit 20 wyszukiwań
 * na godzinę na użytkownika — przed GUS i przed bazą.
 */

const mocks = vi.hoisted(() => ({ gus: vi.fn(), admin: vi.fn() }));
vi.mock('@/lib/cache/redis', () => ({ isRedisConfigured: () => false, getRedis: () => { throw new Error('brak'); } }));
vi.mock('@/lib/auth/verified-user', () => ({ getVerifiedUserContext: async () => ({ ok: true, user: { id: 'nip-lookup-user' } }) }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));
vi.mock('@/lib/xml/invoice-calculator', () => ({ validateNipChecksum: () => true }));
vi.mock('@/app/actions/organizations', () => ({ createOrganizationAction: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => {
    mocks.admin();
    const q = { select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }) };
    return { from: () => q };
  },
}));

import { lookupNipAction } from '@/components/onboarding/actions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gus.mockResolvedValue({ kind: 'success', data: { nip: '1234567890', name: 'Firma', postalCode: '00-001', city: 'Warszawa', street: 'Testowa', buildingNumber: '1' } });
});

describe('wyszukiwanie NIP w onboardingu', () => {
  it('po 20 wyszukiwaniach w godzinie odmawia bez pytania GUS i bazy', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await lookupNipAction('1234567890')).success).toBe(true);
    }
    mocks.gus.mockClear();
    mocks.admin.mockClear();
    const r = await lookupNipAction('1234567890');
    expect(r).toEqual({ success: false, error: expect.stringContaining('Zbyt wiele') });
    expect(mocks.gus).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
