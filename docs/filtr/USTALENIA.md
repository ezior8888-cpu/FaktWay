# Ustalenia żelaznego filtra (FZ)

Plan: `docs/koordynacja/PLAN-ZELAZNY-FILTR.md` (B7). Jeden wiersz to jedno
znalezisko: co filtr złapał, gdzie, jaka waga, jaki test to pokazuje i co
dalej. Test łamany na `main` jest oznaczony `.fails` z numerem FZ, więc CI
zostaje zielone, a znalezisko widać. Naprawa idzie osobnym PR według
protokołu (`AGENTS.md`), najpierw zdjęcie `.fails` (test czerwony), potem kod.
Wagi: KRYT (zła kwota albo dokument dla klientów dziś), WYS (zła kwota
w module za wyłącznikiem albo w rzadkim przypadku), ŚR (rozjazd bez wpływu na
kwotę dziś), NISK (porządek).

| FZ | Data | Obszar | Waga | Opis | Test | Stan |
|---|---|---|---|---|---|---|
| FZ-001 | 9.11.2026 | `ksiegowosc.silniki` | NISK | `doPelnychZlotych` (`lib/ksiegowosc/ryczalt.ts`) i `doZlotych` (`lib/ksiegowosc/pit.ts`) zaokrąglają inaczej kwoty ujemne z końcówką dokładnie 50 gr (-1,50 zł daje -1 zł i -2 zł). Ryczałt nie dostaje dziś ujemnej podstawy, więc klient tego nie widzi; reguła RP-ZAOKR-01 wymaga jednej funkcji (NZ-ZAOKR-04) | `tests/filtr/niezmienniki/zaokraglenia.test.ts` > FZ-001 | otwarte |
| FZ-002 | 9.11.2026 | `jpk.vat-fa` | INFO | `wholeZloty` (`lib/exports/jpk-v7m-generator.ts`) daje ujemne zero (-0) dla kwoty ujemnej poniżej 50 gr, np. korekty zakupu -0,03 zł; widać to w `summarizeJpkV7m().purchaseNet`. Dziś bez skutku: w pliku XML pole ma wartość „0”, a moduł VAT (`lib/ksiegowosc/vat.ts`) tego pola nie zwraca, a jego sumy i `Math.max` dają zwykłe 0. Gdyby kiedyś trafiło do `Intl.NumberFormat`, pokaże „-0,00 zł”; poprawka to zwrócić 0 zamiast -0 | `tests/filtr/roznicowe/vat.test.ts` (porównanie z `+ 0`) | otwarte |
