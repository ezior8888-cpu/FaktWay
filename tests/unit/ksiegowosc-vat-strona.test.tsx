// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';

/**
 * Ekran VAT (plan księgowości JDG, K6): 404 poza pilotażem, pole na nadwyżkę
 * z poprzedniej deklaracji zamiast kwot, kafle P_38/P_48/P_51, termin
 * i mikrorachunek, plik do pobrania po końcu miesiąca, a wysyłka do MF tylko
 * przy włączonym obszarze `wysylka_jpk` i `JPK_MF_ENV`. Komponenty akcji to
 * atrapy, które pokazują, co dostają.
 */

const mocks = vi.hoisted(() => ({
  obszary: { vat: true, wysylka_jpk: false } as Record<string, boolean>,
  rola: 'owner',
  dane: null as unknown,
  nadwyzkaOdczytu: undefined as number | null | undefined,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({
    tenantId: 'firma-1',
    role: mocks.rola,
    user: { id: 'u-1', email: 'jan@example.test' },
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { nip: '1234563218' }, error: null }) }) }) }) },
  }),
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async (_c: unknown, _t: string, obszar: string) => ({ wlaczony: mocks.obszary[obszar] === true }),
}));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-07',
}));
vi.mock('@/components/expenses/finora/month-selector', () => ({ default: (p: { month: string }) => <span data-miesiac={p.month} /> }));
vi.mock('@/components/ksiegowosc/vat-akcje', () => ({
  NadwyzkaPoprzednia: (p: { wartosc: number | null }) => <span data-pole-nadwyzki={String(p.wartosc)} />,
  JpkV7mPobierz: (p: { miesiac: string; nadwyzka: number | null }) => <span data-pobierz={`${p.miesiac}:${p.nadwyzka}`} />,
  JpkV7mWyslij: (p: { rokKwoty: number; testowe: boolean; korekta: boolean; email: string | null }) => (
    <span data-wyslij={`${p.rokKwoty}:${p.testowe}:${p.korekta}:${p.email}`} />
  ),
  SprawdzStatus: (p: { id: string }) => <span data-status={p.id} />,
  PobierzUpo: (p: { id: string }) => <span data-upo={p.id} />,
}));
vi.mock('@/lib/ksiegowosc/vat-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/vat-dane')>()),
  czytajVat: async (_c: unknown, _t: string, _m: string, nadwyzka: number | null) => {
    mocks.nadwyzkaOdczytu = nadwyzka;
    return mocks.dane;
  },
}));

const { default: VatPage } = await import('@/app/(dashboard)/reports/vat/page');

const faktura = {
  invoiceNumber: 'FS/1/10',
  currency: 'PLN',
  invoiceType: 'regular',
  issueDate: '2026-10-05',
  buyerName: 'Klient',
  netTotal: 10000,
  vatTotal: 2300,
  grossTotal: 12300,
  lines: [{ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 10000, netAmount: 10000, vatRate: '23' }],
} as JpkInvoice;

function dane(z: Record<string, unknown> = {}) {
  return {
    ok: true,
    miesiac: '2026-10',
    dane: { issuer: { nip: '1234563218', name: 'Firma' }, issuedInvoices: [faktura], receivedInvoices: [], expenses: [] },
    nadwyzka: { zl: 300, zrodlo: 'klient' },
    wynik: vatMiesiaca({ sprzedaz: [faktura], koszty: [] }, 300),
    wysylki: [],
    ...z,
  };
}

const strona = async (sp: Record<string, string> = { month: '10', year: '2026' }) =>
  renderToStaticMarkup(await VatPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  mocks.obszary = { vat: true, wysylka_jpk: false };
  mocks.rola = 'owner';
  mocks.dane = dane();
  vi.unstubAllEnvs();
});

describe('ekran VAT', () => {
  it('poza pilotażem 404', async () => {
    mocks.obszary.vat = false;
    await expect(strona()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('kafle z części deklaracyjnej, termin 25 listopada i mikrorachunek z symbolem VAT-7; plik do pobrania z nadwyżką klienta', async () => {
    const html = await strona({ month: '10', year: '2026', nadwyzka: '300' });
    expect(mocks.nadwyzkaOdczytu).toBe(300);
    expect(html).toContain('Podatek należny (P_38)');
    expect(html).toContain('2300,00 zł');
    // P_48 to sama nadwyżka (300 zł), do wpłaty 2 000 zł.
    expect(html).toContain('Do wpłaty (P_51)');
    expect(html).toContain('2000,00 zł');
    expect(html).toContain('do 25.11.2026');
    expect(html).toContain('symbol formularza VAT-7, okres 26M10, identyfikator NIP 1234563218');
    expect(html).toContain('data-pobierz="2026-10:300"');
    expect(html).toContain('data-pole-nadwyzki="300"');
    // Odmiana przez liczebnik (w przeglądarce był „1 faktur” i „1 kosztów”).
    expect(html).toContain('1 faktura sprzedaży i 0 kosztów z VAT do odliczenia');
    // Wysyłka wyłączona: ani formularza, ani karty bez wysyłek.
    expect(html).not.toContain('data-wyslij');
    expect(html).not.toContain('Wysyłka do Ministerstwa Finansów');
  });

  it('nadwyżka nieznana: komunikat i pole zamiast kwot i pliku; zła wartość w adresie to brak wartości', async () => {
    mocks.dane = dane({ nadwyzka: null, wynik: null });
    const html = await strona({ month: '10', year: '2026', nadwyzka: '-5' });
    expect(mocks.nadwyzkaOdczytu).toBeNull();
    expect(html).toContain('potrzebna jest nadwyżka z deklaracji za wrzesień 2026');
    expect(html).toContain('data-pole-nadwyzki="null"');
    expect(html).not.toContain('P_38');
    expect(html).not.toContain('data-pobierz');
  });

  it('bieżący miesiąc: kwoty są, pliku jeszcze nie ma', async () => {
    mocks.dane = dane({ miesiac: '2026-11' });
    const html = await strona({ month: '11', year: '2026', nadwyzka: '300' });
    expect(html).toContain('powstaje po zakończeniu miesiąca');
    expect(html).not.toContain('data-pobierz');
  });

  it('wysyłka włączona (obszar i JPK_MF_ENV): formularz dla właściciela z rokiem kwoty przychodu; lista wysyłek ze statusem i UPO', async () => {
    vi.stubEnv('JPK_MF_ENV', 'test');
    mocks.obszary.wysylka_jpk = true;
    let html = await strona({ month: '10', year: '2026', nadwyzka: '300' });
    expect(html).toContain('data-wyslij="2024:true:false:jan@example.test"');

    const wysylka = (z: Record<string, unknown>) => ({
      id: 'w-1',
      okres: '2026-10-01',
      cel: 1,
      srodowisko: 'test',
      skrotPliku: 'x',
      deklaracja: { P_38: 2300, P_39: 300, P_48: 300, P_51: 2000, P_62: 0 },
      stan: 'w_toku',
      numerReferencyjny: 'b7a0810e02818670000000b92c9f5343',
      statusKod: 120,
      statusOpis: null,
      upoSciezka: null,
      blad: null,
      utworzonoO: '2026-11-07T10:00:00Z',
      wyslanoO: null,
      zakonczonoO: null,
      ...z,
    });
    mocks.dane = dane({ wysylki: [wysylka({}), wysylka({ id: 'w-2', stan: 'przyjeta', upoSciezka: 'upo/x.xml' }), wysylka({ id: 'w-3', stan: 'odrzucona', statusKod: 422 })] });
    html = await strona({ month: '10', year: '2026', nadwyzka: '300' });
    // Wysyłka w toku: bez drugiego formularza, ze sprawdzeniem statusu.
    expect(html).not.toContain('data-wyslij');
    expect(html).toContain('data-status="w-1"');
    expect(html).toContain('data-upo="w-2"');
    expect(html).toContain('MF sprawdza plik (środowisko testowe)');
    expect(html).toContain('osobą fizyczną');
    expect(html).toContain('Kod MF 422');

    // Wysyłka, która utknęła przed numerem ponad 15 minut temu, nie blokuje formularza; po przyjętej deklaracji to korekta.
    mocks.dane = dane({
      wysylki: [wysylka({ id: 'w-4', stan: 'wysylanie', numerReferencyjny: null, utworzonoO: '2026-11-01T10:00:00Z' }), wysylka({ id: 'w-2', stan: 'przyjeta', upoSciezka: 'upo/x.xml' })],
    });
    html = await strona({ month: '10', year: '2026', nadwyzka: '300' });
    expect(html).toContain('data-wyslij="2024:true:true:jan@example.test"');
    mocks.dane = dane({ wysylki: [wysylka({ id: 'w-5', stan: 'wysylanie', numerReferencyjny: null, utworzonoO: new Date().toISOString() })] });
    html = await strona({ month: '10', year: '2026', nadwyzka: '300' });
    expect(html).not.toContain('data-wyslij');

    // Członek bez uprawnień: lista bez sprawdzania statusu i bez formularza.
    mocks.dane = dane({ wysylki: [wysylka({}), wysylka({ id: 'w-2', stan: 'przyjeta', upoSciezka: 'upo/x.xml' })] });
    mocks.rola = 'member';
    html = await strona({ month: '10', year: '2026', nadwyzka: '300' });
    expect(html).not.toContain('data-status');
    expect(html).toContain('data-upo="w-2"');
  });

  it('firma zwolniona z VAT albo błąd odczytu: komunikat zamiast kwot', async () => {
    mocks.dane = { ok: false, komunikat: 'Firma korzysta ze zwolnienia z VAT (art. 113), więc nie składa JPK_V7M.' };
    const html = await strona();
    expect(html).toContain('art. 113');
    expect(html).not.toContain('P_38');
  });
});
