#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Wdrożenie produkcji: worker (Coolify id=2), potem aplikacja (id=1)
# ────────────────────────────────────────────────────────────────
# Jedna linia, bez argumentów, z katalogu repo, PO scaleniu PR do `main`
# i PO migracjach „przed wdrożeniem” (AGENTS.md → „Kolejność przy pełnym
# wydaniu”):
#
#   ./scripts/ops/wdroz-produkcje.sh
#
# Repo nie ma webhooka, więc push do `main` niczego nie wdraża. Skrypt robi
# to, co AGENTS.md → „Wdrożenie produkcji” opisuje ręcznie: kolejkuje
# wdrożenie przez `tinker` na ops-1 (commit HEAD gałęzi produkcyjnej), czeka
# na `finished` (build 12-18 min) i dopiero potem rusza następną aplikację —
# oba buildy jadą na app-1 i razem nie mieszczą się w pamięci. Przy `failed`
# przerywa: Coolify zostawia wtedy działającą starą wersję, a ostatnie linie
# logu buildu są na ekranie. Na końcu uruchamia `kontrola-faktur-ksef.sh`.
#
# Skrypt sam ładuje `.agents/infra.env` (K, OPS i reszta) — przycisk „Run”
# w aplikacji uruchamia każdy blok w świeżej powłoce.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git >/dev/null 2>&1; then
  COMMON_DIR=$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    case "$COMMON_DIR" in
      /*) MAIN_ROOT=$(cd "$COMMON_DIR/.." && pwd) ;;
      *)  MAIN_ROOT=$(cd "$ROOT/$COMMON_DIR/.." && pwd) ;;
    esac
  fi
fi

ENV_FILE=""
for candidate in "${FAKTFLOW_INFRA_ENV:-}" "$ROOT/.agents/infra.env" "${MAIN_ROOT:+$MAIN_ROOT/.agents/infra.env}"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    ENV_FILE=$candidate
    break
  fi
done
if [ -z "$ENV_FILE" ]; then
  echo "Nie znalazłem .agents/infra.env (plik jest poza gitem — AGENTS.md → Infrastruktura)." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
for v in K OPS; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

# Kod PHP idzie na wejście tinkera (heredoc), nie przez --execute — AGENTS.md
# wyjaśnia, czemu --execute gubi zmienne w dwóch powłokach. Znaczniki wyniku
# składamy z dwóch kawałków ("WD_" . "UUID="), bo tinker odbija wpisane linie
# i grep złapałby też samo polecenie.
tinker() {
  ssh -i "$K" -o BatchMode=yes root@"$OPS" 'docker exec -i coolify php artisan tinker'
}

queue_deployment() {
  local app_id=$1
  tinker <<PHP | grep -o 'WD_UUID=[A-Za-z0-9]*' | tail -n 1 | cut -d= -f2
\$a = App\\Models\\Application::find($app_id);
\$u = (string) new \\Visus\\Cuid2\\Cuid2();
queue_application_deployment(application: \$a, deployment_uuid: \$u, force_rebuild: false, commit: 'HEAD', is_api: false);
echo "WD_" . "UUID=" . \$u . "\n";
PHP
}

deployment_status() {
  local uuid=$1
  tinker <<PHP | grep -o 'WD_STATUS=[a-z_]*' | tail -n 1 | cut -d= -f2
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

deploy() {
  local app_id=$1 name=$2
  echo "── $name (Coolify id=$app_id): kolejkuję wdrożenie"
  local uuid
  uuid=$(queue_deployment "$app_id")
  if [ -z "$uuid" ]; then
    echo "Nie udało się zakolejkować wdrożenia $name (brak identyfikatora z tinkera)." >&2
    exit 1
  fi
  echo "   identyfikator: $uuid — build trwa 12-18 min, sprawdzam co minutę"
  local status="" waited=0
  while [ "$waited" -lt 40 ]; do
    sleep 60
    waited=$((waited + 1))
    status=$(deployment_status "$uuid" || true)
    echo "   $(date +%H:%M) $name: ${status:-?}"
    case "$status" in
      finished) return 0 ;;
      failed|cancelled*)
        echo "Wdrożenie $name: $status. Coolify zostawił poprzednią wersję. Koniec logu:" >&2
        deployment_log_tail "$uuid" >&2 || true
        exit 1
        ;;
    esac
  done
  echo "Wdrożenie $name nie skończyło się w 40 min (ostatni stan: ${status:-?}). Sprawdź kolejkę w Coolify." >&2
  exit 1
}

deploy 2 "worker pg-boss"
deploy 1 "aplikacja Next.js"

echo "── Oba wdrożenia: finished. Kontrola produkcji:"
"$ROOT/scripts/ops/kontrola-faktur-ksef.sh"
