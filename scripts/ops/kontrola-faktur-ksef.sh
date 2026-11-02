#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Kontrola stanu produkcji: faktury, kolejki pg-boss, worker — TYLKO ODCZYT
# ────────────────────────────────────────────────────────────────
# Jedna linia, bez argumentów, z katalogu repo:
#
#   ./scripts/ops/kontrola-faktur-ksef.sh
#
# Opcjonalnie okno sekcji 9 (dokumenty specjalne bez danych utworzone
# w ostatnich N godzinach; domyślnie 24 — po wdrożeniu A4b podaj czas od
# wgrania 00137):
#
#   ./scripts/ops/kontrola-faktur-ksef.sh --od-godzin 6
#
# Skrypt sam ładuje `.agents/infra.env` (K, APP, DB, PGC, RESTC, APP_PREFIX,
# WORKER_PREFIX) — przycisk „Run” w aplikacji uruchamia każdy blok w świeżej
# powłoce, więc osobne `source` nic nie daje. Nic nie zmienia na serwerach:
# `docker ps`, `docker logs`, `docker inspect` (z env workera wychodzi tylko
# KSEF_ENV — filtr po stronie serwera), `curl` do /api/health, SELECT-y przez
# psql i jedna sonda PostgREST: PATCH bez tokenu (rola anon nie ma prawa
# zapisu) na nieistniejące id — odmowa albo zero wierszy, nigdy zmiana.
#
# Co pokazuje (sekcje odpowiadają kontrolom z rewizji 03.10.2026):
#   1. kontenery na app-1 i SHA obrazów (web i worker na tym samym commicie?)
#   2. log workera z 2 h: crony, błędy, wyczerpane ponowienia, heartbeat
#   3. /api/health aplikacji
#   4. faktury wychodzące wg statusu; `queued` i `sending` > 15 min;
#      `failed` wg kodu; `failed`/`rejected` z przejęciem wysyłki (K3);
#      przyjęte bez środowiska KSeF (W15)
#  4a. Offline24 (automat wyłączony 02.10.2026): KSEF_ENV workera, kolejka
#      ksef_offline_queue wg stanu, otwarte wpisy i co zrobi z nimi cron,
#      faktury offline_queued wg werdyktu (BEZ WYJSCIA), lista do uzgodnienia
#      z KSeF, failed/rejected z OFFLINE_*, inny ślad (zamrożone szkice),
#      wpisy zamknięte, przebiegi crona z inngest_run_log — runbook
#      docs/runbooks/offline24-zalegle.md
#   5. UPO wg statusu i błędu (W12)
#   6. skrzynka: przychodzące bez kosztu, bez XML, z otwartym znacznikiem (K2)
#   7. pg-boss: joby wg (kolejka, stan), harmonogramy, polityka kolejek
#   8. dokumenty, których JPK nie wykaże (W9): stawki spoza FaktWay,
#      zaimportowane KOR/ZAL/ROZ, a od C5b treść z pliku KSeF (adnotacje
#      i daty sprzedaży nieczytelne albo sprzed C5b, procedury, FP/TP/GTU),
#      od C5c kwoty pozycji (ceny brutto, VAT od sumy stawki)
#   9. dokumenty specjalne (A4b, 00137): KOR/ZAL/ROZ wg stanu i kodu,
#      ZAL bez koperty, KOR/ROZ bez special_data (stare i świeże),
#      środowisko KSeF workera, sonda PostgREST na kolumnę special_data;
#      od A4b PR2a: failed KOR/ZAL/ROZ — czy automat ponowi (kod, data
#      wystawienia, dane), zwykłe failed bez pozycji, I5 wg danych,
#      ostatni przebieg crona; od A5 #2 faktury bez akcji automatu
#      z invoiceId (I5 po limicie i poza failed/rejected, odmowy zlecenia)
#  10. duplikaty 440 i decyzja klienta (D-A4-1b-3 PR B, 00148; PR C, 00156):
#      failed KSEF_DUPLICATE_RECONCILE wg powodu i środowiska znacznika, wg
#      blokady decyzji (po 00148), I5D „czeka na klienta” wg środowiska,
#      powiadomienia i decyzje z audytu, decyzje known-number do sprawdzenia
#      dokumentu Y, szkice wycofane (wpis number_taken) wg rodzaju; od PR C:
#      faktflow-original wg oferty i blokady (z importGate i bez, z
#      recheckNeeded wg kind), wersje reguł bramy (rules x kind), I5R z wiekiem
#      (alarm po 72 h od checkedAt), faktury zapisane decyzją z UPO wg statusu,
#      I3K (brak sesji albo daty), szkice wycofane bez numeru, spójność
#      decision.importedInvoiceId (oczekiwane 0 błędów), decyzje wg trybu
#      (import / no-import) i oddania; runbook ksef-error-codes.md, sekcja
#      „D-A4-1b-3 PR C”
#  11. ostatnie migracje w schema_migrations
#  12. dziennik prób wysyłki (A5, 00150): zakres dziennika, wykonania joba
#      bez wiersza w dzienniku (wg inngest_run_log — czy dziennik pisze),
#      wykonania z 24 h wg stanu, błędy, odmowy przed kolejką i przerwane
#      (`started` bez wyniku po 20 min) wg kodu ze stanem faktur teraz,
#      lista ostatnich; w logach od startu kontenera wpisy
#      `ksef.send.attempt` i nieudane zapisy dziennika (progi jak
#      /admin/centrum/bledy; bez 00150 jeden komunikat)
#
# Błąd jednego zapytania nie przerywa reszty (np. kolumna sprzed migracji).
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
  {
    echo "Nie znalazłem .agents/infra.env (plik jest poza gitem — AGENTS.md → Infrastruktura)."
    echo "Szukałem w: ${FAKTFLOW_INFRA_ENV:-(FAKTFLOW_INFRA_ENV nieustawione)}, $ROOT/.agents/infra.env${MAIN_ROOT:+, $MAIN_ROOT/.agents/infra.env}"
  } >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
for v in K APP DB PGC RESTC APP_PREFIX WORKER_PREFIX; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

# `--od-godzin N`: okno sekcji 9 (tylko liczba — trafia do SQL).
A4B_HOURS=24
if [ "${1:-}" = "--od-godzin" ]; then
  if [[ "${2:-}" =~ ^[0-9]{1,4}$ ]]; then
    A4B_HOURS=$2
  else
    echo "--od-godzin wymaga liczby godzin (np. --od-godzin 6)." >&2
    exit 1
  fi
fi

# `--sprawdz`: tylko pokaż, skąd czytasz konfigurację, bez łączenia z serwerami.
if [ "${1:-}" = "--sprawdz" ]; then
  echo "Konfiguracja: $ENV_FILE"
  echo "Klucz SSH: $K ($([ -f "$K" ] && echo 'jest' || echo 'BRAK PLIKU'))"
  echo "Serwery: app=$APP db=$DB; kontener Postgresa: $PGC"
  exit 0
fi

SSH=(ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes)

section() { printf '\n=== %s\n' "$1"; }

# SELECT przez psql w kontenerze Postgresa. SQL bez cudzysłowów, backticków
# i znaku dolara — przechodzi przez dwie powłoki.
sql() {
  local label=$1 query=$2
  printf -- '--- %s\n' "$label"
  "${SSH[@]}" "root@$DB" \
    "docker exec $PGC psql -U postgres -d postgres -At -F' | ' -v ON_ERROR_STOP=1 -c \"$query\"" \
    || echo "  (zapytanie nieudane — brak tabeli/kolumny albo brak dostępu)"
}

section "1. app-1: kontenery (web i worker na tym samym SHA?)"
"${SSH[@]}" "root@$APP" 'docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}" | grep -v coolify-' \
  || echo "  (nie udało się odczytać kontenerów)"

section "2. app-1: worker — crony, błędy, wyczerpane ponowienia, heartbeat (2 h)"
# Wpisy cyklu życia o pojedynczych fakturach (I5, odmowy budowy zlecenia)
# powtarzają się co przebieg i wypychałyby błędy z `tail -40` — pokazuje je
# sekcja 9. Linie ERROR cyklu życia mają inne treści i zostają.
"${SSH[@]}" "root@$APP" \
  "W=\$(docker ps --format '{{.Names}}' | grep '^$WORKER_PREFIX' | head -1); \
   if [ -z \"\$W\" ]; then echo '  (brak kontenera workera)'; exit 0; fi; \
   docker logs --since 2h \"\$W\" 2>&1 | grep -iE 'cron|error|exhaust|heartbeat|błąd|bledy' | grep -v getSession \
     | grep -vE 'Cykl życia: (I5 |faktury nie da się|korekta czeka)' | tail -40" \
  || echo "  (nie udało się odczytać logu workera)"

section "3. app-1: /api/health"
"${SSH[@]}" "root@$APP" \
  "A=\$(docker ps --format '{{.Names}}' | grep '^$APP_PREFIX' | head -1); \
   if [ -z \"\$A\" ]; then echo '  (brak kontenera aplikacji)'; exit 0; fi; \
   docker exec \"\$A\" curl -s -o /dev/null -w 'HTTP %{http_code} w %{time_total}s\n' http://localhost:3000/api/health" \
  || echo "  (nie udało się odpytać /api/health)"

section "4. db-1: faktury wychodzące"
sql "statusy" \
  "SELECT coalesce(ksef_status,'(null)') AS status, count(*) FROM invoices WHERE direction='outgoing' GROUP BY 1 ORDER BY 1"
sql "queued > 15 min (W2/W3: bez joba?)" \
  "SELECT count(*) FROM invoices WHERE direction='outgoing' AND ksef_status='queued' AND updated_at < now() - interval '15 min'"
sql "sending > 15 min od przejęcia (alarm stale_ksef_sending_invoices)" \
  "SELECT count(*) FROM invoices WHERE direction='outgoing' AND ksef_status='sending' AND (submitted_to_ksef_at IS NULL OR submitted_to_ksef_at < now() - interval '15 min')"
sql "failed wg kodu błędu" \
  "SELECT coalesce(last_error_code,'(brak kodu)') AS kod, count(*) FROM invoices WHERE direction='outgoing' AND ksef_status='failed' GROUP BY 1 ORDER BY 2 DESC"
sql "failed/rejected z przejęciem wysyłki (K3: zamrożone, bez ponowienia)" \
  "SELECT ksef_status, count(*) FROM invoices WHERE direction='outgoing' AND ksef_status IN ('failed','rejected') AND submitted_to_ksef_at IS NOT NULL GROUP BY 1"
sql "przyjęte bez środowiska KSeF (W15/S13: do uzgodnienia jako postgres)" \
  "SELECT direction, count(*) FROM invoices WHERE ksef_status='accepted' AND ksef_environment IS NULL GROUP BY 1"
sql "przyjęte wg środowiska (przed przełączeniem KSEF_ENV)" \
  "SELECT direction, coalesce(ksef_environment,'(null)') AS env, count(*) FROM invoices WHERE ksef_status='accepted' GROUP BY 1,2 ORDER BY 1,2"

section "4a. db-1: Offline24 — zaległości po wyłączeniu automatu 02.10 (A5 #4)"
# Nowych wpisów nie ma (isOffline24Enabled = false), ale cron kolejki
# (cron.process-offline-queue, co 5 min, niezależnie od wyłącznika wysyłek)
# zamyka stare wpisy queued ze środowiskiem = KSEF_ENV workera: kwarantanna
# i wygaśnięcie przy przejętej fakturze zostawiają fakturę w offline_queued
# BEZ WYJŚCIA (żadne RPC ani przycisk jej nie obejmuje). Kilka wpisów na
# fakturę jest możliwe — liczy się najnowszy. KSEF_ENV workera nie wchodzi
# do SQL; porównaj z nim kolumnę środowiska. Co znaczy każdy wiersz i co
# robić: docs/runbooks/offline24-zalegle.md. Danych nie zmieniaj.
printf -- '--- KSEF_ENV workera (cron kolejki bierze tylko wpisy z tym środowiskiem)\n'
"${SSH[@]}" "root@$APP" \
  "W=\$(docker ps --format '{{.Names}}' | grep '^$WORKER_PREFIX' | head -1); \
   if [ -z \"\$W\" ]; then echo '  (brak kontenera workera)'; exit 0; fi; \
   docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$W\" | grep '^KSEF_ENV=' || echo '  (KSEF_ENV nieustawione)'" \
  || echo "  (nie udało się odczytać środowiska workera)"
sql "(a) kolejka ksef_offline_queue wg stanu: stan | środowisko | liczba | najstarszy wpis | najnowszy wpis | ostatnia zmiana (pusto = brak śladu Offline24; najnowszy wpis po wdrożeniu wyłączenia, 02-03.10.2026 = coś parkuje mimo wyłączenia — błąd)" \
  "SELECT q.status::text, coalesce(q.ksef_environment,'(null)'), count(*), min(q.created_at)::date, max(q.created_at)::date, max(q.updated_at) FROM ksef_offline_queue q GROUP BY 1,2 ORDER BY 1,2"
sql "(b) otwarte wpisy kolejki (queued/sending) — co z nimi zrobi cron (przy środowisku wpisu = KSEF_ENV): stan | środowisko | powód i skutek | stan faktury | przejęta | po terminie | liczba | najbliższy termin" \
  "SELECT q.status::text, coalesce(q.ksef_environment,'(null)'), CASE WHEN q.status='sending' THEN 'sending: odtworzenie wylaczone od 02.10, nic go nie zamknie' WHEN q.ksef_environment IS NULL THEN 'srodowisko NULL sprzed 00117: cron pomija na zawsze' WHEN q.next_attempt_at > now() THEN 'queued: cron wezmie dopiero po next_attempt_at' WHEN greatest(q.next_attempt_at, q.updated_at) < now() - interval '15 minutes' THEN 'queued ponad 15 min do wziecia: srodowisko inne niz KSEF_ENV albo przebieg crona pada (h)' WHEN i.id IS NULL THEN 'queued: cron oznaczy wpis QUEUE_INVOICE_OWNERSHIP_MISMATCH (faktura innej firmy)' WHEN i.ksef_status='accepted' THEN 'queued: cron zamknie wpis, faktura accepted bez zmian' WHEN i.ksef_status <> 'offline_queued' THEN 'queued: cron zamknie wpis, faktura bez zmian (ma wlasne wyjscie)' WHEN q.deadline < now() AND i.submitted_to_ksef_at IS NULL THEN 'queued: cron zamknie, faktura failed OFFLINE_DEADLINE_EXCEEDED (z wyjsciem)' ELSE 'queued: cron zamknie, faktura zostanie offline_queued BEZ WYJSCIA' END, coalesce(i.ksef_status,'(brak faktury)'), (i.submitted_to_ksef_at IS NOT NULL), (q.deadline < now()), count(*), min(q.deadline) FROM ksef_offline_queue q LEFT JOIN invoices i ON i.id = q.invoice_id AND i.tenant_id = q.tenant_id WHERE q.status IN ('queued','sending') GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6"
sql "(c) faktury offline_queued (najnowszy wpis kolejki): wpis | środowisko wpisu | kod faktury | werdykt | termin | przejęta | dowód kontaktu | QR offline | liczba (BEZ WYJSCIA = faktura stoi dziś bez wyjścia; co ją uwolni — runbook)" \
  "SELECT coalesce(q.status::text,'(brak wpisu)'), coalesce(q.ksef_environment,'(null)'), coalesce(i.last_error_code,'(brak kodu)'), CASE WHEN q.status IN ('failed','expired') THEN 'BEZ WYJSCIA: wpis zamkniety przez cron' WHEN q.status IS NULL OR q.status='sent' THEN 'BEZ WYJSCIA: cron jej nie dotyka (brak wpisu albo sent)' WHEN q.status='sending' OR q.ksef_environment IS NULL THEN 'BEZ WYJSCIA: otwarty wpis, ktorego cron nie wezmie' ELSE 'BEZ WYJSCIA, jesli srodowisko wpisu inne niz KSEF_ENV; rowne = czeka na cron (b)' END, CASE WHEN q.deadline IS NULL THEN '-' WHEN q.deadline < now() THEN 'po terminie' ELSE 'w terminie' END, (i.submitted_to_ksef_at IS NOT NULL), ksef_has_contact_evidence(i.id, i.tenant_id), (i.offline_qr_offline IS NOT NULL), count(*) FROM invoices i LEFT JOIN LATERAL (SELECT x.status, x.ksef_environment, x.deadline, x.next_attempt_at FROM ksef_offline_queue x WHERE x.invoice_id = i.id AND x.tenant_id = i.tenant_id ORDER BY x.created_at DESC, x.id LIMIT 1) q ON true WHERE i.direction='outgoing' AND i.ksef_status='offline_queued' GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 4,1,3"
sql "(d) faktury offline_queued do uzgodnienia z KSeF (do 50; najpierw bez wpisu, potem wg terminu): firma | NIP firmy | faktura | numer | data wystawienia | kod | wpis | środowisko wpisu | termin | przejęta | dowód kontaktu | QR offline | ostatnia zmiana" \
  "SELECT i.tenant_id, t.nip, i.id, i.internal_number, i.issue_date, coalesce(i.last_error_code,'-'), coalesce(q.status::text,'(brak wpisu)'), coalesce(q.ksef_environment,'(null)'), q.deadline, (i.submitted_to_ksef_at IS NOT NULL), ksef_has_contact_evidence(i.id, i.tenant_id), (i.offline_qr_offline IS NOT NULL), i.updated_at FROM invoices i JOIN tenants t ON t.id = i.tenant_id LEFT JOIN LATERAL (SELECT x.status, x.ksef_environment, x.deadline, x.next_attempt_at FROM ksef_offline_queue x WHERE x.invoice_id = i.id AND x.tenant_id = i.tenant_id ORDER BY x.created_at DESC, x.id LIMIT 1) q ON true WHERE i.direction='outgoing' AND i.ksef_status='offline_queued' ORDER BY q.deadline NULLS FIRST, i.updated_at, i.id LIMIT 50"
sql "(e) failed/rejected z kodem OFFLINE_* (kod spoza katalogu = alarm I4): kod | stan | rodzaj | wpis | przejęta | dowód kontaktu | QR offline | w katalogu | liczba" \
  "SELECT i.last_error_code, i.ksef_status, i.invoice_kind, coalesce(q.status::text,'(brak wpisu)'), (i.submitted_to_ksef_at IS NOT NULL), ksef_has_contact_evidence(i.id, i.tenant_id), (i.offline_qr_offline IS NOT NULL), (c.code IS NOT NULL), count(*) FROM invoices i LEFT JOIN ksef_error_codes c ON c.code = i.last_error_code LEFT JOIN LATERAL (SELECT x.status, x.ksef_environment, x.deadline, x.next_attempt_at FROM ksef_offline_queue x WHERE x.invoice_id = i.id AND x.tenant_id = i.tenant_id ORDER BY x.created_at DESC, x.id LIMIT 1) q ON true WHERE i.direction='outgoing' AND i.ksef_status IN ('failed','rejected') AND left(i.last_error_code, 8) = 'OFFLINE_' GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 1,2,3,4"
sql "(f) inny ślad Offline24 bez numeru KSeF (poza c i e): stan | kod | wpis | klucz offline (t = treść i pozycje zamrożone, reset tego nie zdejmuje) | liczba" \
  "SELECT coalesce(i.ksef_status,'(null)'), coalesce(i.last_error_code,'(brak kodu)'), coalesce(q.status::text,'(brak wpisu)'), (i.offline_idempotency_key IS NOT NULL), count(*) FROM invoices i LEFT JOIN LATERAL (SELECT x.status, x.ksef_environment, x.deadline, x.next_attempt_at FROM ksef_offline_queue x WHERE x.invoice_id = i.id AND x.tenant_id = i.tenant_id ORDER BY x.created_at DESC, x.id LIMIT 1) q ON true WHERE i.direction='outgoing' AND i.ksef_number IS NULL AND i.ksef_status IS DISTINCT FROM 'offline_queued' AND NOT (i.ksef_status IN ('failed','rejected') AND left(coalesce(i.last_error_code,''), 8) = 'OFFLINE_') AND (i.offline_idempotency_key IS NOT NULL OR q.status IS NOT NULL) GROUP BY 1,2,3,4 ORDER BY 1,2,3"
sql "(g) wpisy kolejki zamknięte (failed/expired): stan | powód | stan faktury | liczba | ostatnia zmiana (…_REQUIRES_RECONCILIATION albo expired przy offline_queued = kwarantanna albo wygaśnięcie bez wyjścia)" \
  "SELECT q.status::text, left(coalesce(q.last_error,'(brak)'), 60), coalesce(i.ksef_status,'(brak faktury)'), count(*), max(q.updated_at) FROM ksef_offline_queue q LEFT JOIN invoices i ON i.id = q.invoice_id AND i.tenant_id = q.tenant_id WHERE q.status IN ('failed','expired') GROUP BY 1,2,3 ORDER BY 1,2,3"
sql "(h) przebiegi crona cron.process-offline-queue z doby (inngest_run_log, do 5): stan | czas | ms | błąd (failed = handler rzucił wyjątek, wpis zostaje queued; brak wierszy przy działającym workerze = cron nie startuje, sekcja 7)" \
  "SELECT status, created_at, duration_ms, left(coalesce(error_message,'-'), 160) FROM inngest_run_log WHERE event_name='cron.process-offline-queue' AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 5"

section "5. db-1: UPO"
sql "statusy" "SELECT status, count(*) FROM upo_receipts GROUP BY 1 ORDER BY 1"
sql "failed wg błędu (W12: NO_SESSION_REFERENCE wraca co godzinę)" \
  "SELECT left(coalesce(last_error,'(brak)'),60) AS blad, count(*) FROM upo_receipts WHERE status='failed' GROUP BY 1 ORDER BY 2 DESC"

section "6. db-1: skrzynka (faktury przychodzące)"
sql "bez kosztu w expenses (K2)" \
  "SELECT count(*) FROM invoices i WHERE i.direction='incoming' AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.ksef_invoice_id = i.id)"
sql "bez oryginału XML (W11)" \
  "SELECT count(*) FROM invoices WHERE direction='incoming' AND xml_storage_path IS NULL"
sql "z otwartym znacznikiem _pendingFullFetch (K2: cron inbox-backfill)" \
  "SELECT count(*) FROM invoices WHERE direction='incoming' AND fa3_data->>'_pendingFullFetch' = 'true'"
sql "kursory skrzynki (window_to = HWM, saved_count)" \
  "SELECT tenant_id, window_to, announced_count, saved_count, updated_at FROM ksef_inbox_cursor ORDER BY updated_at DESC LIMIT 10"

section "7. db-1: pg-boss"
sql "joby wg kolejki i stanu (osierocone kolejki po ETAP 10?)" \
  "SELECT name, state, count(*) FROM pgboss.job GROUP BY 1,2 ORDER BY 1,2"
sql "harmonogramy (powinny odpowiadać CRON_JOBS; wycofane: cron.refresh-materialized-views)" \
  "SELECT name, cron FROM pgboss.schedule ORDER BY 1"
sql "polityka kolejek (QUEUE_POLICY: retry_limit, expire_seconds)" \
  "SELECT name, retry_limit, retry_delay, expire_seconds FROM pgboss.queue ORDER BY 1"

section "8. db-1: dokumenty, których JPK nie wykaże (W9, import historii KSeF)"
sql "pozycje sprzedaży przyjętej ze stawką spoza FaktWay (0 WDT, 0 EX, 22, 7, 4, 3, nieznana; stare surowe 0 KR / np I / np II)" \
  "SELECT i.tenant_id, i.internal_number, i.ksef_number, to_char(i.issue_date, 'YYYY-MM') AS okres, l.vat_rate, count(*) FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id WHERE i.direction='outgoing' AND i.ksef_status='accepted' AND l.vat_rate NOT IN ('23','8','5','0','zw','oo','np','np_ii') GROUP BY 1,2,3,4,5 ORDER BY 4 DESC, 2 LIMIT 50"
sql "zaimportowane korekty, zaliczki i ROZ zapisane jako zwykłe (invoice_kind regular)" \
  "SELECT tenant_id, internal_number, ksef_number, invoice_type, issue_date FROM invoices WHERE direction='outgoing' AND ksef_status='accepted' AND invoice_kind='regular' AND invoice_type IN ('KOR','ZAL','ROZ') ORDER BY issue_date DESC LIMIT 50"
sql "C5b: sprzedaż z importu, której JPK nie wykaże przez treść z pliku (sprzed C5b = ponów import historii)" \
  "SELECT tenant_id, internal_number, ksef_number, okres, powod FROM (SELECT tenant_id, internal_number, ksef_number, to_char(issue_date, 'YYYY-MM') AS okres, CASE WHEN jsonb_typeof(fa3_data->'annotations') IS DISTINCT FROM 'object' THEN 'bez adnotacji - import sprzed C5b' WHEN fa3_data ? 'annotationProblems' THEN 'adnotacje nieczytelne' WHEN fa3_data->'annotations'->>'simplifiedProcedure' = '1' THEN 'P_23' WHEN fa3_data->'annotations'->>'newMeansOfTransport' = '1' THEN 'P_22' WHEN fa3_data->'annotations' ? 'marginScheme' THEN 'marza' WHEN fa3_data ? 'ksefMarkers' THEN 'FP/TP/GTU/procedura/podmiot upowazniony' WHEN fa3_data->'saleDates'->>'unclear' = 'true' THEN 'rozne daty sprzedazy' WHEN fa3_data ? 'lineAmountProblems' THEN 'kwoty pozycji (ceny brutto / VAT) - C5c' WHEN NOT EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.invoice_id = i.id AND l.vat_rate NOT IN ('23','8','5','0','zw','oo','np','np_ii')) AND EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.invoice_id = i.id AND l.vat_rate = 'zw') IS DISTINCT FROM (coalesce(trim(fa3_data->'annotations'->>'vatExemptionBasis'), '') <> '') THEN 'P_19 niezgodne ze stawkami' END AS powod FROM invoices i WHERE direction='outgoing' AND ksef_status='accepted' AND origin='ksef_import') x WHERE powod IS NOT NULL ORDER BY okres DESC, internal_number LIMIT 50"

sql "C5c: sprzedaż z importu, której pozycje nie sumują się do netto albo VAT faktury (JPK odmówi)" \
  "SELECT i.tenant_id, i.internal_number, i.ksef_number, to_char(i.issue_date, 'YYYY-MM') AS okres, i.net_total, coalesce(sum(l.net_amount), 0) AS netto_pozycji, i.vat_total, coalesce(sum(l.vat_amount), 0) AS vat_pozycji FROM invoices i LEFT JOIN invoice_line_items l ON l.invoice_id = i.id WHERE i.origin='ksef_import' AND i.direction='outgoing' AND i.ksef_status='accepted' GROUP BY i.id HAVING abs(coalesce(sum(l.vat_amount), 0) - i.vat_total) >= 0.005 OR abs(coalesce(sum(l.net_amount), 0) - i.net_total) > 0.01 * greatest(count(l.id), 1) + 0.01 ORDER BY 4 DESC LIMIT 50"

section "9. dokumenty specjalne — dane do ponownej wysyłki (A4b, 00137)"
printf -- '--- KSEF_ENV workera (test = KOR wysyłane także na produkcji FaktWay)\n'
"${SSH[@]}" "root@$APP" \
  "W=\$(docker ps --format '{{.Names}}' | grep '^$WORKER_PREFIX' | head -1); \
   if [ -z \"\$W\" ]; then echo '  (brak kontenera workera)'; exit 0; fi; \
   docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$W\" | grep '^KSEF_ENV=' || echo '  (KSEF_ENV nieustawione)'" \
  || echo "  (nie udało się odczytać środowiska workera)"
sql "KOR/ZAL/ROZ wg rodzaju, stanu i kodu (przed 00137: ile starych dokumentów bez danych)" \
  "SELECT invoice_kind, coalesce(ksef_status,'(null)') AS status, coalesce(last_error_code,'-') AS kod, count(*) FROM invoices WHERE direction='outgoing' AND invoice_kind<>'regular' GROUP BY 1,2,3 ORDER BY 1,2,3"
sql "ZAL bez koperty fa3_data.advanceEnvelope (sprzed 02.10.2026 — bez ponowienia z kopii)" \
  "SELECT coalesce(ksef_status,'(null)') AS status, count(*) FROM invoices WHERE direction='outgoing' AND invoice_kind='advance' AND jsonb_typeof(fa3_data->'advanceEnvelope') IS DISTINCT FROM 'object' GROUP BY 1 ORDER BY 1"
sql "KOR/ROZ bez special_data wg stanu (sprzed 00137; po wgraniu migracji)" \
  "SELECT invoice_kind, coalesce(ksef_status,'(null)') AS status, count(*) FROM invoices WHERE direction='outgoing' AND invoice_kind IN ('correction','final') AND special_data IS NULL GROUP BY 1,2 ORDER BY 1,2"
sql "KOR/ROZ bez special_data utworzone w ostatnich $A4B_HOURS h (po wdrożeniu A4b oczekiwane 0; okno migracja→wdrożenie: każdy stan)" \
  "SELECT id, invoice_kind, internal_number, ksef_status, created_at FROM invoices WHERE direction='outgoing' AND invoice_kind IN ('correction','final') AND special_data IS NULL AND created_at > now() - interval '$A4B_HOURS hours' ORDER BY created_at DESC LIMIT 20"
# A4b PR2a: ponowienie z kopii. „dane” = lustro storedSendPayload (kształt special_data pilnuje CHECK z 00137).
sql "failed KOR/ZAL/ROZ: rodzaj | kod | data wystawienia | dane do ponowienia | czy automat I6/I7 ponowi | liczba (KOR zalezy od KSEF_ENV wyzej; I5 uzgadnia takze po terminie)" \
  "SELECT invoice_kind, kod, data_wyst, dane, CASE WHEN invoice_kind='final' THEN 'nie - ROZ_HOLD do C4' WHEN NOT dane THEN 'nie - brak danych, runbook Stary dokument specjalny' WHEN NOT kod_automatu THEN 'nie - kod bez automatu (klient albo operator)' WHEN data_wyst <> 'dzis' THEN 'nie - data wystawienia minela (decyzja b)' WHEN invoice_kind='correction' THEN 'tylko przy KSEF_ENV=test (production: KOR_HOLD)' ELSE 'tak - I6/I7 dzis' END AS automat, count(*) FROM (SELECT i.invoice_kind, coalesce(i.last_error_code,'(brak kodu)') AS kod, (coalesce(c.auto_requeue, false) OR i.last_error_code IS NOT DISTINCT FROM 'KSEF_PAUSED') AS kod_automatu, CASE WHEN i.issue_date = (now() AT TIME ZONE 'Europe/Warsaw')::date THEN 'dzis' ELSE 'przed dzis' END AS data_wyst, (jsonb_typeof(i.fa3_data->'lines') IS NOT DISTINCT FROM 'array' AND CASE WHEN i.invoice_kind='advance' THEN jsonb_typeof(i.fa3_data->'advanceEnvelope') IS NOT DISTINCT FROM 'object' ELSE i.special_data IS NOT NULL END) AS dane FROM invoices i LEFT JOIN ksef_error_codes c ON c.code = i.last_error_code WHERE i.direction='outgoing' AND i.ksef_status='failed' AND i.invoice_kind<>'regular') x GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4"
sql "zwykle failed z kodem automatu bez tablicy pozycji w fa3_data (I6/I7 pomijaja co przebieg: skippedNoData): kod | liczba" \
  "SELECT coalesce(i.last_error_code,'(brak kodu)') AS kod, count(*) FROM invoices i LEFT JOIN ksef_error_codes c ON c.code = i.last_error_code WHERE i.direction='outgoing' AND i.ksef_status='failed' AND i.invoice_kind='regular' AND (coalesce(c.auto_requeue, false) OR i.last_error_code = 'KSEF_PAUSED') AND jsonb_typeof(i.fa3_data->'lines') IS DISTINCT FROM 'array' GROUP BY 1 ORDER BY 1"
sql "I5: failed/rejected z wpisem sent/intent starszym niz 48 h: rodzaj | stan | dane | czy automat I5 uzgodni | liczba (KOR zalezy od KSEF_ENV wyzej) (od 00148 faktury czekające na decyzję klienta to I5D — sekcja 10; ten licznik je obejmuje)" \
  "SELECT invoice_kind, ksef_status, dane, CASE WHEN invoice_kind='final' THEN 'nie - ROZ_HOLD do C4, operator' WHEN NOT dane THEN 'nie - brak danych, runbook Stary dokument specjalny' WHEN invoice_kind='correction' THEN 'tylko przy KSEF_ENV=test (production: KOR_HOLD)' ELSE 'tak - I5 raz na dobe' END AS automat, count(*) FROM (SELECT DISTINCT i.id, i.invoice_kind, i.ksef_status, (jsonb_typeof(i.fa3_data->'lines') IS NOT DISTINCT FROM 'array' AND CASE WHEN i.invoice_kind='regular' THEN true WHEN i.invoice_kind='advance' THEN jsonb_typeof(i.fa3_data->'advanceEnvelope') IS NOT DISTINCT FROM 'object' ELSE i.special_data IS NOT NULL END) AS dane FROM ksef_submissions s JOIN invoices i ON i.id = s.invoice_id WHERE s.status IN ('sent','intent') AND s.attempted_at < now() - interval '48 hours' AND i.ksef_status IN ('failed','rejected')) x GROUP BY 1,2,3,4 ORDER BY 1,2,3,4"
printf -- '--- ostatni przebieg cyklu życia (worker, 30 min): skippedNoData / skippedNoNip / skippedHeld / skippedIssueDate / skippedConflict\n'
"${SSH[@]}" "root@$APP" \
  "W=\$(docker ps --format '{{.Names}}' | grep '^$WORKER_PREFIX' | head -1); \
   if [ -z \"\$W\" ]; then echo '  (brak kontenera workera)'; exit 0; fi; \
   docker logs --since 30m \"\$W\" 2>&1 | grep 'przebieg zakończony' | tail -1" \
  || echo "  (nie udało się odczytać logu workera)"
# A5 #2: decyzje bez śladu w bazie (I5 po limicie i poza failed/rejected,
# odmowy budowy zlecenia) — log jest jedynym miejscem z invoiceId; Sentry ma
# najwyżej 20 na rodzaj. Ostrzeżenia idą na stderr kontenera: stąd 2>&1.
# Bez znacznika czasu i numeru joba, żeby dwa przebiegi z okna dały jeden
# wpis; najpierw WARN (czeka na człowieka), potem info (stany oczekiwane).
# Pusta lista znaczy „brak” tylko wtedy, gdy ostatni przebieg doszedł do
# I5–I7 (`"paused":false`) — przy wyłączniku cron ich nie sprawdza.
printf -- '--- cykl życia, 30 min: faktury bez akcji automatu (invoiceId, invariant, reason / status, attempts)\n'
"${SSH[@]}" "root@$APP" \
  "W=\$(docker ps --format '{{.Names}}' | grep '^$WORKER_PREFIX' | head -1); \
   if [ -z \"\$W\" ]; then echo '  (brak kontenera workera)'; exit 0; fi; \
   L=\$(docker logs --since 30m \"\$W\" 2>&1) || { echo '  (nie udało się odczytać logu workera)'; exit 0; }; \
   R=\$(printf '%s\n' \"\$L\" | grep 'przebieg zakończony' | tail -1); \
   E=\$(printf '%s\n' \"\$L\" | grep -E 'Cykl życia: (I5 |faktury nie da się|korekta czeka)' \
     | sed -E 's/^\[[^]]*\] \[[^]]*\] //' | sort -u | sort -s -k1,1r); \
   N=\$(printf '%s\n' \"\$E\" | grep -c .); \
   if [ \"\$N\" -gt 0 ]; then \
     printf '%s\n' \"\$E\" | head -200; \
     if [ \"\$N\" -gt 200 ]; then echo \"  (pokazano 200 z \$N; reszta: docker logs workera z 2>&1)\"; fi; \
   else case \"\$R\" in \
     *'\"paused\":false'*) echo '  (brak — ostatni przebieg sprawdził I5–I7)' ;; \
     '') echo '  (brak przebiegu crona w 30 min — lista nic nie mówi)' ;; \
     *) echo '  (pusto, ale ostatni przebieg nie sprawdzał I5–I7: wyłącznik wysyłek włączony albo nieczytelny)' ;; \
   esac; fi" \
  || echo "  (nie udało się odczytać logu workera)"
# PATCH bez tokenu (rola anon) na nieistniejące id — niczego nie zmienia, ale
# PostgREST sprawdza kolumny treści zapisu w swoim cache schematu. SELECT
# kolumny tego nie wykrywa (puszcza go do Postgresa).
printf -- '--- PostgREST zna special_data? (42501 = tak; PGRST204 = nie zna kolumny: brak migracji albo NOTIFY pgrst)\n'
"${SSH[@]}" "root@$DB" \
  "IP=\$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $RESTC); \
   curl -s -X PATCH \"http://\$IP:3000/invoices?id=eq.00000000-0000-0000-0000-000000000000\" \
     -H 'Content-Type: application/json' -d '{\"special_data\":null}' -w ' (HTTP %{http_code})'; echo" \
  || echo "  (nie udało się odpytać PostgREST)"

section "10. duplikaty 440 i decyzja klienta (D-A4-1b-3 PR B, 00148; PR C, 00156)"
# Znacznik 440 = najnowszy wpis intent/sent z original_ksef_number (jak w
# ksef_duplicate_decision_blocker). (a) i (g) działają także przed 00148;
# (b) i (c) wymagają 00148 — przed nią (b) kończy się „zapytanie nieudane”,
# a (c) nie ma wierszy I5D. (h)–(p) to PR C: (h) wywołuje funkcje z 00156
# i przed nią kończy się „zapytanie nieudane”; (j) i (l) czytają I5R i I3K ze
# strażnika (przed 00156 pusto); (i), (k), (m), (n), (o), (p) to czysty odczyt
# znaczników i faktur, więc przed 00156 dają zero wierszy.
sql "(a) failed KSEF_DUPLICATE_RECONCILE: powód znacznika | środowisko danych oryginału | rodzaj | liczba (środowisko inne niż KSEF_ENV workera z sekcji 9 = I5D-env)" \
  "SELECT CASE WHEN m.jest IS NULL THEN '(brak znacznika 440)' WHEN m.powod IS NULL THEN '(znacznik bez original_check - sprzed 00144)' ELSE m.powod END AS powod, coalesce(m.env,'-') AS srodowisko, i.invoice_kind, count(*) FROM invoices i LEFT JOIN LATERAL (SELECT true AS jest, s.original_check->>'reason' AS powod, s.original_check->>'env' AS env FROM ksef_submissions s WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id AND s.status IN ('intent','sent') AND s.original_ksef_number IS NOT NULL ORDER BY s.attempted_at DESC NULLS LAST, s.id LIMIT 1) m ON true WHERE i.direction='outgoing' AND i.ksef_status='failed' AND i.last_error_code='KSEF_DUPLICATE_RECONCILE' GROUP BY 1,2,3 ORDER BY 1,2,3"
sql "(b) failed KSEF_DUPLICATE_RECONCILE wg blokady decyzji: blokada | liczba ((czeka na klienta) = I5D; payments — wpłaty, runbook i zgoda Bartosza; known-stale — sprawdź dokument Y; po 00148. Od 00156: provenance-review = I5R, przegląd pliku; recheck-needed = I5, cron robi nowy werdykt; known-now = I5, cron; cross-tenant = runbook Oryginał w innej firmie)" \
  "SELECT coalesce(public.ksef_duplicate_decision_blocker(i.id, i.tenant_id), '(czeka na klienta)') AS blokada, count(*) FROM invoices i WHERE i.direction='outgoing' AND i.ksef_status='failed' AND i.last_error_code='KSEF_DUPLICATE_RECONCILE' GROUP BY 1 ORDER BY 1"
sql "(c) I5D — czekają na decyzję klienta: środowisko danych oryginału | liczba | najstarsza próba (inne niż KSEF_ENV workera = I5D-env, alarm krytyczny; przed przełączeniem TEST → PROD: ile z env test)" \
  "SELECT coalesce(v.detail->>'env','(brak)') AS srodowisko, count(*), min(v.detail->>'attempted_at') AS najstarsza_proba FROM public.ksef_lifecycle_violations() v WHERE v.invariant='I5D' GROUP BY 1 ORDER BY 1"
sql "(d) powiadomienia „czeka na Twoją decyzję” z 30 dni: kto (auto = pierwszy e-mail, operator = Przypomnij klientowi) | liczba | faktur | ostatnie" \
  "SELECT coalesce(metadata->>'via','(brak)') AS kto, count(*), count(DISTINCT entity_id) AS faktur, max(created_at) AS ostatnie FROM audit_logs WHERE action='invoice.ksef_duplicate_decision_notified' AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1"
sql "(e) decyzje z 7 dni: wybór | powód | kto (client / operator) | liczba" \
  "SELECT coalesce(details_json->>'choice','?') AS wybor, coalesce(details_json->>'reason','?') AS powod, coalesce(details_json->>'via','?') AS kto, count(*) FROM audit_logs WHERE action='invoice.ksef_duplicate_decided' AND created_at > now() - interval '7 days' GROUP BY 1,2,3 ORDER BY 1,2,3"
sql "(f) decyzje known-number z 30 dni — sprawdź dokument Y w KSeF i w FaktWay (runbook; naprawa Y tylko za zgodą Bartosza): firma | faktura | numer | numer KSeF oryginału | Y id | Y numer | Y stan | Y ma numer KSeF oryginału | wybór | kiedy" \
  "SELECT a.tenant_id, a.entity_id AS faktura, a.details_json->'retired'->>'internal_number' AS numer, a.details_json->'original'->>'ksef_number' AS numer_ksef_oryginalu, a.details_json->'original'->'known_invoice'->>'id' AS y_id, a.details_json->'original'->'known_invoice'->>'internalNumber' AS y_numer, coalesce(y.ksef_status::text,'(brak Y)') AS y_stan, (y.ksef_number IS NOT DISTINCT FROM a.details_json->'original'->>'ksef_number') AS y_ma_numer_k, a.details_json->>'choice' AS wybor, a.created_at FROM audit_logs a LEFT JOIN invoices y ON y.id::text = a.details_json->'original'->'known_invoice'->>'id' AND y.tenant_id = a.tenant_id WHERE a.action='invoice.ksef_duplicate_decided' AND a.details_json->>'reason'='known-number' AND a.created_at > now() - interval '30 days' ORDER BY a.created_at DESC LIMIT 50"
sql "(g) szkice z wpisem number_taken (wycofane): rodzaj | skąd (decyzja klienta / automat KSEF_NUMBER_TAKEN) | co blokuje 00148 | liczba" \
  "SELECT i.invoice_kind, CASE WHEN EXISTS (SELECT 1 FROM ksef_submissions s WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id AND s.status='number_taken' AND coalesce(s.original_check ? 'decision', false)) THEN 'decyzja klienta' ELSE 'automat KSEF_NUMBER_TAKEN' END AS skad, CASE WHEN i.invoice_kind IN ('regular','advance') THEN 'trzyma numer: bez wysylki, usuwania i zmiany numeru' ELSE 'bez wysylki i zmiany numeru; klient moze usunac (07.10 (9))' END AS po_00148, count(*) FROM invoices i WHERE i.direction='outgoing' AND i.ksef_status='draft' AND EXISTS (SELECT 1 FROM ksef_submissions s WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id AND s.status='number_taken') GROUP BY 1,2,3 ORDER BY 1,2"

# D-A4-1b-3 PR C (00156): oryginał z oznaczeniem naszego programu (powód
# faktflow-original). Runbook: ksef-error-codes.md, sekcja „D-A4-1b-3 PR C”.
# Tylko odczyt.
sql "(h) faktflow-original wg oferty i blokady (po 00156): brama | rodzaj bramy | recheckNeeded.kind | oferta | blokada | liczba (pair/record/released i (czeka na klienta) = I5D; review-* i provenance-review = I5R, przegląd pliku; recheck-needed = I5, cron robi nowy werdykt; known-now = I5, cron; cross-tenant = runbook „Oryginał w innej firmie”; przy braku bramy albo recheckNeeded blokada recheck-needed wygrywa z ofertą)" \
  "SELECT CASE WHEN public.ksef_duplicate_gate_ok(m.oc->'importGate') THEN 'poprawna' ELSE 'brak albo zly ksztalt' END AS brama, coalesce(m.oc->'importGate'->>'kind','-') AS rodzaj, coalesce(m.oc->'recheckNeeded'->>'kind','-') AS recheck_kind, coalesce(public.ksef_duplicate_original_offer(m.oc, public.ksef_duplicate_own_history(i.id, i.tenant_id, m.sess, m.oc->>'sha256')),'-') AS oferta, coalesce(public.ksef_duplicate_decision_blocker(i.id, i.tenant_id),'(czeka na klienta)') AS blokada, count(*) FROM invoices i CROSS JOIN LATERAL (SELECT s.original_check AS oc, s.original_session_reference_number AS sess FROM ksef_submissions s WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id AND s.status IN ('intent','sent') AND s.original_ksef_number IS NOT NULL ORDER BY s.attempted_at DESC NULLS LAST, s.id LIMIT 1) m WHERE i.direction='outgoing' AND i.ksef_status='failed' AND i.last_error_code='KSEF_DUPLICATE_RECONCILE' AND m.oc->>'reason'='faktflow-original' GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5"
sql "(i) wersje reguł bramy: wersja zapisana na znaczniku | rodzaj | liczba | najstarsze sprawdzenie (porównaj z ORIGINAL_GATE_RULES w lib/ksef/duplicate-check.ts; review z niższą wersją po podbiciu reguł: „Tylko uzgodnij” może zmienić je w importable; importable z niższą wersją nie wymaga nic)" \
  "SELECT coalesce(m.oc->'importGate'->>'rules','-') AS wersja_regul, coalesce(m.oc->'importGate'->>'kind','-') AS rodzaj, count(*), min(m.oc->>'checkedAt') AS najstarsze_sprawdzenie FROM invoices i CROSS JOIN LATERAL (SELECT s.original_check AS oc, s.original_session_reference_number AS sess FROM ksef_submissions s WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id AND s.status IN ('intent','sent') AND s.original_ksef_number IS NOT NULL ORDER BY s.attempted_at DESC NULLS LAST, s.id LIMIT 1) m WHERE i.direction='outgoing' AND i.ksef_status='failed' AND i.last_error_code='KSEF_DUPLICATE_RECONCILE' AND m.oc->>'reason'='faktflow-original' GROUP BY 1,2 ORDER BY 1,2"
sql "(j) I5R (przegląd pliku przez operatora) z wiekiem: faktura | numer KSeF oryginału | problemy bramy | sprawdzono | godzin od sprawdzenia | stan (ALARM I5R-72h po 72 h od checkedAt; brak albo nieczytelna data = alarm od razu; „Tylko uzgodnij”, które pobierze plik, zaczyna 72 h od nowa)" \
  "SELECT v.invoice_id, v.detail->>'original_ksef_number' AS numer_ksef_oryginalu, v.detail->>'problems' AS problemy, v.detail->>'checked_at' AS sprawdzono, CASE WHEN coalesce(v.detail->>'checked_at','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN round(extract(epoch FROM now() - (v.detail->>'checked_at')::timestamptz) / 3600) END AS godzin, CASE WHEN coalesce(v.detail->>'checked_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN 'ALARM I5R-72h (brak daty sprawdzenia)' WHEN now() - (v.detail->>'checked_at')::timestamptz > interval '72 hours' THEN 'ALARM I5R-72h' ELSE 'w terminie' END AS stan FROM public.ksef_lifecycle_violations() v WHERE v.invariant='I5R' ORDER BY 5 DESC NULLS FIRST LIMIT 50"
sql "(k) faktury zapisane decyzją przy 440 (origin ksef_import, fa3_data.import.source = ksef_duplicate_decision): UPO wg statusu | bez daty nadania | bez sesji oryginału | liczba (bez daty = skrypt oryginal-ksef-data-nadania.sh; bez sesji = UPO ręcznie)" \
  "SELECT coalesce(u.status::text,'(brak wiersza UPO)') AS upo, (k.ksef_accepted_at IS NULL) AS bez_daty, NOT EXISTS (SELECT 1 FROM ksef_submissions s WHERE s.invoice_id = k.id AND s.tenant_id = k.tenant_id AND s.response_ksef_number = k.ksef_number AND s.session_reference_number IS NOT NULL) AS bez_sesji, count(*) FROM invoices k LEFT JOIN upo_receipts u ON u.invoice_id = k.id WHERE k.direction='outgoing' AND k.origin='ksef_import' AND k.fa3_data->'import'->>'source'='ksef_duplicate_decision' GROUP BY 1,2,3 ORDER BY 1,2,3"
sql "(l) I3K (faktura zapisana z KSeF bez sesji UPO albo bez daty nadania; do 50): faktura K | numer KSeF | bez sesji | bez daty | status UPO" \
  "SELECT v.invoice_id, v.detail->>'ksef_number' AS numer_ksef, v.detail->>'no_session' AS bez_sesji, v.detail->>'no_date' AS bez_daty, coalesce(v.detail->>'upo_status','(brak)') AS upo FROM public.ksef_lifecycle_violations() v WHERE v.invariant='I3K' ORDER BY 1 LIMIT 50"
sql "(m) szkice wycofane bez numeru po zapisie oryginału (draft, internal_number NULL, wpis number_taken z decyzją importedInvoiceId; jeden wiersz na dokument; do 50): dokument X | firma | dawny numer | faktura K z KSeF" \
  "SELECT z.dokument_x, z.tenant_id, z.dawny_numer, z.faktura_k FROM (SELECT DISTINCT ON (x.id) x.id AS dokument_x, x.tenant_id, m.original_check->'decision'->>'retiredInternalNumber' AS dawny_numer, m.original_check->'decision'->>'importedInvoiceId' AS faktura_k, m.original_check->'decision'->>'at' AS kiedy FROM invoices x JOIN ksef_submissions m ON m.invoice_id = x.id AND m.tenant_id = x.tenant_id AND m.status='number_taken' AND m.original_check->'decision' ? 'importedInvoiceId' WHERE x.direction='outgoing' AND x.ksef_status='draft' AND x.internal_number IS NULL ORDER BY x.id, m.original_check->'decision'->>'at' DESC NULLS LAST) z ORDER BY z.kiedy DESC NULLS LAST, z.dokument_x LIMIT 50"
sql "(n) spójność: każde decision.importedInvoiceId wskazuje fakturę K accepted z ksef_number = original_ksef_number (oczekiwane niespójnych = 0; zapis jest atomowy, więc > 0 to błąd programu albo ręczna zmiana; zgłoś Bartoszowi; liczone po fakturach K, nie po wpisach: decyzja stoi na każdym otwartym wpisie dokumentu X): decyzji z zapisem (faktur K) | niespójnych (faktur K)" \
  "SELECT count(DISTINCT k_id) AS decyzji_z_zapisem, count(DISTINCT k_id) FILTER (WHERE problem IS NOT NULL) AS niespojnych FROM (SELECT m.original_check->'decision'->>'importedInvoiceId' AS k_id, CASE WHEN k.id IS NULL THEN 'brak K' WHEN k.tenant_id <> m.tenant_id THEN 'K innej firmy' WHEN k.ksef_status <> 'accepted' THEN 'K nie jest przyjeta' WHEN k.ksef_number IS DISTINCT FROM m.original_ksef_number THEN 'inny numer KSeF' WHEN k.origin <> 'ksef_import' THEN 'K nie jest z importu' WHEN x.ksef_status <> 'draft' OR x.internal_number IS NOT NULL THEN 'X nie jest szkicem bez numeru' END AS problem FROM ksef_submissions m LEFT JOIN invoices k ON k.id::text = m.original_check->'decision'->>'importedInvoiceId' LEFT JOIN invoices x ON x.id = m.invoice_id WHERE m.status='number_taken' AND m.original_check->'decision' ? 'importedInvoiceId') z"
sql "(n2) spójność, wiersze niespójne (do 20; jeden wiersz na dokument X i fakturę K): dokument X | faktura K z decyzji | problem" \
  "SELECT DISTINCT m.invoice_id AS dokument_x, m.original_check->'decision'->>'importedInvoiceId' AS faktura_k, CASE WHEN k.id IS NULL THEN 'brak K' WHEN k.tenant_id <> m.tenant_id THEN 'K innej firmy' WHEN k.ksef_status <> 'accepted' THEN 'K nie jest przyjeta' WHEN k.ksef_number IS DISTINCT FROM m.original_ksef_number THEN 'inny numer KSeF' WHEN k.origin <> 'ksef_import' THEN 'K nie jest z importu' WHEN x.ksef_status <> 'draft' OR x.internal_number IS NOT NULL THEN 'X nie jest szkicem bez numeru' END AS problem FROM ksef_submissions m LEFT JOIN invoices k ON k.id::text = m.original_check->'decision'->>'importedInvoiceId' LEFT JOIN invoices x ON x.id = m.invoice_id WHERE m.status='number_taken' AND m.original_check->'decision' ? 'importedInvoiceId' AND (k.id IS NULL OR k.tenant_id <> m.tenant_id OR k.ksef_status <> 'accepted' OR k.ksef_number IS DISTINCT FROM m.original_ksef_number OR k.origin <> 'ksef_import' OR x.ksef_status <> 'draft' OR x.internal_number IS NOT NULL) LIMIT 20"
sql "(o) decyzje przy faktflow-original (znaczniki number_taken z decision): tryb (import = zapis K, no-import = decyzja oddana klientowi) | oferta | wybór | kto (client / operator) | po oddaniu przez operatora | decyzji (dokumentów X) | ostatnia" \
  "SELECT coalesce(m.original_check->'decision'->>'mode','?') AS tryb, coalesce(m.original_check->'decision'->>'offer','-') AS oferta, coalesce(m.original_check->'decision'->>'choice','?') AS wybor, coalesce(m.original_check->'decision'->>'via','?') AS kto, (m.original_check->'importGate' ? 'release') AS po_oddaniu, count(DISTINCT m.invoice_id) AS decyzji, max(m.original_check->'decision'->>'at') AS ostatnia FROM ksef_submissions m WHERE m.status='number_taken' AND m.original_check->>'reason'='faktflow-original' AND m.original_check ? 'decision' GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5"
sql "(p) oddania jeszcze bez decyzji klienta (importGate.release na otwartym znaczniku; do 20): faktura | numer KSeF oryginału | oddano | aktor (id)" \
  "SELECT m.invoice_id, m.original_ksef_number, m.original_check->'importGate'->'release'->>'at' AS oddano, m.original_check->'importGate'->'release'->>'actorUserId' AS aktor FROM ksef_submissions m WHERE m.status IN ('intent','sent') AND m.original_check->>'reason'='faktflow-original' AND m.original_check->'importGate' ? 'release' AND NOT (m.original_check ? 'decision') ORDER BY m.original_check->'importGate'->'release'->>'at' DESC LIMIT 20"

section "11. db-1: ostatnie migracje"
sql "schema_migrations" \
  "SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 5"

section "12. db-1: dziennik prób wysyłki (A5, 00150) — błędy, odmowy i przerwane z 24 h"
# Progi jak /admin/centrum/bledy (lib/admin/centrum/send-errors.ts): przerwane
# = `started` bez wyniku po 20 min (worker padł albo zapis wyniku się nie
# udał), „utknęła” = `sending` bez znacznika przejęcia albo starsze niż 30 min
# (I2). Bez tabeli jeden komunikat zamiast serii „zapytanie nieudane”;
# nieudana sonda to „nie wiadomo”, nigdy „pusty dziennik”.
# Sonda to jedyne miejsce sekcji, gdzie skrypt czyta wynik psql: `-At` daje
# samo `t`/`f`, `-X` pomija .psqlrc.
LEDGER=$("${SSH[@]}" "root@$DB" \
  "docker exec $PGC psql -X -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c \"SELECT to_regclass('public.ksef_send_attempts') IS NOT NULL\"") \
  || LEDGER=""
case "$LEDGER" in
  t)
    sql "zakres dziennika: od | ostatni wpis | wierszy z 24 h (puste = dziennik pusty; czy nie było wysyłek, czy dziennik nie pisze — następny wiersz)" \
      "SELECT coalesce((SELECT min(started_at) FROM ksef_send_attempts)::text, '(pusty)') AS od, coalesce((SELECT max(started_at) FROM ksef_send_attempts)::text, '-') AS ostatni_wpis, (SELECT count(*) FROM ksef_send_attempts WHERE started_at > now() - interval '24 hours') AS z_24h"
    # inngest_run_log: wiersz na każde zakończone wykonanie joba (run_id = id joba
    # pg-boss = ksef_send_attempts.job_id) — niezależnie od dziennika.
    sql "wykonania joba wysyłki z 24 h (inngest_run_log) | bez wiersza w dzienniku (> 0 = dziennik nie pisze: worker bez A5 — SHA w sekcji 1 — albo nieudany zapis, logi niżej; w pierwszej dobie po wdrożeniu A5 także wykonania starego workera)" \
      "SELECT count(*) AS wykonan, count(*) FILTER (WHERE a.run_id IS NULL) AS bez_wiersza FROM inngest_run_log l LEFT JOIN (SELECT DISTINCT job_id::text AS run_id FROM ksef_send_attempts WHERE job_id IS NOT NULL AND started_at > now() - interval '25 hours') a ON a.run_id = l.run_id WHERE l.event_name='invoice.submit.requested' AND l.created_at > now() - interval '24 hours'"
    sql "wykonania z 24 h wg stanu: stan | prób | faktur (przerwane = started bez wyniku po 20 min; refused = odmowa przed kolejką, poza skutecznością wysyłki)" \
      "SELECT CASE WHEN status='started' AND finished_at IS NULL AND started_at < now() - interval '20 minutes' THEN 'przerwane' ELSE status END AS stan, count(*), count(DISTINCT invoice_id) AS faktur FROM ksef_send_attempts WHERE started_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1"
    sql "błędy, odmowy i przerwane z 24 h wg kodu: stan | etap | kod | klasa | HTTP | kod KSeF | prób | faktur | firm | faktury teraz: przyjęte | z błędem | utknęły (operator) | w toku | inne (szkic, nieznany) | ostatnio" \
      "SELECT stan, etap, kod, klasa, http, kod_ksef, sum(prob) AS prob, count(*) AS faktur, count(DISTINCT tenant_id) AS firm, count(*) FILTER (WHERE teraz='przyjeta') AS przyjete, count(*) FILTER (WHERE teraz='z bledem') AS z_bledem, count(*) FILTER (WHERE teraz='utknela') AS utknely, count(*) FILTER (WHERE teraz='w toku') AS w_toku, count(*) FILTER (WHERE teraz='inny') AS inne, max(ostatnio) AS ostatnio FROM (SELECT CASE WHEN a.status='started' AND a.finished_at IS NULL AND a.started_at < now() - interval '20 minutes' THEN 'przerwane' ELSE a.status END AS stan, a.stage AS etap, coalesce(a.error_code,'-') AS kod, coalesce(a.error_class,'-') AS klasa, coalesce(a.ksef_http_status::text,'-') AS http, coalesce(a.ksef_code::text,'-') AS kod_ksef, a.invoice_id, a.tenant_id, count(*) AS prob, max(a.started_at) AS ostatnio, CASE WHEN i.ksef_status='accepted' THEN 'przyjeta' WHEN i.ksef_status IN ('failed','rejected') THEN 'z bledem' WHEN i.ksef_status='sending' AND (i.submitted_to_ksef_at IS NULL OR i.submitted_to_ksef_at < now() - interval '30 minutes') THEN 'utknela' WHEN i.ksef_status IN ('queued','offline_queued','sending') THEN 'w toku' ELSE 'inny' END AS teraz FROM ksef_send_attempts a JOIN invoices i ON i.id = a.invoice_id WHERE a.started_at > now() - interval '24 hours' AND (a.status IN ('failed','refused') OR (a.status='started' AND a.finished_at IS NULL AND a.started_at < now() - interval '20 minutes')) GROUP BY 1,2,3,4,5,6,7,8,11) x GROUP BY 1,2,3,4,5,6 ORDER BY 7 DESC, 1, 3 LIMIT 40"
    sql "ostatnie błędy, odmowy i przerwane z 24 h (20): kiedy | stan | etap | kod | HTTP | kod KSeF | faktura | numer | wykonanie (od 0) | stan faktury teraz | treść (zamaskowana, 120 znaków)" \
      "SELECT a.started_at, CASE WHEN a.status='started' AND a.finished_at IS NULL AND a.started_at < now() - interval '20 minutes' THEN 'przerwane' ELSE a.status END AS stan, a.stage, coalesce(a.error_code,'-') AS kod, coalesce(a.ksef_http_status::text,'-') AS http, coalesce(a.ksef_code::text,'-') AS kod_ksef, a.invoice_id, coalesce(i.internal_number,'-') AS numer, a.execution, coalesce(i.ksef_status::text,'(null)') AS teraz, left(replace(replace(coalesce(a.error_message,'-'), chr(10), ' '), chr(13), ' '), 120) AS tresc FROM ksef_send_attempts a JOIN invoices i ON i.id = a.invoice_id WHERE a.started_at > now() - interval '24 hours' AND (a.status IN ('failed','refused') OR (a.status='started' AND a.finished_at IS NULL AND a.started_at < now() - interval '20 minutes')) ORDER BY a.started_at DESC LIMIT 20"
    ;;
  f)
    echo "  BRAK TABELI ksef_send_attempts — migracja 00150 (A5) niewgrana na db-1: dziennika prób nie ma, więc nie wiadomo, czy były błędy. Wgrywanie: AGENTS.md → „Wgrywanie migracji”; stan migracji: sekcja 11."
    ;;
  *)
    echo "  (nie wiadomo: nie udało się sprawdzić tabeli ksef_send_attempts — sekcja pominięta; to NIE znaczy „brak błędów”)"
    ;;
esac
# Zapis do dziennika jest fail-open: nieudany zapis nie zatrzymuje wysyłki.
# Brak wierszy pokazuje zestawienie z inngest_run_log wyżej; logi mówią, czy
# zapis się nie udał — ale tylko od startu kontenera (wdrożenie usuwa stary
# kontener razem z logami). Ostrzeżenia idą na stderr kontenera: stąd 2>&1.
printf -- '--- logi od startu kontenera, najwyżej 24 h (czas startu przy nazwie): ksef.send.attempt = wyniki wykonań w tym oknie; zapis nieudany > 0 = dziennik niepełny, 0 nie mówi nic o czasie sprzed startu (wtedy Sentry: „dziennik prób wysyłki — zapis nieudany”)\n'
"${SSH[@]}" "root@$APP" \
  "N=0; for C in \$(docker ps --format '{{.Names}}' | grep -E '^($WORKER_PREFIX|$APP_PREFIX)'); do N=1; \
     echo \"  \$C (start \$(docker inspect -f '{{.State.StartedAt}}' \"\$C\")): ksef.send.attempt \$(docker logs --since 24h \"\$C\" 2>&1 | grep -cF 'ksef.send.attempt'), zapis nieudany \$(docker logs --since 24h \"\$C\" 2>&1 | grep -cE 'Dziennik prób wysyłki KSeF: (zapis|opis porażki) nieudany|zapis odmowy przed kolejką nieudany')\"; \
   done; [ \$N = 1 ] || echo '  (brak kontenerów aplikacji i workera)'" \
  || echo "  (nie udało się odczytać logów)"

printf '\nKoniec. Skrypt niczego nie zmienił.\n'
