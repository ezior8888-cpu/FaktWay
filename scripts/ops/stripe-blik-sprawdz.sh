#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# BLIK cykliczny: przełącznik w aplikacji i capabilities konta Stripe — TYLKO ODCZYT
# ────────────────────────────────────────────────────────────────
# Jedna linia, bez argumentów, z katalogu repo:
#
#   ./scripts/ops/stripe-blik-sprawdz.sh
#
# Procedura włączania i wycofania: docs/runbooks/stripe-blik.md.
#
# Skrypt sam ładuje `.agents/infra.env` (K, APP, APP_PREFIX). Na serwerze
# `docker exec` uruchamia w kontenerze aplikacji jedno żądanie GET /v1/account.
# Klucz Stripe zostaje w kontenerze: na wyjście idą tylko wartość przełącznika,
# tryb klucza (test albo live) i status dwóch capabilities.
#
# Kod wyjścia 1, gdy przełącznik jest włączony, a BLIK cykliczny nieaktywny:
# klienci widzą wtedy ujawnienia BLIK-a, ale Checkout pokaże samą kartę.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

# Gdzie leży `.agents/infra.env`: zmienna FAKTFLOW_INFRA_ENV, katalog tego
# repo, a dla worktree (`.claude/worktrees/*`) — główny checkout, bo plik jest
# poza gitem i worktree go nie ma.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN_ROOT=""
if command -v git >/dev/null 2>&1; then
  COMMON_DIR=$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    case "$COMMON_DIR" in
      /*) MAIN_ROOT=$(cd "$COMMON_DIR/.." && pwd) ;;
      *)  MAIN_ROOT=$(cd "$ROOT/$COMMON_DIR/.." && pwd) ;;
    esac
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

ssh -i "$K" -o ConnectTimeout=15 -o BatchMode=yes "root@$APP" bash -s -- "^$APP_PREFIX" <<'REMOTE'
set -u
C=$(docker ps --format '{{.Names}}' | grep -E "$1" | head -1)
if [ -z "$C" ]; then
  echo "Nie znalazłem kontenera aplikacji." >&2
  exit 1
fi
docker exec -i "$C" node --input-type=module <<'NODE'
const flag = process.env.STRIPE_BLIK_RECURRING?.trim() ?? '';
const enabled = flag === 'on';
console.log(`STRIPE_BLIK_RECURRING: ${flag || '(puste)'} (${enabled ? 'BLIK włączony' : 'sama karta'})`);

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.log('STRIPE_SECRET_KEY: brak');
  process.exit(1);
}
console.log(`Klucz Stripe: ${key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'inny typ'}`);

const response = await fetch('https://api.stripe.com/v1/account', {
  headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2026-09-30.endive' },
});
const body = await response.json();
if (!response.ok) {
  console.log(`Stripe odpowiedział ${response.status}: ${body.error?.message ?? 'bez opisu'}`);
  process.exit(1);
}

const capabilities = ['blik_payments', 'blik_recurring_payments'].map((name) => [name, body.capabilities?.[name] ?? 'brak']);
for (const [name, status] of capabilities) console.log(`${name}: ${status}`);

const active = capabilities.every(([, status]) => status === 'active');
if (enabled && !active) {
  console.log('UWAGA: przełącznik włączony, BLIK cykliczny nieaktywny. Klient widzi ujawnienia, a Checkout pokaże samą kartę.');
  process.exit(1);
}
if (!enabled && active) {
  console.log('UWAGA: BLIK cykliczny aktywny przy wyłączonym przełączniku. Stripe może pokazać go w Checkout bez ujawnień (runbook: kolejność).');
}
NODE
REMOTE
