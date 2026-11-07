// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji, type WpisReczny } from '@/lib/ksiegowosc/ewidencja';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Strona „Ewidencja” (plan księgowości JDG, K3): 404 poza pilotażem, wiersze
 * i sumy miesiąca, brak sum przy brakach, stany karty JPK_EWP i widok
 * członka firmy bez formularza.
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
  numer: 'FV/7/2026',
  dataWystawienia: '2026-03-10',
  dataSprzedazy: '2026-03-10',
  rodzaj: 'zwykla',
  nettoGr: 10_000_00,
  waluta: 'PLN',
  numerKsef: null,
  fp: false,
  kontrahent: { kraj: 'PL', identyfikator: '1234567890' },
  rozliczoneZaliczkiGr: 0,
  pozycje: null,
};

const WPIS: WpisReczny = {
  id: 'w1',
  rodzaj: 'raport_kasy',
  dataPrzychodu: '2026-03-31',
  dataWpisu: '2026-04-02',
  dokument: 'RK/03/2026',
  kwotaGr: 2_500_00,
  stawkaPb: 300,
  opis: 'Sprzedaż z kasy',
};

const mocks = vi.hoisted(() => ({ wlaczony: true, rola: 'owner', wynik: null as unknown }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => ({ supabase: {}, tenantId: 'firma-1', role: mocks.rola }) }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }) }));
vi.mock('@/lib/ksiegowosc/ewidencja-dane', () => ({ czytajEwidencje: async () => mocks.wynik }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-05',
}));
vi.mock('@/app/actions/ksiegowosc-ewidencja', () => ({
  dodajWpisRecznyAction: vi.fn(),
  usunWpisRecznyAction: vi.fn(),
  pobierzJpkEwpAction: vi.fn(),
}));
vi.mock('@/components/expenses/finora/month-selector', () => ({
  default: (p: { month: string; basePath: string; query: string }) => (
    <span data-wybor-miesiaca={`${p.basePath}|${p.query}|${p.month}`} />
  ),
}));

const { default: EwidencjaPage } = await import('@/app/(dashboard)/reports/ewidencja/page');

function wynik(faktury: FakturaEwidencji[], wpisy: WpisReczny[] = [WPIS], wersje: WersjaProfilu[] = [RYCZALT]) {
  return { ok: true, ewidencja: zbudujEwidencje({ rok: 2026, faktury, wpisy, wersje, kursy: new Map() }), wpisy, wersje };
}

const strona = async (month = '3') => renderToStaticMarkup(await EwidencjaPage({ searchParams: Promise.resolve({ month, year: '2026' }) }));

beforeEach(() => {
  mocks.wlaczony = true;
  mocks.rola = 'owner';
  mocks.wynik = wynik([FAKTURA]);
});

describe('strona ewidencji', () => {
  it('firma poza pilotażem dostaje 404', async () => {
    mocks.wlaczony = false;
    await expect(strona()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('miesiąc: wiersze z faktury i z kasy, sumy według stawek i podpis „według Twoich danych”', async () => {
    const html = await strona();
    expect(html).toContain('data-wybor-miesiaca="/reports/ewidencja|month-year|2026-03"');
    expect(html).toContain('FV/7/2026');
    expect(html).toContain('RK/03/2026');
    expect(html).toMatch(/Przychód ze stawką 12 %.*10\s000,00 zł/);
    expect(html).toMatch(/Przychód ze stawką 3 %.*2\s500,00 zł/);
    expect(html).toMatch(/Razem.*12\s500,00 zł/);
    expect(html).toContain('Według Twoich danych i stawek ryczałtu na 2026 r.');
    expect(html).toContain('Dodaj wpis');
    expect(html).toContain('Pobierz JPK_EWP');
    expect(html).toMatch(/Plik od 01\.01\.2026 do 31\.03\.2026: wiersze 2/);
  });

  it('miesiąc z brakiem: lista braków bez sum, a plik czeka na uzupełnienie', async () => {
    mocks.wynik = wynik([FAKTURA], [WPIS], [{ ...RYCZALT, validFrom: '2026-03-20' }]);
    const html = await strona();
    expect(html).toContain('Braki w ewidencji za marzec 2026');
    expect(html).toContain('Faktura FV/7/2026 z 10.03.2026');
    expect(html).not.toContain('Razem');
    expect(html).toContain('powstanie, gdy ewidencja nie będzie mieć braków. Braki są w miesiącach: marzec 2026');
    expect(html).not.toContain('Pobierz JPK_EWP');
  });

  it('członek firmy: bez formularza i bez pobrania pliku, z informacją, kto to robi', async () => {
    mocks.rola = 'member';
    const html = await strona();
    expect(html).not.toContain('Dodaj wpis');
    expect(html).not.toContain('Pobierz JPK_EWP');
    expect(html).toContain('Wpisy dodaje i usuwa właściciel albo administrator firmy.');
    expect(html).toContain('Plik pobiera właściciel, administrator albo księgowa firmy.');
  });

  it('nieczytelna ewidencja: komunikat zamiast kwot; skala w całym roku: odesłanie do KPiR', async () => {
    mocks.wynik = { ok: false, komunikat: 'Nie udało się odczytać danych ewidencji.' };
    expect(await strona()).toContain('Nie udało się odczytać danych ewidencji.');
    mocks.wynik = wynik([], [], [{ ...RYCZALT, forma: 'skala', stawkaDomyslna: null }]);
    expect(await strona()).toContain('Przy skali i podatku liniowym przychody są w KPiR.');
  });

  it('teksty bez długich myślników', async () => {
    expect(await strona()).not.toMatch(/[—–]/);
  });
});
