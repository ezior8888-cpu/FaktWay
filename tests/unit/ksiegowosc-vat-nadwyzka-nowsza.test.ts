import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F11-A6: nadwyżka z poprzedniej deklaracji (P_39) z zatwierdzonych rozliczeń.
 * P_62 zatwierdzonego poprzedniego miesiąca wygrywało zawsze z P_39 zapisanym
 * przy zatwierdzeniu tego miesiąca, bez porównania, które zatwierdzenie jest
 * nowsze. Klient, który po korekcie deklaracji za wrzesień poza FaktWay wpisał
 * przy zatwierdzaniu października P_39 = 700 zł, widział potem VAT liczony
 * z 500 zł z wrześniowego zatwierdzenia. Teraz wygrywa nowsze zatwierdzenie;
 * bez czasów zatwierdzenia kolejność jak dotąd (poprzedni miesiąc).
 *
 * Atrapy jak w `ksiegowosc-vat-dane.test.ts`: baza, faktury, zwolnienie,
 * wysyłki; wybór źródła i silnik VAT prawdziwe.
 */

const mocks = vi.hoisted(() => ({ rozliczenia: [] as unknown[] }));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/exports/data-fetcher', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/data-fetcher')>()),
  fetchInvoicesForExport: async () => ({ issuedInvoices: [], receivedInvoices: [], expenses: [] }),
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: async () => null,
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
  czytajWpisyReczne: async () => [],
  czytajWpisyKpir: async () => [],
}));

const { czytajVat } = await import('@/lib/ksiegowosc/vat-dane');

const client = {
  from: (tabela: string) => {
    if (tabela !== 'tax_settlements') throw new Error(tabela);
    const l: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in']) l[m] = () => l;
    l.order = async () => ({ data: [...(mocks.rozliczenia as { wersja: number }[])].sort((x, y) => y.wersja - x.wersja), error: null });
    return l;
  },
} as unknown as import('@supabase/supabase-js').SupabaseClient;

const wrzesien = (p62Gr: number, zatwierdzoneO: string, wersja = 1) => ({
  okres: '2026-09-01',
  wersja,
  zatwierdzone_o: zatwierdzoneO,
  migawka: { wejscia: { nadwyzkaNaNastepnyGr: p62Gr } },
});
const pazdziernik = (p39Gr: number, zatwierdzoneO: string, wersja = 1) => ({
  okres: '2026-10-01',
  wersja,
  zatwierdzone_o: zatwierdzoneO,
  migawka: { wejscia: { nadwyzkaPoprzedniaGr: p39Gr } },
});

beforeEach(() => {
  mocks.rozliczenia = [];
});

describe('F11-A6: P_39 z nowszego zatwierdzenia', () => {
  it('październik zatwierdzony po wrześniu z innym P_39: wygrywa kwota z października', async () => {
    mocks.rozliczenia = [wrzesien(50_000, '2026-10-05T09:00:00+00:00'), pazdziernik(70_000, '2026-11-03T10:00:00+00:00')];
    const dane = await czytajVat(client, 't1', '2026-10', null);
    if (!dane.ok) throw new Error(dane.komunikat);
    expect(dane.nadwyzka).toEqual({ zl: 700, zrodlo: 'ten_miesiac' });
    expect(dane.wynik).toMatchObject({ ok: true, nadwyzkaPoprzedniaGr: 70_000 });
  });

  it('wrzesień zatwierdzony ponownie po październiku: wygrywa nowe P_62 września', async () => {
    mocks.rozliczenia = [
      wrzesien(50_000, '2026-10-05T09:00:00+00:00', 1),
      pazdziernik(50_000, '2026-11-03T10:00:00+00:00'),
      wrzesien(48_000, '2026-11-10T08:00:00+00:00', 2),
    ];
    const dane = await czytajVat(client, 't1', '2026-10', null);
    if (!dane.ok) throw new Error(dane.komunikat);
    expect(dane.nadwyzka).toEqual({ zl: 480, zrodlo: 'zatwierdzone' });
  });

  it('wpis klienta dalej wygrywa z oboma zatwierdzeniami', async () => {
    mocks.rozliczenia = [wrzesien(50_000, '2026-10-05T09:00:00+00:00'), pazdziernik(70_000, '2026-11-03T10:00:00+00:00')];
    expect(await czytajVat(client, 't1', '2026-10', 9)).toMatchObject({ nadwyzka: { zl: 9, zrodlo: 'klient' } });
  });
});
