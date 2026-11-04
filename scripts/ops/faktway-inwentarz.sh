#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# Inwentarz produkcji przed zmianą marki FaktFlow → FaktWay
# (etap 0 w docs/rebrand/FAKTWAY.md). Niczego nie zmienia na serwerach.
#
# Uruchomienie (jedna linia, sam ładuje .agents/infra.env):
#   ./scripts/ops/faktway-inwentarz.sh
#
# Co robi:
#   1. Coolify: domeny aplikacji 1 (Next.js) i 2 (worker), ostatnie udane
#      wdrożenie każdej i porównanie z origin/main.
#   2. Coolify: serwisy (Supabase, MinIO) — domeny i zmienne z adresami
#      (SITE_URL, API_EXTERNAL_URL, ADDITIONAL_REDIRECT_URLS, SMTP_*...).
#   3. Zmienne, których WARTOŚĆ zawiera „faktflow” — lista do podmiany.
#   4. Kopie zapasowe baz w Coolify (ostatnie wykonanie).
#   5. Kontenery na app-1 (obraz = commit).
#   6. Pełną kopię zmiennych (Z SEKRETAMI) zapisuje lokalnie w
#      .agents/backup/faktway-<data>/coolify-env.json (chmod 600, poza gitem)
#      — to jest punkt powrotu z kroku 0.6/0.7 planu.
#
# Na ekran nie trafia żadna wartość ze zmiennej o nazwie z KEY, SECRET,
# TOKEN, PASS — tylko nazwy.
# ════════════════════════════════════════════════════════════════

set -euo pipefail

# Gdzie leży `.agents/infra.env`: zmienna FAKTFLOW_INFRA_ENV, katalog tego
# repo, a dla worktree (`.claude/worktrees/*`) — główny checkout.
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
for v in K APP OPS APP_PREFIX WORKER_PREFIX; do
  if [ -z "${!v:-}" ]; then
    echo "Brak zmiennej $v w $ENV_FILE." >&2
    exit 1
  fi
done

OUT="$(dirname "$ENV_FILE")/backup/faktway-$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT"
chmod 700 "$(dirname "$OUT")" "$OUT"
exec > >(tee "$OUT/raport.txt") 2>&1

tinker() {
  ssh -o ConnectTimeout=15 -i "$K" "root@$OPS" 'docker exec -i coolify php artisan tinker'
}

echo "════ Inwentarz FaktFlow → FaktWay — $(date '+%Y-%m-%d %H:%M') ════"
echo "Kopia lokalna: $OUT"
echo

echo "── 1-4. Coolify: aplikacje, serwisy, zmienne z adresami, kopie zapasowe"
# Tinker odbija wpisany kod (linie z „. ”, „< ”) i potrafi skleić echo
# z wynikiem w jednej linii — przez to 17.10 zginęły wiersze APLIKACJA 1
# i KOPIA BAZY. Prawdziwy wynik ma znacznik „## ” (chr(35)), którego nie ma
# w samym kodzie; filtr bierze tylko to, co po znaczniku.
tinker <<'PHP' | grep -a '## ' | sed 's/.*## //' || true
function o($s) { echo chr(35) . chr(35) . ' ' . $s . PHP_EOL; }
$secret = '/(KEY|SECRET|TOKEN|PASS|JWT)/i';
$urlish = '/^(NEXT_PUBLIC_APP_URL|NEXT_PUBLIC_SUPABASE_URL|SUPABASE_URL|SUPABASE_PUBLIC_URL|R2_ENDPOINT|R2_BUCKET_NAME|R2_FORCE_PATH_STYLE|RESEND_FROM_EMAIL|RESEND_FROM_TRANSACTIONAL|RESEND_FROM_MARKETING|EMAIL_FROM|VAPID_SUBJECT|NEXT_PUBLIC_APP_DOMAIN|NEXT_PUBLIC_APP_ENV|KSEF_ENV|SENTRY_ORG|SENTRY_PROJECT|NEXT_PUBLIC_POSTHOG_HOST|LEGACY_HOST_REDIRECT|SITE_URL|API_EXTERNAL_URL|ADDITIONAL_REDIRECT_URLS|SMTP_ADMIN_EMAIL|SMTP_SENDER_NAME|SMTP_HOST|GOTRUE_SITE_URL|GOTRUE_URI_ALLOW_LIST|GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI|GOTRUE_SMTP_ADMIN_EMAIL|GOTRUE_SMTP_SENDER_NAME|MAILER_URLPATHS_[A-Z_]+|MINIO_SERVER_URL|MINIO_BROWSER_REDIRECT_URL|SERVICE_FQDN_[A-Z0-9_]+|SERVICE_URL_[A-Z0-9_]+|PUBLIC_HEALTH_URL)$/';
$show = function ($envs, $indent) use ($secret, $urlish) {
  $withOld = [];
  foreach ($envs as $e) {
    $isSecret = preg_match($secret, $e->key);
    if (!$isSecret && preg_match($urlish, $e->key)) { o($indent . $e->key . '=' . $e->value); }
    if (stripos((string) $e->value, 'faktflow') !== false) { $withOld[] = $e->key . ($isSecret ? ' (sekret)' : ''); }
  }
  o($indent . 'wartość zawiera „faktflow”: ' . (count($withOld) ? implode(', ', array_unique($withOld)) : '—'));
};
foreach ([1, 2] as $id) {
  $a = App\Models\Application::find($id);
  if (!$a) { o("APLIKACJA $id: brak"); continue; }
  o("APLIKACJA $id ($a->name) fqdn=" . ($a->fqdn ?: '—') . " gałąź=$a->git_branch cel=" . ($a->dockerfile_target_build ?: '—'));
  $last = App\Models\ApplicationDeploymentQueue::where('application_id', $id)->where('status', 'finished')->orderBy('id', 'desc')->first();
  o("  ostatnie udane wdrożenie: " . ($last ? "#$last->id commit=$last->commit $last->updated_at" : '—'));
  $show($a->environment_variables()->where('is_preview', false)->get(), '  ');
}
foreach (App\Models\Service::all() as $s) {
  o("SERWIS $s->id ($s->name)");
  foreach ($s->applications as $sa) { o("  kontener $sa->name fqdn=" . ($sa->fqdn ?: '—')); }
  $show($s->environment_variables()->get(), '  ');
}
try {
  foreach (App\Models\ScheduledDatabaseBackup::all() as $b) {
    $last = $b->executions()->orderBy('id', 'desc')->first();
    o("KOPIA BAZY #$b->id częstotliwość=$b->frequency włączona=" . ($b->enabled ? 'tak' : 'nie') . " s3=" . ($b->save_s3 ? 'tak' : 'nie')
      . " ostatnia=" . ($last ? "$last->status $last->created_at" : '—'));
  }
  if (App\Models\ScheduledDatabaseBackup::count() === 0) { o('KOPIE BAZ: brak harmonogramu kopii w Coolify'); }
} catch (\Throwable $t) { o('KOPIE BAZ: nie odczytałem (' . $t->getMessage() . ')'); }
PHP
echo

echo "── origin/main"
git -C "$ROOT" fetch -q origin main 2>/dev/null || true
echo "origin/main = $(git -C "$ROOT" rev-parse origin/main 2>/dev/null || echo '?')"
echo "(Jeśli różni się od commitu ostatniego wdrożenia aplikacji 1, ponowne wdrożenie"
echo " po dopisaniu domeny wgra też te commity — sprawdź je: git log <commit>..origin/main.)"
echo

echo "── 5. Kontenery na app-1"
ssh -o ConnectTimeout=15 -i "$K" "root@$APP" \
  "docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E '^($APP_PREFIX|$WORKER_PREFIX)' || true"
echo

echo "── 6. Pełna kopia zmiennych (z sekretami) → $OUT/coolify-env.json"
tinker <<'PHP' | grep -a '## ' | sed 's/.*## //'
function o($s) { echo chr(35) . chr(35) . ' ' . $s . PHP_EOL; }
$all = [];
foreach ([1, 2] as $id) {
  $a = App\Models\Application::find($id);
  if (!$a) continue;
  $all["application_$id"] = ['name' => $a->name, 'fqdn' => $a->fqdn,
    'env' => $a->environment_variables()->get()->map(fn ($e) => ['key' => $e->key, 'value' => $e->value, 'is_preview' => (bool) $e->is_preview])->values()];
}
foreach (App\Models\Service::all() as $s) {
  $all["service_$s->id"] = ['name' => $s->name,
    'containers' => $s->applications->map(fn ($x) => ['name' => $x->name, 'fqdn' => $x->fqdn])->values(),
    'env' => $s->environment_variables()->get()->map(fn ($e) => ['key' => $e->key, 'value' => $e->value])->values()];
}
file_put_contents('/tmp/faktway-env.json', json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
o('zapisano w kontenerze');
PHP
umask 077
ssh -o ConnectTimeout=15 -i "$K" "root@$OPS" \
  'docker exec coolify cat /tmp/faktway-env.json && docker exec coolify rm -f /tmp/faktway-env.json' \
  > "$OUT/coolify-env.json"
chmod 600 "$OUT/coolify-env.json" "$OUT/raport.txt"
echo "zapisano: $(wc -c < "$OUT/coolify-env.json") bajtów"
echo
echo "Gotowe. Wklej Claude'owi TYLKO raport.txt (bez sekretów), nie coolify-env.json."
