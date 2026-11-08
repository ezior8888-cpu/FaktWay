# expense.review — koszt do decyzji

Grupa W (W-01, W-02) · promień 2 · karta: `single`

## Tytuł

{{sprzedawca}}, {{kwota}}

## Treść

Zaksięgowałem to jako {{kategoria}}. Sprawdź, jeśli to nie był firmowy zakup — cofnę jednym kliknięciem.

## Warianty

### :done — odczyt pewny, koszt zaksięgowany

Tytuł: {{sprzedawca}}, {{kwota}}

Treść: Zaksięgowałem to jako {{kategoria}}, kolumna {{kolumna}}. Sprawdź, jeśli to nie był firmowy zakup — cofnę jednym kliknięciem.

### :ask — coś się nie zgadza, agent NIE twierdzi, że zaksięgował

Tytuł: {{sprzedawca}}, {{kwota}} — do sprawdzenia

Treść: {{powod}} Zajrzyj na chwilę, zanim to zaksięguję.

### :failed — odczyt się nie udał

Tytuł: Nie odczytałem tego zdjęcia

Treść: Zdjęcie zostało w archiwum, nic nie przepadło. Wgraj je jeszcze raz albo zrób nowe ujęcie przy lepszym świetle.

## Przyciski

- główny (`:done`): Zgadza się
- główny (`:ask`): Zobacz i zdecyduj
- główny (`:failed`): Otwórz Wydatki
- drugorzędne: Nie teraz · Nigdy więcej takich

## Zasady, których ten tekst pilnuje

- Wariant `:ask` NIE zawiera słowa „zaksięgowałem”. Agent, który mówi, że
  zrobił coś, czego nie zrobił, traci zaufanie raz i na zawsze.
- Wariant `:done` zawsze mówi o cofnięciu — czynność jest odwracalna i klient
  ma to wiedzieć, zanim zdąży się zdenerwować.
- Powód wątpliwości (`{{powod}}`) przychodzi z silnika i jest konkretny
  („kwota odbiega od tego, co zwykle płacisz u tego sprzedawcy”), nigdy
  „coś wygląda dziwnie”.
