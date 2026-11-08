import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje „Ten miesiąc” (plan księgowości JDG, K4, D6). Atrapy dla bazy,
 * uprawnień, wyłącznika, audytu i odczytu miesiąca; reguły wersji, dat
 * i zapłaty są prawdziwe. Niezmienność i RLS 00168 sprawdza
 * `tests/rls-ksiegowosc-rozliczenia.test.ts` na prawdziwej bazie.
 */

const H = (z: string) => z.repeat(64);

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  wlaczony: true,
  audit: vi.fn(),
  revalidate: vi.fn(),
  dane: null as unknown,
  wstawione: [] as Record<string, unknown>[][],
  bladWstawienia: null as { code?: string; message: string } | null,
  wiersz: null as Record<string, unknown> | null,
  nowszych: 0,
  aktualizacje: [] as Record<string, unknown>[],
  opcjeOdczytu: [] as unknown[],
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-07',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: mocks.wlaczony }) }));
vi.mock('@/lib/ksiegowosc/ten-miesiac-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>()),
  czytajTenMiesiac: async (_c: unknown, _t: string, _m: string, opcje?: unknown) => {
    mocks.opcjeOdczytu.push(opcje);
    return mocks.dane;
  },
}));

const lancuch = (wynik: () => unknown) => {
  const l: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gt']) l[m] = () => l;
  l.maybeSingle = async () => wynik();
  l.then = (ok: (v: unknown) => unknown) => Promise.resolve(wynik()).then(ok);
  return l;
};

const supabase = {
  from: (tabela: string) => {
    if (tabela !== 'tax_settlements') throw new Error(`nieoczekiwana tabela ${tabela}`);
    return {
      insert: async (wiersze: Record<string, unknown>[]) => {
        mocks.wstawione.push(wiersze);
        return { error: mocks.bladWstawienia };
      },
      select: (_kolumny: string, opcje?: { head?: boolean }) =>
        opcje?.head ? lancuch(() => ({ count: mocks.nowszych, error: null })) : lancuch(() => ({ data: mocks.wiersz, error: null })),
      update: (zmiana: Record<string, unknown>) => {
        mocks.aktualizacje.push(zmiana);
        return lancuch(() => ({ error: null }));
      },
    };
  },
};

const { oznaczZaplaconeAction, zatwierdzMiesiacAction } = await import('@/app/actions/ksiegowosc-ten-miesiac');

const POZYCJE = [
  { ok: true, rodzaj: 'ryczalt', kwotaGr: 155_600, termin: { faktyczny: '2026-11-20' }, wejscia: { a: 1 }, szczegoly: { lancuch: [] }, wejsciaHash: H('a') },
  { ok: true, rodzaj: 'zus_spoleczne', kwotaGr: 192_676, spoleczneBezFpGr: 178_829, termin: { faktyczny: '2026-11-20' }, wejscia: { b: 1 }, wejsciaHash: H('b') },
  { ok: true, rodzaj: 'zdrowotna', kwotaGr: 49_835, termin: { faktyczny: '2026-11-20' }, wejscia: { c: 1 }, wejsciaHash: H('c') },
];
/** Skróty, które widać na ekranie przy kliknięciu. */
const SKROTY = { ryczalt: H('a'), zus_spoleczne: H('b'), zdrowotna: H('c') };
const zatwierdz = (skroty: Record<string, string> = SKROTY, miesiac = '2026-10') => zatwierdzMiesiacAction({ miesiac, skroty });

const rozliczenie = (rodzaj: string, wersja: number, hash: string, z: Record<string, unknown> = {}) => ({
  id: `00168168-0000-4000-8000-00000000000${wersja}`,
  miesiac: '2026-10',
  rodzaj,
  wersja,
  kwotaGr: 100,
  termin: '2026-11-20',
  status: 'zatwierdzone',
  wejsciaHash: hash,
  zatwierdzoneO: '2026-11-02T10:00:00Z',
  zaplaconeO: null,
  spoleczneBezFpGr: 0,
  ...z,
});

beforeEach(() => {
  mocks.requireOrgRole.mockReset().mockResolvedValue({ supabase, user: { id: 'u1' }, tenantId: 'firma-1', role: 'owner' });
  mocks.wlaczony = true;
  mocks.audit.mockReset();
  mocks.revalidate.mockReset();
  mocks.dane = { ok: true, wynik: {}, pozycje: POZYCJE, parametryWersja: 'abcd1234abcd1234', rozliczenia: [] };
  mocks.wstawione = [];
  mocks.bladWstawienia = null;
  mocks.wiersz = {
    id: '00168168-0000-4000-8000-000000000001',
    okres: '2026-10-01',
    rodzaj: 'zus_spoleczne',
    wersja: 1,
    kwota_gr: 192676,
    termin: '2026-11-20',
    status: 'zatwierdzone',
    spoleczne_bez_fp: 178829,
    wejscia_hash: H('b'),
    zatwierdzone_o: '2026-11-02T10:00:00Z',
    zaplacone_o: null,
  };
  mocks.nowszych = 0;
  mocks.aktualizacje = [];
  mocks.opcjeOdczytu = [];
});

describe('zatwierdzenie miesiąca', () => {
  it('VAT (K7.1): nadwyżka z ekranu trafia do odczytu, a VAT zapisuje się z P_62 w migawce (P_39 następnego miesiąca)', async () => {
    const vat = {
      ok: true,
      rodzaj: 'vat',
      kwotaGr: 374_500,
      termin: { faktyczny: '2026-11-25' },
      wejscia: { naleznyGr: 690_000, nadwyzkaPoprzedniaGr: 120_000, naliczonyGr: 315_500, nadwyzkaNaNastepnyGr: 0 },
      szczegoly: { zrodloNadwyzki: 'klient' },
      wejsciaHash: H('d'),
    };
    mocks.dane = { ok: true, wynik: {}, pozycje: [...POZYCJE, vat], parametryWersja: 'abcd1234abcd1234', rozliczenia: [] };
    expect(await zatwierdzMiesiacAction({ miesiac: '2026-10', skroty: { ...SKROTY, vat: H('d') }, nadwyzkaVat: 1200 })).toEqual({ success: true, nowe: 4 });
    expect(mocks.opcjeOdczytu).toEqual([{ nadwyzkaVat: 1200 }]);
    expect(mocks.wstawione[0][3]).toMatchObject({ rodzaj: 'vat', kwota_gr: 374_500, termin: '2026-11-25', migawka: { wejscia: { nadwyzkaNaNastepnyGr: 0 } } });
    // Bez nadwyżki z ekranu odczyt dostaje null, a nie zgadnięte zero.
    mocks.wstawione = [];
    mocks.opcjeOdczytu = [];
    await zatwierdz();
    expect(mocks.opcjeOdczytu).toEqual([{ nadwyzkaVat: null }]);
  });

  it('pierwsze zatwierdzenie: trzy rozliczenia w wersji 1, w jednym zapisie, z migawką i audytem', async () => {
    expect(await zatwierdz()).toEqual({ success: true, nowe: 3 });
    expect(mocks.wstawione).toHaveLength(1);
    expect(mocks.wstawione[0].map((w) => [w.rodzaj, w.wersja, w.kwota_gr, w.okres, w.termin])).toEqual([
      ['ryczalt', 1, 155_600, '2026-10-01', '2026-11-20'],
      ['zus_spoleczne', 1, 192_676, '2026-10-01', '2026-11-20'],
      ['zdrowotna', 1, 49_835, '2026-10-01', '2026-11-20'],
    ]);
    expect(mocks.wstawione[0][1]).toMatchObject({ migawka: { spoleczneBezFpGr: 178_829 }, wejscia_hash: H('b'), parametry_wersja: 'abcd1234abcd1234' });
    expect(mocks.wstawione[0][0]).toMatchObject({ migawka: { szczegoly: { lancuch: [] } } });
    expect(mocks.wstawione[0][0]).not.toHaveProperty('zatwierdzone_przez');
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'tax_settlement.approved', metadata: expect.objectContaining({ miesiac: '2026-10' }) }));
  });

  it('dane bez zmian: nic nie zapisuje (drugie kliknięcie) i odświeża stronę; zmiana jednego rozliczenia: tylko jego nowa wersja', async () => {
    mocks.dane = { ...(mocks.dane as object), rozliczenia: [rozliczenie('ryczalt', 1, H('a')), rozliczenie('zus_spoleczne', 1, H('b')), rozliczenie('zdrowotna', 1, H('c'))] };
    expect(await zatwierdz()).toEqual({ success: true, nowe: 0 });
    expect(mocks.wstawione).toEqual([]);
    expect(mocks.revalidate).toHaveBeenCalledWith('/reports/ten-miesiac');
    mocks.dane = { ...(mocks.dane as object), rozliczenia: [rozliczenie('ryczalt', 1, H('9')), rozliczenie('zus_spoleczne', 1, H('b')), rozliczenie('zdrowotna', 1, H('c'))] };
    expect(await zatwierdz()).toEqual({ success: true, nowe: 1 });
    expect(mocks.wstawione[0].map((w) => [w.rodzaj, w.wersja])).toEqual([['ryczalt', 2]]);
  });

  it('kwota zmieniła się od otwarcia strony: odmowa bez zapisu i odświeżenie, żeby było widać nową kwotę', async () => {
    expect(await zatwierdz({ ...SKROTY, ryczalt: H('9') })).toMatchObject({ success: false, error: expect.stringContaining('zmieniły się od otwarcia strony') });
    expect(await zatwierdz({ zus_spoleczne: H('b'), zdrowotna: H('c') })).toMatchObject({ success: false });
    expect(mocks.wstawione).toEqual([]);
    expect(mocks.revalidate).toHaveBeenCalledWith('/reports/ten-miesiac');
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('pozycja z brakiem: zatwierdza tylko policzone rozliczenia', async () => {
    mocks.dane = { ...(mocks.dane as object), pozycje: [POZYCJE[0], { ok: false, rodzaj: 'zus_spoleczne', termin: null, brak: 'niepełny miesiąc' }, POZYCJE[2]] };
    expect(await zatwierdz({ ryczalt: H('a'), zdrowotna: H('c') })).toEqual({ success: true, nowe: 2 });
    expect(mocks.wstawione[0].map((w) => w.rodzaj)).toEqual(['ryczalt', 'zdrowotna']);
  });

  it('miesiąc w trakcie, braki, wyłącznik i równoległe zatwierdzenie: odmowa z komunikatem, bez audytu', async () => {
    expect(await zatwierdz(SKROTY, '2026-11')).toMatchObject({ success: false, error: expect.stringContaining('po jego zakończeniu') });
    mocks.dane = { ok: false, braki: ['Parametry na 2026 r. czekają na sprawdzenie przez księgową.'], rozliczenia: [] };
    expect(await zatwierdz()).toEqual({ success: false, error: 'Parametry na 2026 r. czekają na sprawdzenie przez księgową.' });
    mocks.dane = { ok: true, wynik: {}, pozycje: POZYCJE, parametryWersja: 'x'.repeat(16), rozliczenia: [] };
    mocks.bladWstawienia = { code: '23505', message: 'duplicate' };
    expect(await zatwierdz()).toMatchObject({ success: false, error: expect.stringContaining('właśnie zatwierdził') });
    mocks.wlaczony = false;
    expect(await zatwierdz()).toMatchObject({ success: false, error: expect.stringContaining('nie jest jeszcze dostępne') });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('oznaczenie zapłaty', () => {
  const ID = '00168168-0000-4000-8000-000000000001';

  it('zapłacone z datą i cofnięcie: zmienia tylko status i datę, audyt każdej zmiany', async () => {
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-11-05' })).toEqual({ success: true });
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: false, data: null })).toEqual({ success: true });
    expect(mocks.aktualizacje).toEqual([
      { status: 'zaplacone', zaplacone_o: '2026-11-05' },
      { status: 'zatwierdzone', zaplacone_o: null },
    ]);
    expect(mocks.audit.mock.calls.map((c) => c[0].action)).toEqual(['tax_settlement.paid', 'tax_settlement.unpaid']);
  });

  it('data z przyszłości albo sprzed miesiąca rozliczenia: odmowa bez zmiany', async () => {
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-11-08' })).toMatchObject({ success: false });
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-09-30' })).toMatchObject({
      success: false,
      error: 'Data zapłaty nie może być wcześniejsza niż miesiąc rozliczenia (październik 2026).',
    });
    mocks.wiersz = null;
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-11-05' })).toMatchObject({ success: false, error: expect.stringContaining('nie ma') });
    expect(mocks.aktualizacje).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('starsza wersja po zatwierdzeniu nowej: zapłatę da się zapisać albo poprawić', async () => {
    mocks.nowszych = 1;
    mocks.wiersz = { ...(mocks.wiersz as object), wersja: 1 };
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-11-05' })).toEqual({ success: true });
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: false, data: null })).toEqual({ success: true });
    expect(mocks.aktualizacje).toHaveLength(2);
  });
});
