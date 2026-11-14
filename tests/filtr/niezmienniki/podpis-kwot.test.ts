import { render } from '@react-email/render';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { odlozycProps } from '@/components/przeplywy/finora-1do1/adaptery';
import { APP_NOTIFICATION_LIMITS } from '@/lib/app-notifications/types';
import TerminRozliczenia from '@/lib/email/templates/TerminRozliczenia';
import { terminDla, type RodzajTerminu } from '@/lib/ksiegowosc/kalendarz';
import { trescTerminu, trescWyliczenia, type PozycjaPrzypomnienia } from '@/lib/ksiegowosc/przypomnienia';
import { RODZAJE_ROZLICZEN } from '@/lib/ksiegowosc/ten-miesiac';

import { opcje, PRZYPADKI } from '../generatory/ustawienia';

/**
 * NZ-TRESC-02 (żelazny filtr F10, część 7b; plan B4.2; plan księgowości JDG,
 * sekcja 8): każda kwota modułu, która dociera do klienta, ma podpis „według
 * Twoich danych i stawek na {rok}”, gdzie rok to rok rozliczanego miesiąca.
 * Przy składce zdrowotnej za styczeń podpis wymienia też rok składkowy
 * (luty-styczeń), jak strona „Ten miesiąc”: styczeń liczy się według stawek
 * roku składkowego, który zaczął się w lutym poprzedniego roku.
 *
 * Kanały poza stroną „Ten miesiąc”: przypomnienie o terminie (mail, push,
 * dzwonek: `trescTerminu` i szablon `TerminRozliczenia`), przypomnienie
 * o wyliczonym miesiącu (push: `trescWyliczenia`) i karta „Odłóż na podatek”
 * na Pulpicie (`odlozycProps`). Kwotę w tekście poznajemy po zapisie
 * („1 536,00 zł”, „999 zł”, „4,3 tys. zł”), nie po danych wejściowych, więc
 * test łapie każdą kwotę, którą tekst pokazuje. Podpis strony „Ten miesiąc”
 * sprawdzi ten sam test po wydzieleniu go do `lib/` (PR aplikacji mobilnej
 * M10b).
 */

const KWOTA = /\d(?:[\d\s]*\d)?(?:,\d+)?(?:\s(?:tys\.|mln))?\s?zł/u;

const maly = (s: string) => s.toLocaleLowerCase('pl-PL').replace(/\s+/gu, ' ');

/** Braki w podpisie tekstu z kwotami; pusta lista, gdy podpis jest albo kwot nie ma. */
function brakiPodpisu(tekst: string, miesiac: string, zdrowotna: boolean): string[] {
  if (!KWOTA.test(tekst)) return [];
  const rok = Number(miesiac.slice(0, 4));
  const t = maly(tekst);
  const bledy: string[] = [];
  if (!t.includes(`według twoich danych i stawek na ${rok} r.`)) bledy.push(`brak podpisu z rokiem ${rok} w: ${tekst}`);
  if (zdrowotna && miesiac.endsWith('-01') && !t.includes(`roku składkowego od lutego ${rok - 1} r. do stycznia ${rok} r.`)) {
    bledy.push(`brak roku składkowego zdrowotnej (luty ${rok - 1} do stycznia ${rok}) w: ${tekst}`);
  }
  return bledy;
}

const RODZAJ_TERMINU: readonly RodzajTerminu[] = ['ryczalt', 'zaliczkaPit', 'zus', 'vatJpk'];
// Styczeń częściej niż co dwunasty raz: tam jest rok składkowy zdrowotnej.
const okres = fc.record({
  rok: fc.integer({ min: 2026, max: 2030 }),
  miesiac: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 12 })),
});
const nazwaMiesiaca = (o: { rok: number; miesiac: number }) => `${o.rok}-${String(o.miesiac).padStart(2, '0')}`;
const pozycja: fc.Arbitrary<PozycjaPrzypomnienia> = fc.record({
  rodzaj: fc.constantFrom(...RODZAJE_ROZLICZEN),
  kwotaGr: fc.oneof(fc.constant(null), fc.constant(0), fc.integer({ min: 1, max: 100_000_000 })),
});
// Jak w zadaniach: jedna pozycja na rozliczenie.
const pozycje = fc.uniqueArray(pozycja, { minLength: 1, maxLength: 5, selector: (p) => p.rodzaj });
const zdrowotnaZKwota = (p: readonly PozycjaPrzypomnienia[]) => p.some((x) => x.rodzaj === 'zdrowotna' && x.kwotaGr !== null);

const tekstMaila = async (tytul: string, tresc: string, adres: string) =>
  (await render(TerminRozliczenia({ tytul, tresc, adres })))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');

describe('NZ-TRESC-02: kwoty modułu z podpisem „według Twoich danych i stawek na {rok}”', () => {
  it('sprawdzenie działa na przykładach (żeby test nie był pusty)', () => {
    expect(brakiPodpisu('Bez oznaczonej zapłaty: ryczałt 1 536,00 zł.', '2026-10', false)).not.toEqual([]);
    expect(brakiPodpisu('Ryczałt 999 zł. Według Twoich danych i stawek na 2025 r.', '2026-10', false)).not.toEqual([]);
    expect(brakiPodpisu('Składka zdrowotna 498,35 zł. Według Twoich danych i stawek na 2027 r.', '2027-01', true)).not.toEqual([]);
    expect(brakiPodpisu('Bez oznaczonej zapłaty: ryczałt.', '2026-10', false)).toEqual([]);
    expect(brakiPodpisu('Ryczałt 4,3 tys. zł. Według Twoich danych i stawek na 2026 r.', '2026-10', false)).toEqual([]);
  });

  it('przypomnienie o terminie (push i dzwonek): losowe rozliczenia, kwoty, terminy i dni', () => {
    fc.assert(
      fc.property(okres, fc.constantFrom(...RODZAJ_TERMINU), fc.constantFrom(5 as const, 1 as const), pozycje, (o, rodzaj, dni, p) => {
        const termin = terminDla({ rodzaj, rok: o.rok, miesiac: o.miesiac });
        if (!termin) return;
        const miesiac = nazwaMiesiaca(o);
        const t = trescTerminu({ miesiac, termin, dni, pozycje: p });
        // Push i dzwonek pokazują tytuł i treść; dzwonek przycina treść dopiero po limicie.
        expect(brakiPodpisu(`${t.tytul} ${t.tresc}`, miesiac, zdrowotnaZKwota(p))).toEqual([]);
        expect(Array.from(t.tresc).length).toBeLessThanOrEqual(APP_NOTIFICATION_LIMITS.body);
      }),
      opcje(),
    );
  });

  it('przypomnienie o terminie (mail): ta sama treść w szablonie', async () => {
    await fc.assert(
      fc.asyncProperty(okres, fc.constantFrom(...RODZAJ_TERMINU), fc.constantFrom(5 as const, 1 as const), pozycje, async (o, rodzaj, dni, p) => {
        const termin = terminDla({ rodzaj, rok: o.rok, miesiac: o.miesiac });
        if (!termin) return;
        const miesiac = nazwaMiesiaca(o);
        const t = trescTerminu({ miesiac, termin, dni, pozycje: p });
        expect(brakiPodpisu(await tekstMaila(t.tytul, t.tresc, t.adres), miesiac, zdrowotnaZKwota(p))).toEqual([]);
      }),
      // Szablon to jedna ścieżka; w nocy (50 000 przypadków) wystarczy tyle, ile w PR.
      opcje(Math.min(PRZYPADKI, 300)),
    );
  }, 120_000);

  it('przypomnienie o wyliczonym miesiącu (push): losowe rozliczenia i kwoty', () => {
    fc.assert(
      fc.property(okres, pozycje, (o, p) => {
        const miesiac = nazwaMiesiaca(o);
        const t = trescWyliczenia({ miesiac, pozycje: p });
        expect(brakiPodpisu(`${t.tytul} ${t.tresc}`, miesiac, zdrowotnaZKwota(p))).toEqual([]);
      }),
      opcje(),
    );
  });

  it('karta „Odłóż na podatek”: szacunek z kwotą ma podpis także przy brakach części pozycji', () => {
    const pozycjeKarty = fc.uniqueArray(
      fc.record({ rodzaj: fc.constantFrom(...RODZAJE_ROZLICZEN), kwotaGr: fc.integer({ min: 0, max: 100_000_000 }) }),
      { minLength: 1, maxLength: 5, selector: (p) => p.rodzaj },
    );
    fc.assert(
      fc.property(
        okres,
        pozycjeKarty,
        fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 100_000_000 })),
        fc.array(fc.constantFrom('Brak parametrów składki zdrowotnej.', 'Ewidencja przychodów ma braki.'), { maxLength: 2 }),
        (o, p, przychodGr, braki) => {
          const miesiac = nazwaMiesiaca(o);
          const kwotaGr = p.reduce((s, x) => s + x.kwotaGr, 0);
          const k = odlozycProps({ ok: true, miesiac, kwotaGr, przychodGr, pozycje: p, braki });
          // Kwota w pierścieniu jest zawsze, więc podpis też; suma ze zdrowotną za styczeń z rokiem składkowym.
          expect(KWOTA.test(k.lines.join(' '))).toBe(true);
          expect(brakiPodpisu(`${k.lines.join(' ')} ${k.caption}`, miesiac, p.some((x) => x.rodzaj === 'zdrowotna'))).toEqual([]);
        },
      ),
      opcje(),
    );
  });
});
