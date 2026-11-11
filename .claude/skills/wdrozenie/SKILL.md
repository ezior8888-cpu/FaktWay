---
name: wdrozenie
description: Wdrożenie FaktWay na produkcję (worker, potem aplikacja) i kontrola po wdrożeniu. Tylko na wyraźne polecenie Bartosza.
disable-model-invocation: true
---

1. Upewnij się, że Bartosz w tej rozmowie wprost kazał wdrożyć. Jeśli nie, zapytaj.
2. Przeczytaj `docs/runbooks/wdrozenie-produkcji.md` (kolejność wydania, droga ręczna, co robić przy błędzie).
3. Migracje „przed wdrożeniem” muszą być już wgrane (`/migracja`). Sprawdź nagłówki migracji ze scalonych PR.
4. Sprawdź źródło: `./scripts/ops/coolify-zrodlo.sh stan`. Build z repo: `./scripts/ops/wdroz-produkcje.sh` (12–18 min na aplikację). Obraz z GHCR: `./scripts/ops/wdroz-produkcje.sh --obraz <sha z main>` (czeka na obrazy z `obrazy.yml`). Skrypt sam ładuje `.agents/infra.env`, wdraża worker `id=2`, potem aplikację `id=1`, na końcu `kontrola-faktur-ksef.sh`. Uruchom w tle.
5. Migracje „PO wdrożeniu”, jeśli są.
6. Raport w tabeli: PR, SHA w `main`, migracje, wdrożenia, wynik kontroli.
