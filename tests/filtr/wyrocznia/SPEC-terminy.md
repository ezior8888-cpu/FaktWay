# SPEC: terminy płatności podatków i składek JDG oraz dni wolne od pracy

Źródła: ustawa z 18 stycznia 1951 r. o dniach wolnych od pracy (art. 1, w brzmieniu
z nowelizacją z 2024 r.: 24 grudnia dniem wolnym od roku 2025), Ordynacja podatkowa
(art. 12 § 5), ustawa o podatku dochodowym od osób fizycznych (art. 44 ust. 6),
ustawa o zryczałtowanym podatku dochodowym (art. 21 ust. 1), ustawa o systemie
ubezpieczeń społecznych (art. 47 ust. 1 pkt 1), ustawa o VAT (art. 99 ust. 1,
art. 109 ust. 3b).

## 1. Dni wolne od pracy (ustawa o dniach wolnych od pracy, art. 1)

Dniami wolnymi od pracy są niedziele oraz dni:
- 1 stycznia (Nowy Rok),
- 6 stycznia (Święto Trzech Króli),
- pierwszy dzień Wielkiej Nocy (niedziela wielkanocna),
- drugi dzień Wielkiej Nocy (poniedziałek, dzień po niedzieli wielkanocnej),
- 1 maja,
- 3 maja,
- pierwszy dzień Zielonych Świątek (niedziela, 49 dni po niedzieli wielkanocnej),
- dzień Bożego Ciała (czwartek, 60 dni po niedzieli wielkanocnej),
- 15 sierpnia,
- 1 listopada,
- 11 listopada,
- 24 grudnia, ale dopiero od roku 2025 (w latach 2024 i wcześniej 24 grudnia nie jest dniem wolnym),
- 25 grudnia,
- 26 grudnia.

Niedziela wielkanocna: kalendarz gregoriański, zachodnia (katolicka) Wielkanoc,
czyli pierwsza niedziela po pierwszej pełni księżyca przypadającej 21 marca lub
później, liczona zwykłym algorytmem komputystycznym dla kalendarza gregoriańskiego
(np. algorytm Meeusa/Jonesa/Butchera). Przykłady do sprawdzenia: 2026 → 5 kwietnia,
2027 → 28 marca, 2028 → 16 kwietnia.

Sobota NIE jest dniem wolnym od pracy w rozumieniu tej ustawy, ale Ordynacja
podatkowa traktuje ją przy terminach tak samo (punkt 3).

## 2. Terminy nominalne (za okres rozliczeniowy = miesiąc kalendarzowy)

Okres: rok R i miesiąc M (1-12). Termin zawsze w miesiącu następującym po okresie
(za grudzień R: w styczniu R+1).

| rodzaj | podstawa | dzień miesiąca następującego |
|---|---|---|
| `zaliczkaPit` (zaliczka na PIT, skala lub liniowy) | art. 44 ust. 6 ustawy o PIT | 20 |
| `ryczalt` (ryczałt od przychodów ewidencjonowanych) | art. 21 ust. 1 ustawy o zryczałtowanym podatku | 20 |
| `zus` (składki przedsiębiorcy opłacającego składki tylko za siebie) | art. 47 ust. 1 pkt 1 ustawy o systemie ubezpieczeń społecznych | 20 |
| `vatJpk` (VAT i JPK_V7M za miesiąc) | art. 99 ust. 1 i art. 109 ust. 3b ustawy o VAT | 25 |

## 3. Przesunięcie terminu (art. 12 § 5 Ordynacji podatkowej)

Jeżeli ostatni dzień terminu przypada na sobotę lub na dzień ustawowo wolny od pracy
(punkt 1, w tym każdą niedzielę), za ostatni dzień terminu uważa się następny dzień
po dniu lub dniach wolnych od pracy (czyli pierwszy dzień, który nie jest sobotą,
niedzielą ani dniem z listy w punkcie 1). Termin nigdy nie przesuwa się wstecz.
Ta sama reguła dotyczy składek ZUS.

## 4. Interfejs do napisania (TypeScript, jeden plik, bez importów)

Daty jako napisy 'RRRR-MM-DD'. Bez stref czasowych: licz na liczbach całkowitych
(np. numer dnia od epoki w UTC) albo na `Date.UTC` i metodach `getUTC*`.

```ts
export type Rodzaj = 'ryczalt' | 'zaliczkaPit' | 'zus' | 'vatJpk';
/** Niedziela wielkanocna w roku. */
export function wielkanoc(rok: number): string;
/** Wszystkie dni z listy w punkcie 1 dla roku, rosnąco, bez zwykłych niedziel
 *  (niedziela wielkanocna i Zielone Świątki są na liście, choć to niedziele). */
export function swietaUstawowe(rok: number): string[];
/** Czy dzień jest dniem ustawowo wolnym od pracy: niedziela albo dzień z punktu 1. */
export function czyDzienWolnyOdPracy(data: string): boolean;
/** Czy w tym dniu może upłynąć termin (nie sobota, nie niedziela, nie dzień z punktu 1). */
export function czyDzienTerminu(data: string): boolean;
/** Pierwszy dzień >= data, w którym może upłynąć termin (punkt 3). */
export function przesunTermin(data: string): string;
/** Termin za okres (rok, miesiąc 1-12): nominalny z punktu 2 i faktyczny po punkcie 3. */
export function termin(rodzaj: Rodzaj, rok: number, miesiac: number): { nominalny: string; faktyczny: string };
```

Zakres lat: co najmniej 1990-2100. Nieprawidłowe wejście (miesiąc spoza 1-12, data
w złym formacie): rzuć błąd.
