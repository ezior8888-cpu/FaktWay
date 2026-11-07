// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Karta „Odłóż na podatek” na Przepływach (plan księgowości JDG, K5, D13):
 * firma w pilotażu dostaje szacunek z modułu, pozostałe firmy, tryb
 * przykładowy i błąd odczytu wyłącznika: kartę jak dotąd (19 % liniowy).
 */

const mocks = vi.hoisted(() => ({
  pilotaz: true as boolean | 'blad',
  odczytyModulu: 0,
}));

vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async () => {
    if (mocks.pilotaz === 'blad') throw new Error('flaga');
    return { wlaczony: mocks.pilotaz };
  },
}));
vi.mock('@/lib/ksiegowosc/odlozyc', () => ({
  czytajOdlozyc: async () => {
    mocks.odczytyModulu++;
    return { ok: true, miesiac: '2026-11', kwotaGr: 429_334, przychodGr: 1_500_000, pozycje: [], braki: [] };
  },
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: async () => null,
}));
vi.mock('@/lib/dashboard/cash-flow', () => ({
  getCashFlowData: async () => ({ taxEstimate: { amount: 190, label: 'Szac. podatek od 1 stycznia', subtitle: '19% liniowy', fullYear: true } }),
}));

const { PierscienSlot } = await import('@/components/przeplywy/finora-1do1/sloty');

const karta = async (tryb: 'prawdziwe' | 'przyklad' = 'prawdziwe') =>
  renderToStaticMarkup(await PierscienSlot({ supabase: {} as never, tenantId: 't1', nowIso: '2026-11-07T10:00:00Z', tryb, kosztyKsefOd: null }));

beforeEach(() => {
  mocks.pilotaz = true;
  mocks.odczytyModulu = 0;
});

describe('karta „Odłóż na podatek”', () => {
  it('firma w pilotażu: szacunek za bieżący miesiąc z modułu', async () => {
    const html = await karta();
    // Linie w środku pierścienia rysuje wykres (bez wymiarów w renderze statycznym); sprawdza je test adaptera.
    expect(html).toContain('Szacunek za listopad 2026 z danych do dziś');
    expect(html).toContain('Według Twoich danych i stawek na 2026 r.');
    expect(html).not.toContain('liniowy');
  });

  it('poza pilotażem, w trybie przykładowym i przy błędzie odczytu wyłącznika: karta jak dotąd, bez odczytu modułu', async () => {
    mocks.pilotaz = false;
    expect(await karta()).toContain('Szacunek: liniowy, bez ZUS');
    mocks.pilotaz = true;
    expect(await karta('przyklad')).toContain('Szacunek: liniowy, bez ZUS');
    mocks.pilotaz = 'blad';
    expect(await karta()).toContain('Szacunek: liniowy, bez ZUS');
    expect(mocks.odczytyModulu).toBe(0);
  });
});
