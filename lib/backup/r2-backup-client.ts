import { Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, type _Object } from '@aws-sdk/client-s3';
import { getR2Client, getR2Config } from '@/lib/storage/r2-client';

/**
 * Klient R2 dla backupów. Reusuje credentials z głównej konfiguracji
 * (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY), ale opcjonalnie
 * używa OSOBNEGO bucketa `R2_BACKUPS_BUCKET`.
 *
 * Dlaczego osobny bucket: oddziela retention policies (faktury hot 90d,
 * backupy 30d daily), ułatwia per-bucket IAM scoping, i daje przejrzysty
 * podgląd na storage cost. Fallback: jeśli `R2_BACKUPS_BUCKET` nie ustawione,
 * używamy głównego bucketa z prefixem `backups/`.
 */

interface BackupBucketCtx {
  bucket: string;
  /** Konkatenowany z `r2Key` w build/list/delete. */
  keyPrefix: string;
}

function getBackupCtx(): BackupBucketCtx {
  const custom = process.env.R2_BACKUPS_BUCKET?.trim();
  if (custom && !custom.startsWith('x')) {
    return { bucket: custom, keyPrefix: '' };
  }
  const cfg = getR2Config();
  return { bucket: cfg.bucketName, keyPrefix: 'backups/' };
}

export interface SnapshotKey {
  /** Pełny klucz z prefixem (do uploadu / pobrania). */
  full: string;
  /** Klucz bez prefixu — do zapisu w `backup_log.r2_key`. */
  relative: string;
}

/**
 * Format klucza: `db/YYYY/MM/DD-HHMMSS.json.gz` (relative) plus prefix.
 * UTC w timestamp żeby snapshoty z różnych stref były porównywalne.
 */
export function buildSnapshotKey(now: Date): SnapshotKey {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const relative = `db/${yyyy}/${mm}/${dd}-${hh}${min}${ss}.json.gz`;
  const ctx = getBackupCtx();
  return { full: `${ctx.keyPrefix}${relative}`, relative };
}

export async function uploadSnapshot(
  fullKey: string,
  body: Uint8Array,
  checksumSha256Hex: string,
): Promise<void> {
  const client = getR2Client();
  const { bucket } = getBackupCtx();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: fullKey,
      Body: body,
      ContentType: 'application/gzip',
      // Custom metadata — verify cron porówna z backup_log.checksum.
      Metadata: { 'sha256-hex': checksumSha256Hex },
    }),
  );
}

/**
 * Plik kopii jako strumień (weryfikacja czyta go kawałkami, CPU-V2), zamiast
 * całego pliku w pamięci. W Node SDK zwraca `Readable`.
 */
export async function openSnapshotStream(fullKey: string): Promise<Readable> {
  const client = getR2Client();
  const { bucket } = getBackupCtx();
  const out = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: fullKey }),
  );
  if (!out.Body) {
    throw new Error(`snapshot_empty: ${fullKey}`);
  }
  if (!(out.Body instanceof Readable)) {
    throw new Error(`snapshot_body_not_stream: ${fullKey}`);
  }
  return out.Body;
}

export async function deleteSnapshot(fullKey: string): Promise<void> {
  const client = getR2Client();
  const { bucket } = getBackupCtx();
  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: fullKey }),
  );
}

export interface ListedSnapshot {
  key: string;
  lastModified: Date | undefined;
  sizeBytes: number;
}

/**
 * Lista snapshotów dla cleanup cron. Filtruje po prefixie `<keyPrefix>db/`.
 * R2 zwraca max 1000 per page — paginujemy gdy więcej.
 */
export async function listSnapshots(): Promise<ListedSnapshot[]> {
  const client = getR2Client();
  const { bucket, keyPrefix } = getBackupCtx();
  const prefix = `${keyPrefix}db/`;
  const all: ListedSnapshot[] = [];
  let continuationToken: string | undefined;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of out.Contents ?? []) {
      const o = obj as _Object;
      if (!o.Key) continue;
      all.push({
        key: o.Key,
        lastModified: o.LastModified,
        sizeBytes: o.Size ?? 0,
      });
    }
    continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (continuationToken);
  return all;
}
