import 'server-only';

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { getR2Client, getR2Config } from './r2-client';
import { assertTenantStoragePath } from './tenant-path';

export interface SignedFileUrlOptions {
  /** Ważność adresu w sekundach: tyle, ile trzeba, by przeglądarka poszła za przekierowaniem. */
  expiresInSeconds: number;
  /** Typ treści odpowiedzi magazynu, niezależnie od metadanych obiektu. */
  contentType: string;
  /** `inline` (podgląd w przeglądarce) albo `attachment; filename="…"` (pobranie). */
  contentDisposition: string;
}

/**
 * Krótki podpisany adres pliku z magazynu z typem i sposobem otwarcia
 * ustalonym przez aplikację, nie przez metadane obiektu (portal księgowej,
 * krok 6.2). Ścieżka musi leżeć w folderze firmy. Cache wyłączony jak
 * w `getSignedInvoiceUrl`: wspólny cache nie może oddawać dokumentu po
 * wygaśnięciu adresu.
 *
 * `getSignedInvoiceUrl` z `lib/storage/r2.ts` nie ustawia typu ani
 * `Content-Disposition`; PR #552 (strona faktury dla nabywcy) dokłada mu te
 * opcje. Po jego scaleniu ten helper można zastąpić tamtym.
 */
export async function getSignedFileUrl(
  storagePath: string,
  tenantId: string,
  options: SignedFileUrlOptions,
): Promise<string> {
  assertTenantStoragePath(storagePath, tenantId);
  const { bucketName } = getR2Config();
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({
      Bucket: bucketName,
      Key: storagePath,
      ResponseCacheControl: 'private, no-store',
      ResponseContentType: options.contentType,
      ResponseContentDisposition: options.contentDisposition,
    }),
    { expiresIn: options.expiresInSeconds },
  );
}
