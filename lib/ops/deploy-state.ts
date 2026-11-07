/**
 * Stan wdrożenia dla workflowu `.github/workflows/obrazy.yml` (plan usprawnień 3.1).
 *
 * Przed wdrożeniem workflow sprawdza, czy każda migracja z wdrażanego SHA ma
 * wpis w `supabase_migrations.schema_migrations` na db-1, a po wdrożeniu, czy
 * aplikacja chodzi na nowym commicie. GitHub nie ma klucza SSH do serwerów,
 * więc pyta aplikację, która i tak ma połączenie z bazą (pg-boss, `DATABASE_URL`).
 *
 * Tylko odczyt. Odpowiedź to numery migracji (pliki leżą w publicznym repo)
 * i SHA obrazu. Bez `DEPLOY_STATE_TOKEN` (co najmniej 32 znaki) trasa udaje,
 * że jej nie ma (404); z błędnym tokenem też 404.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { startBoss } from '@/lib/jobs/boss';

export const DEPLOY_STATE_TOKEN_MIN_LENGTH = 32;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** `Authorization: Bearer <token>` zgodny z tokenem z env. Porównanie w stałym czasie. */
export function isDeployStateAuthorized(authorization: string | null, token: string | undefined): boolean {
  if (!token || token.length < DEPLOY_STATE_TOKEN_MIN_LENGTH) return false;
  const match = /^Bearer\s+(\S+)$/.exec(authorization ?? '');
  if (!match?.[1]) return false;
  return timingSafeEqual(sha256(match[1]), sha256(token));
}

const APPLIED_MIGRATIONS_SQL = 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version';

/** Wersje z `schema_migrations` (np. `00167`), rosnąco. */
export async function readAppliedMigrations(): Promise<string[]> {
  const boss = await startBoss();
  const { rows } = await boss.getDb().executeSql(APPLIED_MIGRATIONS_SQL);
  return (rows as { version: unknown }[]).map((row) => String(row.version));
}

/**
 * SHA, z którego zbudowano obraz (`APP_COMMIT_SHA`, argument builda w CI).
 * Obraz z Coolify (build z `Dockerfile` na serwerze) go nie ma: `null`.
 */
export function deployedCommit(): string | null {
  const sha = process.env.APP_COMMIT_SHA?.trim().toLowerCase();
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
