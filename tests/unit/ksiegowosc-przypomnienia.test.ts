import { render } from '@react-email/render';
import { describe, expect, it } from 'vitest';

import TerminRozliczenia from '@/lib/email/templates/TerminRozliczenia';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { grupyFormy, niezaplacone, terminyNaDzis, trescTerminu, trescWyliczenia } from '@/lib/ksiegowosc/przypomnienia';
import type { PozycjaZeSkrotem, Rozliczenie } from '@/lib/ksiegowosc/ten-miesiac-dane';

/**
 * Przypomnienia modułu księgowości (plan księgowości JDG, K5, sekcja 9):
 * kiedy (5 i 1 dzień przed terminem z kalendarza K1), o czym (rozliczenia
 * bez oznaczonej zapłaty) i jakim tekstem (D8: bez trybu rozkazującego).
 */

const PROFIL: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

const wersja = (rodzaj: Rozliczenie['rodzaj'], kwotaGr: number, z: Partial<Rozliczenie> = {}): Rozliczenie => ({
  id: `${rodzaj}-${z.wersja ?? 1}`,
  miesiac: '2026-10',
  rodzaj,
  wersja: 1,
  kwotaGr,
  termin: '2026-11-20',
  status: 'zatwierdzone',
  wejsciaHash: 'a'.repeat(64),
  zatwierdzoneO: '2026-11-02T10:00:00Z',
  zaplaconeO: null,
  spoleczneBezFpGr: 0,
  reczna: false,
  ...z,
});
const szkic = (rodzaj: PozycjaZeSkrotem['rodzaj'], kwotaGr: number): PozycjaZeSkrotem => ({
  ok: true,
  rodzaj,
  kwotaGr,
  termin: null,
  wejscia: {},
  wejsciaHash: 'b'.repeat(64),
});

describe('kiedy przypominać', () => {
  it('termin 20.11.2026 za październik: 5 dni wcześniej (15.11) i dzień wcześniej (19.11), podatek i ZUS w jednym przypomnieniu', () => {
    // Od K7 także grupa zaliczki PIT (ten sam dzień); o firmie decyduje jej forma (`grupyFormy`).
    expect(terminyNaDzis('2026-11-15').map((t) => [t.miesiac, t.grupy, t.dni, t.etap])).toEqual([['2026-10', ['ryczalt', 'pit', 'zus'], 5, 'termin-5:2026-11-20']]);
    expect(terminyNaDzis('2026-11-19').map((t) => [t.grupy, t.dni])).toEqual([[['ryczalt', 'pit', 'zus'], 1]]);
    expect(grupyFormy(['ryczalt', 'pit', 'zus'], 'ryczalt')).toEqual(['ryczalt', 'zus']);
    expect(grupyFormy(['ryczalt', 'pit', 'zus'], 'liniowy')).toEqual(['pit', 'zus']);
    // VAT (K7.1) nie zależy od formy; firmę zwolnioną z VAT pomija zadanie.
    expect(grupyFormy(['vat'], 'ryczalt')).toEqual(['vat']);
    expect(terminyNaDzis('2026-11-16')).toEqual([]);
  });

  it('VAT (K7.1): termin 25.11.2026 za październik osobno, 5 dni wcześniej (20.11) i dzień wcześniej (24.11)', () => {
    expect(terminyNaDzis('2026-11-20').map((t) => [t.miesiac, t.grupy, t.dni, t.etap])).toEqual([['2026-10', ['vat'], 5, 'termin-5:2026-11-25']]);
    expect(terminyNaDzis('2026-11-24').map((t) => [t.grupy, t.dni, t.etap])).toEqual([[['vat'], 1, 'termin-1:2026-11-25']]);
  });

  it('termin przesunięty z soboty 20.02.2027 na poniedziałek 22.02.2027 liczy się od dnia faktycznego', () => {
    const t = terminyNaDzis('2027-02-17');
    expect(t.map((x) => [x.miesiac, x.etap, x.termin.przesuniety])).toEqual([['2027-01', 'termin-5:2027-02-22', true]]);
    expect(terminyNaDzis('2027-02-15')).toEqual([]);
  });

  it('grudzień: termin w styczniu następnego roku', () => {
    expect(terminyNaDzis('2027-01-19').map((x) => [x.miesiac, x.etap])).toEqual([['2026-12', 'termin-1:2027-01-20']]);
  });
});

describe('o czym przypominać', () => {
  const ryczalt = (rozliczenia: Rozliczenie[], pozycje: PozycjaZeSkrotem[] | null = null) =>
    niezaplacone({ grupy: ['ryczalt'], rozliczenia, pozycje, profil: PROFIL });

  it('zatwierdzone bez zapłaty: kwota wersji; zapłacone: nic', () => {
    expect(ryczalt([wersja('ryczalt', 153_600)])).toEqual([{ rodzaj: 'ryczalt', kwotaGr: 153_600 }]);
    expect(ryczalt([wersja('ryczalt', 153_600, { status: 'zaplacone', zaplaconeO: '2026-11-05' })])).toEqual([]);
  });

  it('nowa wersja po zapłaconej poprzedniej: tylko dopłata', () => {
    const rozliczenia = [
      wersja('ryczalt', 150_000, { status: 'zaplacone', zaplaconeO: '2026-11-05' }),
      wersja('ryczalt', 155_600, { id: 'ryczalt-2', wersja: 2 }),
    ];
    expect(ryczalt(rozliczenia)).toEqual([{ rodzaj: 'ryczalt', kwotaGr: 5_600 }]);
  });

  it('bez zatwierdzenia: kwota ze szkicu, a bez szkicu (parametry czekają, D7) samo przypomnienie bez kwoty', () => {
    expect(ryczalt([], [szkic('ryczalt', 153_600)])).toEqual([{ rodzaj: 'ryczalt', kwotaGr: 153_600 }]);
    expect(ryczalt([], null)).toEqual([{ rodzaj: 'ryczalt', kwotaGr: null }]);
  });

  it('ZUS: ulga na start i etat obok bez składek społecznych; kwota zero bez przypomnienia', () => {
    const pozycje = [szkic('zus_spoleczne', 0), szkic('zdrowotna', 49_835)];
    expect(niezaplacone({ grupy: ['zus'], rozliczenia: [], pozycje, profil: { ...PROFIL, zusEtap: 'ulga_na_start', zusOd: '2026-01-01' } })).toEqual([
      { rodzaj: 'zdrowotna', kwotaGr: 49_835 },
    ]);
    expect(niezaplacone({ grupy: ['zus'], rozliczenia: [], pozycje, profil: PROFIL })).toEqual([{ rodzaj: 'zdrowotna', kwotaGr: 49_835 }]);
  });
});

describe('F11-B5: VAT 0 zł', () => {
  const vat = (przyjete?: boolean) =>
    niezaplacone({ grupy: ['vat'], rozliczenia: [], pozycje: [szkic('vat', 0)], profil: PROFIL, jpkPrzyjete: przyjete });

  it('kwota 0 zł: przypomnienie o JPK_V7M, chyba że MF przyjął plik; kwota dodatnia jak dotąd', () => {
    expect(vat()).toEqual([{ rodzaj: 'vat', kwotaGr: 0 }]);
    expect(vat(true)).toEqual([]);
    expect(niezaplacone({ grupy: ['vat'], rozliczenia: [], pozycje: [szkic('vat', 5_000)], profil: PROFIL, jpkPrzyjete: true })).toEqual([{ rodzaj: 'vat', kwotaGr: 5_000 }]);
  });

  it('inne grupy przy kwocie 0 zł dalej bez przypomnienia', () => {
    expect(niezaplacone({ grupy: ['ryczalt'], rozliczenia: [], pozycje: [szkic('ryczalt', 0)], profil: PROFIL })).toEqual([]);
  });

  it('treść: fakty o VAT 0 zł i terminie JPK_V7M, razem z pozycjami do zapłaty', () => {
    const [t] = terminyNaDzis('2026-11-20');
    expect(trescTerminu({ miesiac: '2026-10', termin: t.termin, dni: 5, pozycje: [{ rodzaj: 'vat', kwotaGr: 0 }] }).tresc).toBe(
      'Za 5 dni, 25.11.2026, mija termin za październik 2026. VAT do zapłaty za październik 2026: 0,00 zł; JPK_V7M za ten miesiąc ma ten sam termin. Według Twoich danych i stawek na 2026 r.',
    );
    const razem = trescTerminu({ miesiac: '2026-10', termin: t.termin, dni: 1, pozycje: [{ rodzaj: 'zdrowotna', kwotaGr: 100 }, { rodzaj: 'vat', kwotaGr: 0 }] }).tresc;
    expect(razem).toContain('Bez oznaczonej zapłaty: składka zdrowotna 1,00 zł.');
    expect(razem).toContain('VAT do zapłaty za październik 2026: 0,00 zł');
    expect(razem).not.toMatch(/[—–]|Zapłać|zalecamy|powinieneś/);
  });
});

describe('treść', () => {
  const [termin] = terminyNaDzis('2026-11-15');

  it('przypomnienie o terminie: data, miesiąc, rozliczenia z kwotami albo bez', () => {
    const t = trescTerminu({
      miesiac: '2026-10',
      termin: termin.termin,
      dni: 5,
      pozycje: [
        { rodzaj: 'ryczalt', kwotaGr: 153_600 },
        { rodzaj: 'zdrowotna', kwotaGr: null },
      ],
    });
    expect(t.tytul).toBe('Termin 20.11.2026: rozliczenie za październik 2026');
    expect(t.tresc).toBe('Za 5 dni, 20.11.2026, mija termin za październik 2026. Bez oznaczonej zapłaty: ryczałt 1536,00 zł, składka zdrowotna. Według Twoich danych i stawek na 2026 r.');
    expect(t.adres).toBe('/reports/ten-miesiac?month=10&year=2026');
    expect(trescTerminu({ miesiac: '2026-10', termin: termin.termin, dni: 1, pozycje: [] }).tresc).toMatch(/^Jutro, 20\.11\.2026/);
  });

  it('wyliczony miesiąc i teksty bez trybu rozkazującego i długich myślników (D8)', () => {
    const t = trescWyliczenia({ miesiac: '2026-10', pozycje: [{ rodzaj: 'ryczalt', kwotaGr: 153_600 }, { rodzaj: 'zus_spoleczne', kwotaGr: 192_676 }] });
    expect(t.tytul).toBe('Rozliczenie za październik 2026 jest wyliczone');
    expect(t.tresc).toBe('Do zapłaty: ryczałt 1536,00 zł, składki społeczne 1926,76 zł. Według Twoich danych i stawek na 2026 r. Szczegóły i zatwierdzenie są w zakładce „Ten miesiąc”.');
    const wszystko = [t.tytul, t.tresc, trescTerminu({ miesiac: '2026-10', termin: termin.termin, dni: 5, pozycje: [{ rodzaj: 'ryczalt', kwotaGr: 1 }] }).tresc].join(' ');
    expect(wszystko).not.toMatch(/[—–]|Zapłać|Sprawdź|Uzupełnij|Otwórz|Pamiętaj/);
  });
});

describe('podpis kwot (NZ-TRESC-02)', () => {
  // Termin składek za styczeń 2027 (20.02 to sobota, więc 22.02).
  const styczen = { termin: terminDla({ rodzaj: 'zus', rok: 2027, miesiac: 1 })! };

  it('styczeń: przy składce zdrowotnej z kwotą także rok składkowy, bez niej sam rok stawek', () => {
    const zZdrowotna = trescTerminu({ miesiac: '2027-01', termin: styczen.termin, dni: 5, pozycje: [{ rodzaj: 'ryczalt', kwotaGr: 100 }, { rodzaj: 'zdrowotna', kwotaGr: 49_835 }] });
    expect(zZdrowotna.tresc).toMatch(
      /Według Twoich danych i stawek na 2027 r\.; składka zdrowotna według stawek roku składkowego od lutego 2026 r\. do stycznia 2027 r\.$/,
    );
    const bezZdrowotnej = trescTerminu({ miesiac: '2027-01', termin: styczen.termin, dni: 5, pozycje: [{ rodzaj: 'ryczalt', kwotaGr: 100 }, { rodzaj: 'zdrowotna', kwotaGr: null }] });
    expect(bezZdrowotnej.tresc).toMatch(/Według Twoich danych i stawek na 2027 r\.$/);
    expect(trescWyliczenia({ miesiac: '2027-01', pozycje: [{ rodzaj: 'zdrowotna', kwotaGr: 49_835 }] }).tresc).toContain('roku składkowego od lutego 2026 r. do stycznia 2027 r.');
  });

  it('przypomnienie bez kwot (parametry czekają na księgową) nie ma podpisu kwot', () => {
    const t = trescTerminu({ miesiac: '2026-10', termin: styczen.termin, dni: 1, pozycje: [{ rodzaj: 'ryczalt', kwotaGr: null }, { rodzaj: 'zdrowotna', kwotaGr: null }] });
    expect(t.tresc).not.toMatch(/Według Twoich danych|zł/);
  });

  it('mail: podpis raz, z treści przypomnienia', async () => {
    const t = trescTerminu({ miesiac: '2026-10', termin: styczen.termin, dni: 5, pozycje: [{ rodzaj: 'ryczalt', kwotaGr: 153_600 }] });
    const html = await render(TerminRozliczenia({ tytul: t.tytul, tresc: t.tresc, adres: t.adres }));
    expect(html.match(/według Twoich danych/gi)).toHaveLength(1);
  });
});

describe('F11-B2: dane zmienione po zatwierdzeniu', () => {
  // Październik zatwierdzony (ryczałt 1536 zł) i zapłacony; potem faktura za
  // usługę z 31.10, więc szkic według bieżących danych to 1836 zł (inny skrót
  // wejść). Strona pokazuje dopłatę 300 zł, przypomnienie musi ją wymienić.
  it('szkic z innym skrótem niż zapłacona wersja: przypomnienie o różnicy 300 zł, nie cisza', () => {
    const zmieniony = { ...szkic('ryczalt', 183_600), wejsciaHash: 'b'.repeat(64) } as PozycjaZeSkrotem;
    expect(
      niezaplacone({
        grupy: ['ryczalt'],
        rozliczenia: [wersja('ryczalt', 153_600, { status: 'zaplacone', zaplaconeO: '2026-11-02' })],
        pozycje: [zmieniony],
        profil: PROFIL,
      }),
    ).toEqual([{ rodzaj: 'ryczalt', kwotaGr: 30_000 }]);
  });

  it('szkic z tym samym skrótem co wersja: kwota z wersji, jak dotąd (zapłacone, bez przypomnienia)', () => {
    expect(
      niezaplacone({
        grupy: ['ryczalt'],
        rozliczenia: [wersja('ryczalt', 153_600, { status: 'zaplacone', zaplaconeO: '2026-11-02' })],
        pozycje: [{ ...szkic('ryczalt', 153_600), wejsciaHash: 'a'.repeat(64) } as PozycjaZeSkrotem],
        profil: PROFIL,
      }),
    ).toEqual([]);
  });
});

