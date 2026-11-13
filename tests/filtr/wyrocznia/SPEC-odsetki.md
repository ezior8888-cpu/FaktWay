# SPEC: odsetki za opóźnienie i rekompensata za koszty odzyskiwania należności

Źródła: Kodeks cywilny (art. 481 § 1 i § 2), ustawa z 8 marca 2013 r.
o przeciwdziałaniu nadmiernym opóźnieniom w transakcjach handlowych (art. 4
pkt 3, art. 7, art. 10 ust. 1). Wyrocznia powstaje w czystym pokoju: tylko z tego
pliku, bez kodu aplikacji.

## 1. Odsetki ustawowe za opóźnienie (art. 481 KC)

Jeżeli dłużnik opóźnia się ze spełnieniem świadczenia pieniężnego, wierzyciel
może żądać odsetek za czas opóźnienia (§ 1). Odsetki ustawowe za opóźnienie
wynoszą tyle, ile suma stopy referencyjnej Narodowego Banku Polskiego
i 5,5 punktu procentowego, w stosunku rocznym (§ 2). Stawka zmienia się razem
z każdą zmianą stopy referencyjnej.

## 2. Odsetki ustawowe za opóźnienie w transakcjach handlowych (art. 4 pkt 3 lit. a, art. 7)

W transakcji handlowej (oba podmioty to przedsiębiorcy), gdy dłużnik nie jest
podmiotem publicznym będącym podmiotem leczniczym, odsetki wynoszą tyle, ile
suma:
- stopy referencyjnej NBP obowiązującej 1 stycznia, dla pierwszego półrocza
  danego roku (1 stycznia do 30 czerwca), albo obowiązującej 1 lipca, dla
  drugiego półrocza (1 lipca do 31 grudnia),
- 10 punktów procentowych,

w stosunku rocznym. W trakcie półrocza stawka się nie zmienia, nawet gdy NBP
zmieni stopę referencyjną.

Wniosek (niezmiennik): na 1 stycznia i na 1 lipca obie stawki opierają się na tej
samej stopie referencyjnej, więc stawka „w transakcjach handlowych” jest wtedy
wyższa od stawki z art. 481 KC dokładnie o 4,5 punktu procentowego (10 − 5,5).

## 3. Rekompensata za koszty odzyskiwania należności (art. 10 ust. 1)

Od dnia nabycia uprawnienia do odsetek wierzycielowi przysługuje od dłużnika,
bez wezwania, równowartość kwoty:
- 40 euro, gdy wartość świadczenia pieniężnego nie przekracza 5 000 zł,
- 70 euro, gdy wartość świadczenia pieniężnego jest wyższa niż 5 000 zł,
  ale niższa niż 50 000 zł,
- 100 euro, gdy wartość świadczenia pieniężnego jest równa lub wyższa od
  50 000 zł.

Granice: 5 000,00 zł to 40 euro, 5 000,01 zł to 70 euro, 49 999,99 zł to
70 euro, 50 000,00 zł to 100 euro. Przeliczenie euro na złote (średni kurs NBP
z ostatniego dnia roboczego miesiąca przed miesiącem wymagalności) nie należy
do tej wyroczni.

## 4. Liczenie kwoty odsetek (konwencja programu, nie przepis)

- Odsetki należą się za każdy dzień opóźnienia. Dzień terminu płatności nie
  jest dniem opóźnienia; pierwszy dzień opóźnienia to dzień po terminie.
- Okres od dnia `od` (pierwszy dzień opóźnienia, włącznie) do dnia `do`
  (wyłącznie) ma tyle dni, ile wynosi różnica dat w dniach kalendarzowych.
- Rok liczy się jako 365 dni, także w roku przestępnym.
- Na każdy dzień stosuje się stawkę obowiązującą w tym dniu: z tabeli stawek
  bierze się ostatnią pozycję, której data obowiązywania jest nie późniejsza
  niż ten dzień. Przed pierwszą pozycją tabeli stawki nie ma.
- Kwota dokładna (bez zaokrągleń) to suma po dniach: kwota główna × stawka
  roczna danego dnia / 365. Wyrocznia podaje ją jako ułamek dokładny albo
  liczbę z dokładnością co najmniej do 10⁻⁶ grosza, bez zaokrąglania.

Wejście funkcji liczącej: kwota główna w groszach (liczba całkowita dodatnia),
`od` i `do` jako daty RRRR-MM-DD, tabela stawek jako lista `{ od: RRRR-MM-DD,
stawka: ułamek roczny, np. 0,125 }` posortowana rosnąco. Gdy `do` ≤ `od` albo
kwota ≤ 0, odsetek nie ma (0).
