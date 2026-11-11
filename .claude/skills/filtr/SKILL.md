---
name: filtr
description: Żelazny filtr zmian z ryzykiem prawnym. Użyj, gdy zmiana dotyka pliku z mapy ryzyka (filtr/mapa-ryzyka.json, poziom R1 albo R2: podatki, składki, terminy, faktury, JPK, KSeF, waluty, retencja, treści o podatkach) albo przed PR z takimi plikami: lista kontrolna, karta zmiany, pnpm filtr:lokalnie.
---

Plan i zasady: `docs/koordynacja/PLAN-ZELAZNY-FILTR.md` (część A prostym językiem, B technicznie). Krótko w `filtr/README.md`.

1. **Poziom zmiany:** `pnpm filtr:mapa --diff origin/main`. R1 krytyczny, R2 wprowadza w błąd, R3 pomocniczy, R0 bez ryzyka. Plik z sygnałem poza mapą dopisz do obszaru w `filtr/mapa-ryzyka.json` (wolno bez zgody); wyłączenie, niższy poziom albo usunięta ścieżka to osłabienie (zgoda Bartosza).
2. **R1:** najpierw czerwony test na prawdziwej ścieżce (protokół w `AGENTS.md`); w obszarze R1 to niezmiennik albo przykład urzędowy, nie tylko jeden punkt. Wskaż przepis z rejestru (`filtr/przepisy/`, od kroku F4) albo nowy przepis ze źródłem urzędowym (`docs/koordynacja/ZRODLA-PRAWDY.md`). Nie wpisuj kwot, stawek ani progów do kodu: tylko z parametrów z podpisem.
3. **Napraw wszystkie wystąpienia** tej samej reguły (drugi generator, pulpit, eksport, FLO, PDF): mapa w planie B2 wymienia znane duplikaty.
4. **Przed PR:** `pnpm filtr:lokalnie`, potem drugi czytelnik (`/code-review`) z listą `docs/filtr/LISTA-KONTROLNA.md`: odpowiedź na każde pytanie z plikiem i linią albo „nie dotyczy, bo…”.
5. **Karta zmiany prawnej** w opisie PR (sekcja z `.github/pull_request_template.md`): przy R1 i R2 każde pole wypełnione, poziom nie niższy niż z mapy, w „Dowody” ścieżki testów.
6. **Zgody:** zmiana maszynerii filtra, wiedzy prawnej (przepisy, parametry, złote przypadki, schematy) albo wyjątek wymaga etykiety `zgoda:*` od Bartosza po ostatnim pushu. **Nigdy nie nadawaj ani nie zdejmuj etykiet `zgoda:*`**; poproś w raporcie, co i dlaczego.
7. Gdy filtr blokuje coś, co uważasz za błąd filtra: osobny PR poprawiający filtr (`zgoda:zmiana-filtra`), procedura w `docs/runbooks/filtr.md`. Nie omijaj hooka (`--no-verify`, `SKIP_PREPUSH=1`).
