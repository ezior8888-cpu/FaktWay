import { formatujRachunek } from '@/lib/ksiegowosc/mikrorachunek';
import { rokSkladkowyZdrowotnej } from '@/lib/ksiegowosc/parametry';
import type { RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';

/**
 * Dane do przelewu i podpis kwot „Ten miesiąc”, wspólne dla strony
 * (`reports/ten-miesiac`) i telefonu (`GET /api/mobile/v1/ksiegowosc`, M10b).
 * Przeniesione ze strony bez zmian: mikrorachunek z NIP z symbolem formularza
 * i okresem, rachunek składkowy ZUS z ustawień podatkowych.
 */

const SYMBOL: Readonly<Record<'ryczalt' | 'skala' | 'liniowy', string>> = { ryczalt: 'PPE', skala: 'PIT', liniowy: 'PPL' };

export function daneDoPrzelewu(
  rodzaj: RodzajRozliczenia,
  miesiac: string,
  nip: string | null,
  mikro: string | null,
  nrs: string | null,
  forma: 'ryczalt' | 'skala' | 'liniowy',
): string {
  if (rodzaj === 'ryczalt' || rodzaj === 'pit' || rodzaj === 'vat') {
    if (nip === null) return 'Nie udało się odczytać NIP firmy, więc mikrorachunku teraz nie pokazujemy; strona spróbuje ponownie przy następnym otwarciu.';
    if (!mikro) return 'Mikrorachunek podatkowy wylicza się z NIP firmy, a NIP jest w Ustawieniach, w danych firmy.';
    const symbol = rodzaj === 'vat' ? 'JPK-V7M' : SYMBOL[forma];
    return `Mikrorachunek podatkowy ${formatujRachunek(mikro)}, symbol formularza ${symbol}, okres ${miesiac.slice(2, 4)}M${miesiac.slice(5, 7)}, identyfikator NIP ${nip}.`;
  }
  if (!nrs) return 'Numer rachunku składkowego jest w PUE ZUS; można go zapisać w zakładce „Ustawienia podatkowe”.';
  return `Rachunek składkowy ZUS ${formatujRachunek(nrs)}.`;
}

/** Podpis pod kwotami: dane klienta i stawki roku (zdrowotna według roku składkowego). */
export function podpisKwot(rok: number, rokSkladkowy: number): string {
  const zdrowotna =
    rokSkladkowy !== rok ? `; składka zdrowotna według stawek roku składkowego od lutego ${rokSkladkowy} r. do stycznia ${rokSkladkowy + 1} r.` : '';
  return `Według Twoich danych i stawek na ${rok} r.${zdrowotna}`;
}

/**
 * Ten sam podpis (NZ-TRESC-02) dla kwot spoza strony: przypomnienia (push,
 * dzwonek, mail) i karta „Odłóż na podatek”. Rok składkowy zdrowotnej tylko
 * wtedy, gdy wśród kwot jest składka zdrowotna (strona pokazuje ją zawsze).
 */
export function podpisKwotMiesiaca(miesiac: string, zdrowotna: boolean): string {
  const rok = Number(miesiac.slice(0, 4));
  return podpisKwot(rok, zdrowotna ? rokSkladkowyZdrowotnej(miesiac) : rok);
}
