#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Pauza firmy po 429 z KSeF (L1a) — ścieżka operatora.
# Runbook: docs/runbooks/hamulce-ksef.md, „Pauza firmy po 429 (L1a)”.
#
# UWAGA: skrypt napisany 09.11.2026 i NIE był jeszcze uruchomiony na serwerze.
# Pierwsze użycie zacznij od `stan` i porównaj wynik z runbookiem. Założenia
# do sprawdzenia przy pierwszym przebiegu: Redis to kontener z obrazem
# `redis:7…` na app-1 (nie nakładka SRH), hasło w zmiennej `REDIS_PASSWORD`
# tego kontenera (zasób Redis w Coolify), klucze w bazie 0.
# ────────────────────────────────────────────────────────────────
# Jedna linia z katalogu repo (skrypt sam ładuje `.agents/infra.env`):
#
#   ./scripts/ops/ksef-pauza.sh stan <środowisko> <nip>
#       koniec pauzy firmy (ms od 1970), ile zostało (PTTL) i ile firm
#       z 429 w ostatnich 10 minutach (hamulec wysyłki od 5); tylko odczyt
#   ./scripts/ops/ksef-pauza.sh zdejmij <środowisko> <nip> [--tak]
#       usuwa pauzę firmy z Redisa (DEL); bez `--tak` tylko pokazuje stan
#
# <środowisko>: test | demo | production (KSEF_ENV workera), <nip>: 10 cyfr.
#
# Zdejmij pauzę TYLKO, gdy masz pewność, że blokada MF już minęła (np. MF
# potwierdził, albo pauza wisi po błędnym nagłówku). Żądanie przed końcem
# blokady dostaje znów 429, a powtórki wydłużają blokadę — przy powtarzających
# się naruszeniach także dla podmiotu albo zakresu adresów IP, czyli wszystkich
# firm naraz. Pauza kończy się sama (najwyżej po dobie).
#
# DEL działa w każdym procesie najpóźniej po 5 s (odświeżenie odczytu z Redisa),
# także w workerze, który pauzę zapisał. Wyjątek: pauza zapisana w chwili
# awarii Redisa żyje tylko w pamięci procesu i kończy się sama (najwyżej doba).
# Okna hamulca (`ff:ksef:rl429:<środowisko>`) skrypt nie zmienia: gaśnie samo
# po 10 minutach bez nowego 429.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git >/dev/null 2>&1; then
  COMMON_DIR=$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    # Git Bash na Windowsie podaje ścieżkę bezwzględną jako `C:/…`.
    case "$COMMON_DIR" in
      /*|[A-Za-z]:/*) MAIN_ROOT=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd || true) ;;
      *)              MAIN_ROOT=$(cd "$ROOT/$COMMON_DIR/.." 2>/dev/null && pwd || true) ;;
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
for v in K APP; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

usage() {
  sed -n '12,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

CMD=${1:-}
KSEF_ENV_ARG=${2:-}
NIP=${3:-}
FLAG=${4:-}

case "$CMD" in
  stan|zdejmij) ;;
  *) usage ;;
esac
if ! [[ "$KSEF_ENV_ARG" =~ ^(test|demo|production)$ ]]; then
  echo "Środowisko: test, demo albo production (odczytano: '${KSEF_ENV_ARG:-brak}')." >&2
  usage
fi
if ! [[ "$NIP" =~ ^[0-9]{10}$ ]]; then
  echo "NIP: 10 cyfr bez kresek (odczytano: '${NIP:-brak}')." >&2
  usage
fi
if [ "$CMD" = "stan" ] && [ -n "$FLAG" ]; then
  echo "Nieznana opcja $FLAG (stan nic nie zmienia)." >&2
  exit 1
fi
if [ "$CMD" = "zdejmij" ] && [ -n "$FLAG" ] && [ "$FLAG" != "--tak" ]; then
  echo "Nieznana opcja $FLAG (jedyna: --tak)." >&2
  exit 1
fi

# Klucze jak w lib/cache/keys.ts (`ksefRateLimitPause`, `ksefRateLimitedFirms`).
# Środowisko i NIP sprawdzone wyżej, więc klucze nie wymagają cytowania.
PAUSE_KEY="ff:ksef:pause:$KSEF_ENV_ARG:$NIP"
BRAKE_KEY="ff:ksef:rl429:$KSEF_ENV_ARG"
BRAKE_WINDOW_MS=600000   # KSEF_SEND_BRAKE_WINDOW_MS
BRAKE_MIN_FIRMS=5        # KSEF_SEND_BRAKE_MIN_FIRMS

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)

# Kontener Redisa na app-1: z `REDISC` (opcjonalnie w infra.env) albo jedyny
# działający kontener z obrazem `redis:7…`. Nakładka SRH (`hiett/serverless-
# redis-http`) też ma „redis” w nazwie, ale nie ma `redis-cli`, więc
# dopasowanie idzie po początku nazwy obrazu. Dwa albo zero = odmowa.
find_container() {
  if [ -n "${REDISC:-}" ]; then
    echo "$REDISC"
    return
  fi
  local list count
  # `set -e` nie działa w podpowłoce `$(…)`, więc błąd ssh sprawdzamy jawnie.
  if ! list=$("${SSH[@]}" "root@$APP" \
    "docker ps --format '{{.Names}} {{.Image}}' | awk '\$2 ~ /^(docker\\.io\\/)?(library\\/)?redis:7/ {print \$1}'"); then
    echo "Nie połączyłem się z app-1 (ssh root@\$APP) albo docker ps się nie udał. Przerywam." >&2
    exit 1
  fi
  count=$(printf '%s\n' "$list" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$count" != "1" ]; then
    echo "Nie umiem jednoznacznie wskazać kontenera Redisa na app-1 (znalezione: $count)." >&2
    [ -n "$list" ] && printf '  %s\n' $list >&2
    echo "Ustaw REDISC=<nazwa> w .agents/infra.env albo przed poleceniem i uruchom ponownie." >&2
    exit 1
  fi
  echo "$list"
}

C=$(find_container)
if ! [[ "$C" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "Dziwna nazwa kontenera Redisa: '$C'. Przerywam." >&2
  exit 1
fi

# redis-cli w kontenerze; hasło ze zmiennej kontenera (nie wychodzi z serwera,
# nie trafia do argumentów procesu). Argumenty to stałe polecenia i klucze
# sprawdzone wyżej.
rcli() {
  "${SSH[@]}" "root@$APP" \
    "docker exec $C sh -c 'if [ -n \"\${REDIS_PASSWORD:-}\" ]; then export REDISCLI_AUTH=\"\$REDIS_PASSWORD\"; fi; exec redis-cli --no-auth-warning \"\$@\"' sh $*"
}

check_auth() {
  local out=$1
  if printf '%s' "$out" | grep -q 'NOAUTH\|WRONGPASS'; then
    echo "Redis odmówił (hasło): kontener $C nie ma REDIS_PASSWORD albo ma inne. Runbook: unlock-account.md §1 krok 2." >&2
    exit 1
  fi
}

show_state() {
  local value pttl now_ms since firms
  value=$(rcli GET "$PAUSE_KEY")
  check_auth "$value"
  pttl=$(rcli PTTL "$PAUSE_KEY")
  check_auth "$pttl"
  now_ms=$(( $(date +%s) * 1000 ))
  since=$(( now_ms - BRAKE_WINDOW_MS ))
  firms=$(rcli ZCOUNT "$BRAKE_KEY" "$since" +inf)
  check_auth "$firms"

  echo "Kontener Redisa: $C (app-1)"
  echo "Klucz pauzy:     $PAUSE_KEY"
  if [ -z "$value" ] || [ "$pttl" = "-2" ]; then
    echo "Pauza:           brak w Redisie (worker może ją jeszcze trzymać w pamięci, jeśli sam ją zapisał)"
  else
    echo "Koniec pauzy:    $value (ms od 1970)"
    if [ "$pttl" = "-1" ]; then
      echo "Zostało:         klucz bez TTL — nie powinno się zdarzyć (zapis zawsze z px); zgłoś Bartoszowi"
    else
      echo "Zostało:         $pttl ms (ok. $(( (pttl + 59999) / 60000 )) min)"
    fi
  fi
  echo "Firmy z 429 w 10 min ($BRAKE_KEY): $firms (hamulec wysyłki od $BRAKE_MIN_FIRMS)"
}

case "$CMD" in
  stan)
    show_state
    ;;
  zdejmij)
    show_state
    echo
    if [ "$FLAG" != "--tak" ]; then
      echo "Bez --tak nic nie zmieniam. Zdjęcie: ./scripts/ops/ksef-pauza.sh zdejmij $KSEF_ENV_ARG $NIP --tak"
      echo "Uwaga: zdjęcie przed końcem blokady MF wydłuża blokadę (429 i powtórki)."
      exit 0
    fi
    echo "UWAGA: jeśli blokada MF jeszcze trwa, pierwsze żądanie tej firmy dostanie znów 429,"
    echo "a powtórki wydłużą blokadę — przy kolejnych naruszeniach także dla wszystkich firm (zakres IP)."
    echo "Procesy zobaczą zdjęcie najpóźniej po 5 s (pauza zapisana w czasie awarii Redisa zostaje w pamięci do końca)."
    deleted=$(rcli DEL "$PAUSE_KEY")
    check_auth "$deleted"
    echo "DEL $PAUSE_KEY → $deleted (1 = usunięto, 0 = klucza już nie było)"
    ;;
esac
