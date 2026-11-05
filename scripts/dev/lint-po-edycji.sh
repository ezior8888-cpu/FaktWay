#!/usr/bin/env bash
# Hook PostToolUse Claude Code (Edit, Write, MultiEdit): eslint jednego
# zmienionego pliku, tylko błędy (ok. 0,5 s). Milczy, gdy jest czysto; przy
# błędzie kończy się kodem 2, więc Claude dostaje wynik i poprawia od razu.
# Ostrzeżenia pilnuje próg `lint --max-warnings` w CI, nie ten hook.
command -v jq >/dev/null 2>&1 || exit 0
file="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0
case "$file" in *.ts|*.tsx|*.js|*.mjs|*.cjs) ;; *) exit 0 ;; esac
[ -f "$file" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
cd "$root" 2>/dev/null || exit 0
case "$file" in "$PWD"/*) ;; *) exit 0 ;; esac   # tylko pliki tego repo
[ -x node_modules/.bin/eslint ] || exit 0
if out="$(node_modules/.bin/eslint --no-warn-ignored --quiet "$file" 2>&1)"; then exit 0; fi
{ echo "eslint: błędy w ${file#"$PWD"/}"; printf '%s\n' "$out" | tail -30; } >&2
exit 2
