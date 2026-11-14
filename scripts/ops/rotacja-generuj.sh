#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Nowe wartości sekretów do rotacji (docs/runbooks/rotacja-kluczy.md)
# ────────────────────────────────────────────────────────────────
# Jedna linia, z katalogu repo, na Macu:
#
#   ./scripts/ops/rotacja-generuj.sh jwt
#       nowy JWT_SECRET Supabase + podpisane nim ANON_KEY i SERVICE_ROLE_KEY
#   ./scripts/ops/rotacja-generuj.sh hex EMAIL_UNSUBSCRIBE_SECRET
#   ./scripts/ops/rotacja-generuj.sh hex KSEF_CREDENTIALS_ENCRYPTION_KEY
#       32 losowe bajty jako 64 znaki szesnastkowe
#
# Wartości trafiają WYŁĄCZNIE do pliku w `.agents/backup/rotacja-kluczy/`
# (poza gitem, chmod 600), nie na ekran: przycisk „Run” w aplikacji Claude
# pokazuje wyjście w rozmowie. Na ekranie jest ścieżka pliku i odciski
# (12 znaków SHA-256), te same, które pokazuje `rotacja-kluczy.sh`, więc
# po wklejeniu do Coolify widać, że w kontenerze jest właśnie ta wartość.
#
# Losowanie i podpis robi Node (`crypto`), żeby sekret nie pojawił się
# w argumentach procesu. Nie używaj generatorów JWT w przeglądarce.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

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

# Katalog `.agents` głównego checkoutu (w worktree jest tylko dowiązanie infra.env).
AGENTS_DIR=""
for candidate in "${MAIN_ROOT:+$MAIN_ROOT/.agents}" "$ROOT/.agents"; do
  if [ -n "$candidate" ] && [ -d "$candidate" ]; then
    AGENTS_DIR=$candidate
    break
  fi
done
if [ -z "$AGENTS_DIR" ]; then
  echo "Nie znalazłem katalogu .agents (poza gitem — AGENTS.md → Infrastruktura)." >&2
  exit 1
fi
OUT_DIR=${ROTACJA_STAN:-"$AGENTS_DIR/backup/rotacja-kluczy"}
mkdir -p "$OUT_DIR" && chmod 700 "$OUT_DIR"

usage() {
  echo "Użycie: $0 jwt | $0 hex NAZWA_ZMIENNEJ" >&2
  exit 1
}

MODE=${1:-}
case "$MODE" in
  jwt) NAME=supabase-jwt ;;
  hex)
    NAME=${2:-}
    [[ "$NAME" =~ ^[A-Z][A-Z0-9_]{2,63}$ ]] || usage
    ;;
  *) usage ;;
esac

FILE="$OUT_DIR/$(date +%Y%m%d-%H%M%S)-$NAME.env"
umask 077
node - "$MODE" "$NAME" "$FILE" <<'JS'
'use strict';
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { writeFileSync } = require('node:fs');

const [mode, name, file] = process.argv.slice(2);
const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const b64url = (b) => Buffer.from(b).toString('base64url');

let lines;
let show;
if (mode === 'jwt') {
  // Szesnastkowy: bez znaków, które trzeba cytować w .env Coolify.
  const secret = randomBytes(32).toString('hex');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 60 * 60;
  const sign = (role) => {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ role, iss: 'supabase', iat, exp }));
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
  };
  const anon = sign('anon');
  const service = sign('service_role');
  lines = [
    `# Nowe klucze Supabase (krok 3 runbooka rotacja-kluczy.md), wystawione ${new Date(iat * 1000).toISOString()}`,
    '# JWT_SECRET: sekret usługi Supabase (GoTrue, PostgREST, Realtime, Storage).',
    '# ANON_KEY: usługa Supabase (Kong) + NEXT_PUBLIC_SUPABASE_ANON_KEY w aplikacjach 1 i 2 i zmienna repo w GitHub.',
    '# SERVICE_ROLE_KEY: usługa Supabase (Kong) + SUPABASE_SERVICE_ROLE_KEY w aplikacjach 1 i 2.',
    `JWT_SECRET=${secret}`,
    `ANON_KEY=${anon}`,
    `SERVICE_ROLE_KEY=${service}`,
  ];
  show = [
    `  JWT_SECRET        odcisk ${fp(secret)}`,
    `  ANON_KEY          odcisk ${fp(anon)}  (rola anon, ważny do ${new Date(exp * 1000).toISOString().slice(0, 10)})`,
    `  SERVICE_ROLE_KEY  odcisk ${fp(service)}  (rola service_role)`,
  ];
} else {
  const value = randomBytes(32).toString('hex');
  lines = [`${name}=${value}`];
  show = [`  ${name}  odcisk ${fp(value)}`];
}
writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Zapisane w pliku (chmod 600, poza gitem):\n  ${file}\n`);
console.log(show.join('\n'));
JS

echo
echo "Otwórz plik (np. open -e \"$FILE\"), skopiuj wartości do Coolify, NIE wklejaj ich do czatu."
echo "Po rotacji i kontroli usuń plik: rm \"$FILE\""
