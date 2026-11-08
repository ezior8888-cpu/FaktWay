#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Sprzątanie `.next` w bezczynnych worktree (plan usprawnień 3.6)
# ────────────────────────────────────────────────────────────────
# Każdy worktree po `pnpm build` albo `pnpm dev` trzyma 3–5 GB w `.next`.
# Przy kilkudziesięciu sesjach dysk Maca zapełnia się w kilka dni (03.11.2026:
# ok. 95 GB). Skrypt usuwa SAM katalog `.next` (to tylko cache buildu; `pnpm
# dev`/`build` odtworzy go) w worktree bez aktywności od N dni.
#
#   bash scripts/dev/sprzataj-worktree.sh                 # podgląd, nic nie usuwa
#   bash scripts/dev/sprzataj-worktree.sh --usun          # usuwa
#   bash scripts/dev/sprzataj-worktree.sh --dni 14        # próg bezczynności (domyślnie 7)
#   bash scripts/dev/sprzataj-worktree.sh --zainstaluj-harmonogram   # co niedzielę 3:00 (launchd)
#
# Nigdy nie rusza: głównego katalogu repo, worktree, z którego go uruchomiono,
# worktree z działającym procesem w `.next` (np. `next dev`), kodu, gałęzi
# ani `node_modules`.
set -euo pipefail

DAYS=7
DELETE=0
INSTALL=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --usun) DELETE=1 ;;
    --dni) shift; DAYS="${1:-}"; case "$DAYS" in ''|*[!0-9]*) echo "--dni wymaga liczby" >&2; exit 1 ;; esac ;;
    --zainstaluj-harmonogram) INSTALL=1 ;;
    *) echo "Nieznana opcja: $1" >&2; exit 1 ;;
  esac
  shift
done

here="$(git rev-parse --show-toplevel)"
main_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

if [ "$INSTALL" -eq 1 ]; then
  # Główny katalog bywa na dowolnej gałęzi (także bez tego skryptu), więc
  # harmonogram bierze wersję z origin/main do pliku tymczasowego.
  git -C "$main_root" cat-file -e origin/main:scripts/dev/sprzataj-worktree.sh 2>/dev/null \
    || { echo "Brak scripts/dev/sprzataj-worktree.sh w origin/main (git fetch, potem jeszcze raz)." >&2; exit 1; }
  # shellcheck disable=SC2016 # $f i $(mktemp) rozwija dopiero launchd przez bash -c
  run='f=$(mktemp) &amp;&amp; git show origin/main:scripts/dev/sprzataj-worktree.sh &gt; "$f" &amp;&amp; /bin/bash "$f" --usun; rm -f "$f"'
  label="pl.faktway.sprzataj-worktree"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$main_root/.tmp"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>-c</string><string>$run</string></array>
  <key>WorkingDirectory</key><string>$main_root</string>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$main_root/.tmp/sprzataj-worktree.log</string>
  <key>StandardErrorPath</key><string>$main_root/.tmp/sprzataj-worktree.log</string>
</dict>
</plist>
PLIST
  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load "$plist"
  echo "Harmonogram zainstalowany: $plist (co niedzielę 3:00, log: .tmp/sprzataj-worktree.log)."
  echo "Wyłączenie: launchctl unload \"$plist\" && rm \"$plist\""
  exit 0
fi

mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }
now=$(date +%s)
limit=$((now - DAYS * 86400))
total_kb=0
count=0

while IFS= read -r line; do
  case "$line" in worktree\ *) wt="${line#worktree }" ;; *) continue ;; esac
  [ "$wt" = "$main_root" ] && continue
  [ "$wt" = "$here" ] && continue
  [ -d "$wt/.next" ] || continue
  # Ostatnia aktywność: indeks gita, HEAD worktree albo dowolny plik w .next (dev/build).
  gitdir="$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null)" || continue
  last=$(mtime "$gitdir/index")
  for f in "$gitdir/HEAD" "$gitdir/logs/HEAD" "$wt/.next"; do
    t=$(mtime "$f"); [ "$t" -gt "$last" ] && last=$t
  done
  [ "$last" -lt "$limit" ] || continue
  if command -v lsof >/dev/null 2>&1 && lsof +D "$wt/.next" >/dev/null 2>&1; then
    echo "pomijam (proces używa .next): $wt"
    continue
  fi
  kb=$(du -sk "$wt/.next" 2>/dev/null | cut -f1)
  days_idle=$(( (now - last) / 86400 ))
  printf '%6s MB  %3s dni  %s\n' "$((kb / 1024))" "$days_idle" "${wt#"$main_root"/}"
  total_kb=$((total_kb + kb))
  count=$((count + 1))
  [ "$DELETE" -eq 1 ] && rm -rf "$wt/.next"
done < <(git worktree list --porcelain)

gb=$(awk "BEGIN { printf \"%.1f\", $total_kb / 1048576 }")
if [ "$DELETE" -eq 1 ]; then
  echo "Usunięto .next w $count worktree, zwolniono ok. $gb GB."
else
  echo "Do usunięcia: .next w $count worktree, ok. $gb GB. Uruchom z --usun, żeby usunąć."
fi
