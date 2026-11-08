import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { zbudujKpir, type KosztKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Akcje KPiR (plan księgowości JDG, K7): wpis ręczny z kolumną KPiR i plik
 * JPK_PKPIR(3). Atrapy dla bazy, uprawnień, wyłącznika, audytu i odczytu
 * KPiR; walidacja, reguły profilu, generator i XSD są prawdziwe. RLS 00171
 * sprawdza `tests/rls-ksiegowosc-kpir.test.ts` na prawdziwej bazie.
 */

const SKALA: WersjaProfilu = {
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

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  wersje: [] as unknown[],
  kpir: null as unknown,
  wstawione: [] as Record<string, unknown>[],
  usuwany: null as Record<string, unknown> | null,
  kolumnyUsuniecia: '',
  kpirWKodzie: true,
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2027-01-15',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async () => ({ wlaczony: true }),
  statusObszaru: (obszar: string) => ({ wlaczony: obszar !== 'kpir' || mocks.kpirWKodzie }),
}));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => mocks.wersje,
}));
vi.mock('@/lib/ksiegowosc/kpir-dane', () => ({ czytajKpir: async () => mocks.kpir }));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => '1433',
}));

const supabase = {
  from: (tabela: string) => {
    if (tabela === 'tenants') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { nip: '1234567890' }, error: null }) }) }) };
    return {
      delete: () => ({
        eq: () => ({
          eq: () => ({
            select: async (kolumny: string) => {
              mocks.kolumnyUsuniecia = kolumny;
              return { data: mocks.usuwany ? [mocks.usuwany] : [], error: null };
            },
          }),
        }),
      }),
      insert: (w: Record<string, unknown>) => {
        mocks.wstawione.push(w);
        return {
          select: () => ({
            single: async () => ({ data: { id: '00171171-0000-4000-8000-000000000009', ...w, data_przychodu: w.data_przychodu }, error: null }),
          }),
        };
      },
    };
  },
};

const { dodajWpisKpirAction, pobierzJpkPkpirAction, usunWpisRecznyAction } = await import('@/app/actions/ksiegowosc-ewidencja');

const WPIS = { rodzaj: 'inny' as const, dataPrzychodu: '2026-10-15', dokument: 'NOTA/1', kwota: '123,45', kolumna: 'k8' as const, opis: 'Odsetki' };
const OSOBA = { imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' };

const faktura = (dzien: string, gr: number): FakturaEwidencji => ({
  id: `f-${dzien}`,
  numer: `FV/${dzien}`,
  dataWystawienia: dzien,
  dataSprzedazy: dzien,
  rodzaj: 'zwykla',
  nettoGr: gr,
  waluta: 'PLN',
  numerKsef: null,
  fp: false,
  kontrahent: { kraj: 'PL', identyfikator: '5252241585', nazwa: 'Klient', adres: 'Warszawa' },
  rozliczoneZaliczkiGr: 0,
  pozycje: null,
});
const koszt = (dzien: string, gr: number, kolumna: string | null = 'col_13'): KosztKpir => ({
  id: `k-${dzien}`,
  data: dzien,
  dowod: `FZ/${dzien}`,
  numerKsef: null,
  kontrahent: { nazwa: 'Dostawca', adres: 'Kraków', kraj: 'PL', identyfikator: '5260001246' },
  opis: 'Usługi',
  kolumnaAplikacji: kolumna,
  kwotaGr: gr,
});

beforeEach(() => {
  mocks.requireOrgRole.mockReset().mockResolvedValue({ supabase, user: { id: 'u-1' }, tenantId: 'firma-1', role: 'owner' });
  mocks.audit.mockReset();
  mocks.wersje = [SKALA];
  mocks.wstawione = [];
  mocks.usuwany = null;
  mocks.kolumnyUsuniecia = '';
  mocks.kpirWKodzie = true;
});

describe('wpis ręczny KPiR', () => {
  it('przy skali zapisuje wpis z kolumną, bez stawki; audyt z treścią wpisu', async () => {
    expect(await dodajWpisKpirAction(WPIS)).toEqual({ success: true });
    expect(mocks.wstawione[0]).toEqual({
      tenant_id: 'firma-1',
      rodzaj: 'inny',
      data_przychodu: '2026-10-15',
      dokument: 'NOTA/1',
      kwota_gr: 12_345,
      kolumna: 'k8',
      opis: 'Odsetki',
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ledger_entry.kpir_created', metadata: { wpis: expect.objectContaining({ kolumna: 'k8', kwotaGr: 12_345 }) } }));
  });

  it('dzień z ryczałtem albo bez ustawień: odmowa z wyjściem; brak kolumny: komunikat przy polu', async () => {
    mocks.wersje = [{ ...SKALA, forma: 'ryczalt', stawkaDomyslna: 1200 }];
    expect(await dodajWpisKpirAction(WPIS)).toMatchObject({ success: false, pole: 'dataPrzychodu', error: expect.stringContaining('ewidencji przychodów, nie do KPiR') });
    mocks.wersje = [];
    expect(await dodajWpisKpirAction(WPIS)).toMatchObject({ success: false, pole: 'dataPrzychodu', error: expect.stringContaining('Ustawienia podatkowe') });
    expect(await dodajWpisKpirAction({ ...WPIS, kolumna: '' as never })).toMatchObject({ success: false, pole: 'kolumna' });
    expect(mocks.wstawione).toEqual([]);
  });
});

describe('obszar `kpir` zablokowany w kodzie', () => {
  it('wpis KPiR i plik JPK_PKPIR odmawiają bez zapisu i bez audytu', async () => {
    mocks.kpirWKodzie = false;
    expect(await dodajWpisKpirAction(WPIS)).toMatchObject({ success: false, error: expect.stringContaining('niedostępn') });
    expect(await pobierzJpkPkpirAction({ rok: 2026, doMiesiaca: 12, ...OSOBA })).toMatchObject({ success: false });
    expect(mocks.wstawione).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('usunięcie wpisu ręcznego', () => {
  const ID = '00171171-0000-4000-8000-000000000009';
  const wiersz = { id: ID, rodzaj: 'inny', data_przychodu: '2026-10-15', data_wpisu: '2026-10-16', dokument: 'NOTA/1', kwota_gr: 12_345, opis: 'Odsetki' };

  it('wpis KPiR: audyt ma kolumnę KPiR usuniętego wpisu (przychód albo koszt)', async () => {
    mocks.usuwany = { ...wiersz, stawka_pb: null, kolumna: 'k8' };
    expect(await usunWpisRecznyAction(ID)).toEqual({ success: true });
    expect(mocks.kolumnyUsuniecia).toBe('*');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ledger_entry.deleted', metadata: { wpis: expect.objectContaining({ dokument: 'NOTA/1', kolumna: 'k8', kwotaGr: 12_345 }) } }),
    );
  });

  it('wpis ewidencji ryczałtu: audyt jak dotąd, ze stawką i bez kolumny', async () => {
    mocks.usuwany = { ...wiersz, rodzaj: 'raport_kasy', stawka_pb: 1200, kolumna: null };
    expect(await usunWpisRecznyAction(ID)).toEqual({ success: true });
    const metadata = mocks.audit.mock.calls[0][0].metadata as { wpis: Record<string, unknown> };
    expect(metadata.wpis).toMatchObject({ stawkaPb: 1200, kwotaGr: 12_345 });
    expect(metadata.wpis).not.toHaveProperty('kolumna');
  });
});

describe('plik JPK_PKPIR', () => {
  it('cały 2026 r.: plik przechodzi XSD, cel „złożenie”, audyt z sumami bez danych osoby', async () => {
    const kpir = zbudujKpir({ rok: 2026, faktury: [faktura('2026-03-10', 1_000_000)], koszty: [koszt('2026-03-11', 200_000)], wpisy: [], wersje: [SKALA], kursy: new Map() });
    mocks.kpir = { ok: true, kpir, wpisy: [], wersje: [SKALA] };
    const wynik = await pobierzJpkPkpirAction({ rok: 2026, doMiesiaca: 12, ...OSOBA });
    if (!wynik.success) throw new Error(wynik.error);
    expect(wynik.nazwa).toBe('JPK_PKPIR_1234567890_2026-01-01_2026-12-31.xml');
    expect(wynik.xml).toContain('<CelZlozenia>1</CelZlozenia>');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'jpk_pkpir.downloaded', metadata: { od: '2026-01-01', do: '2026-12-31', celZlozenia: 1, liczbaWierszy: 2, przychodGr: 1_000_000, kosztyGr: 200_000 } }),
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/Testowy|1980-01-01/);
  });

  it('KPiR z brakiem w okresie: bez pliku, z treścią braku', async () => {
    const kpir = zbudujKpir({ rok: 2026, faktury: [faktura('2026-03-10', 1_000_000)], koszty: [koszt('2026-03-11', 200_000, null)], wpisy: [], wersje: [SKALA], kursy: new Map() });
    mocks.kpir = { ok: true, kpir, wpisy: [], wersje: [SKALA] };
    expect(await pobierzJpkPkpirAction({ rok: 2026, doMiesiaca: 12, ...OSOBA })).toMatchObject({
      success: false,
      error: expect.stringContaining('nie ma kolumny KPiR'),
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
