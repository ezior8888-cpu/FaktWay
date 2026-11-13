/**
 * Dane z poprzedniego otwarcia w telefonie (mobile/src/lib/dane/pamiec.ts,
 * etap M7): dane jednego konta nie pokażą się na drugim, wylogowanie czyści
 * wszystko, a pobranie zaczęte przed wylogowaniem niczego już nie zapisze.
 */
import { describe, expect, it } from 'vitest';

import { nazwaZapisu, utworzPamiec, WERSJA_PAMIECI, type Magazyn } from '../../mobile/src/lib/dane/pamiec';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const F1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const F2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function magazynWPamieci(opoznienieZapisu = 0) {
  const pliki = new Map<string, string>();
  const m: Magazyn = {
    czytaj: async (n) => pliki.get(n) ?? null,
    zapisz: async (n, t) => {
      if (opoznienieZapisu) await new Promise((r) => setTimeout(r, opoznienieZapisu));
      pliki.set(n, t);
    },
    usunWszystko: async () => pliki.clear(),
  };
  return { m, pliki };
}

describe('pamięć danych telefonu', () => {
  it('zapis i odczyt dla tego samego konta i firmy', async () => {
    const { m } = magazynWPamieci();
    const p = utworzPamiec(m, () => new Date('2026-11-13T12:00:00Z'));
    await expect(p.zapisz('faktury', U1, F1, { lista: [1] }, p.epoka())).resolves.toBe('2026-11-13T12:00:00.000Z');
    await expect(p.czytaj('faktury', U1, F1)).resolves.toEqual({ dane: { lista: [1] }, zapisano: '2026-11-13T12:00:00.000Z' });
  });

  it('inne konto i inna firma nie widzą zapisu', async () => {
    const { m, pliki } = magazynWPamieci();
    const p = utworzPamiec(m);
    await p.zapisz('faktury', U1, F1, { lista: [1] }, p.epoka());
    await expect(p.czytaj('faktury', U2, F1)).resolves.toBeUndefined();
    await expect(p.czytaj('faktury', U1, F2)).resolves.toBeUndefined();
    // Plik podmieniony pod nazwą innego konta (np. po błędzie) też się nie wczyta.
    pliki.set(nazwaZapisu('faktury', U2, F1) as string, [...pliki.values()][0]);
    await expect(p.czytaj('faktury', U2, F1)).resolves.toBeUndefined();
  });

  it('stara wersja zapisu i śmieci w pliku: brak danych zamiast błędu', async () => {
    const { m, pliki } = magazynWPamieci();
    const p = utworzPamiec(m);
    const nazwa = nazwaZapisu('konto', U1, null) as string;
    pliki.set(nazwa, JSON.stringify({ wersja: WERSJA_PAMIECI + 1, uzytkownik: U1, firma: null, zapisano: 'x', dane: {} }));
    await expect(p.czytaj('konto', U1, null)).resolves.toBeUndefined();
    pliki.set(nazwa, '{niepełny');
    await expect(p.czytaj('konto', U1, null)).resolves.toBeUndefined();
  });

  it('nazwa pliku tylko z identyfikatorów (bez wyjścia z katalogu)', () => {
    expect(nazwaZapisu('faktury', U1, F1)).toBe(`faktury-${U1}-${F1}.json`);
    expect(nazwaZapisu('konto', U1, null)).toBe(`konto-${U1}-konto.json`);
    expect(nazwaZapisu('faktury', '../x', F1)).toBeUndefined();
    expect(nazwaZapisu('faktury', U1, 'a/b')).toBeUndefined();
  });

  it('wylogowanie czyści wszystko', async () => {
    const { m, pliki } = magazynWPamieci();
    const p = utworzPamiec(m);
    await p.zapisz('konto', U1, null, { a: 1 }, p.epoka());
    await p.zapisz('faktury', U1, F1, { a: 1 }, p.epoka());
    await p.wyczysc();
    expect(pliki.size).toBe(0);
  });

  it('pobranie zaczęte przed wylogowaniem nic nie zapisze po nim', async () => {
    const { m, pliki } = magazynWPamieci();
    const p = utworzPamiec(m);
    const epoka = p.epoka();
    await p.wyczysc();
    await expect(p.zapisz('faktury', U1, F1, { lista: [1] }, epoka)).resolves.toBeUndefined();
    expect(pliki.size).toBe(0);
  });

  it('zapis w toku i wylogowanie: po kolei, na końcu pusto', async () => {
    const { m, pliki } = magazynWPamieci(5);
    const p = utworzPamiec(m);
    const zapis = p.zapisz('faktury', U1, F1, { lista: [1] }, p.epoka());
    const czyszczenie = p.wyczysc();
    await Promise.all([zapis, czyszczenie]);
    expect(pliki.size).toBe(0);
  });

  it('błąd zapisu (pełny dysk) nie wywraca aplikacji', async () => {
    const p = utworzPamiec({
      czytaj: async () => null,
      zapisz: async () => {
        throw new Error('ENOSPC');
      },
      usunWszystko: async () => undefined,
    });
    await expect(p.zapisz('faktury', U1, F1, {}, p.epoka())).resolves.toBeUndefined();
    // Kolejka działa dalej po błędzie.
    await expect(p.wyczysc()).resolves.toBeUndefined();
  });
});
