# Wyrocznia: zaliczki na podatek dochodowy (PIT) JDG, skala i podatek liniowy, rok 2026

Napisz JEDEN plik TypeScript `pit.ts` w tym katalogu: niezależną implementację
obliczeń z przepisów poniżej. Bez importów (żadnych bibliotek, żadnego kodu
z innych miejsc). Arytmetyka na BigInt w groszach (liczby całkowite), bez
liczb zmiennoprzecinkowych w obliczeniach kwot.

## Interfejs (dokładnie taki)

```ts
export type FormaPitWyrocznia = 'skala' | 'liniowy';

export interface MiesiacWejscia {
  przychodGr: number;            // przychód miesiąca w groszach (liczba całkowita, ≥ 0)
  kosztyGr: number;              // koszty uzyskania przychodu miesiąca w groszach (≥ 0)
  spoleczneZaplaconeGr: number;  // składki na ubezpieczenia społeczne zapłacone w tym miesiącu (≥ 0)
  zdrowotnaZaplaconaGr: number;  // składka zdrowotna zapłacona w tym miesiącu (≥ 0); odlicza tylko liniowy
}

export interface ParametryPit {
  skalaStawka1Pb: number;        // 1200 = 12 %
  skalaStawka2Pb: number;        // 3200 = 32 %
  skalaProgGr: number;           // 12_000_000 = 120 000 zł
  kwotaZmniejszajacaGr: number;  // 360_000 = 3 600 zł
  liniowyStawkaPb: number;       // 1900 = 19 %
  limitZdrowotnejGr: number;     // 1_410_000 = 14 100 zł rocznie (limit odliczenia przy liniowym)
}

export interface MiesiacWyniku {
  podstawaNarastajacoGr: number; // podstawa obliczenia podatku od początku roku, w pełnych złotych (w groszach)
  podatekNarastajacoGr: number;  // podatek od podstawy od początku roku (w groszach, przed odjęciem zaliczek)
  zaliczkaGr: number;            // zaliczka za ten miesiąc, w pełnych złotych (w groszach)
}

/** Miesiące od stycznia, bez przerw. Wynik: tyle samo miesięcy. */
export function zaliczkiWyrocznia(forma: FormaPitWyrocznia, miesiace: MiesiacWejscia[], p: ParametryPit): MiesiacWyniku[];
```

## Przepisy (stan 2026)

1. Ustawa o PIT, art. 44 ust. 3f: zaliczka za miesiąc to różnica między podatkiem
   od dochodu osiągniętego od początku roku a sumą zaliczek należnych za
   poprzednie miesiące. Gdy różnica wychodzi ujemna albo zero, zaliczki za ten
   miesiąc nie ma (0).
2. Dochód od początku roku = suma przychodów minus suma kosztów od stycznia do
   miesiąca włącznie (może być ujemny, czyli strata).
3. Ustawa o PIT, art. 26 ust. 1 pkt 2: od dochodu odlicza się składki na
   ubezpieczenia społeczne zapłacone od początku roku, ale tylko do wysokości
   dochodu (odliczenie nie tworzy straty). Przy stracie odliczenie to 0.
4. Ustawa o PIT, art. 30c ust. 2 (tylko podatek liniowy): od dochodu
   pomniejszonego o składki społeczne odlicza się także składkę zdrowotną
   zapłaconą od początku roku, najwyżej do limitu rocznego i najwyżej do tego,
   co zostało z dochodu (bez tworzenia straty).
5. Ordynacja podatkowa, art. 63 § 1: podstawę opodatkowania zaokrągla się do
   pełnych złotych (końcówki poniżej 50 groszy pomija się, 50 groszy i więcej
   podwyższa do pełnego złotego). Podstawa nie jest ujemna (przy stracie 0).
   Kwotę zaliczki też zaokrągla się do pełnych złotych według tej samej reguły.
6. Ustawa o PIT, art. 27 ust. 1 (skala): od podstawy do 120 000 zł podatek to
   12 % podstawy minus kwota zmniejszająca 3 600 zł (nie mniej niż 0); powyżej
   120 000 zł podatek to 10 800 zł plus 32 % nadwyżki ponad 120 000 zł. Użyj
   parametrów z `ParametryPit` (nie wpisuj liczb na sztywno).
7. Ustawa o PIT, art. 30c ust. 1 (liniowy): podatek to 19 % podstawy.
8. Suma zaliczek należnych za poprzednie miesiące to suma Twoich wyliczonych
   (zaokrąglonych) zaliczek z wcześniejszych miesięcy tego roku.

Podatek od podstawy w pełnych złotych przy stawkach w punktach bazowych daje
zawsze pełne grosze, więc liczysz go dokładnie (bez zaokrąglania).

Zwróć `podatekNarastajacoGr` jako podatek od podstawy od początku roku (już po
kwocie zmniejszającej przy skali, nie mniej niż 0), a `zaliczkaGr` według pkt 1, 5 i 8.

Na końcu pliku nic poza implementacją. Krótkie komentarze po polsku z numerem
punktu przepisu. Sprawdź ręcznie dwa przykłady w komentarzu na górze pliku:
(a) skala, jeden miesiąc, przychód 140 000 zł, koszty 10 000 zł, bez składek
→ podstawa 130 000 zł, podatek 10 800 + 32 % × 10 000 = 14 000 zł, zaliczka 14 000 zł;
(b) liniowy, jeden miesiąc, przychód 10 000,49 zł, koszty 0, społeczne 1 000 zł,
zdrowotna 500 zł → podstawa 8 500 zł (z 8 500,49 zł), podatek 1 615 zł, zaliczka 1 615 zł.
