<!-- Protokół naprawy: AGENTS.md → „Protokół naprawy błędu”. Wypełnij każdą sekcję; „n/d” też jest odpowiedzią. -->

## Co naprawia

<!-- Kod ustalenia (AUD-NN, P-NN, K/W/S z rewizji) i jedno zdanie, co widział klient. -->

## Zmiana

<!-- Plik → co. Jedna naprawa, bez refaktorów przy okazji. -->

## Najpierw test

<!-- Który test był CZERWONY na main przed naprawą (nazwa pliku, ile przypadków) i co pokazuje po naprawie.
     Wyzwalacze / RPC / przejścia statusów: test na bazie (tests/rls-*.test.ts), nie w pamięci. -->

## Ponowienie od zera

<!-- Worker pg-boss wykonuje cały handler ponownie. Co się stanie przy ponowieniu po każdym kroku z efektem zewnętrznym? Jaki klucz / warunek to zabezpiecza? Jeśli PR nie dotyka jobów: n/d. -->

## Weryfikacja

| Sprawdzenie | Wynik |
|---|---|
| `pnpm typecheck` | |
| `eslint` na zmienionych plikach | |
| Vitest obszar | |
| `pnpm vitest run` całość | |
| `pnpm build` (gdy zmiany w `app/`) | |

## Karta zmiany prawnej (filtr)

<!-- Żelazny filtr (docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B5.6). PR R0 i R3: wystarczy „n/d” w pierwszym polu.
     PR R1 i R2: „Filtr: straż” wymaga każdego pola (gdy nie dotyczy: „n/d”). Poziom: pnpm filtr:mapa --diff origin/main.
     R1: id reguł z rejestru (RP-…) i ścieżki testów w „Dowody”. Etykiet zgoda:* nadaje tylko Bartosz. -->

- Poziom i obszary z mapy:
- Rodzaj: naprawa / nowa funkcja / refaktor bez zmiany zachowania / tylko testy / tylko wiedza
- Przepisy z rejestru (id) albo nowy przepis ze źródłem:
- Źródło zmiany wiedzy (Dz.U., ISAP, MF, ZUS, podpis księgowej) albo n/d:
- Co zmienia się dla klienta (kwoty, terminy, pliki, teksty, nic):
- Zaokrąglenia i kwoty ujemne:
- Granice czasu (miesiąc, rok, rok składkowy, strefa):
- Waluty, korekty, zaliczki:
- Brak danych: komunikat dla klienta i ścieżka operatora:
- Treści (D8) i dane osobowe:
- Dowody: test czerwony przed zmianą, niezmienniki, wyrocznia, przykłady, XSD:
- Drugi czytelnik z listą kontrolną (kto, wynik, odpowiedzi na uwagi):
- Wyjątki od filtra (etykieta, powód) albo brak:

## Migracje

<!-- Brak / numer z rejestru (docs/koordynacja/CLAUDE-DO-CODEXA.md) + „przed” czy „PO wdrożeniu” + co sprawdzić po wgraniu. -->

## Po wdrożeniu

<!-- Co operator ma zobaczyć (log workera, alarm, który się NIE odezwie, zapytanie kontrolne). -->
