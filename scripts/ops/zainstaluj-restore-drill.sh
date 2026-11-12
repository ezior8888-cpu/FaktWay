#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Instalacja cotygodniowej próby odtworzenia na db-1 (plan usprawnień 3.4)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo (uruchamia Bartosz):
#
#   ./scripts/ops/zainstaluj-restore-drill.sh              # instalacja + pierwsza próba
#   ./scripts/ops/zainstaluj-restore-drill.sh --bez-proby  # instalacja bez próby
#   ./scripts/ops/zainstaluj-restore-drill.sh --sprawdz    # tylko odczyt: co jest na db-1
#   ./scripts/ops/zainstaluj-restore-drill.sh --odinstaluj
#
# Adres pingu Healthchecks (osobny check „restore-drill”: okres 7 dni,
# karencja 1 dzień) bierze ze zmiennej DRILL_HC_URL w `.agents/infra.env`
# albo ze środowiska. Przy ponownej instalacji bez tej zmiennej zostaje
# adres zapisany już na db-1. Adres idzie na serwer strumieniem, nie
# w linii poleceń.
#
# Co robi na db-1:
#   /usr/local/sbin/faktflow-restore-drill          ← scripts/hetzner/restore-drill.sh
#   /usr/local/sbin/faktflow-restore-drill-tydzien  ← scripts/hetzner/restore-drill-tydzien.sh
#   /etc/systemd/system/faktflow-restore-drill.{service,timer} ← scripts/hetzner/systemd/
#   /etc/faktflow-restore-drill.env                 DRILL_HC_URL (0600)
#   systemctl enable --now faktflow-restore-drill.timer, potem jedna próba
#   i koniec jej logu.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git > /dev/null 2>&1; then
  # Ścieżka bezwzględna, bo w worktree Git Bash na Windowsie podaje `C:/…`,
  # której nie da się dokleić do $ROOT. Gdy `cd` się nie uda, MAIN_ROOT
  # zostaje pusty, a skrypt idzie dalej.
  COMMON_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2> /dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    MAIN_ROOT=$(cd "$COMMON_DIR/.." 2> /dev/null && pwd) || MAIN_ROOT=""
  fi
fi
ENV_FILE=""
for candidate in "${FAKTFLOW_INFRA_ENV:-}" "$ROOT/.agents/infra.env" "${MAIN_ROOT:+$MAIN_ROOT/.agents/infra.env}"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then ENV_FILE=$candidate; break; fi
done
[ -n "$ENV_FILE" ] || { echo "Nie znalazłem .agents/infra.env (AGENTS.md → Infrastruktura)." >&2; exit 1; }
HC_FROM_ENV=${DRILL_HC_URL:-}
# shellcheck source=/dev/null
source "$ENV_FILE"
DRILL_HC_URL=${HC_FROM_ENV:-${DRILL_HC_URL:-}}
for v in K DB; do
  [ -n "${!v:-}" ] || { echo "Brak zmiennej $v w $ENV_FILE." >&2; exit 1; }
done

SSH=(ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 "root@$DB")
UNIT=faktflow-restore-drill

case "${1:-}" in
  --sprawdz)
    echo "Konfiguracja: $ENV_FILE; DRILL_HC_URL lokalnie: $([ -n "$DRILL_HC_URL" ] && echo jest || echo brak)"
    "${SSH[@]}" "ls -la /usr/local/sbin/faktflow-restore-drill* 2>&1; \
      echo -n 'DRILL_HC_URL na db-1: '; grep -q '^DRILL_HC_URL=.' /etc/faktflow-restore-drill.env 2>/dev/null && echo jest || echo brak; \
      systemctl list-timers --all --no-pager $UNIT.timer; \
      journalctl -u $UNIT --no-pager -n 15 2>/dev/null | grep -E 'WYNIK|BŁĄD|OK$' || echo '(brak przebiegów w dzienniku)'"
    exit 0 ;;
  --odinstaluj)
    "${SSH[@]}" "systemctl disable --now $UNIT.timer 2>/dev/null; \
      rm -f /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer \
        /usr/local/sbin/faktflow-restore-drill /usr/local/sbin/faktflow-restore-drill-tydzien /etc/faktflow-restore-drill.env; \
      systemctl daemon-reload; echo odinstalowane"
    echo "Check „restore-drill” w Healthchecks zatrzymaj (Pause) albo usuń ręcznie, inaczej po 8 dniach przyjdzie alarm."
    exit 0 ;;
  ""|--bez-proby) ;;
  *) echo "Nieznana opcja: $1 (dozwolone: --bez-proby, --sprawdz, --odinstaluj)" >&2; exit 2 ;;
esac

if [ -n "$DRILL_HC_URL" ] && [[ ! $DRILL_HC_URL =~ ^https://[A-Za-z0-9./_-]+$ ]]; then
  echo "DRILL_HC_URL nie wygląda na adres pingu (https://hc-ping.com/<uuid>)." >&2
  exit 1
fi
if [ -z "$DRILL_HC_URL" ] && ! "${SSH[@]}" "grep -q '^DRILL_HC_URL=.' /etc/faktflow-restore-drill.env 2>/dev/null"; then
  echo "Brak DRILL_HC_URL: dopisz do $ENV_FILE linię DRILL_HC_URL=https://hc-ping.com/<uuid>" >&2
  echo "(Healthchecks: nowy check „restore-drill”, okres 7 dni, karencja 1 dzień) i uruchom ponownie." >&2
  exit 1
fi

for f in scripts/hetzner/restore-drill.sh scripts/hetzner/restore-drill-tydzien.sh \
  scripts/hetzner/systemd/$UNIT.service scripts/hetzner/systemd/$UNIT.timer; do
  [ -f "$ROOT/$f" ] || { echo "Brak $ROOT/$f" >&2; exit 1; }
done

# Pliki strumieniem (końce linii LF, nawet z checkoutu z CRLF), potem install.
put() { tr -d '\r' < "$ROOT/$1" | "${SSH[@]}" "umask 077; cat > '$2'"; }
"${SSH[@]}" "mkdir -p /root/.faktflow-instalacja && chmod 700 /root/.faktflow-instalacja"
T=/root/.faktflow-instalacja
put scripts/hetzner/restore-drill.sh "$T/drill"
put scripts/hetzner/restore-drill-tydzien.sh "$T/tydzien"
put scripts/hetzner/systemd/$UNIT.service "$T/service"
put scripts/hetzner/systemd/$UNIT.timer "$T/timer"
if [ -n "$DRILL_HC_URL" ]; then
  printf 'DRILL_HC_URL=%s\n' "$DRILL_HC_URL" | "${SSH[@]}" "umask 077; cat > /etc/faktflow-restore-drill.env"
fi
"${SSH[@]}" "set -e; \
  install -m 700 $T/drill /usr/local/sbin/faktflow-restore-drill; \
  install -m 700 $T/tydzien /usr/local/sbin/faktflow-restore-drill-tydzien; \
  install -m 644 $T/service /etc/systemd/system/$UNIT.service; \
  install -m 644 $T/timer /etc/systemd/system/$UNIT.timer; \
  rm -rf $T; \
  [ -f /etc/faktflow-backup.env ] || echo 'UWAGA: brak /etc/faktflow-backup.env (PGC, BACKUP_DIR) — próba padnie'; \
  systemctl daemon-reload; systemctl enable --now $UNIT.timer; \
  systemctl list-timers --no-pager $UNIT.timer"

if [ "${1:-}" = "--bez-proby" ]; then
  echo "Zainstalowane. Pierwsza próba w najbliższą niedzielę 03:30 UTC."
  exit 0
fi
echo "Pierwsza próba (kilkadziesiąt sekund do kilku minut)…"
RC=0
"${SSH[@]}" "systemctl start $UNIT.service" || RC=$?
"${SSH[@]}" "journalctl -u $UNIT --no-pager -n 60 -o cat"
if [ "$RC" -ne 0 ]; then
  echo "Próba NIEUDANA albo zerwane połączenie (wyżej log; przy zerwanym próba trwa dalej na db-1, sprawdź: --sprawdz)." >&2
  exit 1
fi
echo "Próba udana; Healthchecks dostał ping. Następna: niedziela 03:30 UTC."
