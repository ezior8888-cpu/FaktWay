/**
 * Tabele które celowo POMIJAMY w snapshot:
 *
 * - `audit_logs` jest gigantyczne i ma osobną retencję 12-mc + już immutable.
 *   Restore z snapshotu i tak by nie pasowało (powstałby duplikat zdarzeń).
 * - `inngest_run_log` — operacyjne, samo się rotuje, nie potrzeba.
 * - `ksef_health_log` — telemetria zewnętrzna, generowana na nowo.
 * - `_supabase_migrations` itp. — system tables.
 *
 * Reszta wszystko z `public.*` leci do snapshotu — czytana jako `service_role`.
 * Osobny moduł bez zależności, bo czyta go też strażnik
 * `tests/unit/backup-readable-tables.test.ts`: tabela spoza tej listy, której
 * migracje zabiorą `service_role` odczyt, wywala CI zamiast nocnego backupu.
 */
export const SKIP_TABLES: ReadonlySet<string> = new Set([
  'audit_logs',
  'inngest_run_log',
  'ksef_health_log',
  'gdpr_deletion_requests', // PII + ma własną logikę cooling-off, restore by zepsuł flow
  'webauthn_challenges', // wygasają po 5 minutach, po odtworzeniu i tak martwe
]);
