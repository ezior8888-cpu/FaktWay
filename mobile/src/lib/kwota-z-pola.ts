/**
 * Kwota wpisana w pole na telefonie (formularz faktury, Koszty) i z powrotem.
 * Liczy na liczbach całkowitych i na tekście, bez `Math.round` na ułamkach:
 * „1,005” to 101 groszy (od 0,5 grosza w górę, art. 106e ust. 11 ustawy
 * o VAT), a nie 100, które daje `Math.round(1.005 * 100)`. Obszar R1 mapy
 * filtra (`mobile.faktury`): zapis kosztu z telefonu (M9) bierze stąd kwoty.
 */

const KWOTA_W_POLU = /^([+-])?(\d*)(?:[.,](\d*))?$/;

/** Kwota wpisana w polu („1500”, „1 500,50”, „1500.5”) w groszach; puste albo błędne to NaN. */
export function groszeZPola(tekst: string): number {
  const t = tekst.replace(/\s/g, '');
  const dopasowanie = KWOTA_W_POLU.exec(t);
  if (!dopasowanie) return NaN;
  const [, znak, calosc = '', ulamek = ''] = dopasowanie;
  if (!calosc && !ulamek) return NaN;
  const grosze = Number(calosc || '0') * 100 + Number(ulamek.slice(0, 2).padEnd(2, '0'));
  const wGore = (ulamek[2] ?? '0') >= '5' ? 1 : 0;
  const wynik = grosze + wGore;
  return znak === '-' && wynik !== 0 ? -wynik : wynik;
}

/** Grosze całkowite do pola formularza: „1500,50” (bez waluty i spacji). */
export function doPola(grosze: number): string {
  const abs = Math.abs(Math.trunc(grosze));
  const znak = grosze < 0 && abs > 0 ? '-' : '';
  return `${znak}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
