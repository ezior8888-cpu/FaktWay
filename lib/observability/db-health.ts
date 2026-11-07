/**
 * Stan bazy do raportu dziennego na Telegram (06:00): rozmiar bazy, WAL
 * trzymany przez sloty replikacji i ostatnia kopia.
 *
 * Slot bez konsumenta (Logflare na db-1 nie ma retencji) blokuje usuwanie
 * WAL, a dysk db-1 ma 40 GB, więc rosnący WAL to pierwsza oznaka kłopotu.
 * Kopia: `public.backup_log`, to samo źródło co bramka (`ops.status()`).
 *
 * Tylko odczyt, jedno zapytanie przez połączenie pg-boss (`DATABASE_URL`).
 * Błąd odczytu daje `null`: raport idzie dalej z linią o nieudanym odczycie.
 */

import { startBoss } from '@/lib/jobs/boss';

export interface DbHealth {
  databaseBytes: number;
  /** Najwięcej WAL, ile trzyma jeden slot (0 = brak slotów z `restart_lsn`). */
  slotWalBytes: number;
  slotName: string | null;
  /** Start ostatniej udanej kopii (ISO) albo `null`, gdy nie było żadnej. */
  backupAt: string | null;
  backupFailed24h: number;
}

const DB_HEALTH_SQL = `
  WITH slots AS (
    SELECT slot_name, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained
      FROM pg_replication_slots
     WHERE restart_lsn IS NOT NULL
  )
  SELECT
    pg_database_size(current_database()) AS db_bytes,
    coalesce((SELECT max(retained) FROM slots), 0) AS slot_wal_bytes,
    (SELECT slot_name FROM slots ORDER BY retained DESC LIMIT 1) AS slot_name,
    (SELECT max(started_at) FROM public.backup_log WHERE status = 'success') AS backup_at,
    (SELECT count(*) FROM public.backup_log
      WHERE status = 'failed' AND started_at > now() - interval '24 hours') AS backup_failed_24h`;

interface Row {
  db_bytes: unknown;
  slot_wal_bytes: unknown;
  slot_name: unknown;
  backup_at: unknown;
  backup_failed_24h: unknown;
}

export async function readDbHealth(): Promise<DbHealth | null> {
  try {
    const boss = await startBoss();
    const { rows } = await boss.getDb().executeSql(DB_HEALTH_SQL);
    const row = (rows as Row[])[0];
    if (!row) return null;
    const backupAt = row.backup_at ? new Date(row.backup_at as string | Date).toISOString() : null;
    return {
      databaseBytes: Number(row.db_bytes),
      slotWalBytes: Number(row.slot_wal_bytes),
      slotName: row.slot_name ? String(row.slot_name) : null,
      backupAt,
      backupFailed24h: Number(row.backup_failed_24h),
    };
  } catch {
    return null;
  }
}
