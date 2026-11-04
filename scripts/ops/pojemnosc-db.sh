#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Pojemność produkcji: db-1, app-1, ops-1 — TYLKO ODCZYT
# ────────────────────────────────────────────────────────────────
# Plan skalowania pod 3000 userów, sesja 23 (DBC-10): odczyty z sekcji 5
# planu w jednym przebiegu. Jedna linia, bez argumentów, z katalogu repo:
#
#   ./scripts/ops/pojemnosc-db.sh
#
# Wynik najlepiej zachować poza repo i porównać szczyt (9–11 w dzień
# roboczy) z nocą (02:00):
#
#   ./scripts/ops/pojemnosc-db.sh > ~/pojemnosc-$(date +%F-%H%M).txt 2>&1
#
# `--sprawdz` pokazuje tylko, skąd skrypt czyta konfigurację.
#
# Skrypt sam ładuje `.agents/infra.env` (wymagane K, APP, DB, PGC, RESTC;
# OPS, APP_PREFIX i WORKER_PREFIX opcjonalne) — przycisk „Run” w aplikacji
# uruchamia każdy blok w świeżej powłoce, więc osobne `source` nic nie daje.
#
# Niczego nie zmienia na serwerach. Na hostach czyta: nproc, free, swapon,
# uptime, df, vmstat, docker ps / stats / system df, journalctl
# --disk-usage, /proc (swap wg procesu), cztery klucze
# z /etc/faktflow-backup.env (bez adresu Healthchecks), listę zrzutów,
# wpis crona i koniec dziennika kopii, a z logów app-1 linie
# process.metrics. Z kontenerów PostgREST i GoTrue
# wychodzą wyłącznie wymienione zmienne — filtr grep działa po stronie
# serwera, więc klucze i hasła nie opuszczają db-1. Każde zapytanie do
# Postgresa ma w PGOPTIONS limit 30 s i transakcję tylko do odczytu:
# baza odrzuci każdą próbę zapisu, a ciężkie zapytanie przerwie sama.
#
# Co pokazuje:
#   1. db-1: rdzenie, pamięć, swap (także wg procesu: ile z niego to
#      Postgres), obciążenie, dysk, kradzież CPU (vmstat, kolumna st),
#      kontenery i ich zużycie, miejsce Dockera i dziennika systemowego;
#      kopie bazy: KEEP, RCLONE_REMOTE, liczba i rozmiar zrzutów,
#      pozostałości po przerwanym przebiegu, cron i ostatni przebieg
#   2. app-1: to samo bez kopii, a do tego ostatnie linie process.metrics
#      web i workera oraz liczba ich ostrzeżeń z 24 h
#   3. ops-1 (jeśli jest OPS): dysk, na którym stoi MinIO z plikami
#   4. PostgREST (pula, limit wierszy) i GoTrue (limity żądań, JWT_EXP,
#      częstotliwość maili)
#   5. Postgres: ustawienia pamięci, połączeń i WAL, ustawienia ról
#      i baz, połączenia wg roli, aplikacji i stanu, trafność cache,
#      pliki tymczasowe i licznik transakcji (postgres, _supabase; tx/s
#      z różnicy dwóch przebiegów), rozmiary baz, sloty replikacji
#      z zatrzymanym WAL
#   6. tabele: 25 największych (żywe i martwe wiersze) i 10 największych
#      w _supabase; przyrost audit_logs (wg action) i inngest_run_log
#      (wg event_name), dziennie z 7 dni i z 24 h; czasy przebiegów
#      jobów z 24 h (avg, p95, max)
#   7. pg_stat_statements: 15 zapytań o największym łącznym czasie
#   8. pg-boss: polityka kolejek i zaległości (created, retry, active)
#      z najstarszym zadaniem
#   9. liczby: firmy (aktywne, z danymi KSeF), logowania z 7 i 30 dni,
#      faktury z 30 dni wg kierunku i na firmę
#
# Jak czytać progi: plan skalowania, sekcje 4 i 5. Błąd jednego odczytu
# (brak uprawnień, rozszerzenia, kolumny) nie przerywa reszty.
# ════════════════════════════════════════════════════════════════

# Bez `-e`: nieudany odczyt ma wypisać komunikat i iść dalej.
set -uo pipefail

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
  {
    echo "Nie znalazłem .agents/infra.env (plik jest poza gitem — AGENTS.md → Infrastruktura)."
    echo "Szukałem w: ${FAKTFLOW_INFRA_ENV:-(FAKTFLOW_INFRA_ENV nieustawione)}, $ROOT/.agents/infra.env${MAIN_ROOT:+, $MAIN_ROOT/.agents/infra.env}"
  } >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
for v in K APP DB PGC RESTC; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

if [ "${1:-}" = "--sprawdz" ]; then
  echo "Konfiguracja: $ENV_FILE"
  echo "Klucz SSH: $K ($([ -f "$K" ] && echo 'jest' || echo 'BRAK PLIKU'))"
  echo "Serwery: app=$APP db=$DB ops=${OPS:-(brak — pomijam ops-1)}; kontenery: $PGC, $RESTC"
  exit 0
fi

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)

section() { printf '\n=== %s\n' "$1"; }

# System hosta. Polecenia idą na wejście zdalnego `bash -s` (heredoc
# w apostrofach: lokalnie nic się nie rozwija), każde osobno — błąd jednego
# nie zatrzymuje następnych.
host_system() {
  local host=$1
  "${SSH[@]}" "root@$host" 'bash -s' <<'REMOTE' || echo "  (nie udało się połączyć z $host)"
czytaj() { printf -- '--- %s\n' "$*"; "$@" 2>&1 || echo "  (odczyt nieudany)"; }
czytaj nproc
czytaj free -m
czytaj swapon --show
czytaj uptime
czytaj df -h /
printf -- '--- vmstat 1 5 (kolumna st: procent czasu zabrany przez hiperwizor; stale powyżej 5 to tłok na hoście)\n'
vmstat 1 5 2>&1 || echo "  (odczyt nieudany)"
czytaj docker ps --format 'table {{.Names}}\t{{.Status}}'
czytaj docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'
czytaj docker system df
czytaj journalctl --disk-usage
printf -- '--- swap wg procesu (MB, powyżej 10 MB)\n'
cat /proc/[0-9]*/status 2>/dev/null \
  | awk '/^Name:/ {n = $2} /^VmSwap:/ {s[n] += $2} END {for (k in s) if (s[k] > 10240) printf "%8.0f  %s\n", s[k] / 1024, k}' \
  | sort -rn | head -15
REMOTE
}

# Kopie bazy na db-1 (sesja 22 planu): konfiguracja bez HC_URL i stan katalogu.
db_backups() {
  "${SSH[@]}" "root@$DB" 'bash -s' <<'REMOTE' || echo "  (nie udało się połączyć z db-1)"
CFG=/etc/faktflow-backup.env
printf -- '--- %s: KEEP, RCLONE_REMOTE, BACKUP_DIR, MIN_BYTES\n' "$CFG"
grep -E '^(KEEP|RCLONE_REMOTE|BACKUP_DIR|MIN_BYTES)=' "$CFG" 2>/dev/null \
  || echo "  (brak pliku albo kluczy — db-backup.sh bierze wtedy KEEP=14, BACKUP_DIR=/root/backups/daily)"
DIR=$(grep -E '^BACKUP_DIR=' "$CFG" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'")
DIR=${DIR:-/root/backups/daily}
printf -- '--- zrzuty w %s\n' "$DIR"
if [ -d "$DIR" ]; then
  echo "  kompletne (z plikiem .sha256): $(find "$DIR" -maxdepth 1 -name 'faktflow-*.sha256' | wc -l)"
  du -sh "$DIR" 2>/dev/null
  ls -lht "$DIR" 2>/dev/null | head -7
  printf -- '--- pozostałości po przerwanym przebiegu (.partial-*, .outbox)\n'
  FOUND=0
  for f in "$DIR"/.partial-* "$DIR"/.outbox; do
    [ -e "$f" ] && { du -sh "$f" 2>/dev/null; FOUND=1; }
  done
  [ "$FOUND" = 1 ] || echo "  (brak)"
else
  echo "  (brak katalogu)"
fi
# Runbook (docs/runbooks/backup-restore.md) kładzie wpis w /etc/cron.d.
printf -- '--- cron kopii i ostatnie wpisy jej dziennika\n'
{ grep -Hsi backup /etc/cron.d/* 2>/dev/null; crontab -l 2>/dev/null | grep -i backup; } | grep . \
  || echo "  (brak wpisu w /etc/cron.d ani w crontabie roota)"
tail -3 /var/log/faktflow-db-backup.log 2>/dev/null || echo "  (brak /var/log/faktflow-db-backup.log)"
REMOTE
}

# SELECT przez psql w kontenerze Postgresa. Każde wywołanie z PGOPTIONS:
# limit 30 s i transakcja tylko do odczytu. SQL bez cudzysłowów,
# backticków, znaku dolara i backslashy — przechodzi przez dwie powłoki.
# Trzeci argument: baza (domyślnie postgres).
sql() {
  local label=$1 query=$2 db=${3:-postgres}
  printf -- '--- %s\n' "$label"
  "${SSH[@]}" "root@$DB" "docker exec -e 'PGOPTIONS=-c statement_timeout=30s -c default_transaction_read_only=on' $PGC psql -X -U postgres -d $db -A -F' | ' -P footer=off -v ON_ERROR_STOP=1 -c \"$query\"" \
    || echo "  (zapytanie nieudane — brak tabeli, kolumny, rozszerzenia albo uprawnień)"
}

section "1. db-1: system, kontenery, swap wg procesu"
host_system "$DB"

section "1a. db-1: kopie bazy"
db_backups

section "2. app-1: system, kontenery, swap wg procesu"
host_system "$APP"

section "2a. app-1: ostatnie linie process.metrics (web i worker) i ostrzeżenia z 24 h"
# Co znaczą pola: lib/observability/process-metrics.ts. Próg etapu 2 planu:
# ELU web > 0,6 w szczycie przez 3 dni albo p99 opóźnienia pętli > 100 ms.
if [ -n "${APP_PREFIX:-}" ] && [ -n "${WORKER_PREFIX:-}" ]; then
  "${SSH[@]}" "root@$APP" \
    "for P in $APP_PREFIX $WORKER_PREFIX; do \
       C=\$(docker ps --format '{{.Names}}' | grep \"^\$P\" | head -1); \
       if [ -z \"\$C\" ]; then echo \"--- \$P: brak kontenera\"; continue; fi; \
       echo \"--- \$C: ostatnie 3 linie z 15 min\"; \
       docker logs -t --since 15m \"\$C\" 2>&1 | grep -F '\"msg\":\"process.metrics\"' | tail -3; \
       echo \"  ostrzeżenia process.metrics.warn z 24 h: \$(docker logs --since 24h \"\$C\" 2>&1 | grep -c process.metrics.warn)\"; \
     done" \
    || echo "  (nie udało się odczytać logów)"
else
  echo "  (brak APP_PREFIX albo WORKER_PREFIX w infra.env — pomijam)"
fi

section "3. ops-1: dysk (MinIO z plikami aplikacji)"
if [ -n "${OPS:-}" ]; then
  "${SSH[@]}" "root@$OPS" 'df -h /' || echo "  (nie udało się odczytać dysku ops-1)"
else
  echo "  (brak OPS w infra.env — pomijam)"
fi

section "4. db-1: PostgREST i GoTrue — wybrane zmienne (sekrety zostają na serwerze)"
printf -- '--- PostgREST (%s): pula, czas oczekiwania na połączenie, limit wierszy\n' "$RESTC"
"${SSH[@]}" "root@$DB" \
  "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $RESTC | grep -E '^PGRST_(DB_POOL|DB_POOL_ACQUISITION_TIMEOUT|DB_MAX_ROWS)=' || echo '  (żadna nie jest ustawiona — wartości domyślne PostgREST)'" \
  || echo "  (odczyt nieudany)"
printf -- '--- GoTrue: limity żądań, ważność tokenu, MFA, częstotliwość maili\n'
"${SSH[@]}" "root@$DB" \
  "A=\$(docker ps --format '{{.Names}}' | grep -E 'supabase-auth|gotrue' | head -1); \
   if [ -z \"\$A\" ]; then echo '  (nie znalazłem kontenera GoTrue)'; exit 0; fi; echo \"  kontener: \$A\"; \
   docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$A\" | grep -E '^GOTRUE_(RATE_LIMIT_[A-Z_]+|JWT_EXP|MFA_[A-Z_]*RATE[A-Z_]*|SMTP_MAX_FREQUENCY)=' || echo '  (żadna nie jest ustawiona — wartości domyślne GoTrue)'" \
  || echo "  (odczyt nieudany)"

section "5. db-1: Postgres — ustawienia, połączenia, cache, WAL"
sql "sesja skryptu (oczekiwane: tylko_odczyt = on, limit_czasu = 30s)" \
  "SELECT current_setting('default_transaction_read_only') AS tylko_odczyt, current_setting('statement_timeout') AS limit_czasu, current_user AS rola, version()"
sql "ustawienia (statement_timeout tutaj to limit skryptu; wartość serwera: boot_val, plik i role niżej)" \
  "SELECT name, current_setting(name) AS wartosc, source, boot_val FROM pg_settings WHERE name IN ('shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'max_connections', 'max_wal_size', 'max_slot_wal_keep_size', 'archive_mode', 'statement_timeout', 'shared_preload_libraries') ORDER BY name"
sql "ustawienia z plików konfiguracji" \
  "SELECT name, setting, applied, sourcefile FROM pg_file_settings WHERE name IN ('shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'max_connections', 'max_wal_size', 'max_slot_wal_keep_size', 'archive_mode', 'statement_timeout') ORDER BY name"
sql "ustawienia ról i baz (rolconfig; klucze z secret/key/pass/token/jwt ukryte)" \
  "SELECT coalesce(r.rolname, '(kazda rola)') AS rola, coalesce(d.datname, '(kazda baza)') AS baza, CASE WHEN split_part(c.cfg, '=', 1) ~* 'secret|key|pass|token|jwt' THEN split_part(c.cfg, '=', 1) || '=(ukryte)' ELSE c.cfg END AS ustawienie FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase CROSS JOIN LATERAL unnest(s.setconfig) AS c(cfg) WHERE r.rolname IN ('authenticator', 'authenticated', 'anon', 'service_role', 'supabase_auth_admin', 'postgres') OR s.setrole = 0 ORDER BY 1, 2, 3"
sql "połączenia klientów razem" \
  "SELECT count(*) AS polaczenia, current_setting('max_connections') AS max_connections, count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_transaction FROM pg_stat_activity WHERE backend_type = 'client backend'"
sql "połączenia wg roli, aplikacji i stanu" \
  "SELECT coalesce(usename, '(brak)') AS rola, coalesce(nullif(application_name, ''), '(brak)') AS aplikacja, coalesce(state, '(brak)') AS stan, count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2, 3 ORDER BY 4 DESC"
# Liczniki przeżywają czysty restart Postgresa, więc przy pustym stats_reset
# ich początek jest nieznany i tx/s zostaje puste. Prawdziwe tx/s: różnica
# tx_razem między dwoma przebiegami (szczyt i 02:00) przez sekundy między nimi.
sql "trafność cache, pliki tymczasowe, transakcje (tx_na_s tylko przy znanym stats_reset)" \
  "SELECT datname AS baza, round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_proc, temp_files, pg_size_pretty(temp_bytes) AS temp, xact_commit + xact_rollback AS tx_razem, now() AS teraz, stats_reset, pg_postmaster_start_time() AS start_serwera, CASE WHEN stats_reset IS NOT NULL THEN round((xact_commit + xact_rollback) / greatest(extract(epoch FROM now() - stats_reset), 1)) END AS tx_na_s FROM pg_stat_database WHERE datname IN ('postgres', '_supabase') ORDER BY 1"
sql "rozmiary baz" \
  "SELECT datname AS baza, pg_size_pretty(pg_database_size(datname)) AS rozmiar FROM pg_database WHERE datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY pg_database_size(datname) DESC"
sql "sloty replikacji i zatrzymany WAL" \
  "SELECT slot_name, slot_type, active, wal_status, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS zatrzymany_wal, pg_size_pretty(safe_wal_size) AS zapas_do_limitu FROM pg_replication_slots ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST"
sql "katalog WAL" \
  "SELECT count(*) AS pliki, pg_size_pretty(sum(size)) AS rozmiar FROM pg_ls_waldir()"

section "6. db-1: tabele i przyrost"
sql "25 największych tabel (postgres)" \
  "SELECT schemaname AS schemat, relname AS tabela, pg_size_pretty(pg_total_relation_size(relid)) AS rozmiar, n_live_tup AS zywe, n_dead_tup AS martwe, last_autovacuum FROM pg_stat_all_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY pg_total_relation_size(relid) DESC LIMIT 25"
sql "10 największych tabel (_supabase: logi Logflare)" \
  "SELECT schemaname AS schemat, relname AS tabela, pg_size_pretty(pg_total_relation_size(relid)) AS rozmiar, n_live_tup AS zywe, n_dead_tup AS martwe FROM pg_stat_all_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY pg_total_relation_size(relid) DESC LIMIT 10" \
  _supabase
sql "audit_logs: wiersze dziennie z 7 dni" \
  "SELECT created_at::date AS dzien, count(*) AS wiersze FROM audit_logs WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1"
sql "audit_logs: przyrost z 24 h wg action" \
  "SELECT action, count(*) AS wiersze_24h FROM audit_logs WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 20"
sql "inngest_run_log: wiersze dziennie z 7 dni" \
  "SELECT created_at::date AS dzien, count(*) AS wiersze FROM inngest_run_log WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1"
sql "inngest_run_log: przebiegi i czasy z 24 h wg event_name (kolejki)" \
  "SELECT event_name, count(*) AS przebiegi_24h, count(*) FILTER (WHERE status = 'failed') AS bledy, round(avg(duration_ms)) AS avg_ms, round((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::numeric) AS p95_ms, max(duration_ms) AS max_ms FROM inngest_run_log WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 40"

section "7. db-1: pg_stat_statements — 15 zapytań o największym łącznym czasie"
sql "okno statystyk" \
  "SELECT stats_reset, dealloc FROM extensions.pg_stat_statements_info"
sql "zapytania" \
  "SELECT pg_get_userbyid(userid) AS rola, calls, round(mean_exec_time::numeric, 1) AS mean_ms, round(total_exec_time::numeric) AS total_ms, rows, left(translate(query, chr(10) || chr(13) || chr(9), '   '), 160) AS zapytanie FROM extensions.pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15"

section "8. db-1: pg-boss — polityka kolejek i zaległości"
sql "polityka kolejek (liczniki z monitora pg-boss)" \
  "SELECT name, policy, retry_limit, expire_seconds, queued_count, active_count, failed_count, monitor_on FROM pgboss.queue ORDER BY name"
sql "zaległe zadania (created, retry, active) z najstarszym" \
  "SELECT name, state, count(*) AS zadania, count(*) FILTER (WHERE start_after <= now()) AS gotowe_teraz, min(created_on) AS najstarsze, round(extract(epoch FROM now() - min(created_on)) / 60) AS wiek_min FROM pgboss.job WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 3 DESC"

section "9. db-1: liczby do modelu obciążenia"
sql "firmy" \
  "SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS aktywne, count(*) FILTER (WHERE deleted_at IS NULL AND ksef_credentials_encrypted IS NOT NULL) AS z_danymi_ksef, count(*) AS wszystkie FROM tenants"
sql "konta: ostatnie logowanie (odświeżenie tokenu go nie zmienia)" \
  "SELECT count(*) FILTER (WHERE last_sign_in_at > now() - interval '7 days') AS logowanie_7_dni, count(*) FILTER (WHERE last_sign_in_at > now() - interval '30 days') AS logowanie_30_dni, count(*) AS konta FROM auth.users"
sql "faktury z 30 dni wg kierunku i na firmę" \
  "SELECT direction, count(*) AS faktury_30_dni, count(DISTINCT tenant_id) AS firmy, round(count(*)::numeric / nullif(count(DISTINCT tenant_id), 0), 1) AS na_firme FROM invoices WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1"

printf '\nKoniec odczytu. Progi: plan skalowania, sekcje 4 i 5.\n'
