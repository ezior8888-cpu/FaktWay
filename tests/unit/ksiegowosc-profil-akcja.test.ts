import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcja zapisu profilu podatkowego (plan księgowości JDG, K2). Atrapy tylko
 * dla bazy, uprawnień, wyłącznika i audytu; walidacja, reguła formy
 * i mapowanie wierszy są prawdziwe. RLS i wyzwalacz 00166 sprawdza
 * `tests/rls-ksiegowosc-profil.test.ts` na prawdziwej bazie.
 */

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  wlaczony: true,
  audit: vi.fn(),
  revalidate: vi.fn(),
  istniejace: [] as Record<string, unknown>[],
  bladOdczytu: null as { code?: string; message: string } | null,
  zapisy: [] as { wiersz: Record<string, unknown>; opcje: unknown }[],
  bladZapisu: null as { code?: string; message: string; hint?: string } | null,
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }),
}));

const supabase = {
  from: (tabela: string) => {
    if (tabela !== 'tax_profiles') throw new Error(`nieoczekiwana tabela ${tabela}`);
    return {
      select: () => ({
        eq: () => ({
          order: async () => ({ data: mocks.bladOdczytu ? null : mocks.istniejace, error: mocks.bladOdczytu }),
        }),
      }),
      upsert: (wiersz: Record<string, unknown>, opcje: unknown) => {
        mocks.zapisy.push({ wiersz, opcje });
        return {
          select: () => ({
            single: async () =>
              mocks.bladZapisu ? { data: null, error: mocks.bladZapisu } : { data: { id: 'nowa', ...wiersz }, error: null },
          }),
        };
      },
    };
  },
};

const { zapiszProfilPodatkowyAction } = await import('@/app/actions/ksiegowosc-profil');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');

const WEJSCIE = {
  validFrom: '2027-01-01',
  forma: 'ryczalt' as const,
  stawkaDomyslna: 1200,
  zusEtap: 'pelny' as const,
  zusOd: null,
  chorobowe: false,
  nrsZus: null,
  zakresV1: true,
};

beforeEach(() => {
  mocks.requireOrgRole.mockReset().mockResolvedValue({
    supabase,
    user: { id: 'u1' },
    tenantId: 'firma-1',
    role: 'owner',
  });
  mocks.wlaczony = true;
  mocks.audit.mockReset();
  mocks.revalidate.mockReset();
  mocks.istniejace = [];
  mocks.bladOdczytu = null;
  mocks.zapisy = [];
  mocks.bladZapisu = null;
});

describe('zapis profilu podatkowego', () => {
  it('tylko właściciel i administrator', async () => {
    mocks.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Brak uprawnień do tej akcji.'));
    expect(await zapiszProfilPodatkowyAction(WEJSCIE)).toEqual({ success: false, error: 'Brak uprawnień do tej akcji.' });
    expect(mocks.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin']);
    expect(mocks.zapisy).toEqual([]);
  });

  it('firma poza pilotażem: odmowa bez zapisu', async () => {
    mocks.wlaczony = false;
    const wynik = await zapiszProfilPodatkowyAction(WEJSCIE);
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('nie są jeszcze dostępne') });
    expect(mocks.zapisy).toEqual([]);
  });

  it('bez potwierdzenia zakresu v1: odmowa z polem, bez zapisu i audytu', async () => {
    const { zakresV1: _pominiete, ...bez } = WEJSCIE;
    for (const wejscie of [bez, { ...bez, zakresV1: false }]) {
      const wynik = await zapiszProfilPodatkowyAction(wejscie);
      expect(wynik).toMatchObject({ success: false, pole: 'zakresV1', error: expect.stringContaining('zakresie modułu') });
    }
    expect(mocks.zapisy).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('błędne dane: komunikat z polem, bez zapisu', async () => {
    const wynik = await zapiszProfilPodatkowyAction({ ...WEJSCIE, stawkaDomyslna: null });
    expect(wynik).toMatchObject({ success: false, pole: 'stawkaDomyslna' });
    expect(mocks.zapisy).toEqual([]);
  });

  it('zmiana formy w trakcie roku: odmowa przed zapisem', async () => {
    mocks.istniejace = [
      { id: 'p1', valid_from: '2027-01-01', forma: 'ryczalt', stawka_domyslna: 1200, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null },
    ];
    const wynik = await zapiszProfilPodatkowyAction({ ...WEJSCIE, validFrom: '2027-06-01', forma: 'skala', stawkaDomyslna: null });
    expect(wynik).toMatchObject({ success: false, pole: 'validFrom', error: expect.stringContaining('1 stycznia') });
    expect(mocks.zapisy).toEqual([]);
  });

  it('zapis: upsert po firmie i dniu, audyt z wersją przed i po, odświeżenie strony', async () => {
    mocks.istniejace = [
      { id: 'p1', valid_from: '2027-01-01', forma: 'ryczalt', stawka_domyslna: 850, zus_etap: 'pelny', zus_od: null, chorobowe: false, nrs_zus: null },
    ];
    const wynik = await zapiszProfilPodatkowyAction(WEJSCIE);
    expect(wynik).toMatchObject({ success: true, wersja: { validFrom: '2027-01-01', stawkaDomyslna: 1200 } });
    expect(mocks.zapisy).toEqual([
      {
        wiersz: {
          tenant_id: 'firma-1', valid_from: '2027-01-01', forma: 'ryczalt', stawka_domyslna: 1200,
          zus_etap: 'pelny', zus_od: null, chorobowe: false, najem: false, nrs_zus: null,
        },
        opcje: { onConflict: 'tenant_id,valid_from' },
      },
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tax_profile.saved',
        tenantId: 'firma-1',
        userId: 'u1',
        entityType: 'tax_profile',
        metadata: expect.objectContaining({
          validFrom: '2027-01-01',
          zakresV1: true,
          przed: expect.objectContaining({ stawkaDomyslna: 850 }),
          po: expect.objectContaining({ stawkaDomyslna: 1200 }),
        }),
      }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith('/reports/ustawienia-podatkowe');
  });

  it('wyzwalacz bazy (np. równoległy zapis) daje ten sam komunikat o 1 stycznia', async () => {
    mocks.bladZapisu = { code: '23514', message: 'x', hint: 'tax_profile_form_change' };
    expect(await zapiszProfilPodatkowyAction(WEJSCIE)).toMatchObject({
      success: false,
      pole: 'validFrom',
      error: expect.stringContaining('1 stycznia'),
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('błąd odczytu albo zapisu: komunikat zamiast wyjątku', async () => {
    mocks.bladOdczytu = { code: '57014', message: 'timeout' };
    expect(await zapiszProfilPodatkowyAction(WEJSCIE)).toMatchObject({ success: false, error: expect.stringContaining('Nie udało się') });
    mocks.bladOdczytu = null;
    mocks.bladZapisu = { code: '42501', message: 'permission denied' };
    expect(await zapiszProfilPodatkowyAction(WEJSCIE)).toMatchObject({ success: false, error: expect.stringContaining('Nie udało się') });
  });
});
