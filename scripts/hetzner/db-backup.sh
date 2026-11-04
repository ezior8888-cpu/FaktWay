#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Nocny pełny zrzut bazy na db-1 (krok 6 planu automatyzacji)
# ────────────────────────────────────────────────────────────────
# Dlaczego obok nocnego snapshotu aplikacji: tamten
# (lib/backup/db-snapshot.ts) czyta przez REST tylko schemat `public`,
# stronami, bez punktu w czasie — bez `auth.*` (loginy, MFA) i `pgboss.*`
# (AUD-08). pg_dump robi spójny zrzut całej bazy `postgres` w jednej
# transakcji, a próba odtworzenia z 1 października 2026 potwierdziła, że
# da się go wgrać do czystego obrazu supabase/postgres
# (docs/runbooks/backup-restore.md).
#
# Uruchamia cron na db-1 jako root. Konfiguracja poza repo, w
# /etc/faktflow-backup.env:
#   PGC=<nazwa kontenera Postgresa>   wymagane
#   BACKUP_DIR=/root/backups/daily    katalog zrzutów
#   KEEP=14                           ile ostatnich KOMPLETNYCH zrzutów trzymać
#                                     lokalnie (co najmniej 1). Obniż do 2–3
#                                     dopiero wtedy, gdy działa kopia poza
#                                     serwerem: RCLONE_REMOTE ustawiony, w logu
#                                     co noc „kopia poza serwerem” bez błędu
#                                     cryptcheck i włączone snapshoty Storage
#                                     Boxa. Decyzja Bartosza. Do tego czasu
#                                     lokalne zrzuty to jedyna historia bazy.
#   MIN_BYTES=1000000                 mniejszy zrzut = błąd (pusty albo ucięty)
#   MIN_DUMP_SPACE=1073741824         najmniej miejsca (B) na nowy zrzut, gdy
#                                     nie ma poprzedniego albo był mały
#   DISK_RESERVE_PCT=10               część systemu plików, której zrzut nie
#                                     może zająć (zapas dla Postgresa); 0 tylko
#                                     wtedy, gdy BACKUP_DIR leży na osobnym
#                                     wolumenie
#   HC_URL=https://hc-ping.com/<id>   ping Healthchecks (start / sukces / fail);
#                                     bez niego awarię widać tylko w logu
#   RCLONE_REMOTE=boxcrypt:db         kopia poza serwerem; MUSI być zdalnym
#                                     typu `crypt` — niezaszyfrowanego zrzutu
#                                     skrypt nie wyśle
#   REMOTE_RETENTION_DAYS=60          po ilu dniach skrypt usuwa kopie na
#                                     RCLONE_REMOTE (1–60, umowa powierzenia)
#   LOCK_FILE=/var/lock/faktflow-db-backup.lock
#
# Dysk db-1 dzieli zrzuty z danymi Postgresa, a pełny dysk zatrzymuje bazę
# dla wszystkich (BCK-01, DBC-01). Dlatego:
# - przed zrzutem wolne miejsce musi wynosić co najmniej
#   max(2 × ostatni kompletny zrzut, MIN_DUMP_SPACE) + DISK_RESERVE_PCT%
#   systemu plików; inaczej fail, a zrzut się nie zaczyna;
# - przerwany przebieg (błąd, sygnał) od razu usuwa swoje pliki, nie
#   dopiero następnej nocy;
# - wysyłka idzie wprost z BACKUP_DIR, bez drugiej kopii na dysku.
#
# Retencja ma bezpiecznik (jak AUD-07 w snapshotach aplikacji): kasowanie
# rusza tylko po udanym zrzucie i liczy wyłącznie kompletne zrzuty (z plikiem
# .sha256). Seria awarii nie wypycha dobrych kopii. Lokalna retencja idzie
# PRZED wysyłką, więc pełny albo niedostępny Storage Box nie zatrzymuje jej
# i nie zapełnia dysku db-1 (BCK-04).
#
# Kopia poza serwerem idzie przez `rclone copy`, nie `sync` — skasowanie
# zrzutu na db-1 (retencja, włamanie, pomyłka) nie kasuje go na Storage Box.
# Tam po udanym `cryptcheck` skrypt usuwa kopie starsze niż
# REMOTE_RETENTION_DAYS (umowa powierzenia § 9 ust. 2: cykl kopii ≤ 60 dni)
# i alarmuje (/fail), gdy Storage Box jest zajęty w ponad 80%.
# ════════════════════════════════════════════════════════════════

set -Eeuo pipefail

CONFIG=${FAKTFLOW_BACKUP_CONFIG:-/etc/faktflow-backup.env}
# shellcheck source=/dev/null
[ -f "$CONFIG" ] && . "$CONFIG"

: "${PGC:?brak PGC (nazwa kontenera Postgresa) w $CONFIG}"
BACKUP_DIR=${BACKUP_DIR:-/root/backups/daily}
KEEP=${KEEP:-14}
MIN_BYTES=${MIN_BYTES:-1000000}
MIN_DUMP_SPACE=${MIN_DUMP_SPACE:-1073741824}
DISK_RESERVE_PCT=${DISK_RESERVE_PCT:-10}
REMOTE_RETENTION_DAYS=${REMOTE_RETENTION_DAYS:-60}
LOCK_FILE=${LOCK_FILE:-/var/lock/faktflow-db-backup.lock}

log() { echo "$(date -u +%FT%TZ) $*"; }
mb() { echo "$(( $1 / 1048576 )) MB"; }

ping_hc() {
  [ -n "${HC_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HC_URL}$1" || log "uwaga: ping Healthchecks ($1) nieudany"
}

# Ping przed logiem: przy pełnym dysku zapis do logu może się nie udać,
# a alarm musi wyjść.
fail() {
  ping_hc /fail
  log "BŁĄD: $*" >&2 || :
  exit 1
}

# Pliki bieżącego przebiegu, które nie są kompletnym zrzutem. Działa od chwili
# nadania nazwy (już po zdobyciu blokady), więc przebieg odbity od flock nie
# rusza plików trwającego.
cleanup() {
  [ -n "${PART:-}" ] || return 0
  rm -f -- "$PART".*
  # Przeniesiony zrzut bez pliku sum (przerwa między zmianami nazw) nie jest kopią.
  [ -f "$BACKUP_DIR/$NAME.sha256" ] || rm -f -- "$BACKUP_DIR/$NAME.dump" "$BACKUP_DIR/$NAME.roles.sql"
}
trap cleanup EXIT
trap 'fail "przerwane w linii $LINENO"' ERR
trap 'fail "przerwane sygnałem"' INT TERM HUP

# Liczby z konfiguracji; zero wiodące to w bashu liczba ósemkowa.
for v in KEEP MIN_BYTES MIN_DUMP_SPACE DISK_RESERVE_PCT REMOTE_RETENTION_DAYS; do
  [[ ${!v} =~ ^(0|[1-9][0-9]*)$ ]] || fail "$v=${!v} w $CONFIG nie jest liczbą całkowitą ≥ 0"
done
[ "$KEEP" -ge 1 ] || fail "KEEP=$KEEP w $CONFIG — musi zostać co najmniej bieżący zrzut"
[ "$DISK_RESERVE_PCT" -le 90 ] || fail "DISK_RESERVE_PCT=$DISK_RESERVE_PCT w $CONFIG — najwyżej 90"
[ "$REMOTE_RETENTION_DAYS" -ge 1 ] && [ "$REMOTE_RETENTION_DAYS" -le 60 ] \
  || fail "REMOTE_RETENTION_DAYS=$REMOTE_RETENTION_DAYS w $CONFIG — dozwolone 1–60 (umowa powierzenia: cykl kopii ≤ 60 dni)"
[ -n "${HC_URL:-}" ] || log "UWAGA: brak HC_URL w $CONFIG — awarię tej kopii zobaczysz tylko w tym logu"

# Dwa przebiegi naraz (cron + ręczne uruchomienie) pisałyby te same pliki.
exec 9> "$LOCK_FILE"
flock -n 9 || fail "poprzedni przebieg wciąż trwa"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
ping_hc /start

# Pozostałości po przebiegu zabitym bez sprzątania (SIGKILL, OOM, restart
# serwera) nie mogą udawać kopii ani zajmować miejsca. `.outbox` zostawiała
# wersja skryptu sprzed 27.10.2026.
rm -rf "$BACKUP_DIR"/.partial-* "$BACKUP_DIR"/.outbox

NAME="faktflow-$(date -u +%Y%m%dT%H%M%SZ)"
PART="$BACKUP_DIR/.partial-$NAME"
T0=$(date +%s)

# Kompletne zrzuty, od najnowszego (nazwa zawiera czas UTC). Ukośnik na końcu:
# find wchodzi do BACKUP_DIR także wtedy, gdy to dowiązanie do innego wolumenu.
complete_dumps() {
  find "$BACKUP_DIR/" -maxdepth 1 -type f -name 'faktflow-*.sha256' | sort -r
}
file_size() { stat -c %s -- "$1" 2>/dev/null || echo 0; }

# Miejsce przed zrzutem: pg_dump piszący do pełna zatrzymałby Postgresa.
AVAIL=""; FS_SIZE=""
read -r AVAIL FS_SIZE < <(df -B1 --output=avail,size -- "$BACKUP_DIR" 2>/dev/null | tail -n 1) || true
[[ $AVAIL =~ ^[0-9]+$ && $FS_SIZE =~ ^[0-9]+$ ]] \
  || fail "nie odczytałem wolnego miejsca w $BACKUP_DIR (df) — zrzutu nie zaczynam"
mapfile -t COMPLETE < <(complete_dumps)
LAST=0
if [ -n "${COMPLETE[0]:-}" ]; then
  LAST_BASE=${COMPLETE[0]%.sha256}
  LAST=$(( $(file_size "$LAST_BASE.dump") + $(file_size "$LAST_BASE.roles.sql") ))
fi
NEED=$(( 2 * LAST ))
[ "$NEED" -ge "$MIN_DUMP_SPACE" ] || NEED=$MIN_DUMP_SPACE
NEED=$(( NEED + FS_SIZE * DISK_RESERVE_PCT / 100 ))
[ "$AVAIL" -ge "$NEED" ] || fail "za mało miejsca na zrzut w $BACKUP_DIR: wolne $(mb "$AVAIL"), potrzeba $(mb "$NEED") \
(2 × ostatni zrzut $(mb "$LAST"), co najmniej $(mb "$MIN_DUMP_SPACE"), plus ${DISK_RESERVE_PCT}% systemu plików dla Postgresa). \
Zrzutu nie zaczynam. Zwolnij miejsce na dysku albo przenieś BACKUP_DIR na osobny wolumen (wtedy DISK_RESERVE_PCT=0)"
log "miejsce: wolne $(mb "$AVAIL"), potrzeba $(mb "$NEED")"

# Pełna baza (public, auth, storage, pgboss, supabase_migrations, …) w jednej
# transakcji. supabase_admin = superużytkownik obrazu; `postgres` nie widzi
# wszystkich schematów.
docker exec "$PGC" pg_dump -U supabase_admin -d postgres -Fc -Z 6 > "$PART.dump" \
  || fail "pg_dump nieudany (kontener $PGC)"
# Role z hasłami (hashe) — potrzebne, gdy odtwarzamy poza obrazem Supabase.
docker exec "$PGC" pg_dumpall -U supabase_admin --roles-only > "$PART.roles.sql" \
  || fail "pg_dumpall --roles-only nieudany (kontener $PGC)"

SIZE=$(stat -c %s "$PART.dump")
[ "$SIZE" -ge "$MIN_BYTES" ] || fail "zrzut ma ${SIZE} B (< ${MIN_BYTES}) — pusty albo ucięty"
# Spis treści musi dać się przeczytać, inaczej zrzut jest bezużyteczny.
TOC=$(docker exec -i "$PGC" pg_restore -l < "$PART.dump" | grep -c ';') || fail "pg_restore nie czyta zrzutu"
grep -q 'CREATE ROLE' "$PART.roles.sql" || fail "zrzut ról jest pusty"

# Sumy jeszcze na plikach .partial, z docelowymi nazwami w treści (sed zdejmuje
# przedrostek; GNU pisze „hash  plik”, msys „hash *plik”). Twarde zabicie
# (reset, kill -9) w trakcie liczenia zostawia więc tylko .partial-*, które
# sprząta następny przebieg. Potem same zmiany nazw, plik sum na końcu: to on
# oznacza kompletny zrzut (retencja liczy tylko takie), więc ucięty nie powstaje.
(cd "$BACKUP_DIR" && sha256sum ".partial-$NAME.dump" ".partial-$NAME.roles.sql" | sed 's/[.]partial-//') \
  > "$PART.sha256" || fail "nie policzyłem sum kontrolnych zrzutu"
mv "$PART.dump" "$BACKUP_DIR/$NAME.dump"
mv "$PART.roles.sql" "$BACKUP_DIR/$NAME.roles.sql"
mv "$PART.sha256" "$BACKUP_DIR/$NAME.sha256"
log "zrzut $NAME: ${SIZE} B, ${TOC} pozycji spisu, $(( $(date +%s) - T0 )) s"

# Retencja lokalna: tylko kompletne zrzuty, najnowsze najpierw. Bieżący
# zrzut zostaje zawsze, nawet przy przestawionym zegarze.
mapfile -t COMPLETE < <(complete_dumps)
if [ "${#COMPLETE[@]}" -gt "$KEEP" ]; then
  for sha in "${COMPLETE[@]:$KEEP}"; do
    base=${sha%.sha256}
    if [ "${base##*/}" = "$NAME" ]; then continue; fi
    rm -f -- "$base.dump" "$base.roles.sql" "$sha"
    log "retencja: usunięto $(basename "$base")"
  done
fi

if [ -n "${RCLONE_REMOTE:-}" ]; then
  command -v rclone > /dev/null || fail "RCLONE_REMOTE ustawiony, a rclone nie jest zainstalowany"
  REMOTE_NAME=${RCLONE_REMOTE%%:*}
  rclone config show "$REMOTE_NAME" 2>/dev/null | grep -q '^type = crypt' \
    || fail "zdalny '$REMOTE_NAME' nie jest typu crypt — niezaszyfrowanego zrzutu nie wysyłam"
  # Wprost z BACKUP_DIR, tylko pliki tego zrzutu: bez drugiej kopii na dysku.
  # --immutable nie nadpisze kopii, która już tam jest.
  rclone copy --immutable --retries 3 --include "/$NAME.*" "$BACKUP_DIR" "$RCLONE_REMOTE/$NAME" \
    || fail "wysyłka $NAME na $RCLONE_REMOTE nieudana — lokalny zrzut zostaje"
  # Sprawdzenie po stronie Storage Box: odszyfrowane pliki mają te same sumy.
  rclone cryptcheck --one-way --include "/$NAME.*" "$BACKUP_DIR" "$RCLONE_REMOTE/$NAME" \
    || fail "kopia na $RCLONE_REMOTE nie zgadza się z lokalną"
  log "kopia poza serwerem: $RCLONE_REMOTE/$NAME"

  # Retencja zdalna dopiero teraz: najnowsza kopia na pewno tam jest. Tylko
  # katalogi zrzutów (faktflow-*), nic innego na tym zdalnym.
  rclone delete --min-age "${REMOTE_RETENTION_DAYS}d" --include '/faktflow-*/faktflow-*' "$RCLONE_REMOTE" \
    || fail "retencja na $RCLONE_REMOTE nieudana (rclone delete) — dzisiejsza kopia jest wysłana i sprawdzona"
  rclone rmdirs --leave-root "$RCLONE_REMOTE" \
    || fail "retencja na $RCLONE_REMOTE nieudana (rclone rmdirs) — dzisiejsza kopia jest wysłana i sprawdzona"

  # Zajętość Storage Boxa: pełny przestanie przyjmować kopie.
  ABOUT=$(rclone about --json "$RCLONE_REMOTE" 2>/dev/null) || ABOUT=""
  ABOUT=${ABOUT//[[:space:]]/}
  RE_TOTAL='"total":([0-9]+)'
  RE_USED='"used":([0-9]+)'
  TOTAL=""; USED=""
  if [[ $ABOUT =~ $RE_TOTAL ]]; then TOTAL=${BASH_REMATCH[1]}; fi
  if [[ $ABOUT =~ $RE_USED ]]; then USED=${BASH_REMATCH[1]}; fi
  if [ -n "$TOTAL" ] && [ -n "$USED" ] && [ "$TOTAL" -gt 0 ]; then
    PERMILLE=$(( USED * 1000 / TOTAL ))
    PCT="$(( PERMILLE / 10 )),$(( PERMILLE % 10 ))%"
    log "Storage Box: zajęte $PCT ($(mb "$USED") z $(mb "$TOTAL"))"
    [ $(( USED * 100 )) -le $(( TOTAL * 80 )) ] || fail "Storage Box ($RCLONE_REMOTE) zajęty w $PCT (> 80%). \
Dzisiejsza kopia jest wysłana i sprawdzona, ale wkrótce wysyłka zacznie padać: \
sprawdź snapshoty i stare katalogi albo powiększ Storage Box"
  else
    log "UWAGA: rclone about nie podał zajętości $RCLONE_REMOTE — sprawdź ją ręcznie (rclone about $RCLONE_REMOTE)"
  fi
fi

ping_hc ""
log "OK"
