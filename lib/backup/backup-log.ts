import { createAdminClient } from '@/lib/supabase/server';

/**
 * Helpery DB do tabeli `backup_log` (migracja 00053). Używane przez
 * Inngest snapshot / verify / cleanup jobs.
 */

export type BackupKind = 'daily' | 'weekly' | 'manual';
export type BackupStatus = 'running' | 'success' | 'failed';

interface BackupLogRow {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  r2_key: string | null;
  size_bytes: number | null;
  row_counts: Record<string, number> | null;
  checksum: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
}

interface BackupLogTable {
  from: (n: 'backup_log') => {
    select: (c: string) => {
      eq: (
        k: string,
        v: string,
      ) => {
        order: (
          k: string,
          opts: { ascending: boolean },
        ) => {
          limit: (
            n: number,
          ) => Promise<{
            data: BackupLogRow[] | null;
            error: { message: string } | null;
          }>;
          maybeSingle: () => Promise<{
            data: BackupLogRow | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    insert: (rows: Array<Partial<BackupLogRow>>) => {
      select: (c: string) => {
        maybeSingle: () => Promise<{
          data: BackupLogRow | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (patch: Partial<BackupLogRow>) => {
      eq: (k: string, v: string) => Promise<{
        error: { message: string } | null;
      }>;
    };
  };
}

export async function logBackupStart(kind: BackupKind): Promise<string> {
  const admin = createAdminClient() as unknown as BackupLogTable;
  const ins = await admin
    .from('backup_log')
    .insert([{ kind, status: 'running' }])
    .select('id')
    .maybeSingle();

  if (ins.error || !ins.data) {
    throw new Error(`backup_log_insert_failed: ${ins.error?.message}`);
  }
  return ins.data.id;
}

/**
 * Klucz pliku kopii, zapisany tuż przed wgraniem (plan skalowania, sesja 12).
 * Sprzątanie (`cleanup-old-backups`) usuwa pliki tylko po `r2_key`, więc
 * plik wgrany przez próbę, która potem padła, bez tego wpisu zostałby na
 * zawsze. Weryfikacja bierze tylko wpisy `success`, więc klucz nieudanej
 * próby niczego nie udaje.
 */
export async function logBackupKey(id: string, r2Key: string): Promise<void> {
  const admin = createAdminClient() as unknown as BackupLogTable;
  const upd = await admin.from('backup_log').update({ r2_key: r2Key }).eq('id', id);
  if (upd.error) {
    throw new Error(`backup_log_update_failed: ${upd.error.message}`);
  }
}

export interface BackupSuccessPatch {
  r2_key: string;
  size_bytes: number;
  row_counts: Record<string, number>;
  checksum: string;
  duration_ms: number;
}

export async function logBackupSuccess(
  id: string,
  patch: BackupSuccessPatch,
): Promise<void> {
  const admin = createAdminClient() as unknown as BackupLogTable;
  const upd = await admin
    .from('backup_log')
    .update({
      status: 'success',
      completed_at: new Date().toISOString(),
      ...patch,
    })
    .eq('id', id);
  if (upd.error) {
    throw new Error(`backup_log_update_failed: ${upd.error.message}`);
  }
}

export async function logBackupFailure(
  id: string,
  errorMessage: string,
  durationMs: number,
): Promise<void> {
  const admin = createAdminClient() as unknown as BackupLogTable;
  await admin
    .from('backup_log')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: errorMessage.slice(0, 1000),
      duration_ms: durationMs,
    })
    .eq('id', id);
}

export interface LastBackupSummary {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  r2Key: string | null;
  sizeBytes: number | null;
  startedAt: Date;
  durationMs: number | null;
  errorMessage: string | null;
  rowCounts: Record<string, number> | null;
  checksum: string | null;
}

/**
 * Zwraca ostatni snapshot danego rodzaju — używane w admin /system oraz
 * verify cron (sprawdza ostatnich N success'ów).
 */
export async function getLastBackup(
  kind: BackupKind,
): Promise<LastBackupSummary | null> {
  const admin = createAdminClient() as unknown as BackupLogTable;
  const res = await admin
    .from('backup_log')
    .select('*')
    .eq('kind', kind)
    .order('started_at', { ascending: false })
    .limit(1);
  if (res.error || !res.data || res.data.length === 0) return null;
  const row = res.data[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    r2Key: row.r2_key,
    sizeBytes: row.size_bytes,
    startedAt: new Date(row.started_at),
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    rowCounts: row.row_counts,
    checksum: row.checksum,
  };
}
