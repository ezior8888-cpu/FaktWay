#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Stary dokument specjalny (KOR/ROZ sprzed 00137): dopisanie special_data
# z PIERWSZEGO zlecenia wysyłki tej faktury w pg-boss (A4b PR2a).
# Runbook: docs/runbooks/ksef-error-codes.md, „Stary dokument specjalny”.
#
#   ./scripts/ops/dopisz-dane-specjalne.sh <id-faktury>             — tylko sprawdza (nic nie zmienia)
#   ./scripts/ops/dopisz-dane-specjalne.sh <id-faktury> --wykonaj   — zapis w jednej transakcji
#
# Zapis jest NIEODWRACALNY (00137: special_data zapisuje się raz). Dlatego
# jedno zapytanie sprawdza wszystko naraz i zapisuje tylko, gdy trafia
# DOKŁADNIE jeden wiersz — inaczej ROLLBACK:
#   - faktura KOR albo ROZ, bez special_data;
#   - job `invoice.submit.requested` TEJ faktury (invoiceId), pierwszy w czasie,
#     tej samej firmy (tenantId) i z tego samego środowiska co worker (KSEF_ENV);
#   - treść joba = fa3_data faktury (ta sama wersja dokumentu);
#   - job niesie dane tego rodzaju (correctionData / finalData + wiersze zaliczek).
# Do tego wpis w audit_logs (invoice.special_data_backfilled, id joba).
# ZAL (koperta w fa3_data) — nie tym skryptem: tylko za zgodą Bartosza (runbook).
# pg-boss trzyma joby 7 dni — starszego dokumentu nie da się tak uzupełnić.
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

INVOICE_ID=${1:-}
MODE=${2:-}
if ! [[ "$INVOICE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Podaj id faktury (UUID małymi literami), np. ./scripts/ops/dopisz-dane-specjalne.sh 0b6f…-…" >&2
  exit 1
fi
if [ -n "$MODE" ] && [ "$MODE" != "--wykonaj" ]; then
  echo "Nieznana opcja $MODE (jedyna: --wykonaj)." >&2
  exit 1
fi
WYKONAJ=0
[ "$MODE" = "--wykonaj" ] && WYKONAJ=1

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)

# Środowisko workera — job z innego środowiska nie jest źródłem (F2).
WORKER_ENV=$("${SSH[@]}" "root@$APP" \
  "W=\$(docker ps --format '{{.Names}}' | grep '^$WORKER_PREFIX' | head -1); \
   [ -n \"\$W\" ] && docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$W\" | sed -n 's/^KSEF_ENV=//p'" || true)
if ! [[ "$WORKER_ENV" =~ ^(test|demo|production)$ ]]; then
  echo "Nie udało się ustalić KSEF_ENV workera (odczytano: '${WORKER_ENV:-brak}'). Przerywam." >&2
  exit 1
fi
echo "Faktura: $INVOICE_ID · KSEF_ENV workera: $WORKER_ENV · tryb: $([ $WYKONAJ = 1 ] && echo 'ZAPIS' || echo 'tylko sprawdzenie')"

SQL_FILE=$(mktemp)
trap 'rm -f "$SQL_FILE"' EXIT
cat > "$SQL_FILE" <<'SQL'
\set ON_ERROR_STOP on
\pset footer off
-- Pierwsze zlecenie wysyłki TEJ faktury i wszystkie warunki naraz (wspólne dla podglądu i zapisu).
CREATE TEMP VIEW kandydat AS
  WITH inv AS (
    SELECT id, tenant_id, invoice_kind, ksef_status, last_error_code, special_data, fa3_data
    FROM public.invoices WHERE id = :'id'
  ), pierwszy AS (
    SELECT j.id, j.created_on, j.data
    FROM pgboss.job j, inv
    WHERE j.name = 'invoice.submit.requested' AND j.data->>'invoiceId' = inv.id::text
    ORDER BY j.created_on LIMIT 1
  )
  SELECT inv.id, inv.tenant_id, inv.invoice_kind, inv.ksef_status, inv.last_error_code,
         p.id AS job_id, p.created_on AS job_utworzony, p.data AS job_data,
         inv.special_data IS NULL AS bez_special_data,
         inv.invoice_kind IN ('correction', 'final') AS rodzaj_kor_roz,
         p.id IS NOT NULL AS job_jest,
         coalesce(p.data->>'tenantId' = inv.tenant_id::text, false) AS ta_sama_firma,
         coalesce(p.data->>'environment' = :'env', false) AS to_samo_srodowisko,
         coalesce(p.data->'invoice' = inv.fa3_data, false) AS ta_sama_tresc,
         CASE inv.invoice_kind
           WHEN 'correction' THEN coalesce(jsonb_typeof(p.data->'correctionData') = 'object', false)
           WHEN 'final' THEN coalesce(jsonb_typeof(p.data->'finalData') = 'object'
             AND jsonb_typeof(p.data->'finalAdvanceSettlementRows') = 'array'
             AND jsonb_array_length(p.data->'finalAdvanceSettlementRows') > 0, false)
           ELSE false
         END AS dane_rodzaju,
         public.ksef_has_contact_evidence(inv.id, inv.tenant_id) AS dowod_kontaktu
  FROM inv LEFT JOIN pierwszy p ON true;

\echo '--- faktura i pierwsze zlecenie wysyłki'
SELECT invoice_kind, ksef_status, last_error_code, job_id, job_utworzony,
       bez_special_data, rodzaj_kor_roz, job_jest, ta_sama_firma, to_samo_srodowisko,
       ta_sama_tresc, dane_rodzaju, dowod_kontaktu
FROM kandydat;

SELECT count(*) = 1 AS gotowe FROM kandydat
WHERE bez_special_data AND rodzaj_kor_roz AND job_jest AND ta_sama_firma
  AND to_samo_srodowisko AND ta_sama_tresc AND dane_rodzaju \gset

\if :gotowe
  \echo 'Warunki spełnione — special_data można dopisać z tego zlecenia.'
\else
  \echo 'NIE: któryś warunek nie jest spełniony (kolumny wyżej). Nic nie zapisano — runbook „Stary dokument specjalny”.'
\endif

\if :wykonaj
  \if :gotowe
    BEGIN;
    WITH k AS (
      SELECT * FROM kandydat
      WHERE bez_special_data AND rodzaj_kor_roz AND job_jest AND ta_sama_firma
        AND to_samo_srodowisko AND ta_sama_tresc AND dane_rodzaju
    ), zapis AS (
      UPDATE public.invoices i
      SET special_data = CASE k.invoice_kind
        WHEN 'correction' THEN jsonb_build_object('correctionData', k.job_data->'correctionData')
        ELSE jsonb_build_object('finalData', k.job_data->'finalData',
                                'finalAdvanceSettlementRows', k.job_data->'finalAdvanceSettlementRows')
      END
      FROM k
      WHERE i.id = k.id AND i.tenant_id = k.tenant_id AND i.special_data IS NULL
      RETURNING i.id, i.tenant_id, k.job_id
    ), audyt AS (
      INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, details_json)
      SELECT tenant_id, NULL, 'invoice.special_data_backfilled', 'invoice', id,
             jsonb_build_object('job_id', job_id, 'zrodlo', 'scripts/ops/dopisz-dane-specjalne.sh',
                                'runbook', 'ksef-error-codes.md: Stary dokument specjalny')
      FROM zapis
      RETURNING entity_id
    )
    SELECT count(*) = 1 AS zapisano FROM audyt \gset
    \if :zapisano
      COMMIT;
      \echo 'ZAPISANO special_data i wpis audit_logs. Dalej: runbook „Stary dokument specjalny”, krok 5.'
    \else
      ROLLBACK;
      \echo 'Wycofano: zapis nie trafił dokładnie w jeden wiersz.'
    \endif
  \endif
\endif
SQL

scp -q -i "$K" -o ConnectTimeout=15 -o BatchMode=yes "$SQL_FILE" "root@$DB:/tmp/dopisz-dane-specjalne.sql"
"${SSH[@]}" "root@$DB" \
  "docker cp /tmp/dopisz-dane-specjalne.sql $PGC:/tmp/dopisz-dane-specjalne.sql && \
   docker exec $PGC psql -U postgres -d postgres -X -q \
     -v id=$INVOICE_ID -v env=$WORKER_ENV -v wykonaj=$WYKONAJ \
     -f /tmp/dopisz-dane-specjalne.sql; \
   rc=\$?; rm -f /tmp/dopisz-dane-specjalne.sql; docker exec $PGC rm -f /tmp/dopisz-dane-specjalne.sql; exit \$rc"
