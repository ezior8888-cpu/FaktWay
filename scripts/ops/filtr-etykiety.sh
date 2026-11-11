#!/usr/bin/env bash
# Etykiety żelaznego filtra (krok F2, plan docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B5.4).
# Uruchamia Bartosz, jedną linią z katalogu repo (sesje agentów etykiet zgody
# nie zakładają ani nie nadają):
#
#   ./scripts/ops/filtr-etykiety.sh
#
# Zakłada albo poprawia (--force) cztery etykiety. Nic poza etykietami nie zmienia.
set -euo pipefail

repo="ezior8888-cpu/FaktWay"
gh label create "zgoda:zmiana-filtra" --repo "$repo" --force --color B60205 \
  --description "Bartosz: zgoda na zmianę maszynerii filtra albo osłabienie mapy ryzyka (wygasa po pushu)"
gh label create "zgoda:wiedza-prawna" --repo "$repo" --force --color D93F0B \
  --description "Bartosz: zgoda na zmianę wiedzy prawnej (przepisy, parametry, złote przypadki, schematy)"
gh label create "zgoda:wyjatek-filtra" --repo "$repo" --force --color FBCA04 \
  --description "Bartosz: wyjątek od wymogu straży (np. kod R1 bez testu), powód w karcie PR"
gh label create "filtr" --repo "$repo" --force --color 5319E7 \
  --description "Żelazny filtr: alarm z nocnych i tygodniowych przebiegów, czujki przepisów"
echo "Gotowe: etykiety filtra założone w $repo."
