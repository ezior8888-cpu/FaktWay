#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Złożenie kilku gotowych PR w jeden PR zbiorczy (bez scalania)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo, numery w kolejności scalania (stos od PR
# z bazą `main` w górę, luźne od najstarszego):
#
#   ./scripts/ops/zloz-scalenie.sh 403 404
#   ./scripts/ops/zloz-scalenie.sh --sprawdz 403 404     # tylko kontrola PR
#
# Robi to, co docs/runbooks/scalanie-pr.md („Kilka PR albo stos PR”)
# opisuje ręcznie:
# 1. sprawdza każdy PR: otwarty, nie szkic, baza `main`, kontrole CI
#    zielone; zbiera migracje (`supabase/migrations/*.sql`);
# 2. zakłada gałąź `claude/scalenie-<numery>` od świeżego `origin/main`
#    i dodaje każdy PR przez `git merge --no-ff`; przy konflikcie przerywa
#    i nic nie wypycha;
# 3. `pnpm install --frozen-lockfile`, `pnpm run ci && pnpm build`;
# 4. wypycha gałąź i otwiera PR „Scalenie #A, #B” z tabelą składowych.
#
# NIE scala. Scalenie PR zbiorczego to decyzja Bartosza: skrypt wypisuje
# na końcu polecenie `gh pr merge N --merge`. Migracje i wdrożenie to
# osobne kroki (docs/runbooks/wgrywanie-migracji.md, wdrozenie-produkcji.md).

set -euo pipefail

ONLY_CHECK=0
if [ "${1:-}" = "--sprawdz" ]; then ONLY_CHECK=1; shift; fi
if [ "$#" -eq 0 ]; then
  echo "Podaj numery PR w kolejności scalania, np.: ./scripts/ops/zloz-scalenie.sh 403 404" >&2
  exit 1
fi
for n in "$@"; do
  case "$n" in ''|*[!0-9]*) echo "To nie jest numer PR: $n" >&2; exit 1 ;; esac
done

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
command -v gh >/dev/null || { echo "Brak gh (GitHub CLI)." >&2; exit 1; }

say() { printf '%s\n' "$*"; }
fail() { printf '✘ %s\n' "$*" >&2; exit 1; }

# ─── 1. Kontrola PR ──────────────────────────────────────────────
rows=""
heads=""
problems=0
for n in "$@"; do
  info=$(gh pr view "$n" --json state,isDraft,baseRefName,headRefName,title,statusCheckRollup,files --jq '
    [ .state, (.isDraft|tostring), .baseRefName, .headRefName,
      ([.statusCheckRollup[] | (.conclusion // .status // "PENDING")
         | select(. != "SUCCESS" and . != "NEUTRAL" and . != "SKIPPED")] | unique | join(",")),
      ([.files[].path | select(startswith("supabase/migrations/") and endswith(".sql"))
         | split("/") | last | .[0:5]] | join(" ")),
      .title ] | join("\u001f")') || fail "Nie mogę odczytać PR #$n."
  # Separator \x1f (nie biały znak), bo puste pola (brak migracji, zielone CI)
  # przy tabulatorze zlewają się i przesuwają kolumny.
  IFS=$'\x1f' read -r state draft base head bad migrations title <<<"$info"
  verdict="ok"
  [ "$state" = "OPEN" ] || verdict="stan $state"
  [ "$draft" = "false" ] || verdict="szkic"
  [ "$base" = "main" ] || verdict="baza $base (stos: dodaj najpierw PR bazowy)"
  [ -z "$bad" ] || verdict="CI: $bad"
  if [ "$verdict" = "ok" ]; then say "✔ #$n $head${migrations:+ (migracje: $migrations)}"; else say "✘ #$n $head: $verdict"; problems=1; fi
  rows="$rows| #$n | \`$head\` | $title | ${migrations:-—} |"$'\n'
  heads="$heads $n:$head"
done
[ "$problems" -eq 0 ] || fail "Nie wszystkie PR są gotowe; nic nie zostało zmienione."
[ "$ONLY_CHECK" -eq 0 ] || { say "Kontrola zakończona, nic nie zmieniono."; exit 0; }

# ─── 2. Gałąź zbiorcza ───────────────────────────────────────────
[ -z "$(git status --porcelain)" ] || fail "Katalog roboczy ma niezacommitowane zmiany."
branch="claude/scalenie-$(IFS=-; echo "$*")"
git fetch -q origin
if git rev-parse -q --verify "refs/heads/$branch" >/dev/null || git ls-remote --exit-code -q origin "refs/heads/$branch" >/dev/null 2>&1; then
  fail "Gałąź $branch już istnieje."
fi
start=$(git rev-parse --abbrev-ref HEAD)
base_sha=$(git rev-parse --short origin/main)
git switch -q -c "$branch" origin/main
for pair in $heads; do
  n=${pair%%:*}; head=${pair#*:}
  git fetch -q origin "refs/heads/$head"
  if ! git merge -q --no-ff --no-edit -m "Merge #$n ($head) into $branch" FETCH_HEAD; then
    git merge --abort || true
    git switch -q "$start"
    git branch -q -D "$branch"
    fail "Konflikt przy #$n ($head). Rozwiąż go według docs/runbooks/scalanie-pr.md; nic nie zostało wypchnięte."
  fi
  say "✔ dodany #$n"
done

# ─── 3. Kontrola całości ─────────────────────────────────────────
say "pnpm install, pnpm run ci && pnpm build (kilka minut)…"
log="$ROOT/.tmp/zloz-scalenie.log"
mkdir -p "$ROOT/.tmp"
if ! { pnpm install --prefer-offline --frozen-lockfile && pnpm run ci && pnpm build; } >"$log" 2>&1; then
  tail -30 "$log" >&2
  fail "Kontrola czerwona (pełny log: .tmp/zloz-scalenie.log). Gałąź $branch została lokalnie, nic nie wypchnięto."
fi
say "✔ ci i build zielone"

# ─── 4. PR zbiorczy ──────────────────────────────────────────────
git push -q -u origin "$branch"
title="Scalenie $(printf '#%s, ' "$@" | sed 's/, $//')"
body=$(cat <<EOF
## Co naprawia

Zbiorcze scalenie gotowych PR (\`scripts/ops/zloz-scalenie.sh\`, \`docs/runbooks/scalanie-pr.md\`).

## Zmiana

Od \`main\` @ \`$base_sha\`, \`git merge --no-ff\` w tej kolejności:

| PR | Gałąź | Tytuł | Migracje |
|---|---|---|---|
$rows
## Najpierw test

Opisane w składowych PR.

## Ponowienie od zera

n/d.

## Weryfikacja

| Sprawdzenie | Wynik |
|---|---|
| \`pnpm run ci\` + \`pnpm build\` na gałęzi zbiorczej | zielone |

## Migracje

Kolumna „Migracje” wyżej. Wgrywa się je po scaleniu, przed wdrożeniem (o ile nagłówek nie mówi „PO wdrożeniu”).

## Po wdrożeniu

Według składowych PR.
EOF
)
url=$(gh pr create --base main --head "$branch" --title "$title" --body "$body")
say "✔ $url"
say "Scalenie po zielonym CI (decyzja Bartosza): gh pr merge ${url##*/} --merge"
