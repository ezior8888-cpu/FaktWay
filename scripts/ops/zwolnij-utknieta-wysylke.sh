#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Faktura utknęła w wysyłce (I2: „sending” ponad 30 min; I1: „queued” ponad
# 15 min bez zlecenia) — wyjście operatora (A5).
# Runbook: docs/runbooks/hamulce-ksef.md, „Faktura utknęła w wysyłce (I1/I2)”.
#
#   ./scripts/ops/zwolnij-utknieta-wysylke.sh <id-faktury>             — tylko sprawdza (nic nie zmienia)
#   ./scripts/ops/zwolnij-utknieta-wysylke.sh <id-faktury> --wykonaj   — zwolnienie w jednej transakcji
#
# Cała logika i warunki są w zwolnij-utknieta-wysylke.sql obok (test na bazie:
# tests/rls-zwolnij-utknieta-wysylke.test.ts). Ten plik tylko ładuje
# .agents/infra.env, sprawdza argumenty i uruchamia SQL w kontenerze Postgresa.
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
for v in K DB PGC; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

INVOICE_ID=${1:-}
MODE=${2:-}
if ! [[ "$INVOICE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Podaj id faktury (UUID małymi literami), np. ./scripts/ops/zwolnij-utknieta-wysylke.sh 0b6f…-…" >&2
  exit 1
fi
if [ -n "$MODE" ] && [ "$MODE" != "--wykonaj" ]; then
  echo "Nieznana opcja $MODE (jedyna: --wykonaj)." >&2
  exit 1
fi
WYKONAJ=0
[ "$MODE" = "--wykonaj" ] && WYKONAJ=1

REMOTE=/tmp/zwolnij-utknieta-wysylke.sql
echo "Faktura: $INVOICE_ID · tryb: $([ $WYKONAJ = 1 ] && echo 'ZAPIS' || echo 'tylko sprawdzenie')"

# Checkout z Windowsa ma CRLF — psql nie rozpozna wtedy „\if :wykonaj\r”. Wysyłamy kopię z LF.
SQL_FILE=$(mktemp)
trap 'rm -f "$SQL_FILE"' EXIT
tr -d '\r' < "$ROOT/scripts/ops/zwolnij-utknieta-wysylke.sql" > "$SQL_FILE"

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)
scp -q -i "$K" -o ConnectTimeout=15 -o BatchMode=yes "$SQL_FILE" "root@$DB:$REMOTE"
"${SSH[@]}" "root@$DB" \
  "docker cp $REMOTE $PGC:$REMOTE && \
   docker exec $PGC psql -U postgres -d postgres -X -q \
     -v id=$INVOICE_ID -v wykonaj=$WYKONAJ \
     -f $REMOTE; \
   rc=\$?; rm -f $REMOTE; docker exec $PGC rm -f $REMOTE; exit \$rc"
