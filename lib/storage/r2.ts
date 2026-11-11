import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

import { getR2Client, getR2Config } from './r2-client';
import { assertTenantStoragePath, isDocumentArchiveFileKey } from './tenant-path';
import { XmlArchiveConflictError } from './xml-archive-conflict';

/**
 * Warstwa operacji na obiektach R2 pod tabelę `xml_documents` w Supabase.
 *
 * Konwencja kluczy:
 *   {tenantId}/{YYYY}/{MM}/{invoiceId}.xml       - XML faktury
 *   {tenantId}/{YYYY}/{MM}/{invoiceId}.upo.xml   - UPO (dorzucamy po sukcesie KSeF)
 *
 * Dlaczego klucz po `invoiceId` (UUID z DB), a nie po `ksefNumber`:
 *   - XML trzeba zapisać ZANIM wyślemy do KSeF (audit trail draft/queued),
 *     a numer KSeF dostajemy dopiero po odpowiedzi z API.
 *   - invoiceId mapuje się 1:1 na wiersz `xml_documents`, więc kolumna
 *     `storage_path` pełni rolę naturalnego klucza.
 *
 * Klient S3 / konfiguracja endpointa (w tym jurisdiction EU/US/FedRAMP)
 * mieszka w `./r2-client.ts` - tu tylko operacje.
 */

// ═══════════════════════════════════════════════════════════════
// Helpery do budowy kluczy
// ═══════════════════════════════════════════════════════════════

function parseYearMonth(issueDate: string): { year: string; month: string } {
  // Zamiast polegać na split('-') akceptującym dowolne stringi, waliduj format.
  // To jest nie-gorszący bug: zły klucz = nie znajdziesz obiektu za pół roku.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new Error(
      `Invalid issueDate "${issueDate}": expected YYYY-MM-DD (ISO 8601 date)`,
    );
  }
  const [year, month] = issueDate.split('-');
  return { year, month };
}

/** Klucz XML faktury w magazynie — deterministyczny, więc uzgodniona wysyłka zna ścieżkę bez ponownego uploadu. */
export function invoiceXmlKey(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
): string {
  const { year, month } = parseYearMonth(issueDate);
  return `${tenantId}/${year}/${month}/${invoiceId}.xml`;
}

/**
 * Klucz XML JEDNEJ PRÓBY wysyłki (decyzja D5 cyklu życia faktury):
 * `tenant/yyyy/mm/invoiceId/sendAttemptId.xml`. Każde kolejkowanie ma nowy
 * `sendAttemptId`, więc ponowna wysyłka po resecie i poprawie nigdy nie
 * nadpisuje pliku, który poszedł do KSeF; ponowienie TEJ SAMEJ próby trafia
 * w ten sam klucz (idempotencja HEAD + IfNoneMatch bez zmian).
 */
export function invoiceXmlAttemptKey(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
  attemptId: string,
): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(attemptId)) {
    throw new Error('Invalid sendAttemptId for storage key');
  }
  return `${invoiceXmlAttemptPrefix(tenantId, invoiceId, issueDate)}${attemptId}.xml`;
}

/** Folder prób wysyłki faktury — do wylistowania plików przy retencji. */
export function invoiceXmlAttemptPrefix(tenantId: string, invoiceId: string, issueDate: string): string {
  const { year, month } = parseYearMonth(issueDate);
  return `${tenantId}/${year}/${month}/${invoiceId}/`;
}

/** Klucz XML: per próba, gdy znany `sendAttemptId`; inaczej klucz historyczny per faktura. */
export function invoiceXmlKeyFor(params: {
  tenantId: string;
  invoiceId: string;
  issueDate: string;
  attemptId?: string | null;
}): string {
  return params.attemptId
    ? invoiceXmlAttemptKey(params.tenantId, params.invoiceId, params.issueDate, params.attemptId)
    : invoiceXmlKey(params.tenantId, params.invoiceId, params.issueDate);
}

function invoiceUpoKey(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
): string {
  const { year, month } = parseYearMonth(issueDate);
  return `${tenantId}/${year}/${month}/${invoiceId}.upo.xml`;
}

async function streamToString(body: unknown): Promise<string> {
  if (!body) throw new Error('R2: empty response body');

  // AWS SDK v3 zwraca SdkStreamMixin z metodą transformToString w Node.js 18+.
  // Używamy jej, jeśli jest dostępna, bo obsługuje enkoding i backpressure
  // lepiej niż ręczny for-await.
  if (
    typeof (body as { transformToString?: (enc?: string) => Promise<string> })
      .transformToString === 'function'
  ) {
    return (body as { transformToString: (enc?: string) => Promise<string> })
      .transformToString('utf-8');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Sukcesywnie zbiera Body z GetObject jako bufor binarny (PDF, XML jako bytes).
 */
async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error('R2: empty response body');

  if (
    typeof (body as { transformToByteArray?: () => Promise<Uint8Array> })
      .transformToByteArray === 'function'
  ) {
    const arr = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(arr);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// Publiczne API
// ═══════════════════════════════════════════════════════════════

export interface UploadXmlResult {
  /** Klucz w R2 - zapisz do xml_documents.storage_path. */
  storagePath: string;
  /** SHA-256 hex - zapisz do xml_documents.sha256_hash. */
  sha256Hash: string;
  /** Rozmiar zapisanego bufora w bajtach. */
  sizeBytes: number;
  /** ETag zwrócony przez R2 (MD5 w cudzysłowach) - przydatne do IfMatch. */
  etag: string;
}

export interface XmlUploadOptions {
  /** Dodatkowe metadane - trafiają jako x-amz-meta-* (max 2KB łącznie). */
  metadata?: Record<string, string>;
  /** `sendAttemptId` zdarzenia wysyłki — klucz per próba (D5). Brak = klucz historyczny per faktura. */
  attemptId?: string | null;
}

/**
 * Uploaduje XML faktury do R2.
 *
 * SHA-256 liczymy lokalnie zanim wyślemy, wkładamy w metadata i zwracamy -
 * nie polegamy na ETag (to MD5, a dla multipart to hash-of-hashes, bezużyteczny).
 */
export async function uploadInvoiceXml(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
  xmlContent: string,
  options: XmlUploadOptions = {},
): Promise<UploadXmlResult> {
  return uploadXmlDocument({
    key: invoiceXmlKeyFor({ tenantId, invoiceId, issueDate, attemptId: options.attemptId }),
    body: xmlContent,
    tenantId,
    invoiceId,
    issueDate,
    documentType: 'invoice',
    options,
  });
}

/**
 * Uploaduje UPO faktury do R2 obok XML-a (ten sam folder, sufiks `.upo.xml`).
 * Wołać po pomyślnej wysyłce do KSeF i pobraniu UPO.
 */
export async function uploadInvoiceUpo(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
  upoXmlContent: string,
  options: XmlUploadOptions = {},
): Promise<UploadXmlResult> {
  return uploadXmlDocument({
    key: invoiceUpoKey(tenantId, invoiceId, issueDate),
    body: upoXmlContent,
    tenantId,
    invoiceId,
    issueDate,
    documentType: 'upo',
    options,
  });
}

/**
 * Heurystyka: czy wyjątek to "obiekt już istnieje pod kluczem objętym IfNoneMatch=*".
 *
 * R2/S3 zwracają `PreconditionFailed` (HTTP 412) gdy `IfNoneMatch: '*'` trafia
 * na istniejący klucz. Sam 412 nie dowodzi, że leży tam ten sam plik: dowodem
 * jest dopiero porównanie bajtów w `uploadXmlDocument` (C-12).
 */
function isPreconditionFailed(e: unknown): boolean {
  if (!(e instanceof S3ServiceException)) return false;
  if (e.name === 'PreconditionFailed') return true;
  return e.$metadata?.httpStatusCode === 412;
}

async function uploadXmlDocument(params: {
  key: string;
  body: string;
  tenantId: string;
  invoiceId: string;
  issueDate: string;
  documentType: 'invoice' | 'upo';
  options: XmlUploadOptions;
}): Promise<UploadXmlResult> {
  const { key, body, tenantId, invoiceId, issueDate, documentType, options } = params;
  const { metadata = {} } = options;

  const sha256Hash = sha256Hex(body);
  const bodyBuffer = Buffer.from(body, 'utf8');

  const { bucketName } = getR2Config();
  const client = getR2Client();

  try {
    const result = await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: bodyBuffer,
        ContentType: 'application/xml; charset=utf-8',
        IfNoneMatch: '*',
        Metadata: {
          'sha256-hash': sha256Hash,
          'tenant-id': tenantId,
          'invoice-id': invoiceId,
          'issue-date': issueDate,
          'document-type': documentType,
          ...metadata,
        },
      }),
    );

    return {
      storagePath: key,
      sha256Hash,
      sizeBytes: bodyBuffer.length,
      etag: result.ETag ?? '',
    };
  } catch (e) {
    if (!isPreconditionFailed(e)) throw e;
    // Ponowienie zastaje plik z poprzedniego przebiegu. Te same bajty to sukces;
    // inne to konflikt, a nie nadpisanie (C-12). Błąd odczytu leci dalej jako
    // zwykły błąd: to chwilowa awaria, nie konflikt.
    const stored = await downloadFromR2(key, tenantId);
    if (!stored.equals(bodyBuffer)) throw new XmlArchiveConflictError(key);
    return {
      storagePath: key,
      sha256Hash,
      sizeBytes: bodyBuffer.length,
      etag: '',
    };
  }
}

/**
 * Generyczny zapis bloba pod dowolnym kluczem (np. ścieżki z `lib/ksef/upo-storage`).
 */
export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { bucketName } = getR2Config();
  const client = getR2Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Store a generated export only if its key is still free. A retry or a
 * concurrent worker must keep the first complete object instead of replacing
 * it with a second generation whose timestamp or ZIP metadata may differ.
 * Returns false when the object already exists.
 */
export async function uploadToR2IfAbsent(
  key: string,
  body: Buffer,
  contentType: string,
  /** Metadane obiektu (`x-amz-meta-*`), np. liczby ze spisu archiwum. */
  metadata?: Record<string, string>,
): Promise<boolean> {
  const { bucketName } = getR2Config();
  const client = getR2Client();

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: '*',
        ...(metadata ? { Metadata: metadata } : {}),
      }),
    );
    return true;
  } catch (error) {
    if (isPreconditionFailed(error)) return false;
    throw error;
  }
}

/**
 * Generyczny odczyt obiektu z R2 po kluczu.
 */
export async function downloadFromR2(key: string, tenantId: string): Promise<Buffer> {
  assertTenantStoragePath(key, tenantId);
  const { bucketName } = getR2Config();
  const client = getR2Client();

  const response = await client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: key }),
  );

  if (!response.Body) {
    throw new Error(`R2 object not found: ${key}`);
  }

  return streamToBuffer(response.Body);
}

/**
 * Pobiera obiekt z R2 i weryfikuje integralność przez porównanie SHA-256.
 * Hash mismatch oznacza korupcję danych (lub rozjazd w DB vs obiekt w R2) -
 * rzucamy czytelny błąd, consumer powinien zalogować i oznaczyć wiersz
 * `xml_documents` jako do re-sync.
 */
export async function downloadInvoiceXml(
  storagePath: string,
  expectedSha256Hash: string,
  tenantId: string,
): Promise<string> {
  assertTenantStoragePath(storagePath, tenantId);
  const { bucketName } = getR2Config();
  const client = getR2Client();

  const response = await client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: storagePath }),
  );

  const content = await streamToString(response.Body);
  const actualHash = sha256Hex(content);

  if (actualHash !== expectedSha256Hash) {
    throw new Error(
      `R2: hash mismatch for "${storagePath}". ` +
        `Expected ${expectedSha256Hash}, got ${actualHash}. ` +
        `Oznacza to korupcję danych lub rozjazd xml_documents.sha256_hash.`,
    );
  }

  return content;
}

/**
 * Wariant bez weryfikacji - używaj tylko gdy ZNASZ hash z zaufanego źródła
 * (np. właśnie wgrałeś) i chcesz oszczędzić drugiej pętli po buforze.
 * W większości przypadków chcesz `downloadInvoiceXml` z weryfikacją.
 */
export async function downloadInvoiceXmlUnchecked(
  storagePath: string,
  tenantId: string,
): Promise<string> {
  assertTenantStoragePath(storagePath, tenantId);
  const { bucketName } = getR2Config();
  const client = getR2Client();

  const response = await client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: storagePath }),
  );
  return streamToString(response.Body);
}

export async function invoiceXmlExists(storagePath: string): Promise<boolean> {
  const { bucketName } = getR2Config();
  const client = getR2Client();

  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: storagePath }),
    );
    return true;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (error instanceof NoSuchKey || name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

/**
 * Generyczny alias na `invoiceXmlExists` — HEAD pod dowolnym kluczem R2.
 * Używaj w idempotentnych flow (np. `exports-generate.ts`), gdzie nazwa
 * "invoice xml" wprowadza w błąd.
 */
export const r2ObjectExists = invoiceXmlExists;

/**
 * HEAD obiektu firmy: rozmiar i metadane zapisane przy `uploadToR2IfAbsent`.
 * `null`, gdy obiektu nie ma; inny błąd rzuca (ponowienie zadania).
 */
export async function statR2Object(
  key: string,
  tenantId: string,
): Promise<{ sizeBytes: number; metadata: Record<string, string> } | null> {
  assertTenantStoragePath(key, tenantId);
  const { bucketName } = getR2Config();
  const client = getR2Client();
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return { sizeBytes: head.ContentLength ?? 0, metadata: head.Metadata ?? {} };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (error instanceof NoSuchKey || name === 'NotFound') return null;
    throw error;
  }
}

/**
 * Usuwa plik paczki archiwum dokumentów (krok 6.4, część 2) i nic innego:
 * jeden obiekt o kluczu z wiersza `document_archives`, tylko w katalogu tego
 * zlecenia (`isDocumentArchiveFileKey`). Bez usuwania po prefiksie i bez
 * listowania katalogu firmy. Brak obiektu to sukces (ponowienie po udanym
 * usunięciu); inny błąd rzuca, a zadanie się ponowi.
 */
export async function deleteDocumentArchiveFile(key: string, tenantId: string, archiveId: string): Promise<void> {
  if (!isDocumentArchiveFileKey(key, tenantId, archiveId)) {
    // Celowo bez klucza i identyfikatorów w treści (jak assertTenantStoragePath).
    throw new Error('Storage key is not a file of this document archive');
  }
  const { bucketName } = getR2Config();
  const client = getR2Client();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (error) {
    // S3 i MinIO odpowiadają 204 także bez obiektu; inne zgodne magazyny bywają ostrzejsze.
    const name = (error as { name?: string }).name;
    if (error instanceof NoSuchKey || name === 'NoSuchKey' || name === 'NotFound') return;
    throw error;
  }
}

/**
 * Wszystkie pliki prób wysyłki faktury (folder `invoiceXmlAttemptPrefix`) —
 * retencja usuwa je razem z fakturą (D5: stare próby czyści retencja).
 * Rzuca przy błędzie listowania: „nie wiem, jakie pliki” ≠ „nie ma plików”.
 */
export async function listInvoiceAttemptXmls(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
): Promise<string[]> {
  const { bucketName } = getR2Config();
  const client = getR2Client();
  const prefix = invoiceXmlAttemptPrefix(tenantId, invoiceId, issueDate);
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const obj of result?.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = result?.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** Pobranie przez podpisany adres jako plik (strona faktury dla nabywcy, krok 2.10). */
export interface SignedDownloadOptions {
  /** Nazwa w `Content-Disposition: attachment`; znaki spoza ASCII i cudzysłowy zamieniamy na „_”. */
  downloadFilename?: string;
  /** Typ treści odpowiedzi magazynu (np. `application/pdf`), niezależnie od metadanych obiektu. */
  contentType?: string;
}

/**
 * Zwraca pre-signed URL do pobrania XML lub UPO - URL ważny `expiresInSeconds`
 * sekund (domyślnie 300). Przekazuj do frontendu jako link do pobrania,
 * dzięki czemu bandwidth idzie bezpośrednio z R2 (nie przez nasz backend).
 */
export async function getSignedInvoiceUrl(
  storagePath: string,
  tenantId: string,
  expiresInSeconds: number = 300,
  options: SignedDownloadOptions = {},
): Promise<string> {
  assertTenantStoragePath(storagePath, tenantId);
  const { bucketName } = getR2Config();
  const client = getR2Client();
  const filename = options.downloadFilename
    ?.replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120);

  return getSignedUrl(
    client,
    // Override legacy metadata too: a public cache must not keep serving a
    // sensitive document after its signed URL expires.
    new GetObjectCommand({
      Bucket: bucketName,
      Key: storagePath,
      ResponseCacheControl: 'private, no-store',
      ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename}"` } : {}),
      ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
    }),
    { expiresIn: expiresInSeconds },
  );
}

export interface ListedDocument {
  storagePath: string;
  lastModified?: Date;
  sizeBytes?: number;
  /** 'invoice' | 'upo' - wywnioskowane z sufiksu .upo.xml vs .xml */
  documentType: 'invoice' | 'upo';
}

/**
 * Paginowana lista XML-i + UPO w danym folderze miesięcznym.
 * Max 1000 obiektów per strona (hard limit R2). Kontynuacja przez
 * `continuationToken` z poprzedniej odpowiedzi.
 */
export async function listInvoiceDocuments(params: {
  tenantId: string;
  year: number;
  month?: number;
  continuationToken?: string;
  pageSize?: number;
}): Promise<{ documents: ListedDocument[]; continuationToken?: string }> {
  const { tenantId, year, month, continuationToken, pageSize = 100 } = params;
  const { bucketName } = getR2Config();
  const client = getR2Client();

  const monthSegment = month !== undefined ? `/${String(month).padStart(2, '0')}` : '';
  const prefix = `${tenantId}/${year}${monthSegment}/`;

  const result: ListObjectsV2CommandOutput = await client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      MaxKeys: pageSize,
      ContinuationToken: continuationToken,
    }),
  );

  const documents: ListedDocument[] = [];
  for (const obj of result.Contents ?? []) {
    if (!obj.Key) continue;
    documents.push({
      storagePath: obj.Key,
      lastModified: obj.LastModified,
      sizeBytes: obj.Size,
      documentType: obj.Key.endsWith('.upo.xml') ? 'upo' : 'invoice',
    });
  }

  return {
    documents,
    continuationToken: result.IsTruncated ? result.NextContinuationToken : undefined,
  };
}

/**
 * Usuwa obiekt. Używać WYŁĄCZNIE w testach lub do GDPR erasure (i tylko gdy
 * dane nie podlegają obowiązkowi retencji VAT - w prod bucketach z Object Lock
 * operacja zostanie odrzucona przez R2).
 */
export async function deleteInvoiceXml(storagePath: string): Promise<void> {
  const { bucketName } = getR2Config();
  const client = getR2Client();

  await client.send(
    new DeleteObjectCommand({ Bucket: bucketName, Key: storagePath }),
  );
}
