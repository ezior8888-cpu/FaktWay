#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# BLIK cykliczny, wycofanie: otwarte Checkout Session z BLIK-iem
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo. Bez argumentu tylko pokazuje (odczyt):
#
#   ./scripts/ops/stripe-blik-wygas-sesje.sh
#
# Z argumentem wygasza Session, które oferują BLIK:
#
#   ./scripts/ops/stripe-blik-wygas-sesje.sh --wygas
#
# Po co: Session żyje do 24 h, a aplikacja podaje ją klientowi, który wróci.
# Klient otwierający wygaszoną Session widzi komunikat Stripe, a kolejny klik
# w aplikacji zakłada nową. Procedura: docs/runbooks/stripe-blik.md, „Wycofanie”.
#
# Przy włączonym STRIPE_BLIK_RECURRING nic nie wygasza: klient od razu dostałby
# nową Session z BLIK-iem, więc najpierw trzeba wykonać wcześniejsze kroki wycofania.
#
# Skrypt sam ładuje `.agents/infra.env` (K, APP, APP_PREFIX). Na serwerze
# `docker exec` uruchamia żądania w kontenerze aplikacji. Klucz Stripe zostaje
# w kontenerze: na wyjście idą tylko liczby, identyfikatory Session i daty,
# bez adresów Session i danych klientów.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

MODE=podglad
case "${1:-}" in
  "") ;;
  --wygas) MODE=wygas ;;
  *)
    echo "Użycie: $0 [--wygas]" >&2
    exit 2
    ;;
esac

# Gdzie leży `.agents/infra.env`: zmienna FAKTFLOW_INFRA_ENV, katalog tego
# repo, a dla worktree (`.claude/worktrees/*`) — główny checkout, bo plik jest
# poza gitem i worktree go nie ma.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git >/dev/null 2>&1; then
  # Ścieżka bezwzględna, bo w worktree Git Bash na Windowsie podaje `C:/…`,
  # której nie da się dokleić do $ROOT. Gdy `cd` się nie uda, MAIN_ROOT
  # zostaje pusty, a skrypt idzie dalej.
  COMMON_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    MAIN_ROOT=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd) || MAIN_ROOT=""
  fi
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
for v in K APP APP_PREFIX; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes "root@$APP" bash -s -- "^$APP_PREFIX" "$MODE" <<'REMOTE'
set -u
C=$(docker ps --format '{{.Names}}' | grep -E "$1" | head -1)
if [ -z "$C" ]; then
  echo "Nie znalazłem kontenera aplikacji." >&2
  exit 1
fi
docker exec -i -e BLIK_TRYB="$2" "$C" node --input-type=module <<'NODE'
const expire = process.env.BLIK_TRYB === 'wygas';

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.log('STRIPE_SECRET_KEY: brak');
  process.exit(1);
}
if (expire && process.env.STRIPE_BLIK_RECURRING?.trim() === 'on') {
  console.log('Nic nie wygaszam: STRIPE_BLIK_RECURRING jest włączony, więc klient od razu dostałby nową Session z BLIK-iem. Najpierw wcześniejsze kroki z sekcji „Wycofanie” w docs/runbooks/stripe-blik.md.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}`, 'Stripe-Version': '2026-09-30.endive' };

const open = [];
let startingAfter = '';
for (;;) {
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions?status=open&limit=100${startingAfter}`, { headers });
  const body = await response.json();
  if (!response.ok) {
    console.log(`Stripe odpowiedział ${response.status}: ${body.error?.message ?? 'bez opisu'}`);
    process.exit(1);
  }
  open.push(...body.data);
  if (!body.has_more) break;
  startingAfter = `&starting_after=${body.data.at(-1).id}`;
}

const withBlik = open.filter((session) => session.payment_method_types?.includes('blik'));
console.log(`Otwarte Session: ${open.length}, z BLIK-iem: ${withBlik.length}`);
for (const session of withBlik) {
  console.log(`${session.id}: sama wygaśnie ${new Date(session.expires_at * 1000).toISOString()}`);
}
if (!expire) {
  if (withBlik.length > 0) console.log('To podgląd. Wygaszenie: ./scripts/ops/stripe-blik-wygas-sesje.sh --wygas');
  process.exit(0);
}

let failed = 0;
for (const session of withBlik) {
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session.id}/expire`, { method: 'POST', headers });
  const body = await response.json();
  if (response.ok && body.status === 'expired') {
    console.log(`${session.id}: wygaszona`);
  } else {
    failed += 1;
    console.log(`${session.id}: Stripe odpowiedział ${response.status}: ${body.error?.message ?? 'bez opisu'}`);
  }
}
console.log(`Wygaszone: ${withBlik.length - failed}, błędy: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
NODE
REMOTE
