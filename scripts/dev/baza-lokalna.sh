#!/usr/bin/env bash
# Lokalna baza dla `pnpm dev`: Supabase w Dockerze (Colima) z migracjami z repo.
#
# Zastępuje projekt Supabase Cloud, na który celował .env.local. Ten projekt
# wygasł (23.10.2026 jego adres nie rozwiązywał się już w DNS), więc dev nie
# mógł się zalogować. Dane są wyłącznie na tym Macu, nic nie wygasa i nic nie
# trafia na produkcję.
#
#   pnpm dev:local         start (jak niżej) i od razu `next dev`
#   pnpm db:local          start; pierwszy raz pobiera obrazy (~4 GB),
#                          wgrywa migracje, zakłada konto dev, ustawia .env.local
#   pnpm db:local status   adresy i stan
#   pnpm db:local env      tylko ustawia .env.local na lokalną bazę
#   pnpm db:local stop     zatrzymuje kontenery (dane zostają)
#   pnpm db:local reset    KASUJE lokalne dane i stawia bazę od zera
#
# Kolejność jak w scripts/ci/rls-local.sh: funkcje `ops.*` z 00100 czytają
# `pgboss.job`, a schemat `pgboss` zakłada sam pg-boss. Na świeżej bazie musi
# więc powstać PRZED migracjami — dlatego start idzie bez migracji
# (SUPABASE_DB_MIGRATIONS_ENABLED=false), a migracje wgrywa `migration up`.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DB_CONTAINER="supabase_db_$(sed -n 's/^project_id = "\(.*\)"/\1/p' supabase/config.toml)"
# Usługi, których aplikacja nie używa (pliki idą przez S3/R2, nie Supabase Storage).
EXCLUDE="imgproxy,edge-runtime,logflare,vector,supavisor,storage-api"

# Konto testowe — tylko lokalna baza (GoTrue słucha na 127.0.0.1).
# NIP fikcyjny z AGENTS.md, nie prawdziwej firmy.
DEV_EMAIL="dev@faktway.test"
DEV_PASSWORD="FaktWayDev2026!"
DEV_COMPANY="Firma Testowa (dev)"
DEV_NIP="1234567890"

info() { printf '\033[2m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m✔\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

psql_local() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

ensure_docker() {
  if docker info >/dev/null 2>&1; then return; fi
  command -v colima >/dev/null || fail "Brak Dockera. Zainstaluj: brew install colima docker"
  if colima list 2>/dev/null | grep -q '^default'; then
    info "Uruchamiam Colimę…"
    colima start
  else
    info "Pierwsze uruchomienie Colimy (4 CPU, 6 GB RAM, 40 GB dysku)…"
    colima start --cpu 4 --memory 6 --disk 40 --vm-type vz --mount-type virtiofs
  fi
  docker info >/dev/null 2>&1 || fail "Docker nie odpowiada po starcie Colimy"
}

load_status() {
  eval "$(supabase status -o env 2>/dev/null)"
  [ -n "${API_URL:-}" ] && [ -n "${ANON_KEY:-}" ] && [ -n "${SERVICE_ROLE_KEY:-}" ] \
    || fail "Supabase nie działa — uruchom: pnpm db:local"
}

start_supabase() {
  command -v supabase >/dev/null || fail "Brak Supabase CLI. Zainstaluj: brew install supabase/tap/supabase"
  if supabase status >/dev/null 2>&1; then
    ok "Supabase już działa"
  else
    info "Uruchamiam Supabase (bez migracji)…"
    SUPABASE_DB_MIGRATIONS_ENABLED=false supabase start -x "$EXCLUDE"
  fi
}

ensure_pgboss_schema() {
  if [ "$(psql_local -c "SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss'")" = "1" ]; then return; fi
  [ -d node_modules/pg-boss ] || fail "Brak node_modules — uruchom najpierw: pnpm install"
  info "Zakładam schemat pg-boss…"
  DB_URL="$DB_URL" node --input-type=module -e "
import { PgBoss } from 'pg-boss';
const boss = new PgBoss({ connectionString: process.env.DB_URL, schema: 'pgboss', schedule: false, supervise: false });
await boss.start();
await boss.stop({ graceful: false, close: true });
"
  ok "Schemat pg-boss gotowy"
}

apply_migrations() {
  info "Wgrywam brakujące migracje…"
  # --include-all: numer z nowej gałęzi bywa niższy niż 00200, który już jest.
  if ! supabase migration up --local --include-all >/dev/null; then
    fail "Migracje nie weszły. Baza ma migracje spoza tej gałęzi? Wtedy: pnpm db:local reset"
  fi
  psql_local -c "NOTIFY pgrst, 'reload schema';" >/dev/null
  ok "Migracje: $(psql_local -c 'SELECT count(*) FROM supabase_migrations.schema_migrations') wgranych"
}

seed_dev_account() {
  load_status
  local user_id
  user_id="$(psql_local -c "SELECT id FROM auth.users WHERE email = '$DEV_EMAIL'")"
  if [ -z "$user_id" ]; then
    curl -sf -o /dev/null -X POST "$API_URL/auth/v1/admin/users" \
      -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\",\"email_confirm\":true}" \
      || fail "Nie udało się założyć konta $DEV_EMAIL w GoTrue"
  fi
  # Firma jak w createOrganizationAction: tenant + membership owner + aktywna org.
  psql_local >/dev/null <<SQL
DO \$\$
DECLARE
  v_user uuid;
  v_org uuid;
BEGIN
  SELECT id INTO v_user FROM auth.users WHERE email = '$DEV_EMAIL';
  SELECT organization_id INTO v_org FROM public.memberships
   WHERE user_id = v_user AND status = 'active' LIMIT 1;
  IF v_org IS NULL THEN
    INSERT INTO public.tenants (name, nip, address_json, is_active)
    VALUES ('$DEV_COMPANY', '$DEV_NIP',
            '{"countryCode":"PL","addressLine1":"ul. Testowa 1","addressLine2":"00-001 Warszawa"}', true)
    RETURNING id INTO v_org;
    INSERT INTO public.memberships (organization_id, user_id, role, status)
    VALUES (v_org, v_user, 'owner', 'active');
  END IF;
  UPDATE public.users SET last_active_tenant_id = v_org WHERE id = v_user;
END
\$\$;
SQL
  # Klamry: przy UTF-8 w terminalu bash dokleja „”” do nazwy zmiennej.
  ok "Konto dev: ${DEV_EMAIL} / ${DEV_PASSWORD} (firma „${DEV_COMPANY}”)"
}

set_env_var() {
  local key="$1" value="$2" file="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

write_env() {
  load_status
  local file=".env.local" main_root
  if [ ! -f "$file" ]; then
    # Worktree nie ma własnego .env.local — bierzemy klucze z głównego katalogu.
    main_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
    if [ -f "$main_root/.env.local" ]; then
      cp "$main_root/.env.local" "$file"
      info "Skopiowano .env.local z $main_root"
    else
      cp .env.example "$file"
      info "Brak .env.local — utworzono z .env.example (uzupełnij pozostałe klucze)"
    fi
  elif ! grep -q '^NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321$' "$file" \
    && [ ! -f .env.local.przed-baza-lokalna ]; then
    cp "$file" .env.local.przed-baza-lokalna
    info "Kopia poprzedniego pliku: .env.local.przed-baza-lokalna"
  fi
  set_env_var NEXT_PUBLIC_SUPABASE_URL "$API_URL" "$file"
  set_env_var NEXT_PUBLIC_SUPABASE_ANON_KEY "$ANON_KEY" "$file"
  set_env_var SUPABASE_SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY" "$file"
  # Worker pg-boss (`pnpm worker:dev`) łączy się z Postgresem bezpośrednio.
  set_env_var DATABASE_URL "$DB_URL" "$file"
  ok ".env.local celuje w lokalną bazę ($API_URL) — zrestartuj pnpm dev, jeśli działa"
}

print_status() {
  load_status
  cat <<TXT

  Aplikacja:  pnpm dev → http://localhost:3000  (konto: $DEV_EMAIL)
  Studio:     $STUDIO_URL   (podgląd tabel)
  Poczta:     ${MAILPIT_URL:-${INBUCKET_URL:-}}   (maile z GoTrue: reset hasła, zaproszenia)
  Postgres:   $DB_URL
  Worker:     pnpm worker:dev  (opcjonalnie — joby w tle)

TXT
}

start_all() {
  ensure_docker
  start_supabase
  ensure_pgboss_schema
  apply_migrations
  seed_dev_account
  write_env
  print_status
}

case "${1:-start}" in
  start)
    start_all
    ;;
  status)
    ensure_docker
    print_status
    ;;
  env)
    ensure_docker
    write_env
    ;;
  stop)
    supabase stop
    ok "Zatrzymane (dane zostają). Colimę wyłączysz: colima stop"
    ;;
  reset)
    ensure_docker
    supabase stop --no-backup
    start_all
    ;;
  *)
    fail "Nieznana komenda: $1 (start | status | env | stop | reset)"
    ;;
esac
