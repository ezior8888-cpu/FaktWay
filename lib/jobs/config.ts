/**
 * Konfiguracja kolejki jobów.
 *
 * Jedyny backend to pg-boss w naszym Postgresie (etap 10, 02.10.2026:
 * Inngest odpięty — bez ścieżki powrotu). `JOBS_BACKEND` jest opcjonalny;
 * jeśli ustawiony, musi mieć wartość `pgboss`. Każda inna (także dawne
 * `inngest`) to błąd konfiguracji: zlecenie nie zostaje wysłane, a worker
 * nie startuje — zamiast udawać, że zadania gdzieś trafiają.
 */

import { isBypassAllowedEnv } from '@/lib/security/environment';

export type JobsBackend = 'pgboss';

/** Backend z konfiguracji albo `null` przy nieznanej wartości — bez wyjątku (health). */
export function resolveJobsBackend(): JobsBackend | null {
  const raw = process.env.JOBS_BACKEND?.trim();
  return !raw || raw === 'pgboss' ? 'pgboss' : null;
}

export function getJobsBackend(): JobsBackend {
  const resolved = resolveJobsBackend();
  if (resolved) return resolved;
  throw new Error(
    "JOBS_BACKEND ma nieobsługiwaną wartość — jedyny backend to 'pgboss' (Inngest odpięty). Zlecenie NIE zostało wysłane.",
  );
}

/** Worker startuje tylko przy poprawnej konfiguracji kolejki. */
export function assertPgBossWorkerBackend(): void {
  if (!resolveJobsBackend()) {
    throw new Error(
      "Worker pg-boss: JOBS_BACKEND ma nieobsługiwaną wartość (dozwolone: brak albo 'pgboss').",
    );
  }
}

/**
 * Connection string do Postgresa dla pg-boss (schemat `pgboss` obok `public`).
 * Wymagany TYLKO przez worker i enqueue w trybie pgboss — stąd błąd dopiero
 * przy użyciu, nie przy imporcie modułu.
 */
export function getJobsDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL nie ustawiony — wymagany dla backendu pg-boss (worker/enqueue).',
    );
  }
  return url;
}

const DEFAULT_JOBS_SCHEMA = 'pgboss';
const TEST_JOBS_SCHEMA = /^pgboss_[a-z0-9_]{1,40}$/;

/** Testy obciążenia i testy na bazie mogą mieć osobną kolejkę, ale nigdy produkcja. */
function nonProductionOverride(env: Record<string, string | undefined>): boolean {
  return isBypassAllowedEnv() && env.NODE_ENV !== 'production';
}

/**
 * Schemat pg-boss. Na produkcji zawsze `pgboss`. Test obciążenia skrzynki
 * (`load-tests/ksef-inbox/`) i test na bazie idą w osobnym schemacie, bo lokalna
 * baza bywa wspólna, a cudzy worker wziąłby ich zadania.
 */
export function getJobsSchema(env: Record<string, string | undefined> = process.env): string {
  const raw = env.JOBS_PGBOSS_SCHEMA?.trim();
  if (!raw) return DEFAULT_JOBS_SCHEMA;
  if (!nonProductionOverride(env) || !TEST_JOBS_SCHEMA.test(raw)) {
    throw new Error('JOBS_PGBOSS_SCHEMA jest tylko dla testów poza produkcją (pgboss_<nazwa>).');
  }
  return raw;
}

/**
 * Crony do zaplanowania przez worker: `null` = wszystkie. Test obciążenia
 * skrzynki uruchamia prawdziwy worker tylko z cronem rozsyłki, bo pozostałe
 * (retencja, maile, kopie) pracowałyby na wspólnej lokalnej bazie.
 */
export function getWorkerCronAllowlist(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const raw = env.WORKER_ONLY_CRONS?.trim();
  if (!raw) return null;
  if (!nonProductionOverride(env)) {
    throw new Error('WORKER_ONLY_CRONS jest tylko dla testów poza produkcją.');
  }
  return new Set(raw.split(',').map((queue) => queue.trim()).filter(Boolean));
}

/** Port healthchecku HTTP workera (Coolify + ewentualny push do Kumy). */
export function getWorkerHealthPort(): number {
  const raw = process.env.WORKER_HEALTH_PORT?.trim();
  const port = raw ? Number(raw) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Niepoprawny WORKER_HEALTH_PORT: ${raw}`);
  }
  return port;
}
