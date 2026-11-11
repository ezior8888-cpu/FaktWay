/**
 * Ustawienia nocnej kopii JSON (warstwa C, `docs/runbooks/backup-restore.md` § 6).
 *
 * Osobny moduł bez zależności, bo czytają go strażnik
 * `tests/unit/backup-readable-tables.test.ts` i testy kopii (podmieniają progi).
 *
 * Tabele, które celowo POMIJAMY w snapshot:
 *
 * - `audit_logs` jest gigantyczne i ma osobną retencję 12-mc + już immutable.
 *   Restore z snapshotu i tak by nie pasowało (powstałby duplikat zdarzeń).
 * - `inngest_run_log` — operacyjne, samo się rotuje, nie potrzeba.
 * - `ksef_health_log` — telemetria zewnętrzna, generowana na nowo.
 * - `_supabase_migrations` itp. — system tables.
 *
 * Reszta wszystko z `public.*` leci do snapshotu — czytana jako `service_role`.
 * Tabela spoza tej listy, której migracje zabiorą `service_role` odczyt,
 * wywala CI zamiast nocnego backupu.
 */
export const SKIP_TABLES: ReadonlySet<string> = new Set([
  'audit_logs',
  'inngest_run_log',
  'ksef_health_log',
  'gdpr_deletion_requests', // PII + ma własną logikę cooling-off, restore by zepsuł flow
  'webauthn_challenges', // wygasają po 5 minutach, po odtworzeniu i tak martwe
]);

/**
 * Klucz, po którym kopia czyta tabelę stronami (plan skalowania, sesja 12,
 * QAL-01). Domyślnie `id`. Tu są tabele bez unikalnego `id`, każda ze swoim
 * kluczem głównym w kolejności kolumn klucza (wtedy Postgres czyta stronę
 * z indeksu klucza). Strażnik w `tests/unit/backup-readable-tables.test.ts`
 * sprawdza tę listę z migracjami: nowa tabela bez `id` wywala CI, nie kopię.
 */
export const SNAPSHOT_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['billing_invoice_counters', ['operator_tenant_id', 'period']],
  // Adres kalendarza (00182, krok 7.3): jeden wiersz na firmę, kluczem jest firma.
  ['calendar_feed_tokens', ['tenant_id']],
  ['flo_decisions', ['tenant_id', 'kind']],
  ['flo_kind_flags', ['tenant_id', 'kind']],
  ['flo_prefs', ['tenant_id']],
  ['flo_rollout', ['kind']],
  ['flo_usage', ['tenant_id', 'day']],
  ['global_feature_flags', ['flag']],
  ['ksef_error_codes', ['code']],
  ['ksef_inbox_cursor', ['tenant_id']],
  ['ksef_inbox_schedule', ['tenant_id']],
  ['stripe_financial_case_refs', ['stripe_object_id', 'reference_kind', 'reference_id']],
  ['stripe_financial_cases', ['stripe_object_id']],
  ['stripe_refund_operations', ['payment_id']],
  ['stripe_subscription_sync_leases', ['stripe_subscription_id']],
  ['tenant_feature_flags', ['tenant_id']],
]);

const DOMYSLNY_KLUCZ: readonly string[] = ['id'];

export function snapshotKeyFor(table: string): readonly string[] {
  return SNAPSHOT_KEYS.get(table) ?? DOMYSLNY_KLUCZ;
}

/**
 * Bezpiecznik rozmiaru (JOB-02): kopia liczy bajty JSON-a w trakcie zapisu
 * i po przekroczeniu progu kończy się alarmem „kopia niepełna”, bez wgrywania
 * pliku. Spakowany plik czeka w pamięci workera na wgranie (jedno PutObject),
 * więc próg ogranicza też pamięć: JSON z uuid-ami pakuje się ok. 3 do 6 razy,
 * czyli przy progu to ok. 85–170 MB. Stary zapis nie przeszedłby i tak przez
 * limit długości napisu w V8 (ok. 512 MB), tylko wywracał worker.
 */
export const MAX_SNAPSHOT_JSON_BYTES = 512 * 1024 * 1024;

/**
 * Weryfikacja (CPU-V2) parsuje kopię linia po linii. Dłuższa linia (wiersz
 * z ogromnym polem albo stara kopia jednoliniowa) nie jest parsowana, tylko
 * liczona, z ostrzeżeniem w wyniku. Ogranicza pamięć weryfikacji.
 */
export const MAX_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;
