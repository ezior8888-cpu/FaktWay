// Cron job: codzienny snapshot DB do R2 (Faza 29).
//
// Trigger: 02:00 PL codziennie. Low-traffic window — w razie performance hitu
// userzy śpią. W niedziele kind='weekly' (zostaje 8 tygodni vs 30 dni daily).
//
// Concurrency: limit 1. Snapshot na pełnym dumpem może trwać kilka minut przy
// rosnącym wolumenie — równoległe wywołania zarżnęłyby DB.
//
// Kopia ponad progiem rozmiaru (plan skalowania, sesja 12, JOB-02) nie rzuca
// wyjątku: wpis „failed” z `kopia_niepelna`, jeden alarm na dzień i koniec
// joba. Wyjątek oznaczałby do 4 ponowień, każde tak samo ciężkie i z tym
// samym wynikiem.

import * as Sentry from '@sentry/nextjs';

import { alertCritical, sendSlackAlert } from '@/lib/alerts/slack';
import {
  logBackupFailure,
  logBackupKey,
  logBackupStart,
  logBackupSuccess,
  type BackupKind,
} from '@/lib/backup/backup-log';
import { createDbSnapshot, type SnapshotIncomplete } from '@/lib/backup/db-snapshot';
import { cacheGet, cacheSet } from '@/lib/cache';

import type { JobContext } from '@/lib/jobs/registry';

const MIB = 1024 * 1024;

/** Klucz w Redisie trzyma się dłużej niż doba, żeby objąć całą noc w UTC. */
const INCOMPLETE_ALERT_TTL_SECONDS = 36 * 60 * 60;

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.daily-db-snapshot).
 */
export async function runDailyDbSnapshot({ step }: JobContext) {
    const now = new Date();
    // 0=ndz w UTC; przy 02:00 PL = 00:00 albo 01:00 UTC, wciąż niedziela.
    const kind = now.getUTCDay() === 0 ? 'weekly' : 'daily';

    const logId = await step.run('log-start', async () => {
      return await logBackupStart(kind);
    });

    const startedAt = Date.now();

    try {
      const result = await step.run('snapshot', async () => {
        return await createDbSnapshot({
          kind,
          now,
          // Klucz pliku w backup_log przed wgraniem: plik próby, która potem
          // padnie, dalej usunie sprzątanie kopii (szuka plików po r2_key).
          beforeUpload: (key) => logBackupKey(logId, key.relative),
        });
      });

      if (!result.complete) {
        await step.run('log-incomplete', async () => {
          await logBackupFailure(logId, incompleteLogMessage(result), result.durationMs);
        });
        const alarm = await step.run('alarm-incomplete', async () => {
          return await alertIncompleteOncePerDay(result, kind, now);
        });
        return {
          kind,
          complete: false,
          json_bytes: result.jsonBytes,
          duration_ms: result.durationMs,
          alarm,
        };
      }

      await step.run('log-success', async () => {
        await logBackupSuccess(logId, {
          r2_key: result.r2KeyRelative,
          size_bytes: result.sizeBytes,
          row_counts: result.rowCounts,
          checksum: result.checksum,
          duration_ms: result.durationMs,
        });
      });

      await step.run('slack-success', async () => {
        await sendSlackAlert({
          channel: 'metrics',
          text: `✅ ${kind === 'weekly' ? 'Weekly' : 'Daily'} DB snapshot zakończony.`,
          context: {
            kind,
            size_mb: (result.sizeBytes / 1024 / 1024).toFixed(2),
            // Rozmiar JSON-a przed spakowaniem: to on zbliża się do progu.
            json_mb: (result.jsonBytes / MIB).toFixed(1),
            duration_s: (result.durationMs / 1000).toFixed(1),
            tables: Object.keys(result.rowCounts).length,
          },
        });
      });

      return {
        kind,
        size_bytes: result.sizeBytes,
        duration_ms: result.durationMs,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'unknown';
      Sentry.captureException(err, {
        tags: { job: 'daily-db-snapshot', kind },
      });

      await step.run('log-failure', async () => {
        await logBackupFailure(logId, errorMessage, Date.now() - startedAt);
      });

      await step.run('slack-failure', async () => {
        await sendSlackAlert({
          channel: 'urgent',
          text: `❌ DB snapshot FAILED — RPO at risk. Sprawdź Sentry.`,
          context: { kind, error: errorMessage.slice(0, 200) },
        });
      });

      throw err;
    }
}

function incompleteLogMessage(result: SnapshotIncomplete): string {
  return (
    `kopia_niepelna: JSON przekroczył próg ${result.limitBytes} B przy tabeli ${result.stoppedAtTable} ` +
    `(gotowe ${result.tablesDone} z ${result.tablesTotal} tabel), plik nie został wgrany`
  );
}

type IncompleteAlarm = 'sent' | 'already_sent' | 'not_delivered';

/**
 * Jeden alarm „kopia niepełna” na dzień (UTC). Ponowne doręczenie joba tej
 * samej nocy albo ręczne uruchomienie go nie powtarza.
 *
 * Droga alarmów krytycznych (`alertCritical`): alarm jest dostarczony, gdy
 * potwierdzi go Slack albo Telegram, i dopiero wtedy zapisujemy klucz dnia.
 * Gdy nie potwierdzi żaden kanał: ślad w Sentry i koniec, bez ponowienia joba
 * (kolejna kopia do progu nic by nie zmieniła). Alarm wraca przy ręcznym
 * uruchomieniu albo następnej nocy, a wcześniej odezwie się alarm świeżości
 * kopii (ostatnia udana starsza niż 26 h). Bez Redisa klucz się nie zapisze
 * i alarm przyjdzie przy każdym przebiegu: raczej za dużo niż wcale.
 */
async function alertIncompleteOncePerDay(
  result: SnapshotIncomplete,
  kind: BackupKind,
  now: Date,
): Promise<IncompleteAlarm> {
  const key = `alerts:backup:json-incomplete:${now.toISOString().slice(0, 10)}`;
  if (await cacheGet<string>(key)) return 'already_sent';

  const limitMb = Math.round(result.limitBytes / MIB);
  try {
    await alertCritical(
      `Kopia JSON bazy niepełna (${kind})`,
      `JSON przekroczył próg ${limitMb} MB przy tabeli ${result.stoppedAtTable}, plik nie został wgrany. ` +
        'Zrzut pg_dump (warstwa A) działa osobno. Co zrobić: docs/runbooks/backup-restore.md § 6.',
      {
        fields: [
          { label: 'kind', value: kind },
          { label: 'json_mb', value: (result.jsonBytes / MIB).toFixed(1) },
          { label: 'limit_mb', value: String(limitMb) },
          { label: 'tables_done', value: `${result.tablesDone}/${result.tablesTotal}` },
        ],
      },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { job: 'daily-db-snapshot', kind, step: 'alarm-incomplete' } });
    return 'not_delivered';
  }
  await cacheSet(key, now.toISOString(), INCOMPLETE_ALERT_TTL_SECONDS);
  return 'sent';
}
