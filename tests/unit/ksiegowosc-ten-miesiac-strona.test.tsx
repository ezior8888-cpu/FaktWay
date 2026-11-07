// @vitest-environment jsdom
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Strona „Ten miesiąc” i odczyt (plan księgowości JDG, K4): 404 poza
 * pilotażem, braki zamiast kwot, kafle, dane do przelewu, zatwierdzanie,
 * stany wersji i zapłaty; odczyt na prawdziwych (niesprawdzonych) parametrach
 * 2026. Przyciski akcji to atrapy, które pokazują, co dostają.
 */

const H = (z: string) => z.repeat(64);

const mocks = vi.hoisted(() => ({
  wlaczony: true,
  rola: 'owner',
  dane: null as unknown,
  miesiacOdczytu: '',
  firma: { data: { nip: '1234563218' }, error: null } as { data: unknown; error: unknown },
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
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => mocks.firma }) }) }) },
  }),
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }) }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-07',
}));
vi.mock('@/components/ksiegowosc/ten-miesiac-akcje', () => ({
  ZatwierdzMiesiac: (p: { etykieta: string; skroty?: Record<string, string> }) => <button data-skroty={JSON.stringify(p.skroty ?? null)}>{p.etykieta}</button>,
  ZaplaconeRozliczenie: (p: { id: string; nazwa: string; zaplacone: boolean }) => (
    <span data-zaplata={p.id}>{p.zaplacone ? `Cofnij zapłatę: ${p.nazwa}` : `Zapłacone: ${p.nazwa}`}</span>
  ),
}));
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
  { ok: true, rodzaj: 'ryczalt', kwotaGr: 155_600, termin, wejscia: {}, wejsciaHash: H('a') },
  { ok: true, rodzaj: 'zus_spoleczne', kwotaGr: 192_676, termin, wejscia: {}, wejsciaHash: H('b') },
  { ok: true, rodzaj: 'zdrowotna', kwotaGr: 49_835, termin, wejscia: {}, wejsciaHash: H('c') },
];
const PROFIL = { id: 'p1', validFrom: '2026-01-01', forma: 'ryczalt', stawkaDomyslna: 1200, zusEtap: 'pelny', zusOd: null, chorobowe: true, nrsZus: null, najem: false };
const WYNIK = {
  miesiac: '2026-10',
  profil: PROFIL,
  przychodGr: 1_500_000,
  skladki: { razemGr: 178_829, funduszPracyGr: 13_847 },
  zdrowotna: { przychodNarastajacoGr: 2_821_171, prog: 'do 60 tys.', skladkaGr: 49_835 },
  ryczalt: {
    ryczaltGr: 155_600,
    odliczenia: { odliczonoGr: 203_747, spoleczneZaplaconeGr: 178_829, zdrowotna50ProcGr: 24_918, nadwyzkaZPoprzednichGr: 0, nadwyzkaNaKolejneGr: 0 },
    ujemneNaKolejneGr: new Map(),
  },
};
const zatw = (rodzaj: string, hash: string, z: Record<string, unknown> = {}) => ({
  id: `id-${rodzaj}-${String(z.wersja ?? 1)}`,
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
const dane = (rozliczenia: unknown[] = [], pozycje: unknown[] = POZYCJE) => ({ ok: true, wynik: { ...WYNIK, pozycje }, pozycje, parametryWersja: 'x', rozliczenia, wersje: [PROFIL] });
const strona = async (sp: Record<string, string> = { month: '10', year: '2026' }) => renderToStaticMarkup(await TenMiesiacPage({ searchParams: Promise.resolve(sp) }));
/** Tekst strony bez znaczników (sprawdza zdania niezależnie od podziału na elementy). */
const tekst = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  mocks.wlaczony = true;
  mocks.rola = 'owner';
  mocks.dane = dane();
  mocks.firma = { data: { nip: '1234563218' }, error: null };
});

describe('strona „Ten miesiąc”', () => {
  it('firma poza pilotażem dostaje 404; bez parametrów w adresie liczy poprzedni miesiąc', async () => {
    await strona({});
    expect(mocks.miesiacOdczytu).toBe('2026-10');
    mocks.wlaczony = false;
    await expect(strona()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('kafle Finory, terminy, mikrorachunek z NIP i „Zatwierdź miesiąc” ze skrótami, które widać na ekranie', async () => {
    const html = await strona();
    expect(html).toMatch(/1556,00 zł<\/h4><p[^>]*>Ryczałt/);
    expect(html).toMatch(/1926,76 zł<\/h4><p[^>]*>Składki społeczne/);
    expect(html).toContain('Termin: 20.11.2026');
    expect(html).toContain('symbol formularza PPE, okres 26M10, identyfikator NIP 1234563218');
    expect(html).toContain('Numer rachunku składkowego jest w PUE ZUS');
    expect(html).toContain('Niezatwierdzone.');
    expect(html).toContain('Zatwierdź miesiąc');
    expect(html).toContain(`data-skroty="${JSON.stringify({ ryczalt: H('a'), zus_spoleczne: H('b'), zdrowotna: H('c') }).replace(/"/g, '&quot;')}"`);
  });

  it('każda kwota ma podpis z rokiem stawek; w styczniu zdrowotna według roku składkowego', async () => {
    const t = tekst(await strona());
    expect(t).toContain('Według Twoich danych i stawek na 2026 r.');
    expect(t).not.toContain('r..');
    const styczen = tekst(await strona({ month: '1', year: '2026' }));
    expect(styczen).toContain('składka zdrowotna według stawek roku składkowego od lutego 2025 r. do stycznia 2026 r.');
  });

  it('zatwierdzone bez zmian: „Zapłacone” przy rozliczeniu i informacja, że dane się nie zmieniły', async () => {
    mocks.dane = dane([zatw('ryczalt', H('a')), zatw('zus_spoleczne', H('b')), zatw('zdrowotna', H('c'))]);
    const html = await strona();
    expect(html).toContain('Zatwierdzone (wersja 1).');
    expect(html).toContain('Zapłacone: Ryczałt od przychodów ewidencjonowanych');
    expect(html).toContain('Policzone kwoty są zatwierdzone i dane się od tego czasu nie zmieniły.');
    expect(html).not.toContain('Zatwierdź');
  });

  it('dane zmieniły się po zapłaconej wersji: dopłata od zapłaconej kwoty, a „Cofnij” tej wersji zostaje', async () => {
    mocks.dane = dane([zatw('ryczalt', H('9'), { kwotaGr: 150_000, status: 'zaplacone', zaplaconeO: '2026-11-05' }), zatw('zus_spoleczne', H('b')), zatw('zdrowotna', H('c'))]);
    const t = tekst(await strona());
    expect(t).toContain('Zapłacono 05.11.2026 (wersja 1: 1500,00 zł).');
    expect(t).toContain('Dane zmieniły się po zatwierdzeniu: nowa kwota 1556,00 zł czeka na zatwierdzenie; po zatwierdzeniu do dopłaty zostanie 56,00 zł.');
    expect(t).toContain('Cofnij zapłatę: Ryczałt od przychodów ewidencjonowanych');
    expect(t).toContain('Zatwierdź nową wersję');
  });

  it('dane zmieniły się przed oznaczeniem zapłaty: zapłatę zatwierdzonej wersji wciąż da się zapisać', async () => {
    mocks.dane = dane([zatw('ryczalt', H('9')), zatw('zus_spoleczne', H('b')), zatw('zdrowotna', H('c'))]);
    const t = tekst(await strona());
    expect(t).toContain('Dane zmieniły się po zatwierdzeniu: nowa kwota 1556,00 zł czeka na zatwierdzenie.');
    expect(t).toContain('Zapłacone: Ryczałt od przychodów ewidencjonowanych');
  });

  it('nowa wersja zatwierdzona po zapłacie poprzedniej: do zapłaty zostaje tylko dopłata, a starszą wersję da się poprawić w historii', async () => {
    mocks.dane = dane([
      zatw('ryczalt', H('9'), { kwotaGr: 150_000, status: 'zaplacone', zaplaconeO: '2026-11-05' }),
      zatw('ryczalt', H('a'), { wersja: 2, kwotaGr: 155_600 }),
      zatw('zus_spoleczne', H('b')),
      zatw('zdrowotna', H('c')),
    ]);
    const t = tekst(await strona());
    expect(t).toContain('Zatwierdzone (wersja 2: 1556,00 zł); wcześniejsza wersja jest zapłacona (1500,00 zł), więc do dopłaty zostaje 56,00 zł.');
    expect(t).toContain('Cofnij zapłatę: Ryczałt od przychodów ewidencjonowanych, wersja 1');
  });

  it('brak jednej pozycji: komunikat zamiast kwoty, kafel z wyjaśnieniem, reszta do zatwierdzenia', async () => {
    const pozycje = [POZYCJE[0], { ok: false, rodzaj: 'zus_spoleczne', termin, brak: 'Etap „Ulga na start” kończy się w trakcie miesiąca (wrzesień 2026).' }, POZYCJE[2]];
    mocks.dane = dane([], pozycje);
    const html = await strona();
    const t = tekst(html);
    expect(t).toContain('Etap „Ulga na start” kończy się w trakcie miesiąca (wrzesień 2026).');
    expect(t).toContain('Składki społeczne Kwoty nie liczymy; powód jest niżej, w „Do zapłaty”.');
    expect(html).toContain(`data-skroty="${JSON.stringify({ ryczalt: H('a'), zdrowotna: H('c') }).replace(/"/g, '&quot;')}"`);
  });

  it('błąd odczytu NIP: komunikat o odczycie, a nie odesłanie do ustawień', async () => {
    mocks.firma = { data: null, error: { message: 'timeout', code: '57014' } };
    const t = tekst(await strona());
    expect(t).toContain('Nie udało się odczytać NIP firmy');
    expect(t).not.toContain('a NIP jest w Ustawieniach');
  });

  it('miesiąc w trakcie i członek firmy: bez przycisków, z informacją dlaczego', async () => {
    expect(await strona({ month: '11', year: '2026' })).toContain('Miesiąc zatwierdza się po jego zakończeniu');
    mocks.rola = 'member';
    const html = await strona();
    expect(html).not.toContain('Zatwierdź miesiąc');
    expect(html).toContain('Miesiąc zatwierdza i zapłaty oznacza właściciel albo administrator firmy.');
  });

  it('braki całego miesiąca: lista zamiast kwot; teksty bez długich myślników', async () => {
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
    for (const m of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'range']) l[m] = () => l;
    l.then = (ok: (v: unknown) => unknown) => Promise.resolve(blad ? { data: null, count: null, error: blad } : { data: [], count: 0, error: null }).then(ok);
    return { from: () => l } as unknown as SupabaseClient;
  };

  it('parametry 2026 niesprawdzone przez księgową: braki zamiast kwot (D7), także przed wgraniem 00168', async () => {
    const w = await prawdziwe.czytajTenMiesiac(klient({ code: 'PGRST205', message: 'brak tabeli' }), 'firma-1', '2026-10');
    expect(w).toMatchObject({ ok: false, rozliczenia: [] });
    expect(!w.ok && w.braki).toEqual([
      expect.stringContaining('(ryczałt) czekają na sprawdzenie przez księgową'),
      expect.stringContaining('(składki ZUS) czekają na sprawdzenie przez księgową'),
      expect.stringContaining('(składka zdrowotna) czekają na sprawdzenie przez księgową'),
    ]);
  });

  it('skrót wejść nie zależy od kolejności kluczy; aktualna wersja to najwyższa', () => {
    expect(prawdziwe.stabilnyJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(prawdziwe.stabilnyJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
    const r = (wersja: number) => ({ ...zatw('ryczalt', H('a')), wersja }) as never;
    expect(prawdziwe.aktualne([r(1), r(3), r(2)]).get('ryczalt')).toMatchObject({ wersja: 3 });
  });
});
