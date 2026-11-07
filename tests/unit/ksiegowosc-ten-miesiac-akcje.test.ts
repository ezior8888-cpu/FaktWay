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
  czytajTenMiesiac: async () => mocks.dane,
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
  { rodzaj: 'ryczalt', kwotaGr: 155_600, termin: { faktyczny: '2026-11-20' }, wejscia: { a: 1 }, wejsciaHash: H('a') },
  { rodzaj: 'zus_spoleczne', kwotaGr: 192_676, spoleczneBezFpGr: 178_829, termin: { faktyczny: '2026-11-20' }, wejscia: { b: 1 }, wejsciaHash: H('b') },
  { rodzaj: 'zdrowotna', kwotaGr: 49_835, termin: { faktyczny: '2026-11-20' }, wejscia: { c: 1 }, wejsciaHash: H('c') },
];

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
  mocks.dane = { ok: true, wynik: {}, pozycje: POZYCJE, parametryWersja: 'abcd1234abcd1234', rozliczenia: [], wersje: [] };
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
    migawka: { spoleczneBezFpGr: 178829 },
    wejscia_hash: H('b'),
    zatwierdzone_o: '2026-11-02T10:00:00Z',
    zaplacone_o: null,
  };
  mocks.nowszych = 0;
  mocks.aktualizacje = [];
});

describe('zatwierdzenie miesiąca', () => {
  it('pierwsze zatwierdzenie: trzy rozliczenia w wersji 1, w jednym zapisie, z migawką i audytem', async () => {
    expect(await zatwierdzMiesiacAction('2026-10')).toEqual({ success: true, nowe: 3 });
    expect(mocks.wstawione).toHaveLength(1);
    expect(mocks.wstawione[0].map((w) => [w.rodzaj, w.wersja, w.kwota_gr, w.okres, w.termin])).toEqual([
      ['ryczalt', 1, 155_600, '2026-10-01', '2026-11-20'],
      ['zus_spoleczne', 1, 192_676, '2026-10-01', '2026-11-20'],
      ['zdrowotna', 1, 49_835, '2026-10-01', '2026-11-20'],
    ]);
    expect(mocks.wstawione[0][1]).toMatchObject({ migawka: { spoleczneBezFpGr: 178_829 }, wejscia_hash: H('b'), parametry_wersja: 'abcd1234abcd1234' });
    expect(mocks.wstawione[0][0]).not.toHaveProperty('zatwierdzone_przez');
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'tax_settlement.approved', metadata: expect.objectContaining({ miesiac: '2026-10' }) }));
  });

  it('dane bez zmian: nic nie zapisuje (drugie kliknięcie); zmiana jednego rozliczenia: tylko jego nowa wersja', async () => {
    mocks.dane = { ...(mocks.dane as object), rozliczenia: [rozliczenie('ryczalt', 1, H('a')), rozliczenie('zus_spoleczne', 1, H('b')), rozliczenie('zdrowotna', 1, H('c'))] };
    expect(await zatwierdzMiesiacAction('2026-10')).toEqual({ success: true, nowe: 0 });
    expect(mocks.wstawione).toEqual([]);
    mocks.dane = { ...(mocks.dane as object), rozliczenia: [rozliczenie('ryczalt', 1, H('9')), rozliczenie('zus_spoleczne', 1, H('b')), rozliczenie('zdrowotna', 1, H('c'))] };
    expect(await zatwierdzMiesiacAction('2026-10')).toEqual({ success: true, nowe: 1 });
    expect(mocks.wstawione[0].map((w) => [w.rodzaj, w.wersja])).toEqual([['ryczalt', 2]]);
  });

  it('miesiąc w trakcie, braki, wyłącznik i równoległe zatwierdzenie: odmowa z komunikatem, bez audytu', async () => {
    expect(await zatwierdzMiesiacAction('2026-11')).toMatchObject({ success: false, error: expect.stringContaining('po jego zakończeniu') });
    mocks.dane = { ok: false, braki: ['Parametry na 2026 r. czekają na sprawdzenie przez księgową.'], rozliczenia: [] };
    expect(await zatwierdzMiesiacAction('2026-10')).toEqual({ success: false, error: 'Parametry na 2026 r. czekają na sprawdzenie przez księgową.' });
    mocks.dane = { ok: true, wynik: {}, pozycje: POZYCJE, parametryWersja: 'x'.repeat(16), rozliczenia: [], wersje: [] };
    mocks.bladWstawienia = { code: '23505', message: 'duplicate' };
    expect(await zatwierdzMiesiacAction('2026-10')).toMatchObject({ success: false, error: expect.stringContaining('właśnie zatwierdził') });
    mocks.wlaczony = false;
    expect(await zatwierdzMiesiacAction('2026-10')).toMatchObject({ success: false, error: expect.stringContaining('nie jest jeszcze dostępne') });
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

  it('data z przyszłości albo sprzed miesiąca rozliczenia i starsza wersja: odmowa bez zmiany', async () => {
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-11-08' })).toMatchObject({ success: false });
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-09-30' })).toMatchObject({ success: false, error: expect.stringContaining('wcześniejsza') });
    mocks.nowszych = 1;
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-11-05' })).toMatchObject({ success: false, error: expect.stringContaining('nowsza wersja') });
    mocks.wiersz = null;
    expect(await oznaczZaplaconeAction({ id: ID, zaplacone: true, data: '2026-11-05' })).toMatchObject({ success: false, error: expect.stringContaining('nie ma') });
    expect(mocks.aktualizacje).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
