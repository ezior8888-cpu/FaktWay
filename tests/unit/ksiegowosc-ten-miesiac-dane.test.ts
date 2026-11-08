import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ewidencja, WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import type { Brak } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Odczyt „Ten miesiąc” (plan księgowości JDG, K4): które rozliczenia czyta
 * baza, bramka D7 dla każdej pozycji osobno i skrót wersji (D6). Atrapy dla
 * bazy i ewidencji, silnik i parametry 2026/2027 są prawdziwe.
 */

const mocks = vi.hoisted(() => ({
  brakujace: null as null | ((rok: number, sekcje: readonly string[]) => Brak[]),
  zmienOpisy: false,
  wiersze: [] as Record<string, unknown>[],
  filtry: [] as string[],
  ewidencja: null as unknown,
  kpir: null as null | ((rok: number) => unknown),
  kpirLata: [] as number[],
  kpirWersje: [] as unknown[],
  kpirWKodzie: true,
  vatWKodzie: true,
  vat: null as unknown,
  vatWywolania: [] as { miesiac: string; nadwyzka: number | null }[],
}));

vi.mock('@/lib/ksiegowosc/parametry', async (orig) => {
  const prawdziwe = await orig<typeof import('@/lib/ksiegowosc/parametry')>();
  return {
    ...prawdziwe,
    brakujace: (rok: number, sekcje: readonly import('@/lib/ksiegowosc/parametry').NazwaSekcji[]) =>
      mocks.brakujace ? mocks.brakujace(rok, sekcje) : [],
    parametryRoku: (rok: number) => {
      const p = prawdziwe.parametryRoku(rok);
      if (!p || !mocks.zmienOpisy) return p;
      const kopia = structuredClone(p);
      kopia.ryczalt.liczby.stawka12.uwagi = 'inny opis';
      kopia.zus.sprawdzila = { kto: 'ktoś inny', data: '2027-01-01' };
      return kopia;
    },
  };
});
vi.mock('@/lib/ksiegowosc/ewidencja-dane', () => ({ czytajEwidencje: async () => mocks.ewidencja }));
vi.mock('@/lib/ksiegowosc/wylacznik', async (orig) => {
  const prawdziwy = await orig<typeof import('@/lib/ksiegowosc/wylacznik')>();
  return {
    ...prawdziwy,
    statusObszaru: (obszar: import('@/lib/ksiegowosc/wylacznik').ObszarModulu) =>
      (obszar === 'kpir' && !mocks.kpirWKodzie) || (obszar === 'vat' && !mocks.vatWKodzie)
        ? { wlaczony: false, powod: 'nie_zbudowane' as const }
        : prawdziwy.statusObszaru(obszar),
  };
});
// VAT (K7.1): odczyt VAT ma własne testy (`ksiegowosc-vat-dane`); tu tylko to, co z nim robi „Ten miesiąc”.
vi.mock('@/lib/ksiegowosc/vat-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/vat-dane')>()),
  czytajVat: async (_c: unknown, _t: string, miesiac: string, nadwyzka: number | null) => {
    mocks.vatWywolania.push({ miesiac, nadwyzka });
    return mocks.vat ?? { ok: false, komunikat: 'Firma korzysta ze zwolnienia z VAT (art. 113), więc nie składa JPK_V7M.', zwolniona: true };
  },
}));
vi.mock('@/lib/ksiegowosc/kpir-dane', () => ({
  czytajKpir: async (_c: unknown, _t: string, rok: number, opcje: { wersje?: unknown[] } = {}) => {
    mocks.kpirLata.push(rok);
    mocks.kpirWersje.push(opcje.wersje);
    return mocks.kpir?.(rok);
  },
}));
// Od K7 odczyt bierze wersje profilu osobno (forma decyduje: ewidencja czy KPiR); te same co w atrapie ewidencji.
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => (mocks.ewidencja as { wersje?: unknown[] } | null)?.wersje ?? [],
}));

const { czytajRozliczenia, czytajTenMiesiac } = await import('@/lib/ksiegowosc/ten-miesiac-dane');
const { zbudujKpir } = await import('@/lib/ksiegowosc/kpir');

// Preferencyjny ZUS: jego liczby na 2027 r. są znane (pełny czeka na prognozowane przeciętne wynagrodzenie).
const PROFIL: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'preferencyjny',
  zusOd: '2026-01-01',
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

function wiersz(dzien: string, gr: number): WierszEwidencji {
  return {
    lp: 0,
    dataWpisu: dzien,
    dataPrzychodu: dzien,
    dowod: `D/${dzien}`,
    numerKsef: null,
    krajKontrahenta: null,
    idKontrahenta: null,
    kwotaGr: gr,
    stawkaPb: 1200,
    uwagi: null,
    zrodlo: { typ: 'wpis', id: `w-${dzien}` },
  };
}

const ewidencja = (rok: number, wiersze: WierszEwidencji[]): Ewidencja => ({ rok, wiersze, braki: [], pominiete: [], ryczaltWRoku: true });

const rozliczenie = (okres: string, rodzaj: string, kwota: number, zaplaconeO: string | null, bezFp = 0, wersja = 1) => ({
  id: `00168168-0000-4000-8000-${okres.replace(/-/g, '')}${String(wersja).padStart(2, '0')}${rodzaj.length}`,
  okres,
  rodzaj,
  wersja,
  kwota_gr: kwota,
  termin: '2027-01-20',
  status: zaplaconeO ? 'zaplacone' : 'zatwierdzone',
  wejscia_hash: 'a'.repeat(64),
  zatwierdzone_o: '2026-12-01T10:00:00Z',
  zaplacone_o: zaplaconeO,
  spoleczne_bez_fp: bezFp,
});

const client = {
  from: (tabela: string) => {
    if (tabela !== 'tax_settlements') throw new Error(tabela);
    const l: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'lte', 'gte', 'or', 'order']) {
      l[m] = (...a: unknown[]) => {
        mocks.filtry.push(`${m}:${a.filter((x) => typeof x === 'string').join(',')}`);
        return l;
      };
    }
    l.range = async () => {
      const posortowane = [...mocks.wiersze].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return { data: posortowane, count: posortowane.length, error: null };
    };
    return l;
  },
} as unknown as import('@supabase/supabase-js').SupabaseClient;

beforeEach(() => {
  mocks.brakujace = null;
  mocks.zmienOpisy = false;
  mocks.wiersze = [];
  mocks.filtry = [];
  mocks.ewidencja = { ok: true, ewidencja: ewidencja(2027, [wiersz('2027-01-20', 1_500_000)]), wersje: [PROFIL], wpisy: [] };
  mocks.kpir = null;
  mocks.kpirLata = [];
  mocks.kpirWersje = [];
  mocks.kpirWKodzie = true;
  mocks.vatWKodzie = true;
  mocks.vat = null;
  mocks.vatWywolania = [];
});

describe('odczyt rozliczeń', () => {
  it('czyta wersje miesiąca i wszystkie zapłacone wersje do tego miesiąca, nie tylko od grudnia', async () => {
    await czytajRozliczenia(client, 't1', '2027-01');
    expect(mocks.filtry).toContain('lte:okres,2027-01-01');
    // Od K7.2 także zapłaty spoza wyliczenia jeszcze bez daty (lista z wyjściem na stronie).
    expect(mocks.filtry).toContain('or:okres.eq.2027-01-01,status.eq.zaplacone,migawka->>reczna.eq.true');
    expect(mocks.filtry.some((f) => f.startsWith('gte:okres'))).toBe(false);
  });

  it('zaległe składki za listopad zapłacone w styczniu pomniejszają ryczałt za styczeń', async () => {
    mocks.wiersze = [rozliczenie('2026-11-01', 'zus_spoleczne', 192_676, '2027-01-08', 178_829)];
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(dane.wynik.ryczalt?.odliczenia.spoleczneZaplaconeGr).toBe(178_829);
    // Historia pokazuje tylko wersje stycznia.
    expect(dane.rozliczenia).toEqual([]);
  });
});

describe('bramka D7 dla każdej pozycji', () => {
  it('liczba bez wartości w sekcji (stopa wypadkowa od kwietnia 2027) nie zabiera stycznia', async () => {
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(dane.pozycje.map((p) => [p.rodzaj, p.ok])).toEqual([
      ['ryczalt', true],
      ['zus_spoleczne', true],
      ['zdrowotna', true],
    ]);
  });

  it('niesprawdzona sekcja zdrowotnej daje brak samej zdrowotnej, z komunikatem dla klienta', async () => {
    mocks.brakujace = (rok, sekcje) =>
      sekcje.includes('zdrowotna') ? [{ sekcja: 'zdrowotna', powod: 'niesprawdzone', komunikat: `Stawki na ${rok} r. czekają na sprawdzenie.`, operator: '' }] : [];
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    const zdrowotna = dane.pozycje.find((p) => p.rodzaj === 'zdrowotna');
    expect(zdrowotna).toMatchObject({ ok: false, brak: 'Stawki na 2026 r. czekają na sprawdzenie.' });
    expect(dane.wynik.zdrowotna).toBeNull();
    expect(dane.pozycje.filter((p) => p.ok).map((p) => p.rodzaj)).toEqual(['ryczalt', 'zus_spoleczne']);
  });

  it('wszystkie sekcje niesprawdzone: braki zamiast kwot i bez czytania ewidencji', async () => {
    mocks.brakujace = (_rok, sekcje) => sekcje.map((s) => ({ sekcja: s as 'zus', powod: 'niesprawdzone' as const, komunikat: `czeka: ${s}`, operator: '' }));
    mocks.ewidencja = null;
    expect(await czytajTenMiesiac(client, 't1', '2027-01')).toMatchObject({ ok: false, braki: ['czeka: ryczalt', 'czeka: zus', 'czeka: zdrowotna'] });
  });
});

describe('zapłata spoza wyliczenia (K7.2, D15)', () => {
  it('oznaczenie z migawki, lista zapłaconych w tym miesiącu i jeszcze bez daty, także przy brakach; odliczenie jak każda zapłata', async () => {
    mocks.wiersze = [
      { ...rozliczenie('2025-12-01', 'zus_spoleczne', 192_676, '2027-01-15', 178_829), reczna: true },
      { ...rozliczenie('2026-11-01', 'zdrowotna', 43_254, null), reczna: true },
      { ...rozliczenie('2026-10-01', 'zdrowotna', 43_254, '2026-11-10'), reczna: true },
    ];
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(dane.zaplatyReczne.map((r) => [r.miesiac, r.rodzaj, r.status, r.reczna])).toEqual([
      ['2025-12', 'zus_spoleczne', 'zaplacone', true],
      ['2026-11', 'zdrowotna', 'zatwierdzone', true],
    ]);
    // Zapłata w styczniu za grudzień 2025 r. pomniejsza ryczałt za styczeń jak każda zapłata składek.
    expect(dane.wynik.ryczalt?.odliczenia.spoleczneZaplaconeGr).toBe(178_829);
    expect(mocks.filtry).toContain('or:okres.eq.2027-01-01,status.eq.zaplacone,migawka->>reczna.eq.true');

    mocks.brakujace = (_rok, sekcje) => sekcje.map((x) => ({ sekcja: x as 'zus', powod: 'niesprawdzone' as const, komunikat: `czeka: ${x}`, operator: '' }));
    const zBrakami = await czytajTenMiesiac(client, 't1', '2027-01');
    expect(zBrakami).toMatchObject({ ok: false, zaplatyReczne: [{ miesiac: '2025-12' }, { miesiac: '2026-11' }] });
  });
});

describe('skrót wersji (D6)', () => {
  it('poprawka opisu albo potwierdzenia w parametrach nie zmienia skrótu żadnego rozliczenia', async () => {
    const przed = await czytajTenMiesiac(client, 't1', '2027-01');
    mocks.zmienOpisy = true;
    const po = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!przed.ok || !po.ok) throw new Error('brak');
    const skroty = (d: typeof przed) => d.pozycje.map((p) => (p.ok ? p.wejsciaHash : null));
    expect(skroty(po)).toEqual(skroty(przed));
    expect(skroty(przed).every((s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s))).toBe(true);
  });
});

describe('odczyt przy skali i liniowym (K7)', () => {
  const SKALA: WersjaProfilu = { ...PROFIL, forma: 'skala', stawkaDomyslna: null };
  // Przychód 10 000 zł 15. dnia każdego miesiąca (wpis ręczny w kolumnie 7).
  const kpirRoku = (rok: number) => {
    const wpisy = Array.from({ length: 12 }, (_, i) => ({
      id: `w-${rok}-${i + 1}`,
      data: `${rok}-${String(i + 1).padStart(2, '0')}-15`,
      dokument: `RK/${i + 1}`,
      kolumna: 'k7' as const,
      kwotaGr: 1_000_000,
      opis: null,
    }));
    return { ok: true, kpir: zbudujKpir({ rok, faktury: [], koszty: [], wpisy, wersje: [SKALA], kursy: new Map() }), wpisy: [], wersje: [SKALA] };
  };

  beforeEach(() => {
    mocks.ewidencja = { ok: true, ewidencja: ewidencja(2027, []), wersje: [SKALA], wpisy: [] };
    mocks.kpir = kpirRoku;
  });

  it('styczeń: KPiR roku i grudnia poprzedniego roku, z wersjami profilu z odczytu; zaliczka, składki i zdrowotna od dochodu z grudnia', async () => {
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(mocks.kpirLata).toEqual([2027, 2026]);
    expect(mocks.kpirWersje).toEqual([[SKALA], [SKALA]]);
    expect(dane.pozycje.map((p) => [p.rodzaj, p.ok])).toEqual([
      ['pit', true],
      ['zus_spoleczne', true],
      ['zdrowotna', true],
    ]);
    // 9 % z 10 000 zł dochodu grudnia 2026 r. (bez zapłaconych składek).
    expect(dane.wynik.zdrowotnaOdDochodu).toMatchObject({ dochodGr: 1_000_000, skladkaGr: 90_000 });
    expect(dane.wynik.pit).toMatchObject({ dochodNarastajacoGr: 1_000_000 });
  });

  it('bramka D7 według formy: niesprawdzona skala zabiera tylko zaliczkę, niesprawdzony ryczałt nic', async () => {
    mocks.brakujace = (_rok, sekcje) =>
      sekcje.includes('skala') ? [{ sekcja: 'skala', powod: 'niesprawdzone', komunikat: 'Skala czeka na sprawdzenie.', operator: '' }] : [];
    const dane = await czytajTenMiesiac(client, 't1', '2027-02');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(dane.pozycje.find((p) => p.rodzaj === 'pit')).toMatchObject({ ok: false, brak: 'Skala czeka na sprawdzenie.' });
    expect(dane.wynik.pit).toBeNull();
    expect(dane.pozycje.filter((p) => p.ok).map((p) => p.rodzaj)).toEqual(['zus_spoleczne', 'zdrowotna']);
    expect(mocks.kpirLata).toEqual([2027]);

    mocks.brakujace = (_rok, sekcje) =>
      sekcje.includes('ryczalt') ? [{ sekcja: 'ryczalt', powod: 'niesprawdzone', komunikat: 'Ryczałt czeka.', operator: '' }] : [];
    const zRyczaltem = await czytajTenMiesiac(client, 't1', '2027-02');
    if (!zRyczaltem.ok) throw new Error(zRyczaltem.braki.join(' '));
    expect(zRyczaltem.pozycje.every((p) => p.ok)).toBe(true);
  });

  it('styczeń, KPiR poprzedniego roku z brakiem odczytu: zdrowotna podaje przyczynę i wyjście, zaliczka się liczy', async () => {
    const komunikat = 'Część kosztów z KSeF jest w walucie obcej i czeka na przegląd kursu, więc KPiR teraz nie liczymy. Przegląd jest w Kosztach.';
    mocks.kpir = (rok) => (rok === 2026 ? { ok: false, komunikat } : kpirRoku(rok));
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(dane.pozycje.find((p) => p.rodzaj === 'zdrowotna')).toMatchObject({ ok: false, brak: expect.stringContaining(komunikat) });
    expect(dane.pozycje.find((p) => p.rodzaj === 'pit')).toMatchObject({ ok: true });
  });

  it('obszar `kpir` zablokowany w kodzie: braki zamiast kwot, KPiR nieczytana; ryczałt liczy się dalej', async () => {
    mocks.kpirWKodzie = false;
    const dane = await czytajTenMiesiac(client, 't1', '2027-02');
    expect(dane).toMatchObject({ ok: false, braki: [expect.stringContaining('chwilowo wyłączone')] });
    expect(mocks.kpirLata).toEqual([]);
    mocks.ewidencja = { ok: true, ewidencja: ewidencja(2027, [wiersz('2027-02-20', 1_500_000)]), wersje: [PROFIL], wpisy: [] };
    expect((await czytajTenMiesiac(client, 't1', '2027-02')).ok).toBe(true);
  });
});

describe('VAT w odczycie „Ten miesiąc” (K7.1)', () => {
  const WYNIK = { naleznyGr: 690_000, nadwyzkaPoprzedniaGr: 0, naliczonyGr: 195_500, doZaplatyGr: 494_500, nadwyzkaNaNastepnyGr: 0, liczbaSprzedazy: 1, liczbaZakupow: 1 };

  it('czynny VAT: pozycja VAT z odczytu VAT, a nadwyżka z adresu strony trafia do odczytu', async () => {
    mocks.vat = { ok: true, miesiac: '2027-01', nadwyzka: { zl: 0, zrodlo: 'klient' }, wynik: { ok: true, ...WYNIK }, wysylki: [] };
    const dane = await czytajTenMiesiac(client, 't1', '2027-01', { nadwyzkaVat: 0 });
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(mocks.vatWywolania).toEqual([{ miesiac: '2027-01', nadwyzka: 0 }]);
    expect(dane.pozycje.find((p) => p.rodzaj === 'vat')).toMatchObject({ ok: true, kwotaGr: 494_500, wejsciaHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(dane.wynik.vat).toMatchObject({ nadwyzka: { zl: 0, zrodlo: 'klient' }, nadwyzkaNieznana: false });
  });

  it('nieznana nadwyżka: brak z treścią i oznaczeniem; błąd odczytu VAT: brak samego VAT, reszta się liczy', async () => {
    mocks.vat = { ok: true, miesiac: '2027-01', nadwyzka: null, wynik: null, wysylki: [] };
    const bezNadwyzki = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!bezNadwyzki.ok) throw new Error(bezNadwyzki.braki.join(' '));
    expect(bezNadwyzki.pozycje.find((p) => p.rodzaj === 'vat')).toMatchObject({ ok: false, brak: expect.stringContaining('nadwyżka z deklaracji za grudzień 2026') });
    expect(bezNadwyzki.wynik.vat).toMatchObject({ nadwyzkaNieznana: true });
    expect(mocks.vatWywolania).toEqual([{ miesiac: '2027-01', nadwyzka: null }]);

    mocks.vat = { ok: false, komunikat: 'Nie udało się odczytać faktur i kosztów miesiąca.' };
    const blad = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!blad.ok) throw new Error(blad.braki.join(' '));
    expect(blad.pozycje.map((p) => [p.rodzaj, p.ok])).toEqual([
      ['ryczalt', true],
      ['zus_spoleczne', true],
      ['zdrowotna', true],
      ['vat', false],
    ]);
  });

  it('wszystkie sekcje podatku i składek niesprawdzone (D7): VAT z kwotą liczy się dalej, błąd odczytu VAT nie', async () => {
    mocks.brakujace = (_rok, sekcje) => sekcje.map((x) => ({ sekcja: x as 'zus', powod: 'niesprawdzone' as const, komunikat: `czeka: ${x}`, operator: '' }));
    mocks.vat = { ok: true, miesiac: '2027-01', nadwyzka: { zl: 0, zrodlo: 'klient' }, wynik: { ok: true, ...WYNIK }, wysylki: [] };
    const zVatem = await czytajTenMiesiac(client, 't1', '2027-01', { nadwyzkaVat: 0 });
    if (!zVatem.ok) throw new Error(zVatem.braki.join(' '));
    expect(zVatem.pozycje.map((p) => [p.rodzaj, p.ok])).toEqual([
      ['ryczalt', false],
      ['zus_spoleczne', false],
      ['zdrowotna', false],
      ['vat', true],
    ]);
    mocks.vat = { ok: false, komunikat: 'Nie udało się odczytać faktur i kosztów miesiąca.' };
    expect(await czytajTenMiesiac(client, 't1', '2027-01')).toMatchObject({ ok: false, braki: ['czeka: ryczalt', 'czeka: zus', 'czeka: zdrowotna'] });
  });

  it('firma zwolniona z VAT: bez pozycji VAT; obszar `vat` zablokowany w kodzie: VAT nieczytany', async () => {
    const zwolniona = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!zwolniona.ok) throw new Error(zwolniona.braki.join(' '));
    expect(zwolniona.pozycje.map((p) => p.rodzaj)).toEqual(['ryczalt', 'zus_spoleczne', 'zdrowotna']);
    expect(zwolniona.wynik.vat).toBeNull();

    mocks.vatWKodzie = false;
    mocks.vatWywolania = [];
    const bezObszaru = await czytajTenMiesiac(client, 't1', '2027-01');
    expect(bezObszaru.ok && bezObszaru.pozycje.map((p) => p.rodzaj)).toEqual(['ryczalt', 'zus_spoleczne', 'zdrowotna']);
    expect(mocks.vatWywolania).toEqual([]);
  });
});

