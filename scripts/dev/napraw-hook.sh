#!/usr/bin/env bash
# Hook przed pushem (.githooks/pre-push): ustawia core.hooksPath na ścieżkę
# względną, żeby każdy worktree używał własnej kopii. Naprawia też wartość
# wskazującą na nieistniejący katalog (np. bezwzględną do głównego checkoutu
# na gałęzi bez .githooks, która po cichu wyłączała hook). Tylko git.
# Wywoływany z przygotuj-worktree.sh; wypisuje jedną linię, gdy coś zmienił.
[ -f .githooks/pre-push ] || exit 0

current="$(git config --get core.hooksPath)"
if [ -z "$current" ]; then
  git config core.hooksPath .githooks && echo "hook przed pushem włączony"
  exit 0
fi

case "$current" in
  /*) target="$current" ;;
  *) target="$(git rev-parse --show-toplevel)/$current" ;;
esac
[ -f "$target/pre-push" ] && exit 0

# Ścieżka nie działa: zdejmij nadpisanie z poziomu worktree i ustaw względną.
if [ "$(git config --get extensions.worktreeConfig)" = "true" ]; then
  git config --worktree --unset-all core.hooksPath 2>/dev/null
fi
git config core.hooksPath .githooks && echo "hook przed pushem naprawiony (ścieżka względna)"
exit 0
