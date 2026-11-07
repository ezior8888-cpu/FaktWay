---
name: telefon-review
description: Przegląd zmiany „na telefon”, żeby nie ruszyła zamrożonego widoku na Macu.
disable-model-invocation: true
---

Przeczytaj `docs/runbooks/zmiany-na-telefon.md`. Na zmienionym diffie sprawdź:

1. Każda nowa lub zmieniona klasa wyglądu ma prefiks `max-sm:`/`sm:` albo siedzi w `@media (hover: none) and (pointer: coarse)`. Wypisz każdą, która nie ma, z plikiem i linią.
2. Teksty dla klienta: bez długich myślników, bez plakietek nad nagłówkami, tylko „FaktWay”.
3. Testy wizualne `E2E_PORT=3132 pnpm test:wizualne` (`e2e/README.md`, „Testy wizualne”): desktop musi zostać zielony; zmieniony zrzut telefonu oglądasz w raporcie i odświeżasz wzorzec tylko, gdy zmiana jest zamierzona.
4. Obchód telefonu z `e2e/README.md` („Telefon”). Wynik obu kroków i zrzut telefonu do opisu PR.
