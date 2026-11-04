#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Captcha w GoTrue: stan przełączników i sonda logowania — TYLKO ODCZYT
# ────────────────────────────────────────────────────────────────
# Jedna linia, bez argumentów, z katalogu repo:
#
#   ./scripts/ops/kontrola-captcha-gotrue.sh
#
# Procedura włączania i wycofania: docs/runbooks/captcha-w-gotrue.md.
#
# Skrypt sam ładuje `.agents/infra.env` (K, APP, DB, APP_PREFIX). Nic nie
# zmienia na serwerach: `docker ps` i `docker inspect` (z serwera wychodzą
# tylko true/false, nazwa dostawcy, adres GoTrue, publiczny klucz anon
# i skróty SHA-256 sekretów do porównania — same sekrety zostają na
# serwerze) oraz jedna sonda: logowanie na nieistniejące konto
# `kontrola-captcha@example.invalid` bez tokenu captcha.
#
# Werdykt:
#   A  aplikacja sprawdza token sama, GoTrue bez captcha    stan przed krokiem 2
#   B  aplikacja przekazuje token, GoTrue bez captcha       przejściowy (minuty)
#   C  aplikacja przekazuje token, GoTrue wymusza captcha   docelowy
#   D  GoTrue wymusza captcha, aplikacja sprawdza sama      ZŁY: logowanie nie działa
# Kod wyjścia 1 przy D i przy sekretach, które się nie zgadzają.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

# Gdzie leży `.agents/infra.env`: zmienna FAKTFLOW_INFRA_ENV, katalog tego
# repo, a dla worktree (`.claude/worktrees/*`) — główny checkout, bo plik jest
# poza gitem i worktree go nie ma.
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
for v in K APP DB APP_PREFIX; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)

# Odczyt env kontenera po stronie serwera. Na wyjście idą tylko linie
# `klucz=wartość` z listy niżej; sekrety jako skrót SHA-256 (albo `brak`).
read_env() {
  local host=$1 pattern=$2
  "${SSH[@]}" "root@$host" bash -s -- "$pattern" <<'REMOTE'
set -u
C=$(docker ps --format '{{.Names}}' | grep -E "$1" | head -1)
if [ -z "$C" ]; then echo "kontener=brak"; exit 0; fi
E=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C")
val() { printf '%s\n' "$E" | sed -n "s/^$1=//p" | head -1; }
hash() {
  local s; s=$(val "$1")
  if [ -z "$s" ]; then echo brak; return; fi
  printf '%s' "$s" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64
}
echo "kontener=jest"
echo "switch=$(val AUTH_CAPTCHA_IN_GOTRUE)"
echo "url=$(val NEXT_PUBLIC_SUPABASE_URL)"
echo "anon=$(val NEXT_PUBLIC_SUPABASE_ANON_KEY)"
echo "app_secret=$(hash TURNSTILE_SECRET_KEY)"
echo "enabled=$(val GOTRUE_SECURITY_CAPTCHA_ENABLED)"
echo "provider=$(val GOTRUE_SECURITY_CAPTCHA_PROVIDER)"
echo "gotrue_secret=$(hash GOTRUE_SECURITY_CAPTCHA_SECRET)"
REMOTE
}

field() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }

echo "=== 1. Aplikacja (app-1)"
APP_OUT=$(read_env "$APP" "^$APP_PREFIX") || { echo "  brak połączenia z app-1" >&2; exit 1; }
if [ "$(field "$APP_OUT" kontener)" != jest ]; then echo "  nie znalazłem kontenera aplikacji" >&2; exit 1; fi
SWITCH=$(field "$APP_OUT" switch)
URL=$(field "$APP_OUT" url)
ANON=$(field "$APP_OUT" anon)
APP_SECRET=$(field "$APP_OUT" app_secret)
if [ "$SWITCH" = true ]; then
  echo "  AUTH_CAPTCHA_IN_GOTRUE=true: token z widżetu idzie do GoTrue"
else
  echo "  AUTH_CAPTCHA_IN_GOTRUE=${SWITCH:-(brak)}: aplikacja sprawdza token sama"
fi
echo "  TURNSTILE_SECRET_KEY: $([ "$APP_SECRET" = brak ] && echo 'BRAK' || echo 'ustawiony')"

echo
echo "=== 2. GoTrue (db-1)"
GT_OUT=$(read_env "$DB" "supabase-auth") || { echo "  brak połączenia z db-1" >&2; exit 1; }
if [ "$(field "$GT_OUT" kontener)" != jest ]; then echo "  nie znalazłem kontenera GoTrue" >&2; exit 1; fi
ENABLED=$(field "$GT_OUT" enabled)
PROVIDER=$(field "$GT_OUT" provider)
GT_SECRET=$(field "$GT_OUT" gotrue_secret)
echo "  GOTRUE_SECURITY_CAPTCHA_ENABLED=${ENABLED:-(brak)}"
echo "  GOTRUE_SECURITY_CAPTCHA_PROVIDER=${PROVIDER:-(brak)}"
if [ "$GT_SECRET" = brak ]; then
  echo "  GOTRUE_SECURITY_CAPTCHA_SECRET: brak"
elif [ "$GT_SECRET" = "$APP_SECRET" ]; then
  echo "  GOTRUE_SECURITY_CAPTCHA_SECRET: ustawiony, taki sam jak TURNSTILE_SECRET_KEY aplikacji"
else
  echo "  GOTRUE_SECURITY_CAPTCHA_SECRET: ustawiony, INNY niż TURNSTILE_SECRET_KEY aplikacji"
fi

echo
echo "=== 3. Sonda: logowanie bez tokenu captcha (konto nie istnieje)"
PROBE=unknown
if [ -z "$URL" ] || [ -z "$ANON" ]; then
  echo "  brak adresu GoTrue albo klucza anon w env aplikacji — sonda pominięta"
else
  BODY=$(mktemp)
  CODE=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 15 -X POST \
    "$URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H 'Content-Type: application/json' \
    -d '{"email":"kontrola-captcha@example.invalid","password":"kontrola-bez-tokenu-captcha"}') || CODE=000
  if grep -qi captcha "$BODY"; then
    PROBE=enforced
    echo "  HTTP $CODE, odmowa captcha: GoTrue wymusza captcha"
  elif grep -q invalid_credentials "$BODY" || grep -qi 'invalid login credentials' "$BODY"; then
    PROBE=open
    echo "  HTTP $CODE, „złe dane logowania”: GoTrue NIE wymusza captcha"
  elif [ "$CODE" = 429 ]; then
    echo "  HTTP 429: limit prób GoTrue — uruchom ponownie za kilka minut"
  else
    echo "  HTTP $CODE: nieoczekiwana odpowiedź — sprawdź logi kontenera supabase-auth"
  fi
  rm -f "$BODY"
fi

echo
echo "=== Werdykt"
STATUS=0
if [ "$PROBE" = enforced ] && [ "$SWITCH" = true ]; then
  echo "  C: stan docelowy — token sprawdza GoTrue, aplikacja go przekazuje."
elif [ "$PROBE" = enforced ]; then
  echo "  D: ŹLE — GoTrue wymusza captcha, a aplikacja zużywa token sama, więc logowanie nie działa."
  echo "     Włącz AUTH_CAPTCHA_IN_GOTRUE=true w aplikacji albo wyłącz captcha w GoTrue (runbook, „Wycofanie”)."
  STATUS=1
elif [ "$PROBE" = open ] && [ "$SWITCH" = true ]; then
  echo "  B: przejściowy — aplikacja przekazuje token, GoTrue jeszcze go nie wymaga."
  echo "     Dokończ krok w GoTrue (runbook, punkt 3). Do tego czasu formularze chronią pole-pułapka i limity."
elif [ "$PROBE" = open ]; then
  echo "  A: przed krokiem 2 — aplikacja sprawdza token sama, GoTrue bez captcha."
else
  echo "  nieustalony — sonda nie dała jednoznacznej odpowiedzi."
  STATUS=1
fi
if [ "$ENABLED" = true ] && [ "$GT_SECRET" != "$APP_SECRET" ]; then
  echo "  UWAGA: sekret captcha w GoTrue różni się od TURNSTILE_SECRET_KEY aplikacji — GoTrue odrzuci tokeny z widżetu."
  STATUS=1
fi
if [ "$ENABLED" = true ] && [ "$PROVIDER" != turnstile ]; then
  echo "  UWAGA: GOTRUE_SECURITY_CAPTCHA_PROVIDER powinien być „turnstile”."
  STATUS=1
fi
exit $STATUS
