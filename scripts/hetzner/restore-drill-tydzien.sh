#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Cotygodniowa próba odtworzenia najnowszego nocnego zrzutu (plan usprawnień 3.4)
# ────────────────────────────────────────────────────────────────
# Uruchamia timer systemd na db-1 (scripts/hetzner/systemd/, instalacja:
# scripts/ops/zainstaluj-restore-drill.sh). Bierze najnowszy KOMPLETNY zrzut
# z db-backup.sh (z plikiem .sha256), sprawdza sumy i wgrywa go skryptem
# restore-drill.sh do jednorazowego kontenera bez sieci, z tym samym obrazem
# co produkcyjny Postgres. Po próbie kontener znika.
#
# Alarm idzie istniejącym kanałem: osobny check Healthchecks („restore-drill”,
# okres 7 dni, karencja 1 dzień). Nieudana próba = /fail od razu; próba, która
# się nie uruchomi (timer, serwer, skrypt), = brak pinga, alarm po 8 dniach.
# Integracje checka (Telegram, e-mail) ustawia się w Healthchecks, nie tu.
#
# Ta próba sprawdza, że zrzut da się wgrać. Comiesięczna próba na innym hoście
# (docs/runbooks/backup-restore.md § 5, liczby wierszy z produkcji) zostaje.
#
# Konfiguracja poza repo:
#   /etc/faktflow-backup.env (z db-backup.sh): PGC, BACKUP_DIR. Jego HC_URL to
#     check zrzutu i tu NIE jest używany.
#   /etc/faktflow-restore-drill.env:
#     DRILL_HC_URL=https://hc-ping.com/<id>   ping Healthchecks (start/sukces/fail)
#     DRILL_SCRIPT=/usr/local/sbin/faktflow-restore-drill   restore-drill.sh
#     IMAGE=…              obraz; domyślnie ten, na którym działa kontener PGC
#     DRILL_MIN_FREE=2147483648   najmniej wolnego miejsca (B) dla Dockera
#     DRILL_FREE_FACTOR=10        albo tyle × rozmiar zrzutu, jeśli więcej
#     DISK_RESERVE_PCT=10         plus ta część systemu plików (zapas dla Postgresa)
#     LOCK_FILE=/var/lock/faktflow-restore-drill.lock
# ════════════════════════════════════════════════════════════════

set -Eeuo pipefail

BACKUP_CONFIG=${FAKTFLOW_BACKUP_CONFIG:-/etc/faktflow-backup.env}
CONFIG=${FAKTFLOW_DRILL_CONFIG:-/etc/faktflow-restore-drill.env}

# Z konfiguracji zrzutu tylko PGC i BACKUP_DIR (w podpowłoce, żeby jej HC_URL
# nie przeciekł do tego skryptu).
cfg_backup() {
  [ -f "$BACKUP_CONFIG" ] || return 0
  # shellcheck source=/dev/null
  ( . "$BACKUP_CONFIG" > /dev/null 2>&1; printf '%s' "${!1:-}" )
}
PGC=$(cfg_backup PGC)
BACKUP_DIR=$(cfg_backup BACKUP_DIR)
# shellcheck source=/dev/null
[ -f "$CONFIG" ] && . "$CONFIG"

BACKUP_DIR=${BACKUP_DIR:-/root/backups/daily}
DRILL_SCRIPT=${DRILL_SCRIPT:-/usr/local/sbin/faktflow-restore-drill}
DRILL_MIN_FREE=${DRILL_MIN_FREE:-2147483648}
DRILL_FREE_FACTOR=${DRILL_FREE_FACTOR:-10}
DISK_RESERVE_PCT=${DISK_RESERVE_PCT:-10}
LOCK_FILE=${LOCK_FILE:-/var/lock/faktflow-restore-drill.lock}

log() { echo "$(date -u +%FT%TZ) $*"; }

# Treść pingu: jedna linia wyniku, bez danych z bazy (Healthchecks to usługa zewnętrzna).
ping_hc() {
  [ -n "${DRILL_HC_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "${DRILL_HC_URL}$1" \
    || log "uwaga: ping Healthchecks ($1) nieudany"
}

fail() {
  ping_hc /fail "BŁĄD: $*"
  log "BŁĄD: $*" >&2 || :
  exit 1
}
trap 'fail "przerwane w linii $LINENO"' ERR
trap 'fail "przerwane sygnałem"' INT TERM HUP

for v in DRILL_MIN_FREE DRILL_FREE_FACTOR DISK_RESERVE_PCT; do
  [[ ${!v} =~ ^(0|[1-9][0-9]*)$ ]] || fail "$v=${!v} nie jest liczbą całkowitą ≥ 0"
done
[ -n "${DRILL_HC_URL:-}" ] || log "UWAGA: brak DRILL_HC_URL w $CONFIG — nieudaną próbę zobaczysz tylko w journalctl"

exec 9> "$LOCK_FILE"
flock -n 9 || fail "poprzednia próba wciąż trwa"
ping_hc /start

[ -f "$DRILL_SCRIPT" ] || fail "brak $DRILL_SCRIPT (restore-drill.sh)"

# Najnowszy kompletny zrzut: plik .sha256 powstaje jako ostatni (db-backup.sh).
LATEST=$(find "$BACKUP_DIR/" -maxdepth 1 -type f -name 'faktflow-*.sha256' | sort | tail -n 1)
[ -n "$LATEST" ] || fail "brak kompletnego zrzutu w $BACKUP_DIR"
BASE=${LATEST%.sha256}
NAME=${BASE##*/}
[ -f "$BASE.dump" ] && [ -f "$BASE.roles.sql" ] || fail "zrzut $NAME niekompletny (brak .dump albo .roles.sql)"
# Zrzut starszy niż 2 doby alarmuje check db-backup; tu tylko informacja.
if [ -n "$(find "$LATEST" -mmin +2880)" ]; then
  log "UWAGA: najnowszy kompletny zrzut $NAME ma ponad 48 h — sprawdź check db-backup"
fi

( cd "$BACKUP_DIR" && sha256sum -c --quiet "$NAME.sha256" ) || fail "sumy kontrolne zrzutu $NAME się nie zgadzają"
log "zrzut $NAME: sumy zgodne"

if [ -z "${IMAGE:-}" ]; then
  [ -n "$PGC" ] || fail "brak PGC w $BACKUP_CONFIG i brak IMAGE — nie wiem, jaki obraz ma produkcja"
  IMAGE=$(docker inspect --format '{{.Config.Image}}' "$PGC" 2>/dev/null) || IMAGE=""
  [ -n "$IMAGE" ] || fail "nie odczytałem obrazu kontenera $PGC (docker inspect); po przebudowie w Coolify popraw PGC w $BACKUP_CONFIG"
fi

# Miejsce: odtworzona baza leży na tym samym dysku co produkcyjny Postgres.
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || DOCKER_ROOT=""
[ -d "$DOCKER_ROOT" ] || DOCKER_ROOT=/
read -r AVAIL_KB SIZE_KB < <(df -Pk "$DOCKER_ROOT" | awk 'NR == 2 { print $4, $2 }') || true
[[ ${AVAIL_KB:-} =~ ^[0-9]+$ && ${SIZE_KB:-} =~ ^[0-9]+$ ]] || fail "nie odczytałem wolnego miejsca ($DOCKER_ROOT)"
DUMP_BYTES=$(wc -c < "$BASE.dump" | tr -d ' ')
NEED=$(( DUMP_BYTES * DRILL_FREE_FACTOR ))
[ "$NEED" -ge "$DRILL_MIN_FREE" ] || NEED=$DRILL_MIN_FREE
NEED=$(( NEED + SIZE_KB * 1024 * DISK_RESERVE_PCT / 100 ))
[ $(( AVAIL_KB * 1024 )) -ge "$NEED" ] \
  || fail "za mało miejsca na próbę: wolne $(( AVAIL_KB / 1024 )) MB, potrzeba $(( NEED / 1048576 )) MB — próby nie zaczynam"

log "próba: $NAME, obraz $IMAGE"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
# pipefail: kod próby (tee się nie myli); `||` wyłącza pułapkę ERR.
RC=0
IMAGE=$IMAGE bash "$DRILL_SCRIPT" "$BASE.dump" "$BASE.roles.sql" 2>&1 | tee "$OUT" || RC=$?

WYNIK=$(grep -E '^[0-9TZ:-]+ WYNIK: ' "$OUT" | tail -n 1 | sed -E 's/^[^ ]+ //') || WYNIK=""
SUMMARY="${WYNIK:-restore-drill.sh zakończony kodem $RC} (zrzut $NAME)"
[ "$RC" -eq 0 ] || fail "$SUMMARY"
ping_hc "" "$SUMMARY"
log "OK"
