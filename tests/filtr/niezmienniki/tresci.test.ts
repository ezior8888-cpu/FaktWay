import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { terminDla, type RodzajTerminu } from '@/lib/ksiegowosc/kalendarz';
import { trescTerminu, trescWyliczenia, type PozycjaPrzypomnienia } from '@/lib/ksiegowosc/przypomnienia';
import { RODZAJE_ROZLICZEN } from '@/lib/ksiegowosc/ten-miesiac';

import { opcje } from '../generatory/ustawienia';

/**
 * NZ-TRESC-01 (żelazny filtr F10, część 7; plan B4.2, D8): teksty dla klienta
 * w obszarach R1 i R2 bez trybu rozkazującego i bez porad. Lista słów to
 * lista robocza z planu (pytanie 1 do prawnika, `PYTANIA-DO-PRAWNIKA.md`):
 * zapłać, musisz, powinieneś, należy, zalecamy, radzimy, wybierz, opłaca się,
 * lepiej, najkorzystniej, oszczędzisz. Reguła statyczna `bez-porad` sprawdza
 * napisy w kodzie ekranów; ten test sprawdza teksty składane w biegu:
 * przypomnienia o terminie i o wyliczonym miesiącu (mail, push i dzwonek)
 * dla losowych rozliczeń, kwot (także bez kwoty i VAT 0 zł), terminów
 * z kalendarza i dni przed terminem. Do tego styl D8: bez długich myślników.
 */

const ZAKAZANE = /(?<![\p{L}])(?:zapłać\p{L}*|musisz|musicie|powinieneś|powinnaś|powinniście|należy|zalecamy|radzimy|wybierz\p{L}*|opłaca się|lepiej|najkorzystniej\p{L}*|oszczędzisz|zaoszczędzisz)(?![\p{L}])/iu;
const DLUGIE_MYSLNIKI = /[—–]/;

const RODZAJ_TERMINU: readonly RodzajTerminu[] = ['ryczalt', 'zaliczkaPit', 'zus', 'vatJpk'];
const okres = fc.record({ rok: fc.integer({ min: 2026, max: 2027 }), miesiac: fc.integer({ min: 1, max: 12 }) });
const pozycja: fc.Arbitrary<PozycjaPrzypomnienia> = fc.record({
  rodzaj: fc.constantFrom(...RODZAJE_ROZLICZEN),
  kwotaGr: fc.oneof(fc.constant(null), fc.constant(0), fc.integer({ min: 1, max: 100_000_000 })),
});

function sprawdzTekst(tekst: string): string[] {
  const bledy: string[] = [];
  const slowo = ZAKAZANE.exec(tekst);
  if (slowo) bledy.push(`słowo „${slowo[0]}” w: ${tekst}`);
  if (DLUGIE_MYSLNIKI.test(tekst)) bledy.push(`długi myślnik w: ${tekst}`);
  return bledy;
}

describe('NZ-TRESC-01: przypomnienia bez trybu rozkazującego i bez porad', () => {
  it('lista słów działa na przykładach (żeby test nie był pusty)', () => {
    expect(sprawdzTekst('Zapłać ryczałt do 20 listopada.')).not.toEqual([]);
    expect(sprawdzTekst('Lepiej wybrać ryczałt.')).not.toEqual([]);
    expect(sprawdzTekst('Należy złożyć JPK_V7M.')).not.toEqual([]);
    expect(sprawdzTekst('Termin mija 20 listopada — ryczałt 1 536 zł.')).not.toEqual([]);
    expect(sprawdzTekst('Za 5 dni, 20.11.2026, mija termin za październik 2026. Ryczałt 1 536,00 zł.')).toEqual([]);
  });

  it('przypomnienie o terminie: losowe rozliczenia, kwoty, terminy i dni', () => {
    fc.assert(
      fc.property(okres, fc.constantFrom(...RODZAJ_TERMINU), fc.constantFrom(5 as const, 1 as const), fc.array(pozycja, { minLength: 1, maxLength: 5 }), (o, rodzaj, dni, pozycje) => {
        const termin = terminDla({ rodzaj, rok: o.rok, miesiac: o.miesiac });
        if (!termin) return;
        const miesiac = `${o.rok}-${String(o.miesiac).padStart(2, '0')}`;
        const t = trescTerminu({ miesiac, termin, dni, pozycje });
        expect([...sprawdzTekst(t.tytul), ...sprawdzTekst(t.tresc)]).toEqual([]);
      }),
      opcje(),
    );
  });

  it('przypomnienie o wyliczonym miesiącu: losowe rozliczenia i kwoty', () => {
    fc.assert(
      fc.property(okres, fc.array(pozycja, { minLength: 1, maxLength: 5 }), (o, pozycje) => {
        const miesiac = `${o.rok}-${String(o.miesiac).padStart(2, '0')}`;
        const t = trescWyliczenia({ miesiac, pozycje });
        expect([...sprawdzTekst(t.tytul), ...sprawdzTekst(t.tresc)]).toEqual([]);
      }),
      opcje(),
    );
  });
});
