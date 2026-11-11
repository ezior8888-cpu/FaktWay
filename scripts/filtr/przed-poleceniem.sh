#!/usr/bin/env bash
# Hook PreToolUse Claude Code (Bash): odmawia poleceń omijających filtr
# (żelazny filtr F3). Logika w polecenia.mjs.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -f "$root/scripts/filtr/polecenia.mjs" ] || exit 0
exec node "$root/scripts/filtr/polecenia.mjs"
