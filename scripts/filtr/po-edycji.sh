#!/usr/bin/env bash
# Hook PostToolUse Claude Code (Edit, Write, MultiEdit): mapa ryzyka dla
# zmienionego pliku (żelazny filtr F3). Logika w po-edycji.mjs.
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -f "$root/scripts/filtr/po-edycji.mjs" ] || exit 0
exec node "$root/scripts/filtr/po-edycji.mjs"
