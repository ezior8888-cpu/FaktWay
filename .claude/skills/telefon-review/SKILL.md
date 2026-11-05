---
name: telefon-review
description: Przegląd zmiany „na telefon”, żeby nie ruszyła zamrożonego widoku na Macu.
disable-model-invocation: true
---

Przeczytaj `docs/runbooks/zmiany-na-telefon.md`. Na zmienionym diffie sprawdź:

1. Każda nowa lub zmieniona klasa wyglądu ma prefiks `max-sm:`/`sm:` albo siedzi w `@media (hover: none) and (pointer: coarse)`. Wypisz każdą, która nie ma, z plikiem i linią.
2. Teksty dla klienta: bez długich myślników, bez plakietek nad nagłówkami, tylko „FaktWay”.
3. Obchód telefonu z `e2e/README.md` („Telefon”) i porównanie desktopu 1440 px przed i po. Wynik i zrzuty do opisu PR.
