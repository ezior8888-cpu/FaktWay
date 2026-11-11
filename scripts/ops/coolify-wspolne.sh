#!/usr/bin/env bash
# shellcheck disable=SC1111 # cudzysłowy „…” w komunikatach są celowe
# ════════════════════════════════════════════════════════════════
# Wspólne funkcje `wdroz-produkcje.sh` i `coolify-zrodlo.sh`
# ────────────────────────────────────────────────────────────────
# Plik do `source`, nie do uruchamiania. Przed `source` ustaw ROOT (katalog
# repo). Nic tu nie zmienia produkcji samo z siebie: funkcje wołają skrypty.
#
# Coolify (ops-1) obsługuje dwie aplikacje z tego repo:
#   id=2 worker pg-boss  (Dockerfile, cel `worker`, obraz …-worker)
#   id=1 aplikacja Next  (Dockerfile, cel `runner`, obraz …-runner)
# Źródło każdej z nich jest jedno z dwóch:
#   repo:  build_pack `dockerfile`, Coolify buduje obraz na app-1;
#   obraz: build_pack `dockerimage`, Coolify pobiera gotowy obraz z GHCR
#          (`.github/workflows/obrazy.yml`), tag = pełny SHA commita.
#
# Dlaczego zmiany pól idą przez `Application::whereKey()->update()`, a nie
# przez `$a->save()`: model Coolify (4.6) przy zmianie `build_pack`
# z `dockerfile` na inny CZYŚCI `dockerfile_location`,
# `dockerfile_target_build` i `custom_healthcheck_found`. Powrót z obrazu na
# repo budowałby wtedy ostatni etap `Dockerfile` (docs/runbooks/
# coolify-pulapki.md), a aplikacja straciłaby healthcheck z obrazu. Zapytanie
# bez zdarzeń modelu zmienia tylko podane pola.

GHCR_PREFIX=ghcr.io/ezior8888-cpu/faktway
WORKER_ID=2
WEB_ID=1

die() {
  echo "$*" >&2
  exit 1
}

# Ładuje `.agents/infra.env` (z worktree albo z głównego katalogu) i sprawdza
# podane zmienne. Przycisk „Run” uruchamia każdy blok w świeżej powłoce, więc
# skrypty nie mogą liczyć na wcześniejsze `source`.
zaladuj_infra_env() {
  local main_root="" common_dir candidate env_file="" v
  if command -v git >/dev/null 2>&1; then
    common_dir=$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)
    if [ -n "$common_dir" ]; then
      case "$common_dir" in
        /*) main_root=$(cd "$common_dir/.." && pwd) ;;
        *)  main_root=$(cd "$ROOT/$common_dir/.." && pwd) ;;
      esac
    fi
  fi
  for candidate in "${FAKTFLOW_INFRA_ENV:-}" "$ROOT/.agents/infra.env" "${main_root:+$main_root/.agents/infra.env}"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      env_file=$candidate
      break
    fi
  done
  [ -n "$env_file" ] || die "Nie znalazłem .agents/infra.env (plik jest poza gitem — AGENTS.md → Infrastruktura)."
  # shellcheck source=/dev/null
  source "$env_file"
  for v in "$@"; do
    [ -n "${!v:-}" ] || die "Brak zmiennej $v w $env_file."
  done
}

nazwa_aplikacji() {
  case "$1" in
    "$WORKER_ID") echo "worker pg-boss" ;;
    "$WEB_ID") echo "aplikacja Next.js" ;;
    *) return 1 ;;
  esac
}

# Cel `Dockerfile`, z którego powstaje dana aplikacja (pusty cel = ostatni etap).
cel_dockerfile() {
  case "$1" in
    "$WORKER_ID") echo worker ;;
    "$WEB_ID") echo runner ;;
    *) return 1 ;;
  esac
}

obraz_ghcr() {
  echo "$GHCR_PREFIX-$(cel_dockerfile "$1")"
}

# Prefiks nazwy kontenera na app-1 (UUID aplikacji w Coolify, z infra.env).
prefiks_kontenera() {
  case "$1" in
    "$WORKER_ID") echo "${WORKER_PREFIX:-}" ;;
    "$WEB_ID") echo "${APP_PREFIX:-}" ;;
  esac
}

jest_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

# Kod PHP idzie na wejście tinkera (heredoc), nie przez --execute (runbook
# wdrozenie-produkcji.md: dwie powłoki gubią zmienne). Znaczniki wyniku
# składamy z dwóch kawałków ("WD_" . "X="), bo tinker odbija wpisane linie
# i grep złapałby też samo polecenie.
tinker() {
  ssh -i "$K" -o BatchMode=yes root@"$OPS" 'docker exec -i coolify php artisan tinker'
}

# „build_pack|obraz|tag|dockerfile_location|cel” albo pusto, gdy odczyt padł.
zrodlo_aplikacji() {
  local id=$1
  tinker <<PHP | grep -o 'WD_ZRODLO=[^ ]*' | tail -n 1 | cut -d= -f2- || true
\$a = App\\Models\\Application::find($id);
echo "WD_" . "ZRODLO=" . implode('|', [\$a->build_pack, \$a->docker_registry_image_name ?? '', \$a->docker_registry_image_tag ?? '', \$a->dockerfile_location ?? '', \$a->dockerfile_target_build ?? '']) . "\n";
PHP
}

# Ustawia pola aplikacji bez zdarzeń modelu (nagłówek pliku). Drugi argument
# to tablica PHP z wartościami stałymi albo sprawdzonym SHA. Wypisuje liczbę
# zmienionych wierszy (oczekiwane: 1).
ustaw_pola() {
  local id=$1 pola=$2
  tinker <<PHP | grep -o 'WD_ZMIANA=[0-9]*' | tail -n 1 | cut -d= -f2 || true
echo "WD_" . "ZMIANA=" . App\\Models\\Application::whereKey($id)->update($pola) . "\n";
PHP
}

# Kolejkuje wdrożenie i wypisuje jego identyfikator. `commit` to `HEAD`
# (build z repo) albo pełny SHA (obraz): Coolify zapisuje go w kolejce
# i podaje kontenerowi jako SOURCE_COMMIT.
queue_deployment() {
  local app_id=$1 commit=$2
  tinker <<PHP | grep -o 'WD_UUID=[A-Za-z0-9]*' | tail -n 1 | cut -d= -f2 || true
\$a = App\\Models\\Application::find($app_id);
\$u = (string) new \\Visus\\Cuid2\\Cuid2();
queue_application_deployment(application: \$a, deployment_uuid: \$u, force_rebuild: false, commit: '$commit', is_api: false);
echo "WD_" . "UUID=" . \$u . "\n";
PHP
}

deployment_status() {
  local uuid=$1
  tinker <<PHP | grep -o 'WD_STATUS=[a-z_-]*' | tail -n 1 | cut -d= -f2 || true
echo "WD_" . "STATUS=" . App\\Models\\ApplicationDeploymentQueue::where('deployment_uuid', '$uuid')->value('status') . "\n";
PHP
}

deployment_log_tail() {
  local uuid=$1
  tinker <<PHP
\$d = App\\Models\\ApplicationDeploymentQueue::where('deployment_uuid', '$uuid')->first();
\$logs = json_decode(\$d->logs ?? '[]', true) ?? [];
foreach (array_slice(array_map(fn(\$l) => \$l['output'] ?? '', \$logs), -40) as \$line) { echo \$line . "\n"; }
PHP
}

# Etykieta `org.opencontainers.image.revision` obrazu `<obraz>:<tag>` z GHCR
# (platforma linux/amd64). Pakiety są publiczne: token anonimowy. Kod 1, gdy
# tagu nie ma albo rejestr nie odpowiada.
ghcr_rewizja() {
  local repo=${1#ghcr.io/} tag=$2 token manifest digest config
  local accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
  token=$(curl -fsS --max-time 20 "https://ghcr.io/token?scope=repository:$repo:pull" | jq -r '.token // empty') || return 1
  [ -n "$token" ] || return 1
  manifest=$(curl -fsS --max-time 20 -H "Authorization: Bearer $token" -H "Accept: $accept" \
    "https://ghcr.io/v2/$repo/manifests/$tag") || return 1
  # buildx z atestacjami wypycha indeks; bierzemy z niego obraz linux/amd64.
  digest=$(jq -r '[.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // empty' <<<"$manifest")
  if [ -n "$digest" ]; then
    manifest=$(curl -fsS --max-time 20 -H "Authorization: Bearer $token" -H "Accept: $accept" \
      "https://ghcr.io/v2/$repo/manifests/$digest") || return 1
  fi
  config=$(jq -r '.config.digest // empty' <<<"$manifest")
  [ -n "$config" ] || return 1
  # Blob przekierowuje na podpisany adres innego hosta; curl nie przenosi tam
  # nagłówka Authorization.
  curl -fsSL --max-time 60 -H "Authorization: Bearer $token" "https://ghcr.io/v2/$repo/blobs/$config" \
    | jq -r '.config.Labels["org.opencontainers.image.revision"] // empty'
}

# Czeka, aż oba obrazy `<sha>` będą w GHCR z etykietą równą SHA. Drugi
# argument: najwyżej tyle minut (0 = jedno sprawdzenie, bez czekania).
czekaj_na_obrazy() {
  local sha=$1 minuty=${2:-45} proba=0 id rev gotowe obraz
  local proby=$((minuty * 2))
  while :; do
    gotowe=1
    for id in "$WORKER_ID" "$WEB_ID"; do
      obraz=$(obraz_ghcr "$id")
      # 404 brakującego tagu to oczekiwany stan w trakcie czekania: bez szumu.
      rev=$(ghcr_rewizja "$obraz" "$sha" 2>/dev/null || true)
      if [ -n "$rev" ] && [ "$rev" != "$sha" ]; then
        die "$obraz:$sha ma etykietę rewizji $rev, a nie $sha. Nie wdrażam obrazu z cudzego commita; zbuduj go od nowa: gh workflow run obrazy.yml -f ref=$sha -f wdroz=false"
      fi
      [ "$rev" = "$sha" ] || gotowe=0
    done
    [ "$gotowe" = 1 ] && return 0
    if [ "$proba" -ge "$proby" ]; then
      echo "Brak obrazów $GHCR_PREFIX-{worker,runner}:$sha z etykietą rewizji w GHCR." >&2
      echo "Build robi workflow „Obrazy i wdrożenie” po każdym scaleniu do main (gh run list --workflow obrazy.yml)." >&2
      echo "Ręcznie: gh workflow run obrazy.yml -f ref=$sha -f wdroz=false" >&2
      return 1
    fi
    [ "$proba" = 0 ] && echo "   obrazów $sha jeszcze nie ma w GHCR; czekam do $minuty min (co 30 s)"
    proba=$((proba + 1))
    sleep 30
  done
}

# Tag obrazu działających kontenerów aplikacji na app-1 (dla obu źródeł to
# SHA: Coolify taguje build z repo pełnym SHA, a obraz z GHCR ma tag SHA).
# Kilka kontenerów na różnych tagach (np. stary jeszcze nie zniknął po
# wdrożeniu) = tagi po przecinku, więc porównanie z jednym SHA nie przejdzie.
sha_dzialajacego() {
  local prefiks
  prefiks=$(prefiks_kontenera "$1")
  [ -n "$prefiks" ] || return 0
  ssh -i "$K" -o BatchMode=yes root@"$APP" "docker ps --format '{{.Names}} {{.Image}}'" \
    | awk -v p="$prefiks" 'index($1, p) == 1 { n = split($2, a, ":"); if (!(a[n] in w)) { w[a[n]] = 1; o = o (o == "" ? "" : ",") a[n] } } END { print o }' || true
}

MIN_WOLNE_GB=${WDROZ_MIN_WOLNE_GB:-4}

# Wolne miejsce na / app-1 w GB.
wolne_gb_app1() {
  ssh -i "$K" -o BatchMode=yes root@"$APP" "df -P -BG / | awk 'NR == 2 { print \$4 }'" | tr -dc '0-9' || true
}

# Odmawia (exit 1), gdy na app-1 jest mniej niż MIN_WOLNE_GB wolnego miejsca:
# obraz workera zajmuje po pobraniu ok. 1,5 GB, a 8.11.2026 dysk się zapchał.
sprawdz_miejsce_app1() {
  local wolne
  wolne=$(wolne_gb_app1)
  [ -n "$wolne" ] || die "Nie odczytałem wolnego miejsca na app-1. Nic nie zmieniłem."
  if [ "$wolne" -lt "$MIN_WOLNE_GB" ]; then
    die "Na app-1 wolne tylko $wolne GB (próg $MIN_WOLNE_GB GB). Usuń stare obrazy (ssh … 'docker image ls', zostaw poprzednią wersję do cofnięcia), potem uruchom skrypt ponownie. Nic nie zmieniłem."
  fi
  echo "   app-1: wolne $wolne GB"
}
