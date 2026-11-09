# Wyrocznie: ryczałt, składki ZUS i składka zdrowotna JDG (2026)

Napisz TRZY pliki TypeScript w tym katalogu: `ryczalt.ts`, `zus.ts`,
`zdrowotna.ts`. Każdy bez importów, arytmetyka na BigInt w groszach (liczby
całkowite), bez liczb zmiennoprzecinkowych. Literały BigInt pisz jako
`BigInt(100)`, NIE `100n` (projekt kompiluje do ES2017). Stawki w punktach
bazowych: 10000 = 100 %. „Do grosza, połówka w górę” znaczy: wynik dokładny
w ułamkach grosza zaokrąglij do najbliższego grosza, pół grosza w górę.

## 1. zus.ts: składki na ubezpieczenia społeczne za pełny miesiąc

```ts
export type EtapZusWyrocznia = 'pelny' | 'preferencyjny' | 'ulga_na_start' | 'etat_obok';
export interface ParametryZus {
  prognozowanePrzecietneGr: number; // prognozowane przeciętne wynagrodzenie (np. 942000 = 9 420 zł)
  placaMinimalnaGr: number;         // minimalne wynagrodzenie (480600 = 4 806 zł)
  podstawaPelnaPb: number;          // 6000 = 60 %
  podstawaPreferencyjnaPb: number;  // 3000 = 30 %
  emerytalnaPb: number; rentowaPb: number; chorobowaPb: number;
  wypadkowaDoMarcaPb: number; wypadkowaOdKwietniaPb: number; funduszPracyPb: number;
}
export interface SkladkiZusWyrocznia {
  podstawaGr: number; emerytalnaGr: number; rentoweGr: number; chorobowaGr: number;
  wypadkowaGr: number; razemGr: number; funduszPracyGr: number;
}
export function skladkiWyrocznia(etap: EtapZusWyrocznia, chorobowe: boolean, miesiac: number /* 1-12 */, p: ParametryZus): SkladkiZusWyrocznia;
```

Przepisy (ustawa o systemie ubezpieczeń społecznych art. 18 ust. 8, art. 18a;
Prawo przedsiębiorców art. 18 ust. 1; ustawa o Funduszu Pracy):
- ulga na start i etat obok (zbieg tytułów): wszystkie kwoty 0;
- podstawa: przy „pelny” 60 % prognozowanego przeciętnego wynagrodzenia, przy
  „preferencyjny” 30 % minimalnego wynagrodzenia; do grosza, połówka w górę;
- każda składka osobno: podstawa × stawka, do grosza, połówka w górę;
  chorobowa tylko gdy `chorobowe` (dobrowolna), inaczej 0;
- stawka wypadkowa: styczeń-marzec `wypadkowaDoMarcaPb`, od kwietnia `wypadkowaOdKwietniaPb`;
- `razemGr` = emerytalna + rentowa + chorobowa + wypadkowa (bez Funduszu Pracy);
- Fundusz Pracy (osobno): podstawa × stawka FP, do grosza, tylko przy „pelny”
  (przy preferencyjnym podstawa jest niższa niż minimalne wynagrodzenie, więc 0).

Przykład do sprawdzenia: pełny, z chorobową, marzec, przy parametrach
z nawiasów i stawkach emerytalna 1952, rentowa 800, chorobowa 245, wypadkowa 167,
FP 245: podstawa 5 652,00 zł, razem 1 788,29 zł, FP 138,47 zł (tabela ZUS 2026:
razem z FP 1 926,76 zł). Preferencyjny z chorobową: podstawa 1 441,80 zł, razem 456,18 zł, FP 0.

## 2. zdrowotna.ts: składka zdrowotna

```ts
export interface ParametryZdrowotnej {
  stawkaPb: number;                 // 900 = 9 % (ryczałt i skala)
  stawkaLiniowyPb: number;          // 490 = 4,9 %
  przecietneIvKwGr: number;         // przeciętne wynagrodzenie w IV kwartale roku poprzedniego (922864 = 9 228,64 zł)
  placaMinimalnaGr: number;         // minimalne wynagrodzenie (480600)
  progRyczaltu60Gr: number;         // 6_000_000 = 60 000 zł
  progRyczaltu300Gr: number;        // 30_000_000 = 300 000 zł
}
export function zdrowotnaRyczaltuWyrocznia(przychodNarastajacoGr: number, p: ParametryZdrowotnej): number; // składka w groszach
export function zdrowotnaOdDochoduWyrocznia(forma: 'skala' | 'liniowy', dochodGr: number, p: ParametryZdrowotnej): number;
```

Przepisy (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków
publicznych, art. 79 i art. 81):
- ryczałt: podstawa to 60 % przeciętnego wynagrodzenia z IV kwartału przy
  przychodzie od początku roku do 60 000 zł włącznie, 100 % do 300 000 zł
  włącznie, 180 % powyżej; podstawa do grosza (połówka w górę), składka 9 %
  podstawy, do grosza (połówka w górę);
- skala: 9 % dochodu (ujemny dochód liczy się jak 0), liniowy: 4,9 % dochodu;
  do grosza, połówka w górę; nie mniej niż minimum = 9 % minimalnego
  wynagrodzenia (do grosza, połówka w górę), także przy skali i liniowym.

Przykład: ryczałt do 60 000 zł → 498,35 zł; do 300 000 zł → 830,58 zł;
powyżej → 1 495,04 zł; minimum skali i liniowego 432,54 zł.

## 3. ryczalt.ts: ryczałt od przychodów ewidencjonowanych za miesiąc

```ts
export interface WejscieRyczaltuWyrocznia {
  przychodWgStawek: Array<[number, number]>;   // [stawka w pb, przychód miesiąca w groszach]; kwota może być ujemna (korekta)
  ujemneZPoprzednich: Array<[number, number]>; // [stawka, ujemny przychód tej stawki przeniesiony z wcześniejszych miesięcy roku]
  spoleczneZaplaconeGr: number;                // składki społeczne (bez FP) zapłacone w miesiącu
  zdrowotnaZaplaconaGr: number;                // składka zdrowotna zapłacona w miesiącu
  nadwyzkaZPoprzednichGr: number;              // odliczenia niewykorzystane we wcześniejszych miesiącach roku
  odliczenieZdrowotnejPb: number;              // 5000 = 50 %
}
export interface WynikRyczaltuWyrocznia {
  ryczaltGr: number;                           // w pełnych złotych (w groszach)
  odliczonoGr: number;
  nadwyzkaNaKolejneGr: number;
  podstawaWgStawek: Array<[number, number]>;   // [stawka, podstawa w pełnych złotych w groszach], posortowane po stawce malejąco
  ujemneNaKolejne: Array<[number, number]>;    // [stawka, ujemna kwota], posortowane po stawce malejąco
}
export function ryczaltWyrocznia(w: WejscieRyczaltuWyrocznia): WynikRyczaltuWyrocznia;
```

Przepisy (ustawa o zryczałtowanym podatku dochodowym art. 11 ust. 1 i 1a,
art. 12; ustawa o PIT art. 14 ust. 1m i 1n przez art. 6 ust. 1a; Ordynacja
podatkowa art. 63 § 1) i reguły programu:
1. Dla każdej stawki: przychód miesiąca plus ujemne z poprzednich miesięcy tej
   samej stawki. Wynik ujemny nie jest opodatkowany i przechodzi dalej
   (`ujemneNaKolejne`); wynik zero pomijamy; dodatni to przychód stawki.
2. Odliczenia dostępne = nadwyżka z poprzednich + składki społeczne zapłacone +
   50 % zapłaconej zdrowotnej (do grosza, połówka w górę).
3. Odliczono = mniejsza z: dostępne, suma dodatnich przychodów stawek.
   Nadwyżka na kolejne = dostępne minus odliczono.
4. Odliczono dzieli się między stawki proporcjonalnie do przychodu stawki, co
   do grosza: każda stawka dostaje część całkowitą (w dół) swojej proporcji,
   a pozostałe grosze rozdaje się po jednym stawkom z największą resztą
   z dzielenia; przy równych resztach najpierw wyższa stawka (reguła programu,
   do potwierdzenia przez księgową).
5. Podstawa stawki = przychód stawki minus jej część odliczeń, zaokrąglona do
   pełnych złotych (poniżej 50 gr w dół, 50 gr i więcej w górę).
6. Ryczałt = suma (podstawa stawki × stawka), policzona dokładnie, zaokrąglona
   raz do pełnych złotych (50 gr i więcej w górę).

Przykład: jedna stawka 12 %, przychód 15 000 zł, bez odliczeń → ryczałt 1 800 zł.
Dwie stawki: 8,5 % przychód 10 000 zł i 12 % przychód 5 000 zł, odliczenia
społeczne 1 000 zł, zdrowotna 0 → części odliczeń 666,67 zł i 333,33 zł;
podstawy 9 333 zł i 4 667 zł; ryczałt 793,305 + 560,04 = 1 353,345 zł → 1 353 zł.
