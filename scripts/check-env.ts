#!/usr/bin/env tsx
/**
 * Walidator kompletności zmiennych środowiskowych (audyt 14 sierpnia 2026).
 *
 * GENEZA: audyt wykrył, że AWS_ACCESS_KEY_ID przez wiele miesięcy zawierał
 * placeholder `xxxxxxxx` z .env.example — testy jednostkowe tego nie widzą,
 * bo sprawdzają KOD, nie KONFIGURACJĘ. Ten skrypt zamyka tę lukę: sprawdza
 * każdą zmienną wymaganą przez kod produkcyjny pod kątem (a) obecności,
 * (b) placeholderów, i grupuje wynik per funkcja biznesowa — od razu widać,
 * KTÓRA część apki jest martwa przy obecnym stanie env.
 *
 * Użycie:
 *   pnpm check:env                  # sprawdza .env.local (raport, exit 0)
 *   pnpm check:env --strict         # exit 1 gdy braki w REQUIRED (dla CI)
 *   pnpm check:env -- plik.txt      # sprawdza wskazany plik (np. przed
 *                                     wklejeniem do Coolify)
 *
 * Lista zmiennych DERYWOWANA Z KODU (grep process.env.*), nie z Vercela —
 * dashboard dostawcy bywa niepełny/nieaktualny, kod nie kłamie.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Level = 'required' | 'deferred' | 'optional';

interface VarSpec {
  name: string;
  feature: string;
  level: Level;
  note?: string;
}

/**
 * Zmienne czytane przez kod produkcyjny (lib/ app/ components/ proxy.ts
 * instrumentation* sentry* next.config.ts). Dev-only (E2E_MOCK_*, DEBUG_KSEF,
 * LOAD_TEST_MODE, RESEND_DEV_TO_OVERRIDE, SENTRY_LOG_TEST_SECRET,
 * CI) oraz Vercel-only (VERCEL_*) celowo POZA listą. `EDGE_CONFIG` zniknął
 * w Etapie 8 migracji — globalne flagi siedzą teraz w naszym Postgresie.
 */
const SPECS: VarSpec[] = [
  // ── Rdzeń aplikacji ──
  { name: 'NEXT_PUBLIC_APP_URL', feature: 'Rdzeń aplikacji', level: 'required' },
  { name: 'NEXT_PUBLIC_APP_ENV', feature: 'Rdzeń aplikacji', level: 'required', note: 'MUSI być "production" na prod (bramki SEC-1)' },
  { name: 'NEXT_PUBLIC_APP_DOMAIN', feature: 'Rdzeń aplikacji', level: 'optional' },

  // ── Baza + logowanie (Supabase) ──
  { name: 'NEXT_PUBLIC_SUPABASE_URL', feature: 'Baza + logowanie', level: 'required' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', feature: 'Baza + logowanie', level: 'required' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', feature: 'Baza + logowanie', level: 'required' },
  { name: 'SUPABASE_JWT_SECRET', feature: 'Publiczne API', level: 'optional', note: 'JWT_SECRET Supabase; bez niego /api/v1 odpowiada 503' },

  // ── KSeF (serce produktu) ──
  { name: 'KSEF_ENV', feature: 'KSeF', level: 'required', note: 'test do Fazy 40, potem production' },
  { name: 'KSEF_CREDENTIALS_ENCRYPTION_KEY', feature: 'KSeF', level: 'required', note: 'szyfrowanie certyfikatów klientów' },
  { name: 'KSEF_TEST_URL', feature: 'KSeF', level: 'required' },
  { name: 'KSEF_DEMO_URL', feature: 'KSeF', level: 'optional' },
  { name: 'KSEF_PROD_URL', feature: 'KSeF', level: 'optional', note: 'wymagany dopiero przy KSEF_ENV=production' },

  // ── Pliki (R2 / MinIO po Etapie 5) ──
  { name: 'R2_ACCOUNT_ID', feature: 'Pliki XML/PDF (R2)', level: 'required' },
  { name: 'R2_ACCESS_KEY_ID', feature: 'Pliki XML/PDF (R2)', level: 'required' },
  { name: 'R2_SECRET_ACCESS_KEY', feature: 'Pliki XML/PDF (R2)', level: 'required' },
  { name: 'R2_BUCKET_NAME', feature: 'Pliki XML/PDF (R2)', level: 'required' },
  { name: 'R2_ENDPOINT', feature: 'Pliki XML/PDF (R2)', level: 'optional', note: 'dopiero przy MinIO (Etap 5)' },
  { name: 'R2_FORCE_PATH_STYLE', feature: 'Pliki XML/PDF (R2)', level: 'optional', note: '"true" dopiero przy MinIO' },
  { name: 'R2_JURISDICTION', feature: 'Pliki XML/PDF (R2)', level: 'optional' },
  { name: 'R2_BACKUPS_BUCKET', feature: 'Backupy DB', level: 'optional', note: 'fallback do głównego bucketa' },

  // ── E-maile (Resend) ──
  { name: 'RESEND_API_KEY', feature: 'E-maile', level: 'required', note: 'bez tego maile cicho nie wychodzą (sent:false)' },
  { name: 'RESEND_FROM_EMAIL', feature: 'E-maile', level: 'required' },
  { name: 'RESEND_FROM_TRANSACTIONAL', feature: 'E-maile', level: 'required', note: 'rozdział reputacji domen (Faza 26)' },
  { name: 'RESEND_FROM_MARKETING', feature: 'E-maile', level: 'required' },
  { name: 'RESEND_WEBHOOK_SECRET', feature: 'E-maile', level: 'required', note: 'bounce/complaint handling' },
  { name: 'EMAIL_UNSUBSCRIBE_SECRET', feature: 'E-maile', level: 'required', note: 'HMAC linków wypisu — można wygenerować nowy (openssl rand -hex 32)' },
  { name: 'EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS', feature: 'E-maile', level: 'optional', note: 'tylko na czas rotacji: stary sekret wypisu przez 90 dni, potem usuń' },

  // ── AI (OCR paragonów + support chat) ──
  { name: 'ANTHROPIC_API_KEY', feature: 'AI (OCR + chat)', level: 'required', note: 'bez tego OCR i chat rzucają błąd — klucz z console.anthropic.com' },
  { name: 'ANTHROPIC_OCR_MODEL', feature: 'AI (OCR + chat)', level: 'optional', note: 'default w kodzie' },
  { name: 'ANTHROPIC_SUPPORT_MODEL', feature: 'AI (OCR + chat)', level: 'optional', note: 'default w kodzie' },

  // ── Cache + rate limiting (produkcja: redis:7.2 + serverless-redis-http na app-1, API zgodne z Upstash) ──
  { name: 'UPSTASH_REDIS_REST_URL', feature: 'Cache + limity (Redis)', level: 'optional', note: 'na produkcji ustawiony (własny Redis na app-1, nie chmura Upstash); bez niego cache passthrough, ale m.in. kod TOTP i włączanie 2FA, operacje na haśle i usunięcie konta RODO odmawiają (fail-closed) — pełna lista w nagłówku lib/cache/redis.ts' },
  { name: 'UPSTASH_REDIS_REST_TOKEN', feature: 'Cache + limity (Redis)', level: 'optional' },

  // ── Ochrona przed botami ──
  { name: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', feature: 'Anty-bot (Turnstile)', level: 'required', note: 'bez tego rejestracja działa BEZ ochrony (fail-open, cicho)' },
  { name: 'TURNSTILE_SECRET_KEY', feature: 'Anty-bot (Turnstile)', level: 'required' },

  // ── Monitoring ──
  { name: 'SENTRY_DSN', feature: 'Monitoring błędów', level: 'required' },
  { name: 'NEXT_PUBLIC_SENTRY_DSN', feature: 'Monitoring błędów', level: 'required' },
  { name: 'SENTRY_ORG', feature: 'Monitoring błędów', level: 'optional', note: 'source maps przy buildzie' },
  { name: 'SENTRY_PROJECT', feature: 'Monitoring błędów', level: 'optional' },
  { name: 'SLACK_WEBHOOK_URGENT', feature: 'Alerty Slack', level: 'optional', note: 'alarmy krytyczne idą do Slacka LUB Telegrama — potrzebny przynajmniej jeden kanał' },
  { name: 'SLACK_WEBHOOK_BUGS', feature: 'Alerty Slack', level: 'optional' },
  { name: 'SLACK_WEBHOOK_METRICS', feature: 'Alerty Slack', level: 'optional' },
  { name: 'TELEGRAM_BOT_TOKEN', feature: 'Alerty Telegram', level: 'optional', note: 'token z @BotFather; kopia alertów krytycznych + raport dzienny (lib/alerts/telegram.ts)' },
  { name: 'TELEGRAM_ALERT_CHAT_IDS', feature: 'Alerty Telegram', level: 'optional', note: 'ID czatów prywatnych po przecinku; bez tego kanał wyłączony' },
  { name: 'OPS_HEARTBEAT_URL', feature: 'Heartbeat workera', level: 'optional', note: 'URL pinga Uptime Kuma push / Healthchecks.io — tylko worker (lib/jobs/heartbeat.ts)' },

  // ── Analityka ──
  { name: 'NEXT_PUBLIC_POSTHOG_KEY', feature: 'Analityka (PostHog)', level: 'required' },
  { name: 'NEXT_PUBLIC_POSTHOG_HOST', feature: 'Analityka (PostHog)', level: 'required' },

  // ── Push notifications ──
  { name: 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', feature: 'Push (przypomnienia)', level: 'required', note: 'bez kompletu push cicho nie wychodzą' },
  { name: 'VAPID_PRIVATE_KEY', feature: 'Push (przypomnienia)', level: 'required' },
  { name: 'VAPID_SUBJECT', feature: 'Push (przypomnienia)', level: 'required' },

  // ── Panel admina + raporty operatora ──
  { name: 'ADMIN_EMAILS', feature: 'Panel admina', level: 'required', note: 'pusty = /admin zablokowany + brak daily summary (fail-closed)' },

  // ── Joby w tle (pg-boss; Inngest odpięty w etapie 10) ──
  { name: 'JOBS_BACKEND', feature: 'Joby w tle (pg-boss)', level: 'optional', note: 'brak albo pgboss; inna wartość = zlecenia odrzucane, worker nie startuje' },
  { name: 'DATABASE_URL', feature: 'Joby w tle (pg-boss)', level: 'required', note: 'Postgres db-1 przez sieć prywatną (worker + enqueue z aplikacji)' },
  { name: 'WORKER_HEALTH_PORT', feature: 'Joby w tle (pg-boss)', level: 'optional', note: 'tylko worker; port healthchecku Coolify (domyślnie 8080)' },
  { name: 'WORKER_DISABLE_SCHEDULES', feature: 'Joby w tle (pg-boss)', level: 'optional', note: 'tylko worker; "true" wyłącza crony i czyści zapisany harmonogram' },
  { name: 'APP_ENV', feature: 'Rdzeń aplikacji', level: 'optional', note: 'serwerowy odpowiednik NEXT_PUBLIC_APP_ENV dla bramek bezpieczeństwa (lib/security/environment.ts)' },

  // ── ODŁOŻONE świadomie (nie blokują startu) ──
  { name: 'STRIPE_SECRET_KEY', feature: 'Billing (Stripe)', level: 'deferred', note: 'Faza 37 — wymaga firmy; UI degraduje gracefully' },
  { name: 'STRIPE_WEBHOOK_SECRET', feature: 'Billing (Stripe)', level: 'deferred' },
  { name: 'STRIPE_PRICE_MONTHLY', feature: 'Billing (Stripe)', level: 'deferred' },
  { name: 'STRIPE_PRICE_ANNUAL', feature: 'Billing (Stripe)', level: 'deferred' },
  { name: 'STRIPE_API_VERSION', feature: 'Billing (Stripe)', level: 'optional' },
  { name: 'STRIPE_BLIK_RECURRING', feature: 'Billing (Stripe)', level: 'optional', note: 'włącza tylko „on”: BLIK obok karty przy próbie; najpierw docs/runbooks/stripe-blik.md' },
  { name: 'FAKTFLOW_OPERATOR_TENANT_ID', feature: 'Self-invoicing', level: 'deferred', note: 'Faza 37+ (nasza firma jako sprzedawca)' },
  { name: 'FAKTFLOW_OPERATOR_BANK_ACCOUNT', feature: 'Self-invoicing', level: 'deferred' },
  { name: 'GUS_API_KEY', feature: 'GUS (dane firm)', level: 'required', note: 'bez klucza: sandbox GUS (stare, zanonimizowane dane) — przy KSEF_ENV=production JPK_FA odmawia (adres siedziby z GUS), a podpowiedzi kontrahentów idą z danych testowych' },
  { name: 'AWS_ACCESS_KEY_ID', feature: 'Archiwum Glacier', level: 'deferred', note: 'Faza 2 po launchu — cron nie znajdzie faktur >2 lat do ~2028' },
  { name: 'AWS_SECRET_ACCESS_KEY', feature: 'Archiwum Glacier', level: 'deferred' },
  { name: 'AWS_ARCHIVE_BUCKET', feature: 'Archiwum Glacier', level: 'deferred' },
  { name: 'AWS_REGION', feature: 'Archiwum Glacier', level: 'optional' },
];

/** Placeholder = pusty / seria x-ów / znane wzorce z .env.example. */
function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^"|"$/g, '');
  if (v.length === 0) return true;
  if (/x{4,}/i.test(v)) return true;
  if (v === 'sk_test_placeholder') return true;
  if (v.startsWith('re_xxxx')) return true;
  return false;
}

function parseEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
  }
  return out;
}

// ── main ──
const args = process.argv.slice(2).filter((a) => a !== '--');
const strict = args.includes('--strict');
const fileArg = args.find((a) => !a.startsWith('--'));
const envPath = resolve(process.cwd(), fileArg ?? '.env.local');

let env: Map<string, string>;
try {
  env = parseEnvFile(envPath);
} catch {
  console.error(`✗ Nie można odczytać pliku: ${envPath}`);
  process.exit(1);
}

console.log(`\n🔍 check-env: ${envPath}\n`);

const byFeature = new Map<string, VarSpec[]>();
for (const spec of SPECS) {
  const list = byFeature.get(spec.feature) ?? [];
  list.push(spec);
  byFeature.set(spec.feature, list);
}

let requiredMissing = 0;

for (const [feature, specs] of byFeature) {
  const lines: string[] = [];
  let featureBroken = false;

  for (const spec of specs) {
    const raw = env.get(spec.name);
    const bad = raw === undefined || isPlaceholder(raw);

    let icon: string;
    if (!bad) {
      icon = '✓';
    } else if (spec.level === 'required') {
      icon = '✗';
      requiredMissing++;
      featureBroken = true;
    } else if (spec.level === 'deferred') {
      icon = '⏳';
    } else {
      icon = '·';
    }

    const note = bad && spec.note ? `  — ${spec.note}` : '';
    lines.push(`  ${icon} ${spec.name}${note}`);
  }

  const marker = featureBroken ? '🔴' : '🟢';
  console.log(`${marker} ${feature}`);
  for (const l of lines) console.log(l);
  console.log('');
}

console.log('Legenda: ✓ ok · ✗ BRAK (wymagane) · ⏳ odłożone świadomie · · opcjonalne\n');

if (requiredMissing > 0) {
  console.log(`⚠️  Braki w zmiennych WYMAGANYCH: ${requiredMissing}`);
  if (strict) process.exit(1);
} else {
  console.log('✅ Wszystkie wymagane zmienne mają realne wartości.');
}
