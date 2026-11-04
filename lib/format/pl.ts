/**
 * Formatowanie liczb po polsku — jedno miejsce dla całego panelu.
 *
 * DLACZEGO OSOBNY MODUŁ. `formatPlMoney` mieszkał w
 * `lib/dashboard/monthly-figures.ts`, obok zapytań do Supabase. Komponent
 * kliencki, który by go zaimportował, wciągnąłby do paczki przeglądarki cały
 * moduł serwerowy — więc każdy z nich zamiast tego dopisywał sobie WŁASNĄ
 * kopię tych czterech linijek. Do września 2026 uzbierały się cztery
 * (`expenses-list`, `cash-flow-dashboard`, `kpir-view`, `overdue-dashboard`)
 * i piąta była w drodze razem z podsumowaniem faktury.
 *
 * Ten plik nie importuje niczego, więc nadaje się i na serwer, i do klienta.
 *
 * O GRUPOWANIU TYSIĘCY: polski CLDR ma `minimumGroupingDigits: 2`, więc
 * `4140` zostaje bez spacji, a `18000` dostaje ją („18 000”). To jest
 * zachowanie poprawne i takie samo, jakie panel pokazuje od zawsze — jeśli
 * kiedyś zdecydujemy inaczej, zmiana jest tutaj, w jednym miejscu.
 */

/** Kwota z dwoma miejscami po przecinku, bez symbolu waluty. */
export function formatPlMoney(n: number): string {
  return n.toLocaleString('pl-PL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Liczba całkowita — sztuki, dni, liczniki. */
export function formatPlInt(n: number): string {
  return n.toLocaleString('pl-PL', { maximumFractionDigits: 0 });
}

/**
 * Kwota w skrócie dla małych kafli i osi wykresów Pulpitu: „45,6 tys. zł”,
 * „1,2 mln zł” (plan Finora §7.1). Pełną kwotę (`formatPlMoney`) karta daje
 * w `title`. Poniżej tysiąca bez skrótu i bez groszy: „999 zł”.
 */
export function formatPlCompactMoney(n: number): string {
  // Najpierw zaokrąglenie do złotych, potem wybór gałęzi: 999,6 zł to już
  // „1 tys. zł”, a szum po korekcie zerującej miesiąc (−3,55e-15) to „0 zł”,
  // nie „-0 zł”.
  // `Math.round` zaokrągla połówki w górę (−0,5 → −0), więc zaokrąglamy
  // wartość bezwzględną: korekta in minus wygląda jak sprzedaż, ze znakiem.
  const whole = Math.sign(n) * Math.round(Math.abs(n)) || 0;
  if (Math.abs(whole) < 1000) return `${formatPlInt(whole)}\u00a0zł`;
  const compact = new Intl.NumberFormat('pl-PL', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(n) < 1000 ? whole : n);
  return `${compact}\u00a0zł`;
}

/**
 * Liczba w skrócie bez waluty — oś Y wykresów i ciasne kolumny kart Pulpitu
 * (PLAN-PRAWDZIWE-DANE E5): „12,4 tys.”, „125 tys.”, „1,25 mln”. Najwyżej
 * `significantDigits` cyfr znaczących (domyślnie 3), więc szerokość napisu
 * nie rośnie z kwotą. Poniżej tysiąca liczba całkowita: „999”.
 */
export function formatPlCompactNumber(n: number, significantDigits = 3): string {
  const whole = Math.sign(n) * Math.round(Math.abs(n)) || 0;
  if (Math.abs(whole) < 1000) return formatPlInt(whole);
  return new Intl.NumberFormat('pl-PL', {
    notation: 'compact',
    maximumSignificantDigits: significantDigits,
  }).format(n);
}

/**
 * Zmiana procentowa ze znakiem: „+12%”, „−8%” (minus typograficzny),
 * „0%”. Zaokrąglenie do całych procent (plan Finora §7.1).
 */
export function formatPlPercentChange(pct: number): string {
  const rounded = Math.round(pct);
  if (rounded > 0) return `+${rounded}%`;
  if (rounded < 0) return `−${Math.abs(rounded)}%`;
  return '0%';
}
