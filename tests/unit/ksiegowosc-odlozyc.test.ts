import { describe, expect, it } from 'vitest';

import { odlozycProps } from '@/components/przeplywy/finora-1do1/adaptery';
import { ileOdlozyc } from '@/lib/ksiegowosc/odlozyc';
import type { DaneMiesiaca } from '@/lib/ksiegowosc/ten-miesiac-dane';

/**
 * „Ile odłożyć” (plan księgowości JDG, K5, D13): suma kwot bieżącego
 * miesiąca z silnika „Ten miesiąc” i karta „Odłóż na podatek” dla firmy
 * w pilotażu, zamiast 19 % liniowego.
 */

const H = 'a'.repeat(64);
const pozycja = (rodzaj: 'ryczalt' | 'zus_spoleczne' | 'zdrowotna', kwotaGr: number) => ({ ok: true as const, rodzaj, kwotaGr, termin: null, wejscia: {}, wejsciaHash: H });

function dane(pozycje: unknown[], przychodGr: number | null = 1_500_000): DaneMiesiaca {
  return { ok: true, wynik: { przychodGr } as never, pozycje: pozycje as never, parametryWersja: 'x', rozliczenia: [] };
}

describe('ile odłożyć', () => {
  it('suma ryczałtu, składek i zdrowotnej za bieżący miesiąc', () => {
    const w = ileOdlozyc('2026-11', dane([pozycja('ryczalt', 153_600), pozycja('zus_spoleczne', 192_676), pozycja('zdrowotna', 83_058)]));
    expect(w).toMatchObject({ ok: true, miesiac: '2026-11', kwotaGr: 429_334, przychodGr: 1_500_000, braki: [] });
  });

  it('pozycja z brakiem: suma pozostałych i powód; bez żadnej kwoty: tylko powody', () => {
    const brak = { ok: false, rodzaj: 'zus_spoleczne', termin: null, brak: 'Etap zaczyna się w trakcie miesiąca.' };
    expect(ileOdlozyc('2026-11', dane([pozycja('ryczalt', 153_600), brak, pozycja('zdrowotna', 83_058)]))).toMatchObject({
      ok: true,
      kwotaGr: 236_658,
      braki: ['Etap zaczyna się w trakcie miesiąca.'],
    });
    expect(ileOdlozyc('2026-11', dane([brak]))).toEqual({ ok: false, miesiac: '2026-11', braki: ['Etap zaczyna się w trakcie miesiąca.'] });
    expect(ileOdlozyc('2026-11', { ok: false, braki: ['Stawki czekają na sprawdzenie.'], rozliczenia: [] })).toEqual({
      ok: false,
      miesiac: '2026-11',
      braki: ['Stawki czekają na sprawdzenie.'],
    });
  });
});

describe('karta „Odłóż na podatek” w pilotażu', () => {
  it('udział w przychodzie, kwota, podpis z rokiem stawek', () => {
    const p = odlozycProps({ ok: true, miesiac: '2026-11', kwotaGr: 429_334, przychodGr: 1_500_000, pozycje: [], braki: [] }, 2026);
    expect(p).toMatchObject({ title: 'Odłóż na podatek', subtitle: 'Szacunek za listopad 2026 z danych do dziś', pct: 29, caption: 'Według Twoich danych i stawek na 2026 r.' });
    expect(p.lines[0]).toBe('29%');
    expect(p.lines[2]).toBe('do odłożenia');
  });

  it('część kwot bez szacunku, brak ustawień i parametry czekające na księgową: powód zamiast kwoty, bez trybu rozkazującego', () => {
    expect(odlozycProps({ ok: true, miesiac: '2026-11', kwotaGr: 1, przychodGr: 0, pozycje: [], braki: ['x'] }, 2026)).toMatchObject({
      pct: 0,
      caption: 'Część kwot bez szacunku; szczegóły w „Ten miesiąc”.',
    });
    const bezProfilu = odlozycProps({ ok: false, miesiac: '2026-11', braki: ['Na listopad 2026 nie ma ustawień podatkowych, więc nic nie liczymy.'] }, 2026);
    expect(bezProfilu.caption).toBe('Bez ustawień podatkowych nie liczymy szacunku.');
    const d7 = odlozycProps({ ok: false, miesiac: '2026-11', braki: ['Stawki na 2026 r. (ryczałt) czekają na sprawdzenie przez księgową.'] }, 2026);
    expect(d7.caption).toBe('Szacunku jeszcze nie liczymy; powód jest w „Ten miesiąc”.');
    const teksty = JSON.stringify([bezProfilu, d7]);
    expect(teksty).not.toMatch(/[—–]|Uzupełnij|Sprawdź|Zapłać/);
  });
});
