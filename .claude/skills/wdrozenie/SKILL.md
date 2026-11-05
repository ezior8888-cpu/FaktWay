---
name: wdrozenie
description: Wdrożenie FaktWay na produkcję (worker, potem aplikacja) i kontrola po wdrożeniu. Tylko na wyraźne polecenie Bartosza.
disable-model-invocation: true
---

1. Upewnij się, że Bartosz w tej rozmowie wprost kazał wdrożyć. Jeśli nie, zapytaj.
2. Przeczytaj `docs/runbooks/wdrozenie-produkcji.md` (kolejność wydania, droga ręczna, co robić przy błędzie).
3. Migracje „przed wdrożeniem” muszą być już wgrane (`/migracja`). Sprawdź nagłówki migracji ze scalonych PR.
4. Uruchom `./scripts/ops/wdroz-produkcje.sh` (sam ładuje `.agents/infra.env`, wdraża worker `id=2`, potem aplikację `id=1`, na końcu `kontrola-faktur-ksef.sh`). Build trwa 12–18 min na wdrożenie: uruchom w tle.
5. Migracje „PO wdrożeniu”, jeśli są.
6. Raport w tabeli: PR, SHA w `main`, migracje, wdrożenia, wynik kontroli.
