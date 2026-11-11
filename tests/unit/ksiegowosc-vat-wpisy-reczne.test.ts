import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F11-A1 (przegląd wsteczny K6, waga krytyczna): sprzedaż z wpisów ręcznych
 * (raport z kasy rejestrującej, inny dowód; w KPiR kolumny 7 i 8) nie wchodzi
 * do VAT ani do JPK_V7M, bo `czytajVat` czyta tylko faktury i koszty. Czynny
 * podatnik VAT z kasą fiskalną widział P_38 = 0 i P_51 = 0. Wpisy nie mają
 * stawki VAT (art. 109 ust. 3 ustawy o VAT: ewidencja z podziałem na stawki),
 * więc FaktWay nie policzy z nich podatku; jedyne poprawne zachowanie to brak
 * z nazwą wpisu i wskazaniem, co dalej. Koszty z wpisów (np. wynagrodzenia)
 * nie zaniżają podatku należnego i nie blokują.
 */

const mocks = vi.hoisted(() => ({
  zwolnienie: null as string | null,
  ewidencja: [] as unknown[],
  kpir: [] as unknown[],
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/exports/data-fetcher', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/data-fetcher')>()),
  fetchInvoicesForExport: async () => ({ issuedInvoices: [], receivedInvoices: [], expenses: [] }),
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: async () => mocks.zwolnienie,
}));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/zapis', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wysylka-jpk/zapis')>()),
  czytajWysylki: async () => [],
}));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/certyfikaty', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wysylka-jpk/certyfikaty')>()),
  srodowiskoMf: () => null,
}));
vi.mock('@/lib/ksiegowosc/wpisy-reczne', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wpisy-reczne')>()),
  czytajWpisyReczne: async () => mocks.ewidencja,
  czytajWpisyKpir: async () => mocks.kpir,
}));

const { czytajVat } = await import('@/lib/ksiegowosc/vat-dane');

/** Rozliczenia `tax_settlements` puste: nadwyżka z wpisu klienta (0 zł). */
const client = {
  from: (tabela: string) => {
    if (tabela !== 'tax_settlements') throw new Error(tabela);
    const l: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in']) l[m] = () => l;
    l.order = async () => ({ data: [], error: null });
    return l;
  },
} as unknown as import('@supabase/supabase-js').SupabaseClient;

const raportKasy = {
  id: 'w1', rodzaj: 'raport_kasy', dataPrzychodu: '2026-10-15', dataWpisu: '2026-10-16',
  dokument: 'RK/10/2026', kwotaGr: 1_000_000, stawkaPb: 300, opis: null,
};
const kpir = (kolumna: string, dokument = 'DW/1/10/2026') => ({
  id: `k-${kolumna}`, rodzaj: 'inny', data: '2026-10-20', dokument, kolumna, kwotaGr: 500_000, opis: null,
});

beforeEach(() => {
  mocks.zwolnienie = null;
  mocks.ewidencja = [];
  mocks.kpir = [];
});

describe('F11-A1: VAT miesiąca a wpisy ręczne przychodu', () => {
  it('raport z kasy w ewidencji ryczałtu: brak z numerem wpisu i wyjściem, nie P_38 = 0', async () => {
    mocks.ewidencja = [raportKasy];
    const wynik = await czytajVat(client, 't1', '2026-10', 0);
    expect(wynik.ok).toBe(false);
    if (wynik.ok) return;
    expect(wynik.komunikat).toContain('RK/10/2026');
    expect(wynik.komunikat).toContain('poza FaktWay');
    expect(wynik.zwolniona).toBeUndefined();
  });

  it('przychód z wpisu KPiR (kolumna 7 albo 8): też brak', async () => {
    mocks.kpir = [kpir('k7'), kpir('k8', 'DW/2/10/2026')];
    const wynik = await czytajVat(client, 't1', '2026-10', 0);
    expect(wynik.ok).toBe(false);
    if (wynik.ok) return;
    expect(wynik.komunikat).toContain('DW/1/10/2026');
  });

  it('sam koszt z wpisu KPiR (kolumna 12, wynagrodzenia) nie blokuje: kwoty VAT są', async () => {
    mocks.kpir = [kpir('k12')];
    const wynik = await czytajVat(client, 't1', '2026-10', 0);
    expect(wynik.ok).toBe(true);
  });

  it('firma zwolniona z VAT (art. 113) z raportem z kasy: dalej „zwolniona”, bez braku o wpisach', async () => {
    mocks.zwolnienie = 'art. 113 ust. 1 ustawy o VAT';
    mocks.ewidencja = [raportKasy];
    const wynik = await czytajVat(client, 't1', '2026-10', 0);
    expect(wynik).toMatchObject({ ok: false, zwolniona: true });
  });
});
