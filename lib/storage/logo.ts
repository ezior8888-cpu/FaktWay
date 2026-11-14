import { randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';

import type { LogoFormat } from '@/lib/pdf/logo-obraz';
import { LOGO_FILE_LIMIT_BYTES } from '@/lib/upload-limit';

import { getR2Client, getR2Config } from './r2-client';
import { isTenantStoragePath } from './tenant-path';

/**
 * Logo firmy w magazynie plików (plan kompletnej aplikacji, krok 2.2,
 * część 1). Klucz: `tenants/<id firmy>/logo/<uuid>.png|jpg`, nowy przy każdym
 * wgraniu (plik pod kluczem nigdy się nie zmienia, więc PDF w pamięci
 * podręcznej z tym kluczem w nazwie jest zawsze aktualny). Ten sam wzór
 * pilnuje CHECK `tenants_logo_storage_key_check` (00203) w bazie.
 *
 * Katalog leży pod prefiksem `tenants/<id>/`, który zamiata usuwanie firmy
 * (`docs/prawne/usuwanie-firmy-projekt.md`, § 6.5; lista prefiksów
 * w `tenant-path.ts`). Pojedyncze logo usuwa `lib/invoices/logo-firmy.ts`.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const NAZWA_RE = new RegExp(`^${UUID}\\.(?:png|jpg)$`);
const ROZSZERZENIE: Record<LogoFormat, 'png' | 'jpg'> = { png: 'png', jpeg: 'jpg' };

export const LOGO_CONTENT_TYPE: Record<LogoFormat, string> = { png: 'image/png', jpeg: 'image/jpeg' };

/** Największy obiekt logo, który odczyt przyjmie (zapisane logo ma najwyżej tyle). */
export const LOGO_OBJECT_MAX_BYTES = LOGO_FILE_LIMIT_BYTES;

/**
 * Sprzątanie nie rusza plików młodszych niż to: mogą być wgraniem w toku
 * (druga karta, drugi administrator), którego wskaźnik w bazie zaraz się zapisze.
 */
export const LOGO_SWEEP_MIN_AGE_MS = 15 * 60 * 1000;

export function tenantLogoPrefix(tenantId: string): string {
  return `tenants/${tenantId}/logo/`;
}

export function newTenantLogoKey(tenantId: string, format: LogoFormat): string {
  if (!UUID_RE.test(tenantId)) throw new Error('Invalid organization id for a logo key');
  return `${tenantLogoPrefix(tenantId)}${randomUUID()}.${ROZSZERZENIE[format]}`;
}

/** Klucz logo tej firmy: jej katalog `logo/`, nazwa z UUID i rozszerzeniem PNG albo JPEG, bez `..`. */
export function isTenantLogoKey(key: unknown, tenantId: string): key is string {
  if (typeof key !== 'string' || !UUID_RE.test(tenantId)) return false;
  const prefix = tenantLogoPrefix(tenantId);
  return key.startsWith(prefix) && NAZWA_RE.test(key.slice(prefix.length)) && isTenantStoragePath(key, tenantId);
}

export function logoFormatOfKey(key: string): LogoFormat {
  return key.endsWith('.jpg') ? 'jpeg' : 'png';
}

function assertLogoKey(key: string, tenantId: string): void {
  // Celowo bez klucza i firmy w treści (jak assertTenantStoragePath).
  if (!isTenantLogoKey(key, tenantId)) throw new Error('Storage key is not a logo of this organization');
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return error instanceof NoSuchKey || e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Zapis pliku pod nowym kluczem. `IfNoneMatch: *`: klucz z UUID jest nowy,
 * więc istniejący obiekt znaczy błąd, nie ponowienie, i nie zostaje nadpisany.
 */
export async function putTenantLogo(key: string, tenantId: string, data: Buffer, format: LogoFormat): Promise<void> {
  assertLogoKey(key, tenantId);
  const { bucketName } = getR2Config();
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: data,
      ContentType: LOGO_CONTENT_TYPE[format],
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
      Metadata: { 'tenant-id': tenantId, 'document-type': 'company-logo' },
    }),
  );
}

/** Plik logo albo `null`, gdy go nie ma. Inny błąd magazynu rzuca. */
export async function getTenantLogo(key: string, tenantId: string): Promise<Buffer | null> {
  assertLogoKey(key, tenantId);
  const { bucketName } = getR2Config();
  let response;
  try {
    response = await getR2Client().send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if ((response.ContentLength ?? 0) > LOGO_OBJECT_MAX_BYTES) throw new Error('Logo object is larger than allowed');
  const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) return null;
  const bytes = Buffer.from(await body.transformToByteArray());
  if (bytes.length > LOGO_OBJECT_MAX_BYTES) throw new Error('Logo object is larger than allowed');
  return bytes;
}

/** Czy plik logo jest w magazynie (podgląd w ustawieniach). Błąd magazynu rzuca. */
export async function tenantLogoExists(key: string, tenantId: string): Promise<boolean> {
  assertLogoKey(key, tenantId);
  const { bucketName } = getR2Config();
  try {
    await getR2Client().send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Usuwa jeden plik logo tej firmy. Brak obiektu to sukces (ponowienie po udanym usunięciu). */
export async function deleteTenantLogo(key: string, tenantId: string): Promise<void> {
  assertLogoKey(key, tenantId);
  const { bucketName } = getR2Config();
  try {
    await getR2Client().send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/**
 * Sprzątanie katalogu logo firmy: usuwa pliki inne niż `keep`, starsze niż
 * `LOGO_SWEEP_MIN_AGE_MS` (sieroty po wgraniu, którego zapis w bazie i
 * usunięcie pliku się nie udały, albo po nieudanym usunięciu starego logo).
 * Tylko klucze logo tej firmy; zwraca liczbę usuniętych. Błąd magazynu rzuca.
 */
export async function sweepTenantLogos(tenantId: string, keep: string | null, now: number = Date.now()): Promise<number> {
  if (!UUID_RE.test(tenantId)) throw new Error('Invalid organization id for a logo sweep');
  const { bucketName } = getR2Config();
  const client = getR2Client();
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({ Bucket: bucketName, Prefix: tenantLogoPrefix(tenantId), ContinuationToken: continuationToken }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key || key === keep || !isTenantLogoKey(key, tenantId)) continue;
      const modified = object.LastModified?.getTime();
      if (modified === undefined || now - modified < LOGO_SWEEP_MIN_AGE_MS) continue;
      await deleteTenantLogo(key, tenantId);
      deleted += 1;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}
