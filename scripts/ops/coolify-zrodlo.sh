#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Źródło obrazów produkcji w Coolify: build z repo albo obraz z GHCR
# ────────────────────────────────────────────────────────────────
#   ./scripts/ops/coolify-zrodlo.sh stan            # tylko odczyt
#   ./scripts/ops/coolify-zrodlo.sh obraz [<sha>]   # na obrazy z GHCR
#   ./scripts/ops/coolify-zrodlo.sh repo            # z powrotem na build z repo
#   … obraz|repo --wdroz                             # i od razu wdrożenie
#
# Zmienia tylko konfigurację w Coolify: najpierw worker (id=2), potem
# aplikację (id=1). Działające kontenery zostają, aż ruszy wdrożenie
# (`wdroz-produkcje.sh` w pasującym trybie albo `--wdroz` tutaj).
#
# `obraz` bez SHA bierze SHA, na którym działają dziś oba kontenery, więc
# pierwsze wdrożenie z obrazu podmienia kod na identyczny. Przed zmianą
# sprawdza, że oba obrazy są w GHCR z etykietą rewizji równą SHA.
#
# `repo` ustawia jawnie `dockerfile_location=/Dockerfile` i cel `worker`
# / `runner` oraz czyści nazwę i tag obrazu (przy `dockerfile` z ustawioną
# nazwą obrazu Coolify wypchnąłby build do tego rejestru). Pola idą przez
# zapytanie bez zdarzeń modelu (nagłówek `coolify-wspolne.sh`).
#
# Każdy krok da się powtórzyć: ustawienie tych samych wartości to to samo.
# Po każdej zmianie skrypt czyta pola z powrotem i porównuje.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=scripts/ops/coolify-wspolne.sh
source "$ROOT/scripts/ops/coolify-wspolne.sh"

uzycie() {
  cat <<'TXT'
Użycie:
  ./scripts/ops/coolify-zrodlo.sh stan
  ./scripts/ops/coolify-zrodlo.sh obraz [<sha>] [--wdroz]
  ./scripts/ops/coolify-zrodlo.sh repo [--wdroz]
TXT
}

POLECENIE=${1:-}
[ -n "$POLECENIE" ] || { uzycie >&2; exit 2; }
shift
SHA=""
WDROZ=0
for arg in "$@"; do
  case "$arg" in
    --wdroz) WDROZ=1 ;;
    -h|--help) uzycie; exit 0 ;;
    *)
      if [ "$POLECENIE" = obraz ] && [ -z "$SHA" ]; then SHA=$arg
      else uzycie >&2; exit 2
      fi ;;
  esac
done
case "$POLECENIE" in
  stan|obraz|repo) ;;
  -h|--help) uzycie; exit 0 ;;
  *) uzycie >&2; exit 2 ;;
esac
[ "$POLECENIE" != stan ] || [ "$WDROZ" = 0 ] || { uzycie >&2; exit 2; }

zaladuj_infra_env K OPS APP APP_PREFIX WORKER_PREFIX

pokaz_stan() {
  local id zrodlo bp obraz tag lok cel
  for id in "$WORKER_ID" "$WEB_ID"; do
    zrodlo=$(zrodlo_aplikacji "$id")
    IFS='|' read -r bp obraz tag lok cel <<<"$zrodlo"
    case "$bp" in
      dockerimage) printf '%-18s id=%s  obraz z GHCR: %s:%s' "$(nazwa_aplikacji "$id")" "$id" "$obraz" "$tag" ;;
      dockerfile) printf '%-18s id=%s  build z repo: %s, cel %s' "$(nazwa_aplikacji "$id")" "$id" "${lok:-?}" "${cel:-PUSTY (ostatni etap!)}" ;;
      "") printf '%-18s id=%s  nie odczytałem z Coolify' "$(nazwa_aplikacji "$id")" "$id" ;;
      *) printf '%-18s id=%s  build_pack=%s' "$(nazwa_aplikacji "$id")" "$id" "$bp" ;;
    esac
    printf '; kontener na app-1: %s\n' "$(sha_dzialajacego "$id" || true)"
  done
}

if [ "$POLECENIE" = stan ]; then
  pokaz_stan
  exit 0
fi

# ── Stan wyjściowy: tylko nasze dwa znane układy, inaczej nic nie zmieniamy ──
for id in "$WORKER_ID" "$WEB_ID"; do
  zrodlo=$(zrodlo_aplikacji "$id")
  [ -n "$zrodlo" ] || die "Nie odczytałem źródła aplikacji id=$id z Coolify (tinker na ops-1). Nic nie zmieniłem."
  IFS='|' read -r bp obraz _tag _lok cel <<<"$zrodlo"
  case "$bp" in
    dockerfile) ;;
    dockerimage)
      [ "$obraz" = "$(obraz_ghcr "$id")" ] \
        || die "id=$id jest na obcym obrazie „$obraz” (oczekiwany $(obraz_ghcr "$id")). Nic nie zmieniłem; sprawdź aplikację w panelu Coolify."
      ;;
    *) die "id=$id ma build_pack=$bp, a skrypt zna tylko dockerfile i dockerimage. Nic nie zmieniłem." ;;
  esac
  if [ "$POLECENIE" = obraz ] && [ "$bp" = dockerfile ] && [ "$cel" != "$(cel_dockerfile "$id")" ]; then
    die "id=$id buduje cel „$cel”, a skrypt przypisuje mu obraz $(obraz_ghcr "$id"). Rozjazd id i aplikacji: nic nie zmieniłem."
  fi
done

if [ "$POLECENIE" = obraz ]; then
  if [ -z "$SHA" ]; then
    sha_w=$(sha_dzialajacego "$WORKER_ID")
    sha_a=$(sha_dzialajacego "$WEB_ID")
    if ! jest_sha "$sha_w" || [ "$sha_w" != "$sha_a" ]; then
      die "Worker działa na „${sha_w:-?}”, aplikacja na „${sha_a:-?}”: podaj SHA wprost (./scripts/ops/coolify-zrodlo.sh obraz <sha>)."
    fi
    SHA=$sha_w
    echo "── SHA z działających kontenerów: $SHA"
  fi
  jest_sha "$SHA" || die "SHA musi mieć 40 znaków 0-9a-f, jest: „$SHA”."
  git -C "$ROOT" fetch --quiet origin main || die "git fetch origin main padł: nie sprawdzę, czy SHA jest na main."
  git -C "$ROOT" merge-base --is-ancestor "$SHA" origin/main 2>/dev/null \
    || die "$SHA nie jest na origin/main. Na produkcję idzie tylko scalony kod."
  echo "── Obrazy $SHA w GHCR"
  czekaj_na_obrazy "$SHA" 0 || exit 1
  echo "   oba są, etykieta rewizji = $SHA"
fi

for id in "$WORKER_ID" "$WEB_ID"; do
  if [ "$POLECENIE" = obraz ]; then
    pola="['build_pack' => 'dockerimage', 'docker_registry_image_name' => '$(obraz_ghcr "$id")', 'docker_registry_image_tag' => '$SHA']"
    oczekiwane="dockerimage|$(obraz_ghcr "$id")|$SHA|"
  else
    pola="['build_pack' => 'dockerfile', 'dockerfile_location' => '/Dockerfile', 'dockerfile_target_build' => '$(cel_dockerfile "$id")', 'docker_registry_image_name' => null, 'docker_registry_image_tag' => null]"
    oczekiwane="dockerfile|||/Dockerfile|$(cel_dockerfile "$id")"
  fi
  echo "── $(nazwa_aplikacji "$id") (id=$id): $POLECENIE"
  n=$(ustaw_pola "$id" "$pola")
  [ "$n" = 1 ] || die "Zmiana id=$id nie przeszła (zmienione wiersze: ${n:-?}). Stan: ./scripts/ops/coolify-zrodlo.sh stan"
  zrodlo=$(zrodlo_aplikacji "$id")
  case "$zrodlo" in
    "$oczekiwane"*) ;;
    *) die "Po zmianie id=$id ma „$zrodlo”, oczekiwane „$oczekiwane…”. Stan: ./scripts/ops/coolify-zrodlo.sh stan" ;;
  esac
done

echo "── Nowy stan:"
pokaz_stan

if [ "$WDROZ" = 1 ]; then
  if [ "$POLECENIE" = obraz ]; then
    exec "$ROOT/scripts/ops/wdroz-produkcje.sh" --obraz "$SHA"
  else
    exec "$ROOT/scripts/ops/wdroz-produkcje.sh"
  fi
fi
if [ "$POLECENIE" = obraz ]; then
  echo "Działające kontenery bez zmian. Wdrożenie z obrazu: ./scripts/ops/wdroz-produkcje.sh --obraz $SHA"
else
  echo "Działające kontenery bez zmian. Wdrożenie buildem z repo: ./scripts/ops/wdroz-produkcje.sh"
fi
