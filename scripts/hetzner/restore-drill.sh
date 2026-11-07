#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Próba odtworzenia bazy z zrzutu pg_dump (krok 6 planu automatyzacji)
# ────────────────────────────────────────────────────────────────
# Wgrywa zrzut z db-backup.sh do jednorazowego kontenera z TYM SAMYM obrazem
# co produkcja i porównuje liczby wierszy. Kontener nie ma sieci
# (--network none), więc nic z zewnątrz się do niego nie połączy, a po
# próbie znika razem z danymi.
#
# Uruchamiaj na hoście INNYM niż db-1 (ops-1 albo jednorazowy serwer):
# próba ma pokazać, że kopia przeżyje utratę db-1. Przebieg i wyniki:
# docs/runbooks/backup-restore.md.
#
# Użycie:
#   restore-drill.sh <zrzut.dump> [role.sql] [oczekiwane-liczby.txt]
# Oczekiwane liczby: linie `schemat.tabela|liczba` (zapytanie w runbooku).
#
# Werdykt (ostatnia linia `WYNIK: OK` albo `WYNIK: BŁĄD …`, kod wyjścia 0/1):
# błąd, gdy pg_restore zgłosi coś spoza 4 oczekiwanych błędów (runbook § 4),
# plik ról da błąd inny niż „already exists”, tabela ze spisu zrzutu nie
# powstanie, `auth.users` albo `public.tenants` są puste, nie ma polityk RLS
# albo wpisu w `schema_migrations`, a z plikiem liczb: tabela z produkcji
# nie istnieje po odtworzeniu. Różnice liczby wierszy są tylko informacją
# (pgboss i audit_logs rosną same między zrzutem a liczeniem).
# Cotygodniowe uruchomienie z alarmem: restore-drill-tydzien.sh.
#
# Zmienne:
#   IMAGE=supabase/postgres:15.8.1.085   obraz jak na produkcji
#   KEEP_CONTAINER=1                     nie usuwaj kontenera po próbie
#   READY_PAUSE=5                        s czekania po starcie bazy (skrypty init)
# ════════════════════════════════════════════════════════════════

set -Eeuo pipefail

DUMP=${1:?podaj plik zrzutu (.dump)}
ROLES=${2:-}
EXPECTED=${3:-}
IMAGE=${IMAGE:-supabase/postgres:15.8.1.085}
NAME=faktflow-restore-drill
SCHEMAS="'public','auth','storage','pgboss','supabase_migrations','vault'"

log() { echo "$(date -u +%FT%TZ) $*"; }

FAILS=()
check_fail() {
  FAILS+=("$*")
  log "BŁĄD: $*"
}

# Błędy pg_restore, które daje każde wgranie do świeżego obrazu Supabase
# (obiekty, które obraz już ma). Runbook § 4, krok 5.
EXPECTED_RESTORE_ERRORS='schema "storage" already exists|cannot drop schema storage because other objects depend on it|cannot drop constraint users_pkey on table auth\.users|function graphql_public\.graphql\(text, text, jsonb, jsonb\) does not exist'

[ -f "$DUMP" ] || { log "brak pliku $DUMP"; exit 1; }
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  log "kontener $NAME już istnieje — usuń go albo dokończ poprzednią próbę"
  exit 1
fi

cleanup() {
  if [ "${KEEP_CONTAINER:-0}" = "1" ]; then
    log "kontener $NAME zostaje (KEEP_CONTAINER=1) — usuń: docker rm -f $NAME"
  else
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    log "kontener $NAME usunięty"
  fi
}
trap cleanup EXIT

# Świeży obraz wymaga hasła także na lokalnym gnieździe (produkcja: trust).
PW=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
dexec() { docker exec -e PGPASSWORD="$PW" "$@"; }
psql_drill() { dexec -i "$NAME" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=0 "$@"; }

T0=$(date +%s)
log "start kontenera ($IMAGE, bez sieci)"
docker run -d --name "$NAME" --network none --memory 1g --cpus 1 \
  -e POSTGRES_PASSWORD="$PW" \
  "$IMAGE" postgres -c config_file=/etc/postgresql/postgresql.conf \
  -c shared_buffers=64MB -c log_min_messages=fatal > /dev/null

# Inicjalizacja obrazu (role, rozszerzenia, schematy Supabase) trwa chwilę;
# pg_isready mówi „gotowe” jeszcze w trakcie skryptów init, więc czekamy na rolę.
READY=0
for _ in $(seq 1 90); do
  if dexec "$NAME" psql -U supabase_admin -d postgres -Atc \
      "SELECT 1 FROM pg_roles WHERE rolname = 'authenticator'" 2>/dev/null | grep -q 1; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  log "baza w kontenerze nie wstała w 180 s — ostatnie logi:"
  docker logs --tail 20 "$NAME" 2>&1
  exit 1
fi
sleep "${READY_PAUSE:-5}"
T1=$(date +%s)
log "kontener gotowy po $((T1 - T0)) s"

if [ -n "$ROLES" ]; then
  # Role już istnieją w obrazie — błędy CREATE ROLE są oczekiwane; liczą się
  # atrybuty z ALTER ROLE. Hasła pomijamy: produkcyjny hash supabase_admin
  # odciąłby skrypt od kontenera. Przy prawdziwym odtworzeniu hasła zostają
  # (runbook § 4), bo usługi Supabase łączą się z hasłami z produkcji.
  ROLE_OUT=$(sed -E "s/ PASSWORD '[^']*'//" "$ROLES" | psql_drill -q 2>&1 || true)
  ROLE_ERRORS=$(printf '%s\n' "$ROLE_OUT" | grep -ci 'error' || true)
  log "role wgrane bez haseł (błędy: $ROLE_ERRORS)"
  printf '%s\n' "$ROLE_OUT" | grep -i 'error' | sed -E 's/^.*ERROR: +//' | sort | uniq -c | sort -rn | head -10
  ROLE_UNEXPECTED=$(printf '%s\n' "$ROLE_OUT" | grep -i 'error' | grep -vc 'already exists' || true)
  [ "$ROLE_UNEXPECTED" -eq 0 ] || check_fail "plik ról: $ROLE_UNEXPECTED błędów innych niż „already exists”"
fi

docker cp "$DUMP" "$NAME:/tmp/restore.dump"
RESTORE_LOG=$(mktemp)
dexec "$NAME" pg_restore -U supabase_admin -d postgres --clean --if-exists \
  --no-comments /tmp/restore.dump > "$RESTORE_LOG" 2>&1 || true
T2=$(date +%s)
log "pg_restore zakończony po $((T2 - T1)) s"
ERRORS=$(grep -c 'error:' "$RESTORE_LOG" || true)
log "błędy pg_restore: $ERRORS"
if [ "$ERRORS" -gt 0 ]; then
  grep 'error:' "$RESTORE_LOG" | sed -E 's/^pg_restore: error: //' | cut -c1-160 | sort | uniq -c | sort -rn | head -20
fi
UNEXPECTED=$(grep 'error:' "$RESTORE_LOG" | grep -Evc "$EXPECTED_RESTORE_ERRORS" || true)
[ "$UNEXPECTED" -eq 0 ] || check_fail "pg_restore: $UNEXPECTED błędów spoza 4 oczekiwanych (runbook § 4)"
rm -f "$RESTORE_LOG"

# Tabele ze spisu zrzutu (TABLE DATA: schemat nazwa właściciel na końcu linii).
TOC_TABLES=$(mktemp)
SCHEMA_LIST=",$(printf '%s' "$SCHEMAS" | tr -d "'"),"
dexec "$NAME" pg_restore -l /tmp/restore.dump 2>/dev/null \
  | awk -v s="$SCHEMA_LIST" '/ TABLE DATA / && index(s, "," $(NF-2) ",") { print $(NF-2) "." $(NF-1) }' \
  | sort -u > "$TOC_TABLES" || true
[ -s "$TOC_TABLES" ] || check_fail "spis zrzutu bez danych tabel (pg_restore -l)"

COUNTS=$(mktemp)
psql_drill -At -F'|' -c "SELECT table_schema||'.'||table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ($SCHEMAS) ORDER BY 1;" > "$COUNTS"
log "tabele po odtworzeniu: $(wc -l < "$COUNTS" | tr -d ' ')"
MISSING=$(cut -d'|' -f1 "$COUNTS" | sort -u | comm -23 "$TOC_TABLES" - | head -10 || true)
[ -z "$MISSING" ] || check_fail "tabele ze zrzutu nie powstały: $(echo $MISSING)"
rm -f "$TOC_TABLES"
for t in auth.users public.tenants; do
  n=$(awk -F'|' -v t="$t" '$1 == t { print $2 }' "$COUNTS")
  [ "${n:-0}" -gt 0 ] 2>/dev/null || check_fail "$t pusta albo jej brak po odtworzeniu"
done

if [ -n "$EXPECTED" ]; then
  # Porównanie z produkcją z chwili zrzutu. pgboss i audit_logs rosną same,
  # więc różnice tam są informacyjne; reszta musi się zgadzać co do wiersza.
  DIFFS=$(join -t'|' -a1 -a2 -e BRAK -o 0,1.2,2.2 <(sort "$EXPECTED") <(sort "$COUNTS") \
    | awk -F'|' '$2 != $3 { print }' || true)
  if [ -z "$DIFFS" ]; then
    log "liczby wierszy: wszystkie tabele zgodne z produkcją"
  else
    log "różnice (tabela|produkcja|odtworzone):"
    echo "$DIFFS"
  fi
  GONE=$(printf '%s\n' "$DIFFS" | awk -F'|' '$3 == "BRAK" { print $1 }' | head -10 || true)
  [ -z "$GONE" ] || check_fail "tabele z produkcji nie istnieją po odtworzeniu: $(echo $GONE)"
fi
rm -f "$COUNTS"

STRUCT=$(psql_drill -At -F'|' -c "
  SELECT 'polityki RLS', count(*) FROM pg_policies
  UNION ALL SELECT 'tabele public z RLS', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND c.relrowsecurity AND n.nspname = 'public'
  UNION ALL SELECT 'funkcje public', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL SELECT 'wyzwalacze', count(*) FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'indeksy public', count(*) FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL SELECT 'rozszerzenia', count(*) FROM pg_extension
  UNION ALL SELECT 'ostatnia migracja', max(version)::bigint FROM supabase_migrations.schema_migrations;" || true)
echo "$STRUCT"
POLICIES=$(printf '%s\n' "$STRUCT" | awk -F'|' '$1 == "polityki RLS" { print $2 }')
MIGRATION=$(printf '%s\n' "$STRUCT" | awk -F'|' '$1 == "ostatnia migracja" { print $2 }')
[ "${POLICIES:-0}" -gt 0 ] 2>/dev/null || check_fail "brak polityk RLS po odtworzeniu"
[ -n "$MIGRATION" ] || check_fail "brak wpisu w supabase_migrations.schema_migrations"

log "czas całkowity: $(( $(date +%s) - T0 )) s"
if [ "${#FAILS[@]}" -eq 0 ]; then
  log "WYNIK: OK, ${ERRORS} oczekiwanych błędów pg_restore, ostatnia migracja ${MIGRATION}"
else
  log "WYNIK: BŁĄD (${#FAILS[@]}): $(IFS=';'; echo "${FAILS[*]}")"
  exit 1
fi
