#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Wdrożenie jednej aplikacji Coolify z obrazu w GHCR (plan usprawnień 3.1)
# ────────────────────────────────────────────────────────────────
# Woła go `.github/workflows/obrazy.yml`, po kolei: worker, potem aplikacja.
#
#   scripts/ci/coolify-wdroz.sh <nazwa> <uuid-aplikacji-coolify> <obraz> <sha>
#
# Środowisko: COOLIFY_URL (np. http://<adres-w-tailnecie>:8000, bez /api),
# COOLIFY_TOKEN (token API z uprawnieniami read + deploy). Do retagu obrazu
# potrzebne jest zalogowane `docker` do ghcr.io.
#
# Kroki:
# 1. zapamiętuje, na co wskazuje `<obraz>:produkcja` (do cofnięcia);
# 2. przestawia `<obraz>:produkcja` na `<obraz>:<sha>` (tylko manifest, bez
#    przesyłania warstw). Aplikacja w Coolify ma ustawiony obraz z tagiem
#    `produkcja`, więc wdrożenie pobiera dokładnie ten SHA;
# 3. `POST /api/v1/deploy?uuid=…`, potem co 15 s `GET /api/v1/deployments/<id>`
#    aż do `finished` (najwyżej 20 min);
# 4. czeka, aż Coolify pokaże aplikację jako `running:healthy` (3 min).
# Przy `failed`/`cancelled` przywraca poprzedni `produkcja` (Coolify zostawia
# działający stary kontener) i kończy się kodem 1; po przekroczeniu czasu tag
# zostaje, bo wdrożenie może jeszcze dojść do końca. Ponowne uruchomienie po
# każdym kroku jest bezpieczne: retag na ten sam SHA to to samo, a nowe
# wdrożenie Coolify pobiera ten sam obraz.

set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Użycie: $0 <nazwa> <uuid-aplikacji-coolify> <obraz> <sha>" >&2
  exit 2
fi
NAME=$1 APP_UUID=$2 IMAGE=$3 SHA=$4
: "${COOLIFY_URL:?Brak COOLIFY_URL}"
: "${COOLIFY_TOKEN:?Brak COOLIFY_TOKEN}"
API="${COOLIFY_URL%/}/api/v1"
PROD_TAG=produkcja

coolify() {
  curl --fail-with-body --silent --show-error --max-time 30 \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -H 'Accept: application/json' "$@"
}

PREVIOUS=$(docker buildx imagetools inspect "$IMAGE:$PROD_TAG" --format '{{json .Manifest}}' 2>/dev/null \
  | jq -r '.digest // empty' || true)

restore_tag() {
  if [ -n "$PREVIOUS" ]; then
    echo "   przywracam $IMAGE:$PROD_TAG na $PREVIOUS"
    docker buildx imagetools create --tag "$IMAGE:$PROD_TAG" "$IMAGE@$PREVIOUS" || true
  fi
}

echo "── $NAME: $IMAGE:$PROD_TAG → $SHA (poprzednio: ${PREVIOUS:-brak})"
docker buildx imagetools create --tag "$IMAGE:$PROD_TAG" "$IMAGE:$SHA"

DEPLOYMENT=$(coolify -X POST "$API/deploy?uuid=$APP_UUID&force=false" | jq -r '.deployments[0].deployment_uuid // empty') \
  || DEPLOYMENT=""
if [ -z "$DEPLOYMENT" ]; then
  echo "Coolify nie zwrócił identyfikatora wdrożenia dla $NAME." >&2
  restore_tag
  exit 1
fi
echo "   wdrożenie Coolify: $DEPLOYMENT"

status=""
for _ in $(seq 1 80); do
  sleep 15
  status=$(coolify "$API/deployments/$DEPLOYMENT" | jq -r '.status // empty' || true)
  echo "   $(date -u +%H:%M:%S) $NAME: ${status:-?}"
  case "$status" in
    finished) break ;;
    failed|cancelled*)
      echo "Wdrożenie $NAME: $status. Coolify zostawił poprzednią wersję; log w panelu (wdrożenie $DEPLOYMENT)." >&2
      restore_tag
      exit 1
      ;;
  esac
done
if [ "$status" != finished ]; then
  # Bez cofania tagu: wdrożenie może jeszcze skończyć się na nowym obrazie,
  # a tag musi wskazywać to, co działa.
  echo "Wdrożenie $NAME nie skończyło się w 20 min (ostatni stan: ${status:-?}); $IMAGE:$PROD_TAG zostaje na $SHA. Sprawdź wdrożenie $DEPLOYMENT w panelu." >&2
  exit 1
fi

health=""
for _ in $(seq 1 18); do
  health=$(coolify "$API/applications/$APP_UUID" | jq -r '.status // empty' || true)
  [ "$health" = "running:healthy" ] && break
  sleep 10
done
echo "   stan w Coolify: ${health:-?}"
if [ "$health" != "running:healthy" ]; then
  echo "$NAME po wdrożeniu nie jest running:healthy (jest: ${health:-?}). Sprawdź kontener; cofnięcie: runbook wdrozenie-produkcji.md." >&2
  exit 1
fi
echo "── $NAME: wdrożony $SHA"
