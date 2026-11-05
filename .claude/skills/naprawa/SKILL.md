---
name: naprawa
description: Start naprawy błędu według protokołu z AGENTS.md (gałąź, czerwony test, PR według szablonu).
disable-model-invocation: true
---

Protokół jest w `AGENTS.md` („Protokół naprawy błędu”). Kroki na start:

1. `git fetch origin` i gałąź od `origin/main`: `claude/<kod-ustalenia>-<temat>`. Sprawdź `gh pr list` pod kątem tych samych plików.
2. Test odtwarzający błąd na prawdziwej ścieżce (mocki tylko HTTP i baza; wyzwalacze, RPC i uprawnienia w `tests/rls-*.test.ts`). Uruchom i zobacz czerwony.
3. Napraw przyczynę i wszystkie jej wystąpienia (przeszukaj inne generatory, runnery, ścieżki UI).
4. Ponowienie od zera: każdy krok z efektem zewnętrznym idempotentny albo z kluczem.
5. Przed PR: `pnpm run ci && pnpm build`, potem `/code-review` jako drugi czytelnik.
6. PR według `.github/pull_request_template.md`, wiersz w dzienniku planu, raport i stop.
