#!/usr/bin/env bash
# Przygotowuje świeży worktree do pracy: zależności, .env.local, adresy
# serwerów i hook przed pushem. Uruchamia go hook SessionStart Claude Code
# (`.claude/settings.json`); Codex i ludzie mogą wołać go ręcznie:
#
#   bash scripts/dev/przygotuj-worktree.sh
#
# Gdy wszystko jest na miejscu, kończy się w milisekundach i nic nie pisze.
# Gdy coś zrobi, pisze jedną linię. Nie uruchamia Colimy ani bazy (to robi
# `pnpm db:local`), niczego nie dodaje do gita.
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0
main_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

done_items=()
problems=()

# 1. Zależności: brak node_modules albo lockfile nowszy niż ostatnia instalacja.
if [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  mkdir -p .tmp
  started=$SECONDS
  if pnpm install --prefer-offline --frozen-lockfile >.tmp/przygotuj-worktree.log 2>&1; then
    done_items+=("pnpm install ($((SECONDS - started)) s)")
  else
    problems+=("pnpm install padł, log: .tmp/przygotuj-worktree.log")
  fi
fi

# 2. .env.local: z działającej bazy lokalnej, a bez niej kopia z głównego katalogu.
#    Colimy nie uruchamiamy: to kilka GB pamięci i pół minuty, decyzja człowieka.
if [ ! -f .env.local ]; then
  if docker info >/dev/null 2>&1 && supabase status >/dev/null 2>&1 \
    && bash scripts/dev/baza-lokalna.sh env >/dev/null 2>&1; then
    done_items+=(".env.local z bazy lokalnej")
  elif [ "$main_root" != "$root" ] && [ -f "$main_root/.env.local" ]; then
    cp "$main_root/.env.local" .env.local && done_items+=(".env.local skopiowany z głównego katalogu")
  else
    problems+=("brak .env.local: uruchom pnpm db:local")
  fi
fi

# 3. Adresy serwerów: dowiązanie do pliku z głównego katalogu, tylko gdy git
#    na pewno go ignoruje (repo jest publiczne).
if [ "$main_root" != "$root" ] && [ ! -e .agents/infra.env ] && [ -f "$main_root/.agents/infra.env" ]; then
  if git check-ignore -q .agents/infra.env; then
    mkdir -p .agents && ln -s "$main_root/.agents/infra.env" .agents/infra.env \
      && done_items+=(".agents/infra.env dowiązany")
  else
    problems+=(".agents/ nie jest w .gitignore, infra.env NIE dowiązany")
  fi
fi

# 4. Hook przed pushem (.githooks/pre-push). Ścieżka względna, więc każdy
#    worktree używa własnej kopii; gałąź bez katalogu .githooks po prostu go nie ma.
if [ -d .githooks ] && [ -z "$(git config --get core.hooksPath)" ]; then
  git config core.hooksPath .githooks && done_items+=("hook przed pushem włączony")
fi

if [ ${#done_items[@]} -gt 0 ]; then
  (IFS=','; echo "Przygotowanie worktree:${done_items[*]/#/ }.")
fi
if [ ${#problems[@]} -gt 0 ]; then
  (IFS=';'; echo "Przygotowanie worktree, do zrobienia:${problems[*]/#/ }.")
fi
exit 0
