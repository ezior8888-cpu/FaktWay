#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# BLIK cykliczny: przełącznik, capabilities konta i wersja webhooka — TYLKO ODCZYT
# ────────────────────────────────────────────────────────────────
# Jedna linia, bez argumentów, z katalogu repo:
#
#   ./scripts/ops/stripe-blik-sprawdz.sh
#
# Procedura włączania i wycofania: docs/runbooks/stripe-blik.md.
#
# Skrypt sam ładuje `.agents/infra.env` (K, APP, APP_PREFIX). Na serwerze
# `docker exec` uruchamia w kontenerze aplikacji trzy żądania GET: /v1/account,
# /v1/webhook_endpoints i /v1/events. Klucz Stripe zostaje w kontenerze: na wyjście
# idą tylko wartość przełącznika, tryb klucza (test albo live), status dwóch
# capabilities oraz adres i wersja API endpointu webhooka.
#
# Kod wyjścia 1, gdy:
#   - przełącznik jest włączony, a BLIK cykliczny nieaktywny: klienci widzą wtedy
#     ujawnienia BLIK-a, ale Checkout pokaże samą kartę,
#   - endpoint webhooka aplikacji nie istnieje albo dostaje zdarzenia w wersji bez
#     `invoice.payment_intent` i `invoice.charge` (od basil): opłacona faktura nie
#     zapisze się bez uzgodnienia, a nieudana straci kod odmowy.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

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

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2026-09-30.endive' },
  });
  const body = await response.json();
  if (!response.ok) {
    console.log(`Stripe odpowiedział ${response.status} na ${path}: ${body.error?.message ?? 'bez opisu'}`);
    process.exit(1);
  }
  return body;
}

let problem = false;

const account = await stripeGet('/v1/account');
const capabilities = ['blik_payments', 'blik_recurring_payments'].map((name) => [name, account.capabilities?.[name] ?? 'brak']);
for (const [name, status] of capabilities) console.log(`${name}: ${status}`);

const active = capabilities.every(([, status]) => status === 'active');
if (enabled && !active) {
  console.log('UWAGA: przełącznik włączony, BLIK cykliczny nieaktywny. Klient widzi ujawnienia, a Checkout pokaże samą kartę.');
  problem = true;
}
if (!enabled && active) {
  console.log('UWAGA: BLIK cykliczny aktywny przy wyłączonym przełączniku. Stripe może pokazać go w Checkout bez ujawnień (runbook: kolejność).');
}

// Webhook czyta `invoice.payment_intent` i `invoice.charge`, usunięte w 2025-03-31.basil.
// Endpoint bez własnej wersji dostaje domyślną wersję konta, a tę widać na ostatnim zdarzeniu.
const hasInvoiceReferences = (version) => typeof version === 'string' && version < '2025-03-31';
const endpoints = (await stripeGet('/v1/webhook_endpoints?limit=100')).data.filter(
  (endpoint) => endpoint.status === 'enabled' && new URL(endpoint.url).pathname === '/api/stripe/webhook',
);
const accountDefault = (await stripeGet('/v1/events?limit=1')).data[0]?.api_version ?? null;
if (endpoints.length === 0) {
  console.log('UWAGA: brak włączonego endpointu webhooka na ścieżce /api/stripe/webhook.');
  problem = true;
}
for (const endpoint of endpoints) {
  const version = endpoint.api_version ?? accountDefault;
  console.log(`Webhook ${endpoint.url}: ${endpoint.api_version ?? `domyślna wersja konta (${accountDefault ?? 'nieznana'})`}`);
  if (!hasInvoiceReferences(version)) {
    console.log(`UWAGA: zdarzenia w wersji ${version ?? 'nieznana'} mogą nie mieć invoice.payment_intent i invoice.charge. Opłacona faktura wymaga wtedy uzgodnienia, nieudana traci kod odmowy (docs/security/STRIPE-PARA-PI-CHARGE-ODBIOR-2026-09-25.md).`);
    problem = true;
  }
}

process.exit(problem ? 1 : 0);
NODE
REMOTE
