#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Rotacja kluczy: kontrola po każdym kroku (docs/runbooks/rotacja-kluczy.md)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo, przed rotacją i po KAŻDYM kroku:
#
#   ./scripts/ops/rotacja-kluczy.sh
#
# Mail kontrolny domyślnie idzie na `delivered@resend.dev` (adres testowy
# Resend: przyjmuje i niczego nie dostarcza). Na własną skrzynkę:
#
#   ROTACJA_MAIL_DO=ty@example.com ./scripts/ops/rotacja-kluczy.sh
#
# Krok 4 runbooka (klucz KSeF), jedyny tryb z zapisem w bazie:
#
#   ./scripts/ops/rotacja-kluczy.sh przeszyfruj-ksef
#
# robi to samo, a między częścią 1 i 2 przeszyfrowuje dane KSeF bieżącym
# kluczem (scripts/reencrypt-ksef-credentials.ts --apply w workerze). Rusza
# tylko przy zielonej spójności, bo przeszyfrowanie kluczem, którego nie ma
# w drugim kontenerze, odcięłoby firmy od KSeF.
#
# Co robi (niczego nie zmienia w konfiguracji):
#   1. Odciski sekretów w kontenerach: aplikacja i worker (app-1), GoTrue,
#      PostgREST i Kong (db-1). Odcisk = 12 pierwszych znaków SHA-256
#      liczonych NA SERWERZE; same wartości nie opuszczają serwera. Porównuje
#      aplikację z workerem, aplikację z Kongiem i GoTrue z PostgREST, a obok
#      pokazuje, co zmieniło się od poprzedniego uruchomienia (zapis odcisków
#      w .agents/backup/rotacja-kluczy/, poza gitem).
#   2. Działanie: /api/health, stan kontenerów, sonda w aplikacji i w workerze
#      (scripts/ops/rotacja-kluczy-sonda.mjs: klucz anon, logowanie, klucz
#      service_role w GoTrue i PostgREST, mail przez API Resend, zapis i odczyt
#      MinIO, Turnstile, webhooki Slacka), mail przez SMTP GoTrue z db-1,
#      przekierowanie Google, liczba firm z danymi KSeF według środowiska
#      i podgląd przeszyfrowania danych KSeF (bez zapisu).
#
# Skutki uboczne, wszystkie celowe: dwa maile przez API Resend (aplikacja,
# worker) i jeden przez SMTP GoTrue na ROTACJA_MAIL_DO; obiekt próbny
# `_kontrola-rotacji/*` w buckecie plików, usuwany od razu; jedna nieudana
# próba logowania na `kontrola-rotacji@example.invalid`.
#
# Kod wyjścia 0 = wszystko działa i odciski są spójne. 1 = coś do poprawy
# (linie BŁĄD). Skrypt sam ładuje `.agents/infra.env` (K, APP, DB,
# APP_PREFIX, WORKER_PREFIX, opcjonalnie RESTC i PGC).
# ════════════════════════════════════════════════════════════════

set -uo pipefail

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
for v in K APP DB APP_PREFIX WORKER_PREFIX; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

TRYB=${1:-kontrola}
case "$TRYB" in
  kontrola|przeszyfruj-ksef) ;;
  *) echo "Użycie: $0 [przeszyfruj-ksef]" >&2; exit 1 ;;
esac

MAIL_DO=${ROTACJA_MAIL_DO:-delivered@resend.dev}
# Adres trafia do polecenia na serwerze, więc tylko prosty kształt.
if ! [[ "$MAIL_DO" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "ROTACJA_MAIL_DO nie wygląda na adres e-mail." >&2
  exit 1
fi

# Odciski z poprzedniego uruchomienia leżą obok infra.env (w worktree to
# dowiązanie, więc idziemy do prawdziwego katalogu .agents).
ENV_REAL=$ENV_FILE
if [ -L "$ENV_FILE" ]; then
  ENV_REAL=$(readlink "$ENV_FILE")
  case "$ENV_REAL" in /*) ;; *) ENV_REAL="$(dirname "$ENV_FILE")/$ENV_REAL" ;; esac
fi
STATE_DIR=${ROTACJA_STAN:-"$(dirname "$ENV_REAL")/backup/rotacja-kluczy"}
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
STATE_FILE="$STATE_DIR/odciski.txt"

PROBE="$ROOT/scripts/ops/rotacja-kluczy-sonda.mjs"
SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)
FAILS=0

ok()   { printf '  OK     %s\n' "$1"; }
bad()  { printf '  BŁĄD   %s\n' "$1"; FAILS=$((FAILS + 1)); }
info() { printf '  ·      %s\n' "$1"; }

# ── Odczyt env kontenera po stronie serwera ─────────────────────
# Argumenty: wzorzec nazwy kontenera, potem specyfikacje `fp:ZMIENNA`
# (odcisk), `jwt:ZMIENNA` (odcisk + rola i iat z części jawnej tokenu)
# i `val:ZMIENNA` (wartość; tylko dla zmiennych jawnych z list niżej).
# Wyjście: linie `klucz=wartość`, sekrety wyłącznie jako odcisk.
read_env() {
  local host=$1; shift
  "${SSH[@]}" "root@$host" bash -s -- "$@" <<'REMOTE'
set -u
pattern=$1; shift
C=$(docker ps --format '{{.Names}}' | grep -E "$pattern" | head -1)
if [ -z "$C" ]; then echo "kontener=brak"; exit 0; fi
E=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C")
val() { printf '%s\n' "$E" | sed -n "s/^$1=//p" | head -1; }
fp() {
  local s; s=$(val "$1")
  if [ -z "$s" ]; then echo brak; return; fi
  printf '%s' "$s" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12
}
jwt() {
  local s p payload role iat
  s=$(val "$1")
  [ -z "$s" ] && return
  p=$(printf '%s' "$s" | cut -d. -f2 | tr '_-' '/+')
  case $((${#p} % 4)) in 2) p="$p==" ;; 3) p="$p=" ;; esac
  payload=$(printf '%s' "$p" | base64 -d 2>/dev/null || true)
  role=$(printf '%s' "$payload" | sed -n 's/.*"role" *: *"\([a-z_]*\)".*/\1/p')
  iat=$(printf '%s' "$payload" | sed -n 's/.*"iat" *: *\([0-9]*\).*/\1/p')
  echo "jwt.$1=${role:-?}/${iat:-?}"
}
echo "kontener=jest"
echo "stan=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}} {{.State.StartedAt}}' "$C")"
echo "projekt=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$C" 2>/dev/null)"
for spec in "$@"; do
  kind=${spec%%:*}; name=${spec#*:}
  case $kind in
    fp)  echo "fp.$name=$(fp "$name")" ;;
    jwt) echo "fp.$name=$(fp "$name")"; jwt "$name" ;;
    val) echo "val.$name=$(val "$name")" ;;
  esac
done
REMOTE
}

field() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }

iat_date() {
  local iat=$1
  [[ "$iat" =~ ^[0-9]+$ ]] || { echo "?"; return; }
  date -r "$iat" +%F 2>/dev/null || date -d "@$iat" +%F 2>/dev/null || echo "?"
}

# Sekrety aplikacji i workera. Ta sama lista w obu: brak w jednym z nich
# też jest informacją.
APP_SECRETS=(
  jwt:SUPABASE_SERVICE_ROLE_KEY
  jwt:NEXT_PUBLIC_SUPABASE_ANON_KEY
  fp:KSEF_CREDENTIALS_ENCRYPTION_KEY
  fp:KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS
  fp:EMAIL_UNSUBSCRIBE_SECRET
  fp:RESEND_API_KEY
  fp:RESEND_WEBHOOK_SECRET
  fp:TURNSTILE_SECRET_KEY
  fp:SLACK_WEBHOOK_URGENT
  fp:SLACK_WEBHOOK_BUGS
  fp:SLACK_WEBHOOK_METRICS
  fp:R2_ACCESS_KEY_ID
  fp:R2_SECRET_ACCESS_KEY
  fp:AWS_ACCESS_KEY_ID
  fp:AWS_SECRET_ACCESS_KEY
  fp:GOOGLE_CLIENT_SECRET
)
# Muszą być takie same w aplikacji i workerze, jeśli którykolwiek je ma.
SHARED=(SUPABASE_SERVICE_ROLE_KEY KSEF_CREDENTIALS_ENCRYPTION_KEY KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS
  EMAIL_UNSUBSCRIBE_SECRET RESEND_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY)

echo "════ Rotacja kluczy: kontrola $(date '+%Y-%m-%d %H:%M') ════"
echo

echo "── 1. Odciski sekretów (SHA-256, 12 znaków; wartości zostają na serwerach)"
APP_OUT=$(read_env "$APP" "^$APP_PREFIX" "${APP_SECRETS[@]}" val:NEXT_PUBLIC_APP_URL val:NEXT_PUBLIC_SUPABASE_URL) || APP_OUT="kontener=?"
WRK_OUT=$(read_env "$APP" "^$WORKER_PREFIX" "${APP_SECRETS[@]}") || WRK_OUT="kontener=?"
AUTH_OUT=$(read_env "$DB" "supabase-auth" fp:GOTRUE_JWT_SECRET fp:GOTRUE_SMTP_PASS fp:GOTRUE_EXTERNAL_GOOGLE_SECRET \
  fp:GOTRUE_SECURITY_CAPTCHA_SECRET val:GOTRUE_SECURITY_CAPTCHA_ENABLED val:GOTRUE_EXTERNAL_GOOGLE_ENABLED) || AUTH_OUT="kontener=?"
REST_OUT=$(read_env "$DB" "${RESTC:-supabase-rest}" fp:PGRST_JWT_SECRET) || REST_OUT="kontener=?"
KONG_OUT=$(read_env "$DB" "supabase-kong" jwt:SUPABASE_ANON_KEY jwt:SUPABASE_SERVICE_KEY) || KONG_OUT="kontener=?"

for pair in "aplikacja (app-1):APP_OUT" "worker (app-1):WRK_OUT" "GoTrue (db-1):AUTH_OUT" "PostgREST (db-1):REST_OUT" "Kong (db-1):KONG_OUT"; do
  label=${pair%%:*}; var=${pair#*:}
  case "$(field "${!var}" kontener)" in
    jest) ;;
    brak) bad "$label: nie znalazłem kontenera" ;;
    *)    bad "$label: brak połączenia SSH" ;;
  esac
done

# Odciski jako linie `zakres.ZMIENNA=odcisk` (bash 3.2 na Macu nie ma
# tablic asocjacyjnych).
NOW_TXT=""
collect() { NOW_TXT+=$(printf '%s\n' "$2" | sed -n "s/^fp\./$1./p")$'\n'; }
lookup() { awk -F= -v k="$1" -v d="$2" '$1 == k { print substr($0, length(k) + 2); f = 1; exit } END { if (!f) print d }'; }
now() { printf '%s\n' "$NOW_TXT" | lookup "$1" "?"; }
prev() { if [ -f "$STATE_FILE" ]; then lookup "$1" "-" <"$STATE_FILE"; else echo "-"; fi; }
collect app "$APP_OUT"; collect worker "$WRK_OUT"; collect gotrue "$AUTH_OUT"; collect postgrest "$REST_OUT"; collect kong "$KONG_OUT"

change() {
  local p; p=$(prev "$1")
  if [ "$p" = "-" ]; then echo "(pierwszy zapis)"
  elif [ "$p" = "$(now "$1")" ]; then echo "bez zmian"
  else echo "ZMIENIONY"; fi
}
# Dwie wartości są „takie same” tylko wtedy, gdy obie są prawdziwymi odciskami.
same() { [ "$1" = "$2" ] && [ "$1" != "?" ] && [ "$1" != brak ]; }

printf '  %-42s %-13s %-13s %s\n' "zmienna" "aplikacja" "worker" "od poprzedniej kontroli (aplikacja)"
for spec in "${APP_SECRETS[@]}"; do
  n=${spec#*:}
  printf '  %-42s %-13s %-13s %s\n' "$n" "$(now "app.$n")" "$(now "worker.$n")" "$(change "app.$n")"
done
for k in gotrue.GOTRUE_JWT_SECRET gotrue.GOTRUE_SMTP_PASS gotrue.GOTRUE_EXTERNAL_GOOGLE_SECRET gotrue.GOTRUE_SECURITY_CAPTCHA_SECRET \
         postgrest.PGRST_JWT_SECRET kong.SUPABASE_ANON_KEY kong.SUPABASE_SERVICE_KEY; do
  printf '  %-42s %-27s %s\n' "$k" "$(now "$k")" "$(change "$k")"
done

for n in SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY; do
  j=$(field "$APP_OUT" "jwt.$n")
  [ -n "$j" ] && info "$n: rola ${j%%/*}, wystawiony $(iat_date "${j#*/}")"
done
info "Usługa Supabase na db-1, projekt compose: $(field "$AUTH_OUT" projekt)"

echo
echo "── Spójność"
for n in "${SHARED[@]}"; do
  a=$(now "app.$n"); w=$(now "worker.$n")
  if [ "$a" = brak ] && [ "$w" = brak ]; then
    case $n in KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) ;; *) bad "$n: brak w aplikacji i w workerze" ;; esac
  elif [ "$a" != "$w" ]; then
    bad "$n: aplikacja i worker mają RÓŻNE wartości (albo jeden jej nie ma)"
  fi
done
for n in SLACK_WEBHOOK_URGENT SLACK_WEBHOOK_BUGS SLACK_WEBHOOK_METRICS NEXT_PUBLIC_SUPABASE_ANON_KEY; do
  a=$(now "app.$n"); w=$(now "worker.$n")
  if [ "$a" != brak ] && [ "$w" != brak ] && [ "$a" != "$w" ]; then bad "$n: aplikacja i worker mają różne wartości"; fi
done
KSEF_PREV=$(now app.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS)
if [ "$KSEF_PREV" != brak ] && [ "$KSEF_PREV" != "?" ]; then
  if same "$KSEF_PREV" "$(now app.KSEF_CREDENTIALS_ENCRYPTION_KEY)"; then
    bad "KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS jest taki sam jak bieżący klucz"
  else
    info "KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS ustawiony: trwa rotacja klucza KSeF (krok 4)"
  fi
fi
if same "$(now gotrue.GOTRUE_JWT_SECRET)" "$(now postgrest.PGRST_JWT_SECRET)"; then
  ok "GoTrue i PostgREST: ten sam sekret JWT"
else
  bad "GoTrue i PostgREST: różne albo nieodczytane sekrety JWT (tokeny z logowania nie przejdą przez API)"
fi
if same "$(now app.SUPABASE_SERVICE_ROLE_KEY)" "$(now kong.SUPABASE_SERVICE_KEY)"; then
  ok "klucz service_role aplikacji = klucz w Kongu"
else
  bad "klucz service_role aplikacji różni się od klucza w Kongu (Kong go odrzuci)"
fi
if same "$(now app.NEXT_PUBLIC_SUPABASE_ANON_KEY)" "$(now kong.SUPABASE_ANON_KEY)"; then
  ok "klucz anon aplikacji = klucz w Kongu"
else
  bad "klucz anon aplikacji różni się od klucza w Kongu (logowanie w przeglądarce nie zadziała)"
fi
smtp=$(now gotrue.GOTRUE_SMTP_PASS)
if [ "$smtp" = brak ]; then info "GoTrue bez GOTRUE_SMTP_PASS (maile logowania nie przez Resend SMTP?)"
elif same "$smtp" "$(now app.RESEND_API_KEY)"; then info "SMTP GoTrue używa tego samego klucza Resend co aplikacja"
else info "SMTP GoTrue używa INNEGO klucza Resend niż aplikacja (rotuj oba)"; fi
if [ "$(field "$AUTH_OUT" val.GOTRUE_SECURITY_CAPTCHA_ENABLED)" = true ] \
   && ! same "$(now gotrue.GOTRUE_SECURITY_CAPTCHA_SECRET)" "$(now app.TURNSTILE_SECRET_KEY)"; then
  bad "captcha w GoTrue włączona, a jej sekret różni się od TURNSTILE_SECRET_KEY aplikacji"
fi
for scope in app worker; do
  if [ "$(now "$scope.GOOGLE_CLIENT_SECRET")" != brak ] && [ "$(now "$scope.GOOGLE_CLIENT_SECRET")" != "?" ]; then
    info "GOOGLE_CLIENT_SECRET w env ($scope): kod go nie czyta (Google obsługuje GoTrue), usuń zmienną po rotacji"
  fi
  if [ "$(now "$scope.AWS_ACCESS_KEY_ID")" != brak ] && [ "$(now "$scope.AWS_ACCESS_KEY_ID")" != "?" ]; then
    info "AWS_ACCESS_KEY_ID w env ($scope): archiwum Glacier jest odłożone, sprawdź klucz w AWS IAM (runbook, krok 1f)"
  fi
done

# scripts/reencrypt-ksef-credentials.ts w workerze (pełne node_modules i tsx).
# Bez argumentu: podgląd, niczego nie zapisuje, a odszyfrowuje każdy zapis
# kluczami z env. `--apply`: zapis. Ostatnia linia wyjścia: `KOD=<kod wyjścia>`.
ksef_reencrypt() {
  "${SSH[@]}" "root@$APP" \
    "C=\$(docker ps --format '{{.Names}}' | grep -E '^$WORKER_PREFIX' | head -1); [ -n \"\$C\" ] && docker exec \"\$C\" node --import ./lib/jobs/server-only-hook.mjs --import tsx scripts/reencrypt-ksef-credentials.ts $* 2>&1; echo \"KOD=\$?\"" 2>/dev/null \
    || echo "KOD=ssh"
}

# Krok 4: przeszyfrowanie (tylko w trybie `przeszyfruj-ksef`). Worker ma pełne
# node_modules i tsx; skrypt czyta zapisy stronami i zapisuje warunkowo
# (updated_at), więc ponowienie jest bezpieczne.
if [ "$TRYB" = przeszyfruj-ksef ]; then
  echo
  echo "── Przeszyfrowanie danych KSeF bieżącym kluczem"
  if [ "$FAILS" -gt 0 ]; then
    bad "przeszyfrowanie pominięte: najpierw popraw błędy spójności wyżej"
  else
    APPLY_OUT=$(ksef_reencrypt --apply)
    printf '%s\n' "$APPLY_OUT" | grep -v '^KOD=' | sed 's/^/           /'
    if [ "$(printf '%s\n' "$APPLY_OUT" | sed -n 's/^KOD=//p' | tail -1)" = 0 ]; then
      ok "KSeF: przeszyfrowanie zakończone kompletnie"
    else
      bad "KSeF: przeszyfrowanie niekompletne, uruchom tryb przeszyfruj-ksef jeszcze raz (NIE usuwaj _PREVIOUS)"
    fi
  fi
fi

echo
echo "── 2. Działanie"
APP_URL=$(field "$APP_OUT" val.NEXT_PUBLIC_APP_URL); APP_URL=${APP_URL:-https://faktway.pl}
SUPA_URL=$(field "$APP_OUT" val.NEXT_PUBLIC_SUPABASE_URL)
body=$(mktemp)
code=$(curl -s -o "$body" -m 20 -w '%{http_code}' "$APP_URL/api/health") || code=000
if [ "$code" = 200 ] && grep -q '"healthy"' "$body"; then ok "$APP_URL/api/health → 200 healthy"
else bad "$APP_URL/api/health → $code (oczekiwane 200 healthy)"; fi
rm -f "$body"

for pair in "aplikacja:APP_OUT" "worker:WRK_OUT"; do
  label=${pair%%:*}; var=${pair#*:}
  st=$(field "${!var}" stan)
  case "$st" in
    healthy*|running*) ok "kontener $label: ${st%% *}, uruchomiony ${st#* }" ;;
    # Pierwsze ~30 s po Restarcie: healthcheck jeszcze nie odpowiedział.
    starting*) info "kontener $label: dopiero startuje (uruchomiony ${st#* }), powtórz kontrolę za minutę" ;;
    "") ;;
    *) bad "kontener $label: ${st}" ;;
  esac
done

run_probe() {
  local rola=$1 prefix=$2 line nazwa stan opis
  while IFS= read -r line; do
    case "$line" in
      SONDA\|*)
        IFS='|' read -r _ nazwa stan opis <<<"$line"
        case "$stan" in
          ok) ok "[$rola] $nazwa: $opis" ;;
          pominiete) info "[$rola] $nazwa: pominięte, $opis" ;;
          *) bad "[$rola] $nazwa: $opis" ;;
        esac
        ;;
    esac
  done < <("${SSH[@]}" "root@$APP" \
    "C=\$(docker ps --format '{{.Names}}' | grep -E '^$prefix' | head -1); if [ -z \"\$C\" ]; then echo 'SONDA|kontener|blad|brak kontenera'; exit 0; fi; docker exec -i -e ROTACJA_ROLA=$rola -e ROTACJA_MAIL_DO=$MAIL_DO \"\$C\" node --input-type=module -" \
    <"$PROBE" 2>/dev/null || echo "SONDA|ssh|blad|sonda nie uruchomiła się")
}
run_probe app "$APP_PREFIX"
run_probe worker "$WORKER_PREFIX"

# SMTP GoTrue: ten sam serwer, użytkownik i hasło co maile z linkami logowania.
# Hasło idzie do curl przez konfigurację na stdin (`-K -`), nie w argumentach.
# Funkcja, nie heredoc wprost w `$(...)`: bash 3.2 na Macu nie parsuje
# `case` z heredoca wewnątrz podstawienia polecenia.
smtp_probe() {
  "${SSH[@]}" "root@$DB" bash -s -- "$MAIL_DO" <<'REMOTE' 2>/dev/null
set -u
TO=$1
C=$(docker ps --format '{{.Names}}' | grep -E 'supabase-auth' | head -1)
[ -z "$C" ] && { echo "blad|brak kontenera GoTrue"; exit 0; }
command -v curl >/dev/null || { echo "pominiete|brak curl na db-1"; exit 0; }
E=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C")
val() { printf '%s\n' "$E" | sed -n "s/^$1=//p" | head -1; }
HOST=$(val GOTRUE_SMTP_HOST); PORT=$(val GOTRUE_SMTP_PORT); USR=$(val GOTRUE_SMTP_USER)
PASS=$(val GOTRUE_SMTP_PASS); FROM=$(val GOTRUE_SMTP_ADMIN_EMAIL)
[ -z "$HOST" ] || [ -z "$PASS" ] || [ -z "$FROM" ] && { echo "pominiete|GoTrue bez kompletu GOTRUE_SMTP_*"; exit 0; }
case "${PORT:-587}" in
  465) URL="smtps://$HOST:465"; TLS=() ;;
  *)   URL="smtp://$HOST:${PORT:-587}"; TLS=(--ssl-reqd) ;;
esac
MSG=$(mktemp)
printf 'From: %s\r\nTo: %s\r\nSubject: FaktWay: kontrola rotacji kluczy (SMTP GoTrue)\r\n\r\nMail kontrolny ze scripts/ops/rotacja-kluczy.sh przez SMTP GoTrue.\r\n' "$FROM" "$TO" >"$MSG"
u=${USR//\\/\\\\}; u=${u//\"/\\\"}; p=${PASS//\\/\\\\}; p=${p//\"/\\\"}
code=$(printf 'user = "%s:%s"\n' "$u" "$p" | curl -s -K - --url "$URL" "${TLS[@]}" --mail-from "$FROM" --mail-rcpt "$TO" \
  -T "$MSG" -m 30 -o /dev/null -w '%{response_code}' 2>/dev/null) || true
rm -f "$MSG"
if [ "$code" = 250 ]; then echo "ok|serwer SMTP przyjął mail (250)"
elif [ "$code" = 535 ]; then echo "blad|SMTP odrzucił logowanie (535): zły klucz w GOTRUE_SMTP_PASS"
else echo "blad|SMTP odpowiedział ${code:-brak}"; fi
REMOTE
}
SMTP_RES=$(smtp_probe) || SMTP_RES="blad|brak połączenia z db-1"
case "${SMTP_RES%%|*}" in
  ok) ok "[GoTrue] smtp: ${SMTP_RES#*|} do $MAIL_DO" ;;
  pominiete) info "[GoTrue] smtp: pominięte, ${SMTP_RES#*|}" ;;
  *) bad "[GoTrue] smtp: ${SMTP_RES#*|}" ;;
esac

if [ "$(field "$AUTH_OUT" val.GOTRUE_EXTERNAL_GOOGLE_ENABLED)" = true ] && [ -n "$SUPA_URL" ]; then
  loc=$(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "$SUPA_URL/auth/v1/authorize?provider=google") || loc=000
  case "$loc" in
    30?\ https://accounts.google.com/*) ok "Google: GoTrue przekierowuje do Google (sekret klienta sprawdzisz tylko logując się przez Google)" ;;
    *) bad "Google: /auth/v1/authorize → ${loc%% *} (oczekiwane przekierowanie do accounts.google.com)" ;;
  esac
fi

# Ile firm ma zapisane dane KSeF i z którego środowiska KSeF (ocena ryzyka,
# krok 4). Same liczby, bez danych.
if [ -n "${PGC:-}" ]; then
  KSEF_ENVS=$("${SSH[@]}" "root@$DB" \
    "docker exec $PGC psql -U postgres -d postgres -At -F: -c \"SELECT coalesce(ksef_environment, 'nieznane'), count(*) FROM public.tenants WHERE ksef_credentials_encrypted IS NOT NULL GROUP BY 1 ORDER BY 1\"" 2>/dev/null) \
    || KSEF_ENVS=""
  if [ -n "$KSEF_ENVS" ]; then
    info "firmy z zapisanymi danymi KSeF (środowisko: liczba): $(printf '%s' "$KSEF_ENVS" | tr '\n' ' ')"
  else
    info "firmy z danymi KSeF: brak albo zapytanie nieudane"
  fi
fi

# Podgląd przeszyfrowania KSeF (bez zapisu).
KSEF_OUT=$(ksef_reencrypt)
ksef_line=$(printf '%s\n' "$KSEF_OUT" | grep -m1 '^Przeczytano:' || true)
ksef_code=$(printf '%s\n' "$KSEF_OUT" | sed -n 's/^KOD=//p' | tail -1)
if [ -z "$ksef_line" ]; then
  bad "KSeF: podgląd przeszyfrowania nie dał raportu (kod ${ksef_code:-?})"
else
  failed=$(printf '%s' "$ksef_line" | sed -n 's/.*błędy: \([0-9]*\).*/\1/p')
  todo=$(printf '%s' "$ksef_line" | sed -n 's/.*Do przeszyfrowania (podgląd): \([0-9]*\).*/\1/p')
  if [ "${failed:-1}" != 0 ] || [ "$ksef_code" != 0 ]; then
    bad "KSeF: $ksef_line"
    printf '%s\n' "$KSEF_OUT" | grep -v '^Przeczytano:\|^KOD=' | head -5 | sed 's/^/           /'
  else
    ok "KSeF: wszystkie zapisy odszyfrowują się kluczami z env ($ksef_line)"
    [ "${todo:-0}" != 0 ] && info "KSeF: $todo zapisów na starym kluczu albo w formacie v1 (krok 4: przeszyfrowanie)"
  fi
fi

# Zapis odcisków na koniec: następna kontrola pokaże zmiany. Klucze, których
# tym razem nie odczytano (SSH, brak kontenera), zostają z poprzedniego zapisu,
# żeby jeden nieudany przebieg nie kasował punktu odniesienia.
{
  printf '%s\n' "$NOW_TXT" | grep -v '^$'
  if [ -f "$STATE_FILE" ]; then
    printf '%s\n' "$NOW_TXT" | grep -v '^$' | cut -d= -f1 >"$STATE_FILE.read"
    grep -v -F -x -f "$STATE_FILE.read" <(cut -d= -f1 "$STATE_FILE") | while IFS= read -r k; do
      grep -m1 -F "$k=" "$STATE_FILE"
    done
    rm -f "$STATE_FILE.read"
  fi
} | sort >"$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE" && chmod 600 "$STATE_FILE"

echo
echo "── Do sprawdzenia ręcznie (skrypt tego nie umie):"
echo "   logowanie hasłem i przez Google w przeglądarce; Resend → Webhooks → ostatnie dostawy 2xx."
echo
if [ "$FAILS" -eq 0 ]; then echo "Wszystko OK."; else echo "Błędy: $FAILS (szczegóły wyżej, linie BŁĄD)."; fi
[ "$FAILS" -eq 0 ]
