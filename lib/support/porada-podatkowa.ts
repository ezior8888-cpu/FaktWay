/**
 * Pytania o poradę podatkową w czacie pomocy (S-12). Zakaz porad był dotąd
 * tylko w poleceniu dla modelu. Klasyfikator FLO (`lib/flo/tax-topic.ts`) jest
 * celowo szeroki (każde „VAT”, „JPK”, „ZUS”), a w czacie pomocy aplikacji do
 * faktur takie słowa ma większość pytań o obsługę. Tu wąsko: prośba o ocenę
 * własnej sytuacji (czy mogę odliczyć, jaką stawkę wybrać, czy to koszt, ile
 * zapłacę, co się bardziej opłaca, czy muszę być podatnikiem VAT). Takie
 * pytanie nie trafia do modelu, odpowiedź jest stała.
 */

/** Małe litery, bez polskich znaków: łapie też „czy moge odliczyc”. */
function normalizuj(tekst: string): string {
  return tekst
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const WZORCE: readonly RegExp[] = [
  // czy mogę / wolno / trzeba / muszę … odliczyć, zaliczyć, rozliczyć, opodatkować
  /\bczy\s+(moge|mozna|mozemy|wolno|trzeba|musze|nalezy|powinienem|powinnam)\b.*\b(odlicz|zalicz|rozlicz|opodatkow|wrzuci|ujac|ujmowac)/,
  // jaką stawkę mam wybrać / zastosować
  /\bjak(a|ie|i)?\s+stawk\w*\b.*\b(mam|wybra|zastosow|powinien|powinnam|nalezy|trzeba)/,
  // czy to (jest) koszt / przychód / zwolnione
  /\bczy\b.*\b(to|ten|ta|te|taki|taka|takie)\s+(jest\s+|sa\s+|bedzie\s+)?(koszt|przychod|zwolnion)\w*/,
  // ile zapłacę / wyniesie
  /\bile\s+(zaplac|bede\s+placi|wyniesie|wyjdzie|mam\s+zaplaci|musze\s+zaplaci|trzeba\s+zaplaci)\w*/,
  // co się bardziej opłaca, co wybrać: ryczałt, skala, liniowy
  /\b(bardziej|lepiej)\s+(sie\s+)?oplaca|\boplaca\s+sie\s+(bardziej|lepiej)\b|\bco\s+(wybrac|lepsze)\b.*\b(ryczalt|skal|liniow)/,
  // czy muszę być / zostać podatnikiem VAT, przejść na ryczałt
  /\bczy\s+(musze|trzeba|powinienem|powinnam|moge)\s+(byc|zostac|zarejestrowac|przejsc)\b.*\b(vat|podatnik|zwolnion|ryczalt|skal|liniow)/,
];

export function czyPytanieOPorade(tekst: string): boolean {
  const t = normalizuj(tekst);
  return WZORCE.some((w) => w.test(t));
}

/** Stała odpowiedź na pytanie o poradę: bez oceny, z drogą do księgowej i do człowieka. */
export const ODPOWIEDZ_PORADA =
  'Na pytania o to, jak rozliczyć podatek w Twojej sytuacji, w czacie nie odpowiadam: to zależy od szczegółów, więc potwierdź to z księgową albo doradcą podatkowym. ' +
  'W obsłudze FaktWay chętnie pomogę, np. gdzie co ustawić w aplikacji. Możesz też użyć przycisku „Połącz z człowiekiem” pod rozmową.';
