// @vitest-environment jsdom
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Strona „Ten miesiąc” i odczyt (plan księgowości JDG, K4): 404 poza
 * pilotażem, braki zamiast kwot, kafle, dane do przelewu, zatwierdzanie
 * i stany wersji; odczyt na prawdziwych (niesprawdzonych) parametrach 2026.
 */

const H = (z: string) => z.repeat(64);

const mocks = vi.hoisted(() => ({ wlaczony: true, rola: 'owner', dane: null as unknown, miesiacOdczytu: '' }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({
    tenantId: 'firma-1',
    role: mocks.rola,
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { nip: '1234563218' }, error: null }) }) }) }) },
  }),
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }) }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-07',
}));
vi.mock('@/app/actions/ksiegowosc-ten-miesiac', () => ({ zatwierdzMiesiacAction: vi.fn(), oznaczZaplaconeAction: vi.fn() }));
vi.mock('@/components/expenses/finora/month-selector', () => ({ default: (p: { month: string }) => <span data-miesiac={p.month} /> }));
vi.mock('@/lib/ksiegowosc/ten-miesiac-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>()),
  czytajTenMiesiac: async (_c: unknown, _t: string, miesiac: string) => {
    mocks.miesiacOdczytu = miesiac;
    return mocks.dane;
  },
}));

const { default: TenMiesiacPage } = await import('@/app/(dashboard)/reports/ten-miesiac/page');
const prawdziwe = await vi.importActual<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>('@/lib/ksiegowosc/ten-miesiac-dane');

const termin = { rodzaj: 'ryczalt', nominalny: '2026-11-20', faktyczny: '2026-11-20', przesuniety: false };
const POZYCJE = [
  { rodzaj: 'ryczalt', kwotaGr: 155_600, termin, wejscia: {}, wejsciaHash: H('a') },
  { rodzaj: 'zus_spoleczne', kwotaGr: 192_676, termin, wejscia: {}, wejsciaHash: H('b') },
  { rodzaj: 'zdrowotna', kwotaGr: 49_835, termin, wejscia: {}, wejsciaHash: H('c') },
];
const WYNIK = {
  miesiac: '2026-10',
  przychodGr: 1_500_000,
  skladki: { razemGr: 178_829, funduszPracyGr: 13_847 },
  zdrowotna: { przychodNarastajacoGr: 2_821_171, prog: 'do 60 tys.', skladkaGr: 49_835 },
  ryczalt: { ryczaltGr: 155_600, odliczenia: { odliczonoGr: 203_747, spoleczneZaplaconeGr: 178_829, zdrowotna50ProcGr: 24_918, nadwyzkaZPoprzednichGr: 0, nadwyzkaNaKolejneGr: 0 } },
};
const zatw = (rodzaj: string, hash: string, z: Record<string, unknown> = {}) => ({
  id: `id-${rodzaj}`,
  miesiac: '2026-10',
  rodzaj,
  wersja: 1,
  kwotaGr: 100_000,
  termin: '2026-11-20',
  status: 'zatwierdzone',
  wejsciaHash: hash,
  zatwierdzoneO: '2026-11-02T10:00:00Z',
  zaplaconeO: null,
  spoleczneBezFpGr: 0,
  ...z,
});
const dane = (rozliczenia: unknown[] = []) => ({ ok: true, wynik: WYNIK, pozycje: POZYCJE, parametryWersja: 'x', rozliczenia, wersje: [] });
const strona = async (sp: Record<string, string> = { month: '10', year: '2026' }) => renderToStaticMarkup(await TenMiesiacPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  mocks.wlaczony = true;
  mocks.rola = 'owner';
  mocks.dane = dane();
});

describe('strona „Ten miesiąc”', () => {
  it('firma poza pilotażem dostaje 404; bez parametrów w adresie liczy poprzedni miesiąc', async () => {
    await strona({});
    expect(mocks.miesiacOdczytu).toBe('2026-10');
    mocks.wlaczony = false;
    await expect(strona()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('kafle, terminy, mikrorachunek z NIP i „Zatwierdź miesiąc” po zakończeniu miesiąca', async () => {
    const html = await strona();
    expect(html).toMatch(/Ryczałt<\/p><p[^>]*>1556,00 zł/);
    expect(html).toContain('Termin: 20.11.2026');
    expect(html).toContain('symbol formularza PPE, okres 26M10, identyfikator NIP 1234563218');
    expect(html).toContain('Numer rachunku składkowego jest w PUE ZUS');
    expect(html).toContain('Niezatwierdzone.');
    expect(html).toContain('Zatwierdź miesiąc');
    expect(html).toContain('Według Twoich danych i stawek na 2026 r.');
  });

  it('zatwierdzone bez zmian: „Zapłacone” przy rozliczeniu; zmiana po zapłacie: nowa wersja i dopłata', async () => {
    mocks.dane = dane([zatw('ryczalt', H('a')), zatw('zus_spoleczne', H('b')), zatw('zdrowotna', H('c'))]);
    let html = await strona();
    expect(html).toContain('Zatwierdzone (wersja 1).');
    expect(html).toContain('Zapłacone');
    expect(html).toContain('Miesiąc jest zatwierdzony i dane się od tego czasu nie zmieniły.');
    mocks.dane = dane([zatw('ryczalt', H('9'), { status: 'zaplacone', zaplaconeO: '2026-11-05' }), zatw('zus_spoleczne', H('b')), zatw('zdrowotna', H('c'))]);
    html = await strona();
    expect(html).toMatch(/Dane zmieniły się po zatwierdzeniu.*dopłata to 556,00 zł/);
    expect(html).toContain('Zatwierdź nową wersję');
    expect(html).toContain('Historia wersji');
  });

  it('miesiąc w trakcie i członek firmy: bez przycisków, z informacją dlaczego', async () => {
    expect(await strona({ month: '11', year: '2026' })).toContain('Miesiąc zatwierdza się po jego zakończeniu');
    mocks.rola = 'member';
    const html = await strona();
    expect(html).not.toContain('Zatwierdź miesiąc');
    expect(html).toContain('Miesiąc zatwierdza i zapłaty oznacza właściciel albo administrator firmy.');
  });

  it('braki: lista zamiast kwot; teksty bez długich myślników', async () => {
    mocks.dane = { ok: false, braki: ['Parametry na 2026 r. czekają na sprawdzenie.'], rozliczenia: [] };
    const html = await strona();
    expect(html).toContain('Kwot za październik 2026 nie liczymy');
    expect(html).not.toContain('Do zapłaty');
    mocks.dane = dane();
    expect(await strona()).not.toMatch(/[—–]/);
  });
});

describe('odczyt „Ten miesiąc”', () => {
  const klient = (blad: { code: string; message: string } | null = null) => {
    const l: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'range']) l[m] = () => l;
    l.then = (ok: (v: unknown) => unknown) => Promise.resolve(blad ? { data: null, count: null, error: blad } : { data: [], count: 0, error: null }).then(ok);
    return { from: () => l } as unknown as SupabaseClient;
  };

  it('parametry 2026 niesprawdzone przez księgową: braki zamiast kwot (D7), także przed wgraniem 00168', async () => {
    const w = await prawdziwe.czytajTenMiesiac(klient({ code: 'PGRST205', message: 'brak tabeli' }), 'firma-1', '2026-10');
    expect(w.ok).toBe(false);
    expect(!w.ok && w.braki.length).toBeGreaterThan(0);
  });

  it('skrót wejść nie zależy od kolejności kluczy; aktualna wersja to najwyższa', () => {
    expect(prawdziwe.stabilnyJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(prawdziwe.stabilnyJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
    const r = (wersja: number) => ({ ...zatw('ryczalt', H('a')), wersja }) as never;
    expect(prawdziwe.aktualne([r(1), r(3), r(2)]).get('ryczalt')).toMatchObject({ wersja: 3 });
  });
});
