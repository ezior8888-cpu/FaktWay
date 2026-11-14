#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Wgranie migracji „przed wdrożeniem” na produkcję (db-1)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo, PO scaleniu PR do `main`, numery po kolei:
#
#   ./scripts/ops/wgraj-migracje.sh 00157 00158 00159
#
# Skrypt robi to, co AGENTS.md → „Wgrywanie migracji” opisuje ręcznie:
# - pliki bierze wyłącznie z `origin/main`, nie z katalogu roboczego;
# - zatrzymuje się na DROP TABLE, DROP COLUMN, TRUNCATE i DELETE FROM poza
#   ciałem funkcji, bo te wymagają osobnej zgody Bartosza;
# - pomija numer, który już jest w `schema_migrations`;
# - każdą migrację wykonuje w jednej transakcji i dopisuje do `schema_migrations`;
# - na końcu `NOTIFY pgrst` i sprawdzenie, że PostgREST widzi nowe tabele.
#
# Przy pierwszym błędzie kończy pracę: wcześniejsze numery zostają wgrane,
# a powtórne uruchomienie je pominie. Wdrożenie to osobny krok:
# `./scripts/ops/wdroz-produkcje.sh`.
#
# Skrypt sam ładuje `.agents/infra.env` — przycisk „Run” w aplikacji uruchamia
# każdy blok w świeżej powłoce.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Podaj numery migracji, np.: ./scripts/ops/wgraj-migracje.sh 00157 00158" >&2
  exit 1
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
# Ścieżka bezwzględna, bo w worktree Git Bash na Windowsie podaje `C:/…`,
# której nie da się dokleić do $ROOT. Gdy `cd` się nie uda, MAIN_ROOT
# zostaje pusty, a skrypt idzie dalej.
COMMON_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [ -n "$COMMON_DIR" ]; then
  MAIN_ROOT=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd) || MAIN_ROOT=""
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
for v in K DB PGC RESTC; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

on_db() {
  ssh -i "$K" -o BatchMode=yes root@"$DB" "$@"
}

psql_query() {
  on_db "docker exec $PGC psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -c \"$1\""
}

git -C "$ROOT" fetch origin main --quiet
ALL_FILES=$(git -C "$ROOT" ls-tree --name-only origin/main supabase/migrations/)

# Najpierw sprawdzenie wszystkich numerów, żeby nie zatrzymać się w połowie
# na literówce albo zakazanej instrukcji.
FILES=""
for num in "$@"; do
  case "$num" in
    [0-9][0-9][0-9][0-9][0-9]) ;;
    *) echo "Niepoprawny numer migracji: $num" >&2; exit 1 ;;
  esac
  file=$(printf '%s\n' "$ALL_FILES" | grep "/${num}_" || true)
  if [ -z "$file" ] || [ "$(printf '%s\n' "$file" | wc -l | tr -d ' ')" != "1" ]; then
    echo "Migracja $num: oczekiwałem jednego pliku na origin/main, znalazłem: ${file:-żadnego}." >&2
    exit 1
  fi
  forbidden=$(git -C "$ROOT" show "origin/main:$file" \
    | grep -nE '^(DROP TABLE|TRUNCATE|DELETE FROM)|^ALTER TABLE.*DROP COLUMN|^[[:space:]]+DROP COLUMN' || true)
  if [ -n "$forbidden" ]; then
    echo "Migracja $num ma instrukcje wymagające zgody Bartosza. Wgraj ją ręcznie:" >&2
    printf '%s\n' "$forbidden" >&2
    exit 1
  fi
  FILES="$FILES $file"
done

TABLES=""
for file in $FILES; do
  base=$(basename "$file" .sql)
  num=${base%%_*}
  name=${base#*_}
  if [ -n "$(psql_query "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '$num'")" ]; then
    echo "── $num: już wgrana, pomijam"
    continue
  fi
  echo "── $num: wgrywam $base"
  git -C "$ROOT" show "origin/main:$file" \
    | on_db "docker exec -i $PGC psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 --single-transaction -f -"
  psql_query "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$num', '$name') ON CONFLICT (version) DO NOTHING" >/dev/null
  TABLES="$TABLES $(git -C "$ROOT" show "origin/main:$file" \
    | grep -oE '^CREATE TABLE (IF NOT EXISTS )?public\.[a-z0-9_]+' | sed 's/.*public\.//' || true)"
done

psql_query "NOTIFY pgrst, 'reload schema'" >/dev/null
sleep 3

REST_IP=$(on_db "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $RESTC")
for table in $TABLES; do
  # 42501 to poprawna odpowiedź: PostgREST znalazł tabelę i odmówił dopiero
  # na autoryzacji. Niewidoczna tabela to PGRST205.
  body=$(on_db "curl -s 'http://$REST_IP:3000/$table?limit=1'")
  case "$body" in
    *PGRST205*|*PGRST204*)
      echo "PostgREST nie widzi tabeli $table: $body" >&2
      exit 1
      ;;
  esac
  echo "── PostgREST widzi tabelę $table"
done

echo "── Wpisy w schema_migrations:"
psql_query "SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT $(($# + 1))"
echo "── Gotowe. Następny krok: ./scripts/ops/wdroz-produkcje.sh"
