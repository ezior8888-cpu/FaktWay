#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Faktura zapisana z KSeF decyzją klienta bez daty nadania numeru (I3K
# „no_date”; alarm Sentry `ksef-duplicate-import-no-date`): uzupełnienie
# `ksef_accepted_at` datą z Aplikacji Podatnika KSeF (D-A4-1b-3 PR C, 00156).
# Runbook: docs/runbooks/ksef-error-codes.md, „Brak daty nadania”.
#
#   ./scripts/ops/oryginal-ksef-data-nadania.sh <id-faktury-K> <czas z KSeF>             tylko sprawdza
#   ./scripts/ops/oryginal-ksef-data-nadania.sh <id-faktury-K> <czas z KSeF> --wykonaj   zapis
#
# <czas z KSeF> to pełny czas ISO 8601 ze strefą, np. 2026-10-08T12:34:56Z albo
# 2026-10-08T14:34:56+02:00. <id-faktury-K> to faktura ZAPISANA Z KSeF (K, nie
# wycofany dokument): w alarmie Sentry to `importedInvoiceId`, w sekcji 10
# `kontrola-faktur-ksef.sh` (l) pierwsza kolumna albo (m) `faktura_k`.
#
# Cała logika i warunki są w oryginal-ksef-data-nadania.sql obok (test na bazie:
# tests/rls-oryginal-data-nadania.test.ts). Zapis dzieje się tylko wtedy, gdy
# faktura jest przyjęta, powstała z decyzji przy 440 (to K, którą pokazuje
# I3K), nie ma jeszcze daty, a czas jest poprawny i nie z przyszłości; w jednej
# transakcji, z jednym wpisem audit_logs (`invoice.ksef_accepted_at_backfilled`),
# dokładnie jeden wiersz albo ROLLBACK. Ten plik tylko ładuje .agents/infra.env,
# sprawdza argumenty i uruchamia SQL w kontenerze Postgresa.
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
  echo "Nie znalazłem .agents/infra.env (plik jest poza gitem, patrz AGENTS.md, sekcja Infrastruktura)." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
for v in K DB PGC; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

INVOICE_ID=${1:-}
ISO=${2:-}
MODE=${3:-}
USAGE="Użycie: ./scripts/ops/oryginal-ksef-data-nadania.sh <id-faktury-K> <czas z KSeF, np. 2026-10-08T12:34:56Z> [--wykonaj]"
if ! [[ "$INVOICE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Podaj id faktury K (UUID małymi literami)." >&2
  echo "$USAGE" >&2
  exit 1
fi
# Pełny czas ISO 8601 ze strefą (Z albo +hh:mm). Tylko znaki tego wzorca trafiają dalej do powłoki zdalnej.
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
if ! [[ "$ISO" =~ $ISO_RE ]]; then
  echo "Podaj czas z KSeF jako pełny czas ISO 8601 ze strefą, np. 2026-10-08T12:34:56Z albo 2026-10-08T14:34:56+02:00." >&2
  echo "$USAGE" >&2
  exit 1
fi
if [ -n "$MODE" ] && [ "$MODE" != "--wykonaj" ]; then
  echo "Nieznana opcja $MODE (jedyna: --wykonaj)." >&2
  exit 1
fi
WYKONAJ=0
[ "$MODE" = "--wykonaj" ] && WYKONAJ=1

REMOTE=/tmp/oryginal-ksef-data-nadania.sql
echo "Faktura K: $INVOICE_ID · czas z KSeF: $ISO · tryb: $([ $WYKONAJ = 1 ] && echo 'ZAPIS' || echo 'tylko sprawdzenie')"

# Checkout z Windowsa ma CRLF, a wtedy psql nie rozpozna „\if :wykonaj\r”. Wysyłamy kopię z LF.
SQL_FILE=$(mktemp)
trap 'rm -f "$SQL_FILE"' EXIT
tr -d '\r' < "$ROOT/scripts/ops/oryginal-ksef-data-nadania.sql" > "$SQL_FILE"

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)
scp -q -i "$K" -o ConnectTimeout=15 -o BatchMode=yes "$SQL_FILE" "root@$DB:$REMOTE"
"${SSH[@]}" "root@$DB" \
  "docker cp $REMOTE $PGC:$REMOTE && \
   docker exec $PGC psql -U postgres -d postgres -X -q \
     -v id=$INVOICE_ID -v iso=$ISO -v wykonaj=$WYKONAJ \
     -f $REMOTE; \
   rc=\$?; rm -f $REMOTE; docker exec $PGC rm -f $REMOTE; exit \$rc"
