import { beforeEach, describe, expect, it, vi } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Akcje ewidencji przychodów (plan księgowości JDG, K3). Atrapy tylko dla
 * bazy, uprawnień, wyłącznika, audytu i odczytu ewidencji; walidacja,
 * reguły profilu, generator i XSD JPK_EWP są prawdziwe. RLS 00167 sprawdza
 * `tests/rls-ksiegowosc-wpisy.test.ts` na prawdziwej bazie.
 */

const RYCZALT: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: false,
  nrsZus: null,
};

const FAKTURA: FakturaEwidencji = {
  id: 'f1',
  numer: 'FV/1/2026',
  dataWystawienia: '2026-03-10',
  dataSprzedazy: '2026-03-10',
  rodzaj: 'zwykla',
  nettoGr: 10_000_00,
  waluta: 'PLN',
  numerKsef: '1234567890-20260310-0A1B2C-3D4E5F-6A',
  fp: false,
  kontrahent: { kraj: 'PL', identyfikator: '1234567890' },
  rozliczoneZaliczkiGr: 0,
  pozycje: null,
};

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  wlaczony: true,
  audit: vi.fn(),
  revalidate: vi.fn(),
  wersje: [] as unknown[],
  ewidencja: null as unknown,
  urzad: '0202' as string | null,
  nip: '1234567890',
  wstawione: [] as Record<string, unknown>[],
  bladWstawienia: null as { message: string } | null,
  usuniete: [] as Record<string, unknown>[],
  filtryUsuniecia: [] as [string, unknown][],
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-05',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }) }));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => mocks.wersje,
}));
vi.mock('@/lib/ksiegowosc/ewidencja-dane', () => ({ czytajEwidencje: async () => mocks.ewidencja }));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => mocks.urzad,
}));

const WIERSZ_WPISU = {
  id: '00167167-0000-4000-8000-000000000001',
  rodzaj: 'raport_kasy',
  data_przychodu: '2026-03-31',
  data_wpisu: '2026-11-05',
  dokument: 'RK/03/2026',
  kwota_gr: 250000,
  stawka_pb: 300,
  opis: null,
};

const supabase = {
  from: (tabela: string) => {
    if (tabela === 'tenants') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { nip: mocks.nip }, error: null }) }) }) };
    }
    if (tabela !== 'ledger_manual_entries') throw new Error(`nieoczekiwana tabela ${tabela}`);
    return {
      insert: (wiersz: Record<string, unknown>) => {
        mocks.wstawione.push(wiersz);
        return {
          select: () => ({
            single: async () =>
              mocks.bladWstawienia ? { data: null, error: mocks.bladWstawienia } : { data: { ...WIERSZ_WPISU, ...wiersz }, error: null },
          }),
        };
      },
      delete: () => {
        const lancuch = {
          eq: (kol: string, wartosc: unknown) => {
            mocks.filtryUsuniecia.push([kol, wartosc]);
            return lancuch;
          },
          select: async () => ({ data: mocks.usuniete, error: null }),
        };
        return lancuch;
      },
    };
  },
};

const { dodajWpisRecznyAction, pobierzJpkEwpAction, usunWpisRecznyAction } = await import('@/app/actions/ksiegowosc-ewidencja');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');
const { validateJpkEwp } = await import('@/lib/ksiegowosc/jpk-ewp-walidator');

const WPIS = { rodzaj: 'raport_kasy' as const, dataPrzychodu: '2026-03-31', dokument: ' RK/03/2026 ', kwota: '2 500,00', stawkaPb: 300, opis: '' };
const POBRANIE = { rok: 2026, doMiesiaca: 6, imie: 'Jan', nazwisko: 'Kowalski', dataUrodzenia: '1985-04-12' };

function zEwidencja(faktury: FakturaEwidencji[], wersje: WersjaProfilu[] = [RYCZALT]) {
  return { ok: true, ewidencja: zbudujEwidencje({ rok: 2026, faktury, wpisy: [], wersje, kursy: new Map() }), wpisy: [], wersje };
}

beforeEach(() => {
  mocks.requireOrgRole.mockReset().mockResolvedValue({ supabase, user: { id: 'u1' }, tenantId: 'firma-1', role: 'owner' });
  mocks.wlaczony = true;
  mocks.audit.mockReset();
  mocks.revalidate.mockReset();
  mocks.wersje = [RYCZALT];
  mocks.ewidencja = zEwidencja([FAKTURA]);
  mocks.urzad = '0202';
  mocks.nip = '1234567890';
  mocks.wstawione = [];
  mocks.bladWstawienia = null;
  mocks.usuniete = [WIERSZ_WPISU];
  mocks.filtryUsuniecia = [];
});

describe('dodanie wpisu ręcznego', () => {
  it('właściciel dodaje wpis: kolumny treści bez daty wpisu i autora, audyt z całym wpisem', async () => {
    expect(await dodajWpisRecznyAction(WPIS)).toEqual({ success: true });
    expect(mocks.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin']);
    expect(mocks.wstawione).toEqual([
      { tenant_id: 'firma-1', rodzaj: 'raport_kasy', data_przychodu: '2026-03-31', dokument: 'RK/03/2026', kwota_gr: 250000, stawka_pb: 300, opis: null },
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ledger_entry.created', entityType: 'ledger_manual_entry', metadata: { wpis: expect.objectContaining({ kwotaGr: 250000, dataWpisu: '2026-11-05' }) } }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith('/reports/ewidencja');
  });

  it('członek firmy dostaje odmowę z uprawnień, bez zapisu', async () => {
    mocks.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await dodajWpisRecznyAction(WPIS)).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
    expect(mocks.wstawione).toEqual([]);
  });

  it('zła kwota i data z przyszłości wracają przy polu, bez zapisu', async () => {
    expect(await dodajWpisRecznyAction({ ...WPIS, kwota: '12,345' })).toMatchObject({ success: false, pole: 'kwota' });
    expect(await dodajWpisRecznyAction({ ...WPIS, kwota: '0' })).toMatchObject({ success: false, pole: 'kwota' });
    expect(await dodajWpisRecznyAction({ ...WPIS, dataPrzychodu: '2026-11-06' })).toMatchObject({ success: false, pole: 'dataPrzychodu' });
    expect(mocks.wstawione).toEqual([]);
  });

  it('firma poza pilotażem, dzień bez profilu i dzień ze skalą to odmowa z wyjściem', async () => {
    mocks.wlaczony = false;
    expect(await dodajWpisRecznyAction(WPIS)).toMatchObject({ success: false, error: expect.stringContaining('nie jest jeszcze dostępna') });
    mocks.wlaczony = true;
    mocks.wersje = [{ ...RYCZALT, validFrom: '2026-06-01' }];
    expect(await dodajWpisRecznyAction(WPIS)).toMatchObject({ success: false, pole: 'dataPrzychodu', error: expect.stringContaining('„Ustawienia podatkowe”') });
    mocks.wersje = [{ ...RYCZALT, forma: 'skala', stawkaDomyslna: null }];
    expect(await dodajWpisRecznyAction(WPIS)).toMatchObject({ success: false, error: expect.stringContaining('skala podatkowa') });
    expect(mocks.wstawione).toEqual([]);
  });

  it('błąd zapisu: komunikat, bez audytu', async () => {
    mocks.bladWstawienia = { message: 'permission denied' };
    expect(await dodajWpisRecznyAction(WPIS)).toMatchObject({ success: false, error: expect.stringContaining('nic się nie zmieniło') });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('usunięcie wpisu ręcznego', () => {
  it('usuwa po id i firmie, audyt z usuniętą treścią', async () => {
    expect(await usunWpisRecznyAction(WIERSZ_WPISU.id)).toEqual({ success: true });
    expect(mocks.filtryUsuniecia).toEqual([['id', WIERSZ_WPISU.id], ['tenant_id', 'firma-1']]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ledger_entry.deleted', entityId: WIERSZ_WPISU.id, metadata: { wpis: expect.objectContaining({ dokument: 'RK/03/2026' }) } }),
    );
  });

  it('drugie usunięcie i zły identyfikator kończą się komunikatem, bez audytu', async () => {
    mocks.usuniete = [];
    expect(await usunWpisRecznyAction(WIERSZ_WPISU.id)).toEqual({ success: false, error: 'Tego wpisu już nie ma na liście.' });
    expect(await usunWpisRecznyAction('nie-uuid')).toMatchObject({ success: false });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('pobranie pliku JPK_EWP', () => {
  it('plik za część roku: „na żądanie”, zgodny z XSD MF, audyt bez danych osoby', async () => {
    const wynik = await pobierzJpkEwpAction(POBRANIE);
    if (!wynik.success) throw new Error(wynik.error);
    expect(wynik.nazwa).toBe('JPK_EWP_1234567890_2026-01-01_2026-06-30.xml');
    expect(wynik.xml).toContain('<CelZlozenia>0</CelZlozenia>');
    expect(wynik.xml).toContain('<KodUrzedu>0202</KodUrzedu>');
    expect((await validateJpkEwp(wynik.xml)).valid).toBe(true);
    const wpisAudytu = mocks.audit.mock.calls[0][0];
    expect(wpisAudytu).toMatchObject({ action: 'jpk_ewp.downloaded', metadata: { od: '2026-01-01', do: '2026-06-30', celZlozenia: 0, liczbaWierszy: 1, sumaGr: 10_000_00 } });
    expect(JSON.stringify(wpisAudytu)).not.toMatch(/Kowalski|1985/);
    // audit_logs.entity_id to uuid, a logAudit połyka błąd zapisu: okres jako
    // identyfikator gubił wpis po cichu (wyszło w przeglądarce na osobnej bazie).
    expect(wpisAudytu.entityId).toBeUndefined();
  });

  it('okres z brakiem, okres pusty, brak urzędu i zły NIP: odmowa z wyjściem, bez pliku i audytu', async () => {
    mocks.ewidencja = zEwidencja([FAKTURA], [{ ...RYCZALT, validFrom: '2026-06-01' }]);
    expect(await pobierzJpkEwpAction(POBRANIE)).toMatchObject({ success: false, error: expect.stringMatching(/dopóki ewidencja ma braki\. Faktura FV\/1\/2026/) });
    mocks.ewidencja = zEwidencja([]);
    expect(await pobierzJpkEwpAction(POBRANIE)).toMatchObject({ success: false, error: expect.stringContaining('plik JPK_EWP byłby pusty') });
    mocks.ewidencja = zEwidencja([FAKTURA]);
    mocks.urzad = null;
    expect(await pobierzJpkEwpAction(POBRANIE)).toMatchObject({ success: false, error: expect.stringContaining('urzędu skarbowego') });
    mocks.urzad = '0202';
    mocks.nip = '123';
    expect(await pobierzJpkEwpAction(POBRANIE)).toMatchObject({ success: false, error: expect.stringContaining('NIP firmy') });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('dane osoby sprawdzone przed plikiem; ewidencja nieczytelna daje jej komunikat', async () => {
    expect(await pobierzJpkEwpAction({ ...POBRANIE, imie: ' ' })).toMatchObject({ success: false, pole: 'imie' });
    expect(await pobierzJpkEwpAction({ ...POBRANIE, dataUrodzenia: '2030-01-01' })).toMatchObject({ success: false, pole: 'dataUrodzenia' });
    mocks.ewidencja = { ok: false, komunikat: 'Nie udało się odczytać danych ewidencji.' };
    expect(await pobierzJpkEwpAction(POBRANIE)).toEqual({ success: false, error: 'Nie udało się odczytać danych ewidencji.' });
  });

  it('księgowa firmy też pobiera plik', async () => {
    await pobierzJpkEwpAction(POBRANIE);
    expect(mocks.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'accountant']);
  });
});
