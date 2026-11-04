// Konfiguracja bramki ze zmiennych środowiskowych (Coolify, aplikacja na ops-1).
// Brak wymaganej zmiennej = proces nie startuje. Wartości sekretów nigdy nie
// trafiają do logów.

const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'BRAMKA_USERS',
  'BRAMKA_TOTP_SECRET',
  'OPS_DATABASE_URL',
  'COOLIFY_API_URL',
  'COOLIFY_API_TOKEN',
  'COOLIFY_APP_WEB',
  'COOLIFY_APP_WORKER',
];

/**
 * BRAMKA_USERS: „123456789:Bartosz,987654321:Igor” — identyfikatory Telegrama
 * (from.id) osób, które mogą wydawać polecenia. Wszyscy inni są ignorowani.
 */
export function parseUsers(raw) {
  const users = new Map();
  for (const part of String(raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,20}):(.{1,32})$/.exec(part);
    if (!m) throw new Error('BRAMKA_USERS: oczekiwano „id:imię” rozdzielonych przecinkami');
    users.set(m[1], m[2].trim());
  }
  if (users.size === 0) throw new Error('BRAMKA_USERS: pusta lista');
  if (users.size > 5) throw new Error('BRAMKA_USERS: najwyżej 5 osób');
  return users;
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length > 0) throw new Error(`Brak zmiennych: ${missing.join(', ')}`);
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN.trim(),
    users: parseUsers(env.BRAMKA_USERS),
    totpSecret: env.BRAMKA_TOTP_SECRET.trim(),
    databaseUrl: env.OPS_DATABASE_URL.trim(),
    coolify: {
      baseUrl: env.COOLIFY_API_URL.trim().replace(/\/$/, ''),
      token: env.COOLIFY_API_TOKEN.trim(),
      webUuid: env.COOLIFY_APP_WEB.trim(),
      workerUuid: env.COOLIFY_APP_WORKER.trim(),
    },
    github: {
      repo: (env.GITHUB_REPO ?? 'ezior8888-cpu/ksef-saas').trim(),
      branch: (env.GITHUB_BRANCH ?? 'main').trim(),
      token: env.GITHUB_TOKEN?.trim() || null,
    },
    healthUrl: (env.PUBLIC_HEALTH_URL ?? 'https://faktway.pl/api/health').trim(),
    // Kontrole, bez których wdrożenie się nie zacznie (nazwy jobów z CI).
    requiredChecks: (env.BRAMKA_REQUIRED_CHECKS ?? 'Typecheck + Lint + Unit tests,Next build')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };
}
