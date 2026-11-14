import { rokSkladkowyZdrowotnej } from '@/lib/ksiegowosc/parametry';

/**
 * Podpis kwot modułu (NZ-TRESC-02; plan księgowości JDG, sekcja 8), ten sam
 * tekst co pod kwotami na stronie „Ten miesiąc”: rok stawek rozliczanego
 * miesiąca, a gdy wśród kwot jest składka zdrowotna za styczeń, także jej rok
 * składkowy (od lutego poprzedniego roku do stycznia). Kończy się kropką.
 * Używają go przypomnienia (push, dzwonek, mail) i karta „Odłóż na podatek”.
 */
export function podpisKwotMiesiaca(miesiac: string, zdrowotna: boolean): string {
  const rok = Number(miesiac.slice(0, 4));
  const rokSkladkowy = rokSkladkowyZdrowotnej(miesiac);
  const dopisek =
    zdrowotna && rokSkladkowy !== rok
      ? `; składka zdrowotna według stawek roku składkowego od lutego ${rokSkladkowy} r. do stycznia ${rokSkladkowy + 1} r.`
      : '';
  return `Według Twoich danych i stawek na ${rok} r.${dopisek}`;
}
