#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Synchronizacja historii KSeF (00155, decyzja Bartosza 22.10.2026) —
# ścieżka operatora. Runbook: docs/runbooks/synchronizacja-historii-ksef.md
# ────────────────────────────────────────────────────────────────
# Jedna linia z katalogu repo (skrypt sam ładuje `.agents/infra.env`):
#
#   ./scripts/ops/ksef-historia.sh stan
#       strumienie wg fazy, problemu i błędu; pozycje wg statusu i powodu;
#       firmy zweryfikowane bez strumieni; top 10 wg kolejki pobrań; firmy
#       wstrzymane przez klienta; dawne importy bez środowiska; `df -h` na db-1;
#       sprzedaż pominięta jako obecna, a poza księgami, z listą firm (ZAP-01);
#       firmy z najwięcej szkicami blokującymi oryginał (`number_conflict`)
#   ./scripts/ops/ksef-historia.sh stare-importy
#       przed wdrożeniem: dawne zadania Magicznego importu w toku (musi być 0)
#   ./scripts/ops/ksef-historia.sh pozycje <id-firmy> [status] [powód]
#       pozycje dziennika firmy ze szczegółem dla operatora (`detail`)
#   ./scripts/ops/ksef-historia.sh odblokuj <id-firmy> <powód> [--tak] [--wymus]
#       pozycje z tym powodem → `pending` (próby 0); `currency_not_supported`
#       tylko z `--wymus`; `retired_draft` — tylko po decyzji Bartosza
#   ./scripts/ops/ksef-historia.sh wznow <id-firmy> [--tak]
#       zdejmuje pauzę po 429, dzierżawę, błąd firmy i problemy kursorów
#   ./scripts/ops/ksef-historia.sh wstrzymaj-wszystko <godziny> [--tak]
#       awaryjne zatrzymanie historii wszystkich firm bez wdrożenia
#
# Każda zmiana najpierw POKAZUJE, ilu wierszy dotknie, a wykonuje się tylko
# z `--tak` — w jednej transakcji, z wpisem w `audit_logs`. Bez `--tak` nic
# się nie zmienia. Środowisko KSeF bierzemy z workera (KSEF_ENV) — zmiany
# dotyczą tylko strumieni tego środowiska. Wysyłki i skrzynki nie dotyka.
# ════════════════════════════════════════════════════════════════

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
for v in K APP DB PGC WORKER_PREFIX; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
STATUSES='pending imported skipped deferred blocked'
REASONS='repair_content ksef_not_ready jpk_note repaired own_invoice already_present retired_draft duplicate_decision own_send_pending currency_not_supported parse_failed number_conflict number_taken_local file_import_mismatch local_conflict own_send_unresolved save_failed repair_failed download_failed archive_conflict metadata_mismatch'
UNBLOCKABLE='retired_draft duplicate_decision own_send_pending currency_not_supported parse_failed number_conflict number_taken_local file_import_mismatch local_conflict own_send_unresolved save_failed repair_failed download_failed archive_conflict metadata_mismatch'

usage() {
  sed -n '6,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

in_list() {
  local needle=$1 list=$2 item
  for item in $list; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

section() { printf '\n=== %s\n' "$1"; }

# SELECT przez psql w kontenerze Postgresa (tylko odczyt). SQL bez cudzysłowów,
# backticków i znaku dolara — przechodzi przez dwie powłoki.
sql() {
  local label=$1 query=$2
  printf -- '--- %s\n' "$label"
  "${SSH[@]}" "root@$DB" \
    "docker exec $PGC psql -U postgres -d postgres -At -F' | ' -v ON_ERROR_STOP=1 -c \"$query\"" \
    || echo "  (zapytanie nieudane — brak tabeli/kolumny albo brak dostępu)"
}

worker_env() {
  local env
  env=$("${SSH[@]}" "root@$APP" \
    "W=\$(docker ps --format '{{.Names}}' | grep '^$WORKER_PREFIX' | head -1); \
     [ -n \"\$W\" ] && docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$W\" | sed -n 's/^KSEF_ENV=//p'" || true)
  if ! [[ "$env" =~ ^(test|demo|production)$ ]]; then
    echo "Nie udało się ustalić KSEF_ENV workera (odczytano: '${env:-brak}'). Przerywam." >&2
    exit 1
  fi
  echo "$env"
}

# Plik SQL (z `\if :tak`) wykonany w kontenerze z bezpiecznymi zmiennymi psql
# (`:'zmienna'` cytuje wartość — bez wstrzyknięć).
run_sql_file() {
  local name=$1 file=$2; shift 2
  local remote="/tmp/ksef-historia-$name-$$.sql"
  local vars=""
  local kv
  for kv in "$@"; do vars="$vars -v $kv"; done
  scp -q -i "$K" -o ConnectTimeout=15 -o BatchMode=yes "$file" "root@$DB:$remote"
  "${SSH[@]}" "root@$DB" \
    "docker cp $remote $PGC:$remote && \
     docker exec $PGC psql -U postgres -d postgres -X -q $vars -f $remote; \
     rc=\$?; rm -f $remote; docker exec $PGC rm -f $remote; exit \$rc"
}

CMD=${1:-}
[ -z "$CMD" ] && usage
shift || true

case "$CMD" in
  stan)
    section "1. strumienie wg środowiska, kierunku i fazy"
    sql "faza (waiting=brak wiersza — patrz pkt 3)" \
      "SELECT environment, direction, CASE WHEN backfill_issue = 'capacity' THEN 'limit' WHEN backfill_completed_at IS NULL THEN 'searching' ELSE 'zaleglosc zakonczona' END AS faza, count(*) FROM ksef_history_sync GROUP BY 1,2,3 ORDER BY 1,2,3"
    sql "problemy kursorów i błędy firm" \
      "SELECT environment, direction, coalesce(backfill_issue,'-') AS zaleglosc, coalesce(live_issue,'-') AS biezace, coalesce(last_error_code,'-') AS blad, count(*) FROM ksef_history_sync GROUP BY 1,2,3,4,5 HAVING backfill_issue IS NOT NULL OR live_issue IS NOT NULL OR last_error_code IS NOT NULL ORDER BY 6 DESC"
    sql "pauza po 429 / dzierżawa / bez sukcesu > 6 h" \
      "SELECT environment, count(*) FILTER (WHERE paused_until > now()) AS pauza_429, count(*) FILTER (WHERE rate_limited_at > now() - interval '1 hour') AS z_429_w_godzinie, count(*) FILTER (WHERE lease_until > now()) AS dzierzawa, count(*) FILTER (WHERE coalesce(last_success_at, created_at) < now() - interval '6 hours') AS bez_sukcesu_6h FROM ksef_history_sync WHERE direction = 'outgoing' GROUP BY 1"
    section "2. dziennik wg statusu i powodu"
    sql "pozycje" \
      "SELECT environment, direction, status, coalesce(reason_code,'-') AS powod, count(*) FROM ksef_history_items GROUP BY 1,2,3,4 ORDER BY 1,2,3,5 DESC"
    section "3. firmy zweryfikowane bez strumieni (alarm stale_ksef_history_sync)"
    sql "bez strumienia sprzedaży / zakupów" \
      "SELECT t.ksef_verified_environment AS env, count(*) FILTER (WHERE o.id IS NULL) AS bez_sprzedazy, count(*) FILTER (WHERE o.id IS NOT NULL AND i.id IS NULL) AS bez_zakupow FROM tenants t LEFT JOIN ksef_history_sync o ON o.tenant_id = t.id AND o.environment = t.ksef_verified_environment AND o.direction = 'outgoing' LEFT JOIN ksef_history_sync i ON i.tenant_id = t.id AND i.environment = t.ksef_verified_environment AND i.direction = 'incoming' WHERE t.ksef_credentials_encrypted IS NOT NULL AND t.ksef_verified_at IS NOT NULL AND t.deleted_at IS NULL AND t.is_active GROUP BY 1"
    section "4. top 10 firm wg kolejki pobrań"
    sql "pending na firmę" \
      "SELECT tenant_id, environment, count(*) AS pending FROM ksef_history_items WHERE status = 'pending' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10"
    section "5. firmy wstrzymane przez klienta"
    sql "pauza klienta" \
      "SELECT tenant_id, environment, client_paused_at FROM ksef_history_sync WHERE client_paused_at IS NOT NULL ORDER BY client_paused_at DESC LIMIT 50"
    section "6. dawne importy z KSeF bez środowiska (bez naprawy — do uzgodnienia)"
    sql "origin=ksef_import, ksef_environment NULL" \
      "SELECT direction, count(*) FROM invoices WHERE origin = 'ksef_import' AND ksef_environment IS NULL GROUP BY 1"
    section "7. db-1: miejsce na dysku"
    "${SSH[@]}" "root@$DB" 'df -h / /var/lib/docker 2>/dev/null | sort -u' || echo "  (nie udało się odczytać df)"
    sql "rozmiar tabel historii" \
      "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables WHERE relname IN ('ksef_history_items','ksef_history_sync','invoices','invoice_line_items') ORDER BY 1"
    section "8. ZAP-01: sprzedaż pominięta jako obecna, a poza księgami (sprzed poprawki — otwarcie to decyzja Bartosza)"
    sql "already_present bez posiadacza w księgach (usuniety = szkic usunięty po pominięciu)" \
      "SELECT h.environment, coalesce(i.origin,'usuniety') AS posiadacz, coalesce(i.ksef_status,'-') AS status, count(*) FROM ksef_history_items h LEFT JOIN invoices i ON i.id = h.invoice_id WHERE h.direction = 'outgoing' AND h.status = 'skipped' AND h.reason_code = 'already_present' AND (i.id IS NULL OR i.ksef_status IS DISTINCT FROM 'accepted' OR (i.ksef_environment IS DISTINCT FROM h.environment AND NOT (i.ksef_environment IS NULL AND i.origin = 'ksef_import'))) GROUP BY 1,2,3 ORDER BY 4 DESC"
    sql "te same pozycje wg firmy (najwięcej pierwsze, do 100 firm)" \
      "SELECT h.tenant_id, h.environment, count(*) AS pozycje, count(*) FILTER (WHERE i.id IS NULL) AS szkic_usuniety FROM ksef_history_items h LEFT JOIN invoices i ON i.id = h.invoice_id WHERE h.direction = 'outgoing' AND h.status = 'skipped' AND h.reason_code = 'already_present' AND (i.id IS NULL OR i.ksef_status IS DISTINCT FROM 'accepted' OR (i.ksef_environment IS DISTINCT FROM h.environment AND NOT (i.ksef_environment IS NULL AND i.origin = 'ksef_import'))) GROUP BY 1,2 ORDER BY 3 DESC LIMIT 100"
    section "9. szkice blokujące oryginał z KSeF (number_conflict) — przy wielu: kontakt z klientem"
    sql "firmy wg liczby blokad (szkic_usuniety = czeka na sprawdzenie, 50 pozycji na przebieg; najstarsza = odkryta najdawniej)" \
      "SELECT tenant_id, environment, count(*) AS blokady, count(*) FILTER (WHERE invoice_id IS NULL) AS szkic_usuniety, min(discovered_at) AS najstarsza FROM ksef_history_items WHERE direction = 'outgoing' AND status = 'blocked' AND reason_code = 'number_conflict' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20"
    ;;

  stare-importy)
    section "Magiczny import — zadania w toku (przed wdrożeniem oba = 0)"
    sql "import_jobs ksef_history w toku" \
      "SELECT count(*) FROM import_jobs WHERE source = 'ksef_history' AND status NOT IN ('completed','failed')"
    sql "pgboss: import.ksef-history.requested (created/retry/active)" \
      "SELECT count(*) FROM pgboss.job WHERE name = 'import.ksef-history.requested' AND state IN ('created','retry','active')"
    ;;

  pozycje)
    TENANT=${1:-}
    STATUS=${2:-}
    REASON=${3:-}
    [[ "$TENANT" =~ $UUID_RE ]] || { echo "Podaj id firmy (UUID małymi literami)." >&2; exit 1; }
    if [ -n "$STATUS" ] && ! in_list "$STATUS" "$STATUSES"; then echo "Status spoza listy: $STATUSES" >&2; exit 1; fi
    if [ -n "$REASON" ] && ! in_list "$REASON" "$REASONS"; then echo "Powód spoza listy: $REASONS" >&2; exit 1; fi
    FILTER="tenant_id = '$TENANT'"
    [ -n "$STATUS" ] && FILTER="$FILTER AND status = '$STATUS'"
    [ -n "$REASON" ] && FILTER="$FILTER AND reason_code = '$REASON'"
    sql "pozycje firmy (najnowsze 100)" \
      "SELECT environment, direction, ksef_number, invoice_number, issue_date, status, coalesce(reason_code,'-'), attempts, next_attempt_at, invoice_id, left(coalesce(detail,''), 160), updated_at FROM ksef_history_items WHERE $FILTER ORDER BY updated_at DESC LIMIT 100"
    sql "strumienie firmy" \
      "SELECT environment, direction, backfill_cursor, backfill_window_end, backfill_page_offset, backfill_completed_at, coalesce(backfill_issue,'-'), live_hwm, coalesce(live_issue,'-'), paused_until, coalesce(last_error_code,'-'), left(coalesce(last_error_detail,''), 120), last_success_at FROM ksef_history_sync WHERE tenant_id = '$TENANT' ORDER BY 1,2"
    ;;

  odblokuj)
    TENANT=${1:-}
    REASON=${2:-}
    shift 2 || true
    TAK=0; WYMUS=0
    for flag in "$@"; do
      case "$flag" in
        --tak) TAK=1 ;;
        --wymus) WYMUS=1 ;;
        *) echo "Nieznana opcja $flag (dozwolone: --tak, --wymus)." >&2; exit 1 ;;
      esac
    done
    [[ "$TENANT" =~ $UUID_RE ]] || { echo "Podaj id firmy (UUID małymi literami)." >&2; exit 1; }
    in_list "$REASON" "$UNBLOCKABLE" || { echo "Powód spoza listy: $UNBLOCKABLE" >&2; exit 1; }
    if [ "$REASON" = "currency_not_supported" ] && [ "$WYMUS" != 1 ]; then
      echo "currency_not_supported: FaktWay nie przenosi faktur walutowych — odblokuj dopiero, gdy jest obsługa walut (--wymus)." >&2
      exit 1
    fi
    ENV=$(worker_env)
    echo "Firma: $TENANT · powód: $REASON · KSEF_ENV workera: $ENV · tryb: $([ $TAK = 1 ] && echo ZAPIS || echo 'tylko podgląd')"
    SQL_FILE=$(mktemp); trap 'rm -f "$SQL_FILE"' EXIT
    cat > "$SQL_FILE" <<'SQL'
\set ON_ERROR_STOP on
\pset footer off
SELECT count(*) AS do_odblokowania FROM public.ksef_history_items
 WHERE tenant_id = :'tenant' AND environment = :'env' AND reason_code = :'reason'
   AND status IN ('blocked', 'skipped', 'deferred');
\if :tak
BEGIN;
WITH zmiana AS (
  UPDATE public.ksef_history_items
     SET status = 'pending',
         -- Naprawa treści zostaje naprawą (z powiązaniem); reszta — świeże pobranie.
         reason_code = CASE WHEN :'reason' = 'repair_failed' THEN 'repair_content' ELSE NULL END,
         invoice_id = CASE WHEN :'reason' = 'repair_failed' THEN invoice_id ELSE NULL END,
         attempts = 0, next_attempt_at = NULL, first_deferred_at = NULL, resolved_at = NULL, detail = NULL
   WHERE tenant_id = :'tenant' AND environment = :'env' AND reason_code = :'reason'
     AND status IN ('blocked', 'skipped', 'deferred')
  RETURNING id
), audyt AS (
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  SELECT :'tenant'::uuid, NULL, 'ksef.history.operator', 'ksef_history', NULL,
         jsonb_build_object('command', 'odblokuj', 'reason', :'reason', 'environment', :'env',
                            'rows', (SELECT count(*) FROM zmiana), 'source', 'scripts/ops/ksef-historia.sh')
  RETURNING id
)
SELECT (SELECT count(*) FROM zmiana) AS odblokowano;
COMMIT;
\echo 'Odblokowane pozycje pobierze najbliższy przebieg (do 15 min).'
\else
\echo 'Podgląd — nic nie zmieniono. Dodaj --tak, żeby wykonać.'
\endif
SQL
    run_sql_file odblokuj "$SQL_FILE" "tenant=$TENANT" "env=$ENV" "reason=$REASON" "tak=$TAK"
    ;;

  wznow)
    TENANT=${1:-}
    TAK=0
    [ "${2:-}" = "--tak" ] && TAK=1
    [ -n "${2:-}" ] && [ "${2:-}" != "--tak" ] && { echo "Nieznana opcja ${2:-} (jedyna: --tak)." >&2; exit 1; }
    [[ "$TENANT" =~ $UUID_RE ]] || { echo "Podaj id firmy (UUID małymi literami)." >&2; exit 1; }
    ENV=$(worker_env)
    echo "Firma: $TENANT · KSEF_ENV workera: $ENV · tryb: $([ $TAK = 1 ] && echo ZAPIS || echo 'tylko podgląd')"
    SQL_FILE=$(mktemp); trap 'rm -f "$SQL_FILE"' EXIT
    cat > "$SQL_FILE" <<'SQL'
\set ON_ERROR_STOP on
\pset footer off
SELECT direction, paused_until, lease_until, last_error_code, backfill_issue, live_issue, rate_limit_hits
  FROM public.ksef_history_sync WHERE tenant_id = :'tenant' AND environment = :'env' ORDER BY direction;
\if :tak
BEGIN;
-- Stan firmy żyje tylko na wierszu sprzedaży (CHECK 00155).
UPDATE public.ksef_history_sync
   SET paused_until = NULL, lease_until = NULL, last_error_code = NULL, last_error_detail = NULL,
       last_error_at = NULL, rate_limit_hits = 0, consecutive_failures = 0
 WHERE tenant_id = :'tenant' AND environment = :'env' AND direction = 'outgoing';
UPDATE public.ksef_history_sync
   SET backfill_issue = NULL, backfill_issue_at = NULL, live_issue = NULL, live_issue_at = NULL
 WHERE tenant_id = :'tenant' AND environment = :'env';
INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
VALUES (:'tenant'::uuid, NULL, 'ksef.history.operator', 'ksef_history', NULL,
        jsonb_build_object('command', 'wznow', 'environment', :'env', 'source', 'scripts/ops/ksef-historia.sh'));
COMMIT;
\echo 'Wznowione — najbliższy cron (do 15 min) zleci przebieg; pobieranie idzie od zapisanego miejsca.'
\else
\echo 'Podgląd — nic nie zmieniono. Dodaj --tak, żeby wykonać.'
\endif
SQL
    run_sql_file wznow "$SQL_FILE" "tenant=$TENANT" "env=$ENV" "tak=$TAK"
    ;;

  wstrzymaj-wszystko)
    HOURS=${1:-}
    TAK=0
    [ "${2:-}" = "--tak" ] && TAK=1
    [ -n "${2:-}" ] && [ "${2:-}" != "--tak" ] && { echo "Nieznana opcja ${2:-} (jedyna: --tak)." >&2; exit 1; }
    if ! [[ "$HOURS" =~ ^[0-9]{1,3}$ ]] || [ "$HOURS" -lt 1 ] || [ "$HOURS" -gt 168 ]; then
      echo "Podaj liczbę godzin 1–168, np. ./scripts/ops/ksef-historia.sh wstrzymaj-wszystko 6 --tak" >&2
      exit 1
    fi
    ENV=$(worker_env)
    echo "Wszystkie firmy · $HOURS h · KSEF_ENV workera: $ENV · tryb: $([ $TAK = 1 ] && echo ZAPIS || echo 'tylko podgląd')"
    SQL_FILE=$(mktemp); trap 'rm -f "$SQL_FILE"' EXIT
    cat > "$SQL_FILE" <<'SQL'
\set ON_ERROR_STOP on
\pset footer off
SELECT count(*) AS strumieni_sprzedazy FROM public.ksef_history_sync
 WHERE environment = :'env' AND direction = 'outgoing';
\if :tak
BEGIN;
-- Pauza firmy (jak po 429): cron nie zleca, dzierżawa nie przejdzie. Na
-- ekranie klient widzi „KSeF ograniczył tempo pobierania. Wznowimy…”.
UPDATE public.ksef_history_sync
   SET paused_until = greatest(coalesce(paused_until, now()), now() + make_interval(hours => :'hours'::int))
 WHERE environment = :'env' AND direction = 'outgoing';
INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
VALUES (NULL, NULL, 'ksef.history.operator', 'ksef_history', NULL,
        jsonb_build_object('command', 'wstrzymaj-wszystko', 'hours', :'hours'::int, 'environment', :'env',
                           'source', 'scripts/ops/ksef-historia.sh'));
COMMIT;
\echo 'Wstrzymane. Wysyłka faktur i Skrzynka KSeF działają bez zmian. Wcześniejsze wznowienie: wznow <id-firmy> --tak.'
\else
\echo 'Podgląd — nic nie zmieniono. Dodaj --tak, żeby wykonać.'
\endif
SQL
    run_sql_file wstrzymaj "$SQL_FILE" "env=$ENV" "hours=$HOURS" "tak=$TAK"
    ;;

  *)
    usage
    ;;
esac
