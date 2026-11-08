# Żelazny filtr: gdy coś zablokuje

> Plan: `docs/koordynacja/PLAN-ZELAZNY-FILTR.md` (B6). Dane filtra: `filtr/`
> (`README.md` w skrócie). Etykiety zgody nadaje tylko Bartosz.

## Gdzie filtr łapie i co dalej

| Gdzie | Co widać | Co zrobić |
|---|---|---|
| hook Claude po edycji | `[FILTR] … jest poza mapą ryzyka` (kod 2) | dopisać plik do obszaru w `filtr/mapa-ryzyka.json`; sprawdzić `pnpm filtr:mapa <plik>` |
| hook Claude przed poleceniem | `[FILTR] Polecenie zablokowane (…)` | nie omijać; etykiety i ustawienia GitHuba robi Bartosz |
| pre-push | `pre-push: żelazny filtr…` albo `testy żelaznego filtra … czerwone` | poprawić i wypchnąć ponownie; `pnpm filtr:lokalnie` pokazuje to samo |
| „Filtr: straż” w PR | lista wymogów: plik, co zrobić, kto daje wyjątek | uzupełnić kartę, mapę albo testy; o etykietę poprosić Bartosza po ostatnim pushu |
| test `tests/filtr/mapa.test.ts` | plik z sygnałem poza mapą albo martwy wzorzec | dopisać plik do mapy; martwy wzorzec poprawić albo usunąć |

Lokalnie przed PR:

```bash
pnpm filtr:lokalnie
```

```bash
node scripts/filtr/straz.mjs --pr 488 --tylko-raport
```

## Wyjątki

Wyjątek zwalnia tylko z wymogu straży (karta, test przy kodzie R1, komentarz
`filtr-wyjatek`), nigdy z czerwonego testu prawnego. Wymaga etykiety
`zgoda:wyjatek-filtra` i powodu w karcie (pole „Wyjątki od filtra”). Rejestr
wyjątków: `docs/filtr/WYJATKI.md` (od pierwszego wyjątku): data, PR, reguła,
powód, kto, do kiedy.

## Awaria filtra (pilna poprawka produkcji)

1. Czerwony wymóg straży: `zgoda:wyjatek-filtra` z powodem w karcie.
2. Czerwony test filtra, a poprawka dotyczy czego innego: najpierw osobny PR
   poprawiający test albo filtr (`zgoda:zmiana-filtra`), potem poprawka.
3. Ostateczność: Bartosz zdejmuje „Filtr: straż” z wymaganych kontroli
   (Settings, Rules, Rulesets), scala, przywraca kontrolę tego samego dnia
   i wpisuje wyjątek.
4. W ciągu 24 godzin sesja uruchamia pełny filtr na `main`
   (`pnpm filtr:testy`, `pnpm filtr:mapa --skan`) i zapisuje wynik w dzienniku
   planu.
5. Każda awaria filtra to znalezisko z przyczyną i testem filtra.
