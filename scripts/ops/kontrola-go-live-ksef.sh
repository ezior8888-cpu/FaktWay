#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Kontrola przełączenia KSeF z TEST na PROD — TYLKO ODCZYT
# ────────────────────────────────────────────────────────────────
# Jedna linia, bez argumentów, z katalogu repo:
#
#   ./scripts/ops/kontrola-go-live-ksef.sh
#
# Runbook: docs/runbooks/go-live-ksef-prod.md (plan „zero zgubionych
# faktur”, karta F1). Oczekiwane wartości są w etykietach wyniku, numer
# kroku runbooka w nagłówku sekcji. Ten sam skrypt przed oknem (krok 1),
# w oknie (kroki 5, 8, 9, 10) i po otwarciu (kroki 11, 12).
#
# Skrypt sam ładuje `.agents/infra.env` (K, APP, DB, PGC, RESTC, APP_PREFIX,
# WORKER_PREFIX) — przycisk „Run” w aplikacji uruchamia każdy blok w świeżej
# powłoce, więc osobne `source` nic nie daje. Adresów serwerów tu nie ma
# (repo jest publiczne). Nic nie zmienia na serwerach: `docker ps`,
# `docker inspect` (ze zmiennych kontenerów wychodzą tylko nazwy z listy
# w sekcji 1 — filtr po stronie serwera; GUS_API_KEY tylko jako „ustawione”
# albo „brak”) i SELECT-y przez psql w transakcji tylko do odczytu z limitem
# 30 s. Nie ma go na liście poleceń, które agent uruchamia bez pytania
# (.claude/settings.json).
#
# Co pokazuje:
#   1. KSEF_ENV i zmienne sąsiednie workera i aplikacji (krok 8)
#   2. flagi globalne; firmy z Księgowością JDG i fakturami spoza PROD
#      (kroki 2, 4, 6, 11)
#   3. bramka zero w jednym wierszu; faktury w drodze, żywe zlecenia
#      pg-boss, otwarte wpisy Offline24 (krok 5)
#   4. failed wg klasy i kodu; lista failed poza klasą terminal (kroki 3, 5)
#   5. otwarte wpisy wysyłki (sent, intent) przy failed/rejected (kroki 3, 5)
#   6. firmy wg środowiska weryfikacji certyfikatu (krok 10)
#   7. przyjęte wg kierunku i środowiska; firmy z fakturami spoza PROD;
#      przypomnienia do faktur spoza PROD (§2.2 runbooka, D1, F1-f)
#   8. lejek: first_invoice_accepted_at a faktury PROD (krok 9)
#   9. kursory skrzynki (decyzja D5)
#  10. ostatnie 24 h: ENV_MISMATCH, NOT_VERIFIED, przyjęte na PROD, UPO
#      faktur PROD (kroki 11, 12)
#
# Błąd jednego zapytania nie przerywa reszty (np. kolumna sprzed migracji).
# ════════════════════════════════════════════════════════════════
set -euo pipefail

# Gdzie leży `.agents/infra.env`: zmienna FAKTFLOW_INFRA_ENV, katalog tego
# repo, a dla worktree (`.claude/worktrees/*`) — główny checkout, bo plik jest
# poza gitem i worktree go nie ma. Ścieżka bezwzględna jak w
# scripts/dev/przygotuj-worktree.sh: Git Bash na Windowsie podaje `C:/…`,
# czego `case /*` nie rozpoznaje. Nieudane `cd` nie przerywa skryptu, bo
# wtedy zostają pozostałe miejsca.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git >/dev/null 2>&1; then
  COMMON_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    MAIN_ROOT=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd) || MAIN_ROOT=""
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
# i znaku dolara — przechodzi przez dwie powłoki. PGOPTIONS: transakcja tylko
# do odczytu i limit 30 s, jak w kontrola-faktur-ksef.sh.
sql() {
  local label=$1 query=$2
  printf -- '--- %s\n' "$label"
  "${SSH[@]}" "root@$DB" \
    "docker exec -e 'PGOPTIONS=-c statement_timeout=30s -c default_transaction_read_only=on' $PGC psql -U postgres -d postgres -At -F' | ' -v ON_ERROR_STOP=1 -c \"$query\"" \
    || echo "  (zapytanie nieudane — brak tabeli/kolumny albo brak dostępu)"
}

# Zmienne kontenera na app-1: tylko nazwy z listy (filtr po stronie serwera,
# reszta env nie wychodzi z serwera). GUS_API_KEY to klucz, więc tylko
# „ustawione” albo „brak”. Dwa ostrzeżenia z lib/ksef/client.ts
# i claim-environment.ts: brak KSEF_ENV oraz KSEF_PROD_URL inne niż oficjalny
# adres. Puste `KSEF_PROD_URL=` też psuje środowisko, bo `??` w kodzie
# zastępuje tylko brak zmiennej, a pusty adres nie jest adresem.
container_env() {
  local label=$1 prefix=$2
  printf -- '--- %s\n' "$label"
  "${SSH[@]}" "root@$APP" \
    "C=\$(docker ps --format '{{.Names}}' | grep '^$prefix' | head -1); \
     if [ -z \"\$C\" ]; then echo '  (brak kontenera)'; exit 0; fi; \
     E=\$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"\$C\"); \
     printf '%s\n' \"\$E\" | grep -E '^(KSEF_ENV|KSEF_PROD_URL|KSEF_TEST_URL|KSEF_DEMO_URL|JPK_MF_ENV|WORKER_DISABLE_SCHEDULES|JOBS_BACKEND)=' \
       || echo '  (żadna z tych zmiennych nie jest ustawiona)'; \
     printf '%s\n' \"\$E\" | grep -q '^KSEF_ENV=' || echo '  UWAGA: brak KSEF_ENV, środowisko nieustawione (runbook §2.3)'; \
     if printf '%s\n' \"\$E\" | grep '^KSEF_PROD_URL=' | grep -qvxF 'KSEF_PROD_URL=https://api.ksef.mf.gov.pl/v2'; then echo '  UWAGA: KSEF_PROD_URL inne niż oficjalny adres (także puste): przy KSEF_ENV=production środowisko nieustawione (runbook §2.3)'; fi; \
     if printf '%s\n' \"\$E\" | grep -q '^GUS_API_KEY=.'; then echo '  GUS_API_KEY: ustawione'; else echo '  GUS_API_KEY: brak'; fi" \
    || echo "  (nie udało się odczytać zmiennych kontenera)"
}

section "1. app-1: KSEF_ENV workera i aplikacji (krok 8)"
# Przed krokiem 7 oba KSEF_ENV=test. Po kroku 7 oba KSEF_ENV=production,
# KSEF_PROD_URL nieobecne albo dokładnie https://api.ksef.mf.gov.pl/v2 (bez
# ukośnika na końcu; puste i każda inna wartość = środowisko nieustawione,
# runbook §2.3), WORKER_DISABLE_SCHEDULES nieobecne. Bez wierszy „UWAGA”.
# Różne KSEF_ENV workera i aplikacji = ENV_MISMATCH.
container_env "worker (Coolify id=2): KSEF_ENV taki sam jak w aplikacji" "$WORKER_PREFIX"
container_env "aplikacja (Coolify id=1)" "$APP_PREFIX"

section "2. db-1: flagi (kroki 2, 4, 6 i 11)"
sql "flagi globalne: flaga | włączona | zmiana | kto | notatka (w oknie killAllKsefSubmissions i maintenanceMode = t, po kroku 11 obie f)" \
  "SELECT flag, enabled, updated_at, coalesce(updated_by,'-'), left(coalesce(note,'-'), 80) FROM global_feature_flags ORDER BY flag"
sql "firmy z Księgowością JDG (ksiegowosc_enabled) i przyjętymi fakturami spoza PROD (po przełączeniu ewidencja odmówi im całego roku: killKsiegowosc albo decyzja D1)" \
  "SELECT count(*) FROM tenant_feature_flags f WHERE f.ksiegowosc_enabled AND EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = f.tenant_id AND i.ksef_status='accepted' AND i.ksef_environment IS DISTINCT FROM 'production')"

section "3. db-1: bramka zero (krok 5) — faktury w drodze, zlecenia, Offline24"
sql "(a) bramka: w drodze | zlecenia wysyłki w pg-boss | otwarte wpisy Offline24 | failed poza klasą terminal | otwarte wpisy wysyłki przy failed/rejected (przed zmianą KSEF_ENV wszystkie 0, inaczej krok 3)" \
  "SELECT (SELECT count(*) FROM invoices WHERE direction='outgoing' AND ksef_status IN ('queued','sending','offline_queued')), (SELECT count(*) FROM pgboss.job WHERE name='invoice.submit.requested' AND state IN ('created','retry','active')), (SELECT count(*) FROM ksef_offline_queue WHERE status IN ('queued','sending')), (SELECT count(*) FROM invoices i LEFT JOIN ksef_error_codes c ON c.code = i.last_error_code WHERE i.direction='outgoing' AND i.ksef_status='failed' AND c.class IS DISTINCT FROM 'terminal'), (SELECT count(*) FROM ksef_submissions s JOIN invoices i ON i.id = s.invoice_id AND i.tenant_id = s.tenant_id WHERE s.status IN ('sent','intent') AND i.ksef_status IN ('failed','rejected'))"
sql "(b) faktury w drodze: stan | liczba | najstarsza zmiana (utknięte queued i sending: zwolnij-utknieta-wysylke.sh; offline_queued: offline24-zalegle.md)" \
  "SELECT ksef_status, count(*), min(updated_at) FROM invoices WHERE direction='outgoing' AND ksef_status IN ('queued','sending','offline_queued') GROUP BY 1 ORDER BY 1"
sql "(c) żywe zlecenia pg-boss poza cronami: kolejka | stan | liczba (bramka: brak invoice.submit.requested; zlecenia skrzynki, historii i UPO z TEST po przełączeniu odmówią — szum, krok 12)" \
  "SELECT name, state, count(*) FROM pgboss.job WHERE state IN ('created','retry','active') AND left(name, 5) <> 'cron.' GROUP BY 1,2 ORDER BY 1,2"
sql "(d) otwarte wpisy Offline24: stan | środowisko | liczba (bramka: brak wierszy, offline24-zalegle.md)" \
  "SELECT status::text, coalesce(ksef_environment,'(null)'), count(*) FROM ksef_offline_queue WHERE status IN ('queued','sending') GROUP BY 1,2 ORDER BY 1,2"

section "4. db-1: faktury failed (kroki 3 i 5)"
sql "(a) failed wg klasy i kodu: klasa z ksef_error_codes | kod | liczba (terminal zostaje; reszta to bramka: po przełączeniu cron albo przycisk wyśle je już na PROD)" \
  "SELECT coalesce(c.class,'(spoza katalogu)'), coalesce(i.last_error_code,'(brak kodu)'), count(*) FROM invoices i LEFT JOIN ksef_error_codes c ON c.code = i.last_error_code WHERE i.direction='outgoing' AND i.ksef_status='failed' GROUP BY 1,2 ORDER BY 1,2"
sql "(b) failed poza klasą terminal (do 100): firma | faktura | numer | rodzaj | data wystawienia | kod | klasa | dowód kontaktu | ostatnia zmiana (co z którą: tabela w kroku 3 runbooka)" \
  "SELECT i.tenant_id, i.id, i.internal_number, i.invoice_kind, i.issue_date, coalesce(i.last_error_code,'(brak kodu)'), coalesce(c.class,'(spoza katalogu)'), ksef_has_contact_evidence(i.id, i.tenant_id), i.updated_at FROM invoices i LEFT JOIN ksef_error_codes c ON c.code = i.last_error_code WHERE i.direction='outgoing' AND i.ksef_status='failed' AND c.class IS DISTINCT FROM 'terminal' ORDER BY 7, 6, i.updated_at, i.id LIMIT 100"

section "5. db-1: otwarte wpisy wysyłki przy failed/rejected (kroki 3 i 5)"
sql "(a) stan faktury | stan wpisu | liczba | najstarsza próba (bramka: brak wierszy; Tylko uzgodnij jeszcze na TEST, po przełączeniu uzgadniałoby z PROD)" \
  "SELECT i.ksef_status, s.status, count(*), min(s.attempted_at) FROM ksef_submissions s JOIN invoices i ON i.id = s.invoice_id AND i.tenant_id = s.tenant_id WHERE s.status IN ('sent','intent') AND i.ksef_status IN ('failed','rejected') GROUP BY 1,2 ORDER BY 1,2"
sql "(b) lista (do 50): firma | faktura | numer | stan | kod | stan wpisu | próba" \
  "SELECT i.tenant_id, i.id, i.internal_number, i.ksef_status, coalesce(i.last_error_code,'(brak kodu)'), s.status, s.attempted_at FROM ksef_submissions s JOIN invoices i ON i.id = s.invoice_id AND i.tenant_id = s.tenant_id WHERE s.status IN ('sent','intent') AND i.ksef_status IN ('failed','rejected') ORDER BY s.attempted_at, i.id LIMIT 50"

section "6. db-1: firmy wg środowiska weryfikacji certyfikatu (krok 10)"
sql "środowisko | firmy (po przełączeniu production rośnie, gdy firmy weryfikują się na PROD; pozostałe widzą dane przykładowe i nie wyślą faktury)" \
  "SELECT coalesce(ksef_verified_environment,'(brak)'), count(*) FROM tenants WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1"

section "7. db-1: faktury spoza PROD (§2.2 runbooka, decyzje D1 i D6)"
sql "(a) przyjęte wg kierunku i środowiska" \
  "SELECT direction, coalesce(ksef_environment,'(null)'), count(*) FROM invoices WHERE ksef_status='accepted' GROUP BY 1,2 ORDER BY 1,2"
sql "(b) firmy z przyjętymi fakturami spoza PROD (do 200): firma | środowisko | sprzedaż | zakupy | najstarsza data wystawienia | najnowsza (po przełączeniu KPiR, eksporty i Księgowość JDG odmówią ich okresów)" \
  "SELECT i.tenant_id, coalesce(i.ksef_environment,'(null)'), count(*) FILTER (WHERE i.direction='outgoing'), count(*) FILTER (WHERE i.direction='incoming'), min(i.issue_date), max(i.issue_date) FROM invoices i WHERE i.ksef_status='accepted' AND i.ksef_environment IS DISTINCT FROM 'production' GROUP BY 1,2 ORDER BY 3 DESC, 1 LIMIT 200"
sql "(c) przypomnienia o płatności do faktur spoza PROD: faktury | firmy (warunki findInvoicesRequiringReminders; ustalenie F1-f: po przełączeniu nabywca dalej dostaje ponaglenia)" \
  "SELECT count(*), count(DISTINCT i.tenant_id) FROM invoices i WHERE i.direction='outgoing' AND i.ksef_status='accepted' AND i.invoice_kind IN ('regular','advance','final') AND i.origin='app' AND i.payment_status IN ('unpaid','partial','overdue') AND i.payment_due_date < current_date AND i.reminders_paused = false AND i.ksef_environment IS DISTINCT FROM 'production'"

section "8. db-1: lejek, first_invoice_accepted_at (krok 9: po nim oba 0)"
sql "(a) firmy z datą pierwszej faktury bez przyjętej faktury PROD (przed krokiem 9 to firmy z fakturą z TEST)" \
  "SELECT count(*) FROM tenants t WHERE t.first_invoice_accepted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = t.id AND i.direction='outgoing' AND i.ksef_status='accepted' AND i.origin='app' AND i.ksef_environment='production')"
sql "(b) firmy z przyjętą fakturą PROD bez daty pierwszej faktury (zawsze 0)" \
  "SELECT count(*) FROM tenants t WHERE t.first_invoice_accepted_at IS NULL AND EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = t.id AND i.direction='outgoing' AND i.ksef_status='accepted' AND i.origin='app' AND i.ksef_environment='production')"

section "9. db-1: kursory skrzynki (decyzja D5)"
sql "kursory | najstarszy HWM | najnowszy HWM (kursor jest jeden na firmę, bez środowiska: pierwsze okno PROD zacznie się od tego HWM)" \
  "SELECT count(*), min(window_to), max(window_to) FROM ksef_inbox_cursor"

section "10. db-1: ostatnie 24 h (kroki 11 i 12)"
sql "(a) failed ENV_MISMATCH i NOT_VERIFIED: kod | liczba (ENV_MISMATCH zawsze 0; NOT_VERIFIED tylko u firm przed weryfikacją PROD)" \
  "SELECT last_error_code, count(*) FROM invoices WHERE direction='outgoing' AND ksef_status='failed' AND last_error_code IN ('ENV_MISMATCH','NOT_VERIFIED') AND updated_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1"
sql "(b) przyjęte na PROD: kierunek | liczba | ostatnia (po kroku 11 sprzedaż rośnie)" \
  "SELECT direction, count(*), max(coalesce(ksef_accepted_at, created_at)) FROM invoices WHERE ksef_status='accepted' AND ksef_environment='production' AND coalesce(ksef_accepted_at, created_at) > now() - interval '24 hours' GROUP BY 1 ORDER BY 1"
sql "(c) UPO faktur PROD: stan | liczba (pierwsza faktura z kroku 11 ma UPO)" \
  "SELECT u.status, count(*) FROM upo_receipts u JOIN invoices i ON i.id = u.invoice_id AND i.tenant_id = u.tenant_id WHERE i.ksef_environment='production' GROUP BY 1 ORDER BY 1"

printf '\nKoniec. Skrypt niczego nie zmienił.\n'
