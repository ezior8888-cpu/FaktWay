import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Wysylka } from '@/lib/ksiegowosc/wysylka-jpk/zapis';

/**
 * Nadwyżka z poprzedniej deklaracji (P_39) w odczycie VAT (plan księgowości
 * JDG, K6 i K7.1): deklaracja przyjęta przez MF, potem kwota wpisana przez
 * klienta, potem P_62 rozliczenia VAT za poprzedni miesiąc zatwierdzonego
 * w „Ten miesiąc”, potem P_39 z zatwierdzonego rozliczenia tego miesiąca.
 * Bez żadnej z nich kwot nie ma. Atrapy dla bazy, faktur, zwolnienia
 * i wysyłek; silnik VAT i wybór źródła są prawdziwe.
 */

const mocks = vi.hoisted(() => ({
  zwolnienie: null as string | null,
  wysylki: [] as unknown[],
  srodowisko: null as 'test' | 'produkcja' | null,
  rozliczenia: [] as unknown[],
  bladRozliczen: null as { code: string; message: string } | null,
  filtry: [] as string[],
  bladFaktur: null as Error | null,
  sentry: { captureException: vi.fn() },
}));

vi.mock('@sentry/nextjs', () => mocks.sentry);
vi.mock('@/lib/exports/data-fetcher', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/data-fetcher')>()),
  fetchInvoicesForExport: async () => {
    if (mocks.bladFaktur) throw mocks.bladFaktur;
    return { issuedInvoices: [], receivedInvoices: [], expenses: [] };
  },
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: async () => mocks.zwolnienie,
}));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/zapis', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wysylka-jpk/zapis')>()),
  czytajWysylki: async () => mocks.wysylki,
}));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/certyfikaty', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wysylka-jpk/certyfikaty')>()),
  srodowiskoMf: () => mocks.srodowisko,
}));
// Wpisy ręczne przychodu blokują VAT (F11-A1, osobny test); tu ich nie ma.
vi.mock('@/lib/ksiegowosc/wpisy-reczne', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wpisy-reczne')>()),
  czytajWpisyReczne: async () => [],
  czytajWpisyKpir: async () => [],
}));

const sentry = mocks.sentry;
const { czytajVat, nadwyzkaZAdresu } = await import('@/lib/ksiegowosc/vat-dane');

const client = {
  from: (tabela: string) => {
    if (tabela !== 'tax_settlements') throw new Error(tabela);
    const l: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in']) {
      l[m] = (...a: unknown[]) => {
        mocks.filtry.push(`${m}:${a.map(String).join(',')}`);
        return l;
      };
    }
    // Najwyższa wersja najpierw, jak `order('wersja', { ascending: false })`.
    l.order = async (...a: unknown[]) => {
      mocks.filtry.push(`order:${String(a[0])}`);
      const wiersze = [...(mocks.rozliczenia as { wersja: number }[])].sort((x, y) => y.wersja - x.wersja);
      return { data: mocks.bladRozliczen ? null : wiersze, error: mocks.bladRozliczen };
    };
    return l;
  },
} as unknown as import('@supabase/supabase-js').SupabaseClient;

const wrzesien = (p62Gr: unknown, wersja = 2) => ({ okres: '2026-09-01', wersja, migawka: { wejscia: { nadwyzkaNaNastepnyGr: p62Gr } } });
const pazdziernik = (p39Gr: unknown, wersja = 1) => ({ okres: '2026-10-01', wersja, migawka: { wejscia: { nadwyzkaPoprzedniaGr: p39Gr } } });

const przyjetaZaWrzesien = (p62: number): Wysylka =>
  ({
    id: 'w1',
    okres: '2026-09-01',
    cel: 1,
    srodowisko: 'test',
    deklaracja: { P_62: p62 },
    stan: 'przyjeta',
    zakonczonoO: '2026-10-20T10:00:00Z',
  }) as unknown as Wysylka;

beforeEach(() => {
  mocks.zwolnienie = null;
  mocks.wysylki = [];
  mocks.srodowisko = null;
  mocks.rozliczenia = [];
  mocks.bladRozliczen = null;
  mocks.filtry = [];
  mocks.bladFaktur = null;
  mocks.sentry.captureException.mockClear();
});

describe('nadwyżka z poprzedniej deklaracji (P_39)', () => {
  it('bez MF i bez wpisu klienta: P_62 rozliczenia VAT za wrzesień zatwierdzonego w „Ten miesiąc”', async () => {
    mocks.rozliczenia = [wrzesien(100_000, 1), wrzesien(120_000, 2)];
    const dane = await czytajVat(client, 't1', '2026-10', null);
    if (!dane.ok) throw new Error(dane.komunikat);
    expect(dane.nadwyzka).toEqual({ zl: 1200, zrodlo: 'zatwierdzone' });
    expect(dane.wynik).toMatchObject({ ok: true, nadwyzkaPoprzedniaGr: 120_000 });
    // Najwyższa wersja rozliczeń VAT tej firmy za wrzesień i październik, jednym zapytaniem.
    expect(mocks.filtry).toEqual(['select:okres, wersja, migawka', 'eq:tenant_id,t1', 'eq:rodzaj,vat', 'in:okres,2026-09-01,2026-10-01', 'order:wersja']);
  });

  it('wpis klienta wygrywa z zatwierdzonym rozliczeniem, a deklaracja przyjęta przez MF z obydwoma', async () => {
    mocks.rozliczenia = [wrzesien(120_000)];
    expect((await czytajVat(client, 't1', '2026-10', 500)) as { nadwyzka: unknown }).toMatchObject({ nadwyzka: { zl: 500, zrodlo: 'klient' } });
    mocks.srodowisko = 'test';
    mocks.wysylki = [przyjetaZaWrzesien(300)];
    expect((await czytajVat(client, 't1', '2026-10', 500)) as { nadwyzka: unknown }).toMatchObject({ nadwyzka: { zl: 300, zrodlo: 'mf' } });
  });

  it('bez żadnego źródła kwot nie ma; kwota z groszami albo ujemna w migawce to też brak (bez zgadywania)', async () => {
    expect(await czytajVat(client, 't1', '2026-10', null)).toMatchObject({ ok: true, nadwyzka: null, wynik: null });
    mocks.rozliczenia = [wrzesien(12_345)];
    expect(await czytajVat(client, 't1', '2026-10', null)).toMatchObject({ ok: true, nadwyzka: null });
    mocks.rozliczenia = [wrzesien(-100)];
    expect(await czytajVat(client, 't1', '2026-10', null)).toMatchObject({ ok: true, nadwyzka: null });
  });

  it('zatwierdzony październik bez września: P_39 z jego własnej migawki, więc powrót na stronę nie gubi kwoty', async () => {
    mocks.rozliczenia = [pazdziernik(0)];
    const dane = await czytajVat(client, 't1', '2026-10', null);
    if (!dane.ok) throw new Error(dane.komunikat);
    expect(dane.nadwyzka).toEqual({ zl: 0, zrodlo: 'ten_miesiac' });
    expect(dane.wynik).toMatchObject({ ok: true, nadwyzkaPoprzedniaGr: 0 });
  });

  it('wrzesień zatwierdzony później z innym P_62 wygrywa z migawką października (korekta oznacza zmianę), a wpis klienta z obydwoma', async () => {
    mocks.rozliczenia = [pazdziernik(0), wrzesien(30_000)];
    expect(await czytajVat(client, 't1', '2026-10', null)).toMatchObject({ nadwyzka: { zl: 300, zrodlo: 'zatwierdzone' } });
    expect(await czytajVat(client, 't1', '2026-10', 7)).toMatchObject({ nadwyzka: { zl: 7, zrodlo: 'klient' } });
  });

  it('przed 00168 (brak tabeli rozliczeń): bez nadwyżki zatwierdzonej, nie awaria; inny błąd odczytu: błąd odczytu VAT', async () => {
    mocks.bladRozliczen = { code: 'PGRST205', message: 'brak tabeli' };
    expect(await czytajVat(client, 't1', '2026-10', 400)).toMatchObject({ ok: true, nadwyzka: { zl: 400, zrodlo: 'klient' } });
    mocks.bladRozliczen = { code: '57014', message: 'timeout' };
    expect(await czytajVat(client, 't1', '2026-10', 400)).toMatchObject({ ok: false, komunikat: expect.stringContaining('rozliczeń') });
  });

  it('firma zwolniona z VAT (art. 113): odmowa z oznaczeniem zwolnienia, nie błąd odczytu', async () => {
    mocks.zwolnienie = 'art. 113 ust. 1';
    expect(await czytajVat(client, 't1', '2026-10', null)).toMatchObject({ ok: false, zwolniona: true });
  });

  it('nadwyżka z adresu strony: pełne złote bez znaku, inaczej nic', () => {
    expect(nadwyzkaZAdresu('1200')).toBe(1200);
    expect(nadwyzkaZAdresu('0')).toBe(0);
    expect(nadwyzkaZAdresu('12,50')).toBeNull();
    expect(nadwyzkaZAdresu('-5')).toBeNull();
    expect(nadwyzkaZAdresu(undefined)).toBeNull();
  });
});

describe('F11-A4: stany trwałe z odczytu faktur to osobne komunikaty z wyjściem', () => {
  it('koszt z KSeF w walucie obcej czeka na kurs: komunikat o przeglądzie w Kosztach, bez Sentry', async () => {
    const { KsefExpenseCurrencyNotSupportedError } = await import('@/lib/expenses/ksef-currency-review');
    const { BLAD_ODCZYTU_VAT } = await import('@/lib/ksiegowosc/vat-dane');
    mocks.bladFaktur = new KsefExpenseCurrencyNotSupportedError();
    const w = await czytajVat(client, 'firma-1', '2026-10', 0);
    expect(w).toMatchObject({ ok: false, komunikat: expect.stringContaining('Przegląd jest w Kosztach') });
    expect(w).not.toEqual({ ok: false, komunikat: BLAD_ODCZYTU_VAT });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('przyjęte faktury bez środowiska KSeF: komunikat o zgłoszeniu w Pomocy, bez Sentry', async () => {
    const { AcceptedInvoiceEnvironmentIncompleteError } = await import('@/lib/ksef/accounting-provenance');
    mocks.bladFaktur = new AcceptedInvoiceEnvironmentIncompleteError();
    const w = await czytajVat(client, 'firma-1', '2026-10', 0);
    expect(w).toMatchObject({ ok: false, komunikat: expect.stringContaining('Pomocy') });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('inny błąd (także niedostępna kontrola środowiska) zostaje błędem odczytu z Sentry', async () => {
    const { BLAD_ODCZYTU_VAT } = await import('@/lib/ksiegowosc/vat-dane');
    mocks.bladFaktur = new Error('KSeF environment reconciliation check is unavailable');
    expect(await czytajVat(client, 'firma-1', '2026-10', 0)).toEqual({ ok: false, komunikat: BLAD_ODCZYTU_VAT });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
