# Lista kontrolna prawna (drugi czytelnik)

Żelazny filtr, plan `docs/koordynacja/PLAN-ZELAZNY-FILTR.md`, B4.9. Wspólna dla
Claude (skill `/filtr`, `/code-review`) i Codexa (`AGENTS.md`). Drugi czytelnik
to osobna sesja, która nie pisała zmiany. Przy zmianie R1 i R2 odpowiada na
każde pytanie z plikiem i linią albo „nie dotyczy, bo…”. Wynik idzie do karty
zmiany prawnej w opisie PR (pole „Drugi czytelnik”).

1. Który przepis z rejestru (id)? Czy data obowiązywania obejmuje okresy,
   które kod liczy?
2. Czy źródło jest urzędowe (hierarchia w `docs/koordynacja/ZRODLA-PRAWDY.md`)?
   Jeśli branżowe: pewność „niska” i pytanie do księgowej.
3. Zaokrąglenia: która reguła, w którym miejscu (pozycja, suma, podstawa,
   podatek), co z kwotami ujemnymi?
4. Czy kwoty są groszami od wejścia do wyjścia? Jak wchodzą z bazy (typ
   `numeric` jako tekst)?
5. Granice czasu: miesiąc w Warszawie, ostatni dzień miesiąca, rok, rok
   składkowy zdrowotnej (luty-styczeń), rok stopy wypadkowej
   (kwiecień-marzec), zmiana czasu, rok przestępny.
6. Terminy: dzień ustawowy, przesunięcie z weekendu i święta, grudzień
   i styczeń.
7. Waluty: kurs, dzień kursu, tabela, brak kursu.
8. Korekty: okres ujęcia, łańcuch korekt, korekta większa niż przychód.
9. Zaliczki: brak dublowania, rozliczenie w fakturze końcowej.
10. Faktura do paragonu, faktury spoza KSeF, środowisko KSeF (test
    i produkcja).
11. Brak danych: komunikat z nazwą braku, wyjście dla klienta i operatora;
    nigdy 0 zamiast braku.
12. Parametry: tylko z rejestru; podpis księgowej; następny rok.
13. Wersje i niezmienność zatwierdzonych rozliczeń.
14. Ponowienie zadania od zera: idempotencja maila, pusha, wysyłki JPK
    i KSeF.
15. Odczyt stronami (1000 wierszy PostgREST).
16. Treści: bez porad i trybu rozkazującego; podpis „według Twoich danych”;
    „FaktWay”; bez długich myślników.
17. Dane osobowe: co zapisujemy, co logujemy, jak długo; dane autoryzujące
    nigdzie.
18. Wyłącznik i podpis księgowej: czy nowa ścieżka je respektuje?
19. Dowody: test czerwony przed zmianą; niezmienniki dotkniętych reguł;
    wyrocznia; złote przypadki; XSD; test na bazie dla wyzwalaczy.
20. Wszystkie wystąpienia: czy ta sama reguła jest liczona gdzie indziej
    (drugi generator, pulpit, eksport, FLO, PDF)?
21. Co zobaczy klient, jeśli to jest źle, i czy ten obszar działa dziś dla
    wszystkich firm?
