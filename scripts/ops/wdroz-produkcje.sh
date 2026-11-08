#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Wdrożenie produkcji: worker (Coolify id=2), potem aplikacja (id=1)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo, PO scaleniu PR do `main` i PO migracjach
# „przed wdrożeniem” (docs/runbooks/wdrozenie-produkcji.md):
#
#   ./scripts/ops/wdroz-produkcje.sh                  # build z repo na app-1
#   ./scripts/ops/wdroz-produkcje.sh --obraz          # obraz z GHCR, SHA = origin/main
#   ./scripts/ops/wdroz-produkcje.sh --obraz <sha>    # obraz z GHCR, ten SHA z main
#
# Tryb musi pasować do źródła ustawionego w Coolify (`coolify-zrodlo.sh`);
# przy rozjeździe skrypt nic nie wdraża i mówi, którą komendę wybrać.
#
# Build z repo: kolejkuje wdrożenie przez `tinker` na ops-1 (commit HEAD
# gałęzi produkcyjnej), czeka na `finished` (build 12-18 min) i dopiero
# potem rusza następną aplikację — oba buildy jadą na app-1 i razem nie
# mieszczą się w pamięci.
#
# Obraz z GHCR (`.github/workflows/obrazy.yml` buduje go po scaleniu):
#   1. SHA musi być na origin/main (wdraża się tylko scalony kod);
#   2. czeka (do 45 min), aż oba obrazy `<sha>` będą w GHCR z etykietą
#      rewizji równą SHA;
#   3. sprawdza wolne miejsce na app-1 (8.11.2026 build zapchał dysk);
#   4. dla workera, potem aplikacji: tag obrazu w Coolify = SHA, wdrożenie
#      z `commit: <sha>`, czekanie na `finished`, kontrola, że kontener
#      działa na `<obraz>:<sha>`.
#   Przy `failed` tag wraca na poprzedni (Coolify zostawia działający stary
#   kontener). Ponowne uruchomienie po każdym kroku jest bezpieczne: ten sam
#   tag i nowe wdrożenie tego samego obrazu.
#
# Na końcu obu trybów: `kontrola-faktur-ksef.sh`. Skrypt sam ładuje
# `.agents/infra.env` (przycisk „Run” daje świeżą powłokę).

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=scripts/ops/coolify-wspolne.sh
source "$ROOT/scripts/ops/coolify-wspolne.sh"

uzycie() {
  cat <<'TXT'
Użycie:
  ./scripts/ops/wdroz-produkcje.sh                  # build z repo na app-1
  ./scripts/ops/wdroz-produkcje.sh --obraz          # obraz z GHCR, SHA = origin/main
  ./scripts/ops/wdroz-produkcje.sh --obraz <sha>    # obraz z GHCR, ten SHA z main
TXT
}

TRYB=repo
SHA=""
case "${1:-}" in
  "") ;;
  --obraz)
    TRYB=obraz
    SHA=${2:-}
    [ "$#" -le 2 ] || { uzycie >&2; exit 2; }
    ;;
  -h|--help) uzycie; exit 0 ;;
  *) uzycie >&2; exit 2 ;;
esac
[ "$TRYB" = obraz ] || [ "$#" -le 1 ] || { uzycie >&2; exit 2; }

if [ "$TRYB" = obraz ]; then
  zaladuj_infra_env K OPS APP APP_PREFIX WORKER_PREFIX
else
  zaladuj_infra_env K OPS
fi

MIN_WOLNE_GB=${WDROZ_MIN_WOLNE_GB:-4}

# ── Źródło w Coolify musi pasować do trybu ──
# Poprzednie tagi w POPRZEDNI_TAG_<id> (bash 3.2 z macOS nie ma tablic
# asocjacyjnych).
poprzedni_tag() {
  local var="POPRZEDNI_TAG_$1"
  echo "${!var:-}"
}
for id in "$WORKER_ID" "$WEB_ID"; do
  zrodlo=$(zrodlo_aplikacji "$id")
  [ -n "$zrodlo" ] || die "Nie odczytałem źródła aplikacji id=$id z Coolify (tinker na ops-1). Nic nie wdrożyłem."
  IFS='|' read -r bp obraz tag _lokalizacja cel <<<"$zrodlo"
  if [ "$TRYB" = repo ]; then
    if [ "$bp" = dockerimage ]; then
      die "$(nazwa_aplikacji "$id") (id=$id) jest przełączony na obraz z GHCR ($obraz:$tag). Wdrażaj: ./scripts/ops/wdroz-produkcje.sh --obraz <sha>; powrót do buildu z repo: ./scripts/ops/coolify-zrodlo.sh repo"
    fi
    if [ "$bp" != dockerfile ] || [ "$cel" != "$(cel_dockerfile "$id")" ]; then
      die "$(nazwa_aplikacji "$id") (id=$id): build_pack=$bp, cel Dockerfile=„$cel”, oczekiwane dockerfile/$(cel_dockerfile "$id"). Pusty cel buduje ostatni etap (coolify-pulapki.md). Napraw: ./scripts/ops/coolify-zrodlo.sh repo"
    fi
  else
    if [ "$bp" != dockerimage ] || [ "$obraz" != "$(obraz_ghcr "$id")" ]; then
      die "$(nazwa_aplikacji "$id") (id=$id) nie jest na obrazie $(obraz_ghcr "$id") (build_pack=$bp, obraz=„$obraz”). Przełącz: ./scripts/ops/coolify-zrodlo.sh obraz <sha>; albo wdrażaj buildem z repo: ./scripts/ops/wdroz-produkcje.sh"
    fi
    printf -v "POPRZEDNI_TAG_$id" '%s' "$tag"
  fi
done

# ── Tryb obrazu: SHA z main, obrazy w GHCR, miejsce na dysku ──
if [ "$TRYB" = obraz ]; then
  git -C "$ROOT" fetch --quiet origin main || die "git fetch origin main padł: nie sprawdzę, czy SHA jest na main."
  if [ -z "$SHA" ]; then
    SHA=$(git -C "$ROOT" rev-parse origin/main)
  fi
  jest_sha "$SHA" || die "SHA musi mieć 40 znaków 0-9a-f (pełny SHA z main), jest: „$SHA”."
  git -C "$ROOT" merge-base --is-ancestor "$SHA" origin/main 2>/dev/null \
    || die "$SHA nie jest na origin/main. Wdraża się tylko scalony kod (AGENTS.md, niezmienniki)."
  echo "── Obrazy $SHA w GHCR"
  czekaj_na_obrazy "$SHA" "${WDROZ_CZEKAJ_MIN:-45}" || exit 1
  echo "   oba obrazy są, etykieta rewizji = $SHA"
  wolne=$(wolne_gb_app1)
  [ -n "$wolne" ] || die "Nie odczytałem wolnego miejsca na app-1. Nic nie wdrożyłem."
  if [ "$wolne" -lt "$MIN_WOLNE_GB" ]; then
    die "Na app-1 wolne tylko $wolne GB (próg $MIN_WOLNE_GB GB; obraz workera ma ok. 2 GB). Usuń stare obrazy (ssh … 'docker image ls', zostaw poprzednią wersję do cofnięcia), potem uruchom skrypt ponownie."
  fi
  echo "   app-1: wolne $wolne GB"
fi

# Czeka na koniec wdrożenia. Kod 0 = finished, 1 = failed/cancelled (log na
# ekranie), 2 = przekroczony czas.
czekaj_na_wdrozenie() {
  local uuid=$1 name=$2 odstep=$3 limit=$4
  local status="" waited=0 puste=0
  while [ "$waited" -lt "$limit" ]; do
    sleep "$odstep"
    waited=$((waited + 1))
    status=$(deployment_status "$uuid")
    echo "   $(date +%H:%M) $name: ${status:-?}"
    case "$status" in
      finished) return 0 ;;
      failed|cancelled*)
        echo "Wdrożenie $name: $status. Coolify zostawił poprzednią wersję. Koniec logu:" >&2
        deployment_log_tail "$uuid" >&2 || true
        return 1
        ;;
      "")
        # Brak wiersza w kolejce trzy razy z rzędu: Coolify odrzucił
        # wdrożenie albo tinker nie odpowiada. Nie czekamy 40 minut na nic.
        puste=$((puste + 1))
        if [ "$puste" -ge 3 ]; then
          echo "Wdrożenie $name ($uuid): trzy razy brak stanu w kolejce Coolify. Sprawdź kolejkę w panelu." >&2
          return 1
        fi
        ;;
      *) puste=0 ;;
    esac
  done
  echo "Wdrożenie $name nie skończyło się w czasie (ostatni stan: ${status:-?}). Sprawdź kolejkę w Coolify." >&2
  return 2
}

deploy_repo() {
  local app_id=$1 name
  name=$(nazwa_aplikacji "$app_id")
  echo "── $name (Coolify id=$app_id): kolejkuję build z repo"
  local uuid
  uuid=$(queue_deployment "$app_id" HEAD)
  [ -n "$uuid" ] || die "Nie udało się zakolejkować wdrożenia $name (brak identyfikatora z tinkera)."
  echo "   identyfikator: $uuid — build trwa 12-18 min, sprawdzam co minutę"
  czekaj_na_wdrozenie "$uuid" "$name" 60 40 || exit 1
}

deploy_obraz() {
  local app_id=$1 name obraz poprzedni n uuid rc=0 dziala
  name=$(nazwa_aplikacji "$app_id")
  obraz=$(obraz_ghcr "$app_id")
  poprzedni=$(poprzedni_tag "$app_id")
  echo "── $name (Coolify id=$app_id): $obraz:$SHA (było: ${poprzedni:-brak})"
  n=$(ustaw_pola "$app_id" "['docker_registry_image_tag' => '$SHA']")
  [ "$n" = 1 ] || die "Nie ustawiłem tagu obrazu dla $name (zmienione wiersze: ${n:-?}). Nic nie wdrożyłem."
  uuid=$(queue_deployment "$app_id" "$SHA")
  if [ -z "$uuid" ]; then
    przywroc_tag "$app_id" "$poprzedni"
    die "Nie udało się zakolejkować wdrożenia $name (brak identyfikatora z tinkera)."
  fi
  echo "   identyfikator: $uuid — pobranie obrazu i start trwają kilka minut, sprawdzam co 20 s"
  czekaj_na_wdrozenie "$uuid" "$name" 20 45 || rc=$?
  if [ "$rc" = 1 ]; then
    przywroc_tag "$app_id" "$poprzedni"
    exit 1
  elif [ "$rc" != 0 ]; then
    # Bez cofania tagu: wdrożenie może jeszcze skończyć się na nowym obrazie.
    echo "Tag $name zostaje na $SHA. Po sprawdzeniu w panelu uruchom skrypt ponownie albo cofnij: ./scripts/ops/wdroz-produkcje.sh --obraz <poprzedni sha>" >&2
    exit 1
  fi
  dziala=$(sha_dzialajacego "$app_id")
  if [ "$dziala" != "$SHA" ]; then
    die "$name: Coolify zgłosił finished, ale kontener na app-1 działa na „${dziala:-?}”, nie na $SHA. Sprawdź kontenery: ./scripts/ops/kontrola-faktur-ksef.sh"
  fi
  echo "   kontener działa na $obraz:$SHA"
}

przywroc_tag() {
  local app_id=$1 tag=$2 wartosc
  if [ -n "$tag" ]; then wartosc="'$tag'"; else wartosc=null; fi
  echo "   przywracam tag obrazu na ${tag:-brak} (Coolify zostawia działający stary kontener)" >&2
  ustaw_pola "$app_id" "['docker_registry_image_tag' => $wartosc]" >/dev/null || true
}

if [ "$TRYB" = repo ]; then
  deploy_repo "$WORKER_ID"
  deploy_repo "$WEB_ID"
else
  deploy_obraz "$WORKER_ID"
  if ! (deploy_obraz "$WEB_ID"); then
    echo "⚠️  Worker jest na $SHA, aplikacja na poprzedniej wersji (stan mieszany). Cofnięcie workera: ./scripts/ops/wdroz-produkcje.sh --obraz $(poprzedni_tag "$WORKER_ID")" >&2
    exit 1
  fi
fi

echo "── Oba wdrożenia: finished. Kontrola produkcji:"
"$ROOT/scripts/ops/kontrola-faktur-ksef.sh"
