// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { zbudujKpir, type KosztKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Zakładka „Ewidencja” przy skali i liniowym (plan księgowości JDG, K7):
 * KPiR zamiast ewidencji przychodów, wiersze i sumy miesiąca, braki bez sum,
 * wpisy ręczne z kolumną, karta JPK_PKPIR; ryczałt bez zmian.
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

const mocks = vi.hoisted(() => ({ rola: 'owner', wersje: [] as unknown[] | null, kpir: null as unknown, ewidencja: vi.fn() }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => ({ supabase: {}, tenantId: 'firma-1', role: mocks.rola }) }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: true }) }));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => {
    if (mocks.wersje === null) throw new Error('odczyt ustawień');
    return mocks.wersje;
  },
}));
vi.mock('@/lib/ksiegowosc/kpir-dane', () => ({ czytajKpir: async () => mocks.kpir }));
vi.mock('@/lib/ksiegowosc/ewidencja-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ewidencja-dane')>()),
  czytajEwidencje: mocks.ewidencja,
}));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-05',
}));
vi.mock('@/app/actions/ksiegowosc-ewidencja', () => ({
  dodajWpisRecznyAction: vi.fn(),
  dodajWpisKpirAction: vi.fn(),
  usunWpisRecznyAction: vi.fn(),
  pobierzJpkEwpAction: vi.fn(),
  pobierzJpkPkpirAction: vi.fn(),
}));
vi.mock('@/components/expenses/finora/month-selector', () => ({ default: () => <span data-wybor-miesiaca /> }));

const { default: EwidencjaPage } = await import('@/app/(dashboard)/reports/ewidencja/page');

const faktura = (dzien: string, gr: number): FakturaEwidencji => ({
  id: `f-${dzien}`,
  numer: `FV/${dzien}`,
  dataWystawienia: dzien,
  dataSprzedazy: dzien,
  rodzaj: 'zwykla',
  nettoGr: gr,
  waluta: 'PLN',
  numerKsef: '1234567890-20260310-0100001AF629-AF',
  fp: false,
  kontrahent: { kraj: 'PL', identyfikator: '5252241585', nazwa: 'Klient Sp. z o.o.', adres: 'Warszawa' },
  rozliczoneZaliczkiGr: 0,
  pozycje: null,
});
const koszt = (dzien: string, gr: number, kolumna: string | null = 'col_13'): KosztKpir => ({
  id: `k-${dzien}`,
  data: dzien,
  dowod: `FZ/${dzien}`,
  numerKsef: null,
  kontrahent: { nazwa: 'Dostawca', adres: null, kraj: null, identyfikator: null },
  opis: 'Usługi księgowe',
  kolumnaAplikacji: kolumna,
  kwotaGr: gr,
});

function wynik(koszty: KosztKpir[] = [koszt('2026-03-12', 30_000)]) {
  const wpisy = [{ id: 'w1', rodzaj: 'inny' as const, data: '2026-03-20', dokument: 'NOTA/1', kolumna: 'k8' as const, kwotaGr: 5_000, opis: 'Odsetki' }];
  return { ok: true, kpir: zbudujKpir({ rok: 2026, faktury: [faktura('2026-03-10', 1_000_000)], koszty, wpisy, wersje: [SKALA], kursy: new Map() }), wpisy, wersje: [SKALA] };
}

const strona = async () => renderToStaticMarkup(await EwidencjaPage({ searchParams: Promise.resolve({ month: '3', year: '2026' }) }));

beforeEach(() => {
  mocks.rola = 'owner';
  mocks.wersje = [SKALA];
  mocks.kpir = wynik();
  mocks.ewidencja.mockReset();
});

describe('KPiR w zakładce „Ewidencja”', () => {
  it('skala: KPiR za miesiąc z kontrahentem, kolumną i sumami; ewidencji przychodów nie czyta', async () => {
    const html = await strona();
    expect(html).toContain('KPiR, marzec 2026');
    expect(html).toContain('Klient Sp. z o.o.');
    expect(html).toContain('1234567890-20260310-0100001AF629-AF');
    expect(html).toContain('Pozostałe wydatki (13)');
    // Fundusz Pracy to koszt w KPiR, składki społeczne odlicza zaliczka (bez podwójnego odliczenia).
    expect(html).toContain('Fundusz Pracy i Fundusz Solidarnościowy z zapłaconych składek ZUS są kosztem w kolumnie 13');
    expect(html).toContain('Składek społecznych (a przy liniowym także zdrowotnej) KPiR nie zawiera');
    // Przychód 10 000 + 50 zł, koszty 300 zł, dochód 9 750 zł.
    expect(html).toMatch(/Razem w miesiącu.*10\s050,00 zł/);
    expect(html).toMatch(/Dochód w miesiącu.*9750,00 zł/);
    expect(html).toContain('Plik JPK_PKPIR');
    expect(html).toContain('Wpisy ręczne w KPiR');
    expect(html).toContain('Przychód: pozostałe przychody (8)');
    expect(mocks.ewidencja).not.toHaveBeenCalled();
  });

  it('brak w miesiącu: komunikat z wyjściem, bez sum i bez pliku', async () => {
    mocks.kpir = wynik([koszt('2026-03-12', 30_000, null)]);
    const html = await strona();
    expect(html).toContain('Braki w KPiR za marzec 2026');
    expect(html).toContain('Kolumnę KPiR ustawia się w Kosztach');
    expect(html).not.toContain('Razem w miesiącu');
    expect(html).toContain('powstanie, gdy KPiR nie będzie mieć braków');
  });

  it('członek firmy: bez formularza wpisu i bez pobrania pliku', async () => {
    mocks.rola = 'member';
    const html = await strona();
    expect(html).toContain('Wpisy dodaje i usuwa właściciel albo administrator firmy.');
    expect(html).toContain('Plik pobiera właściciel, administrator albo księgowa firmy.');
  });

  it('błąd odczytu ustawień podatkowych: komunikat zamiast ewidencji ryczałtu dla firmy, której formy nie znamy', async () => {
    mocks.wersje = null;
    const html = await strona();
    expect(html).toContain('Ewidencja jest chwilowo niedostępna');
    expect(html).toContain('Nie udało się odczytać danych ewidencji');
    expect(mocks.ewidencja).not.toHaveBeenCalled();
  });
});
