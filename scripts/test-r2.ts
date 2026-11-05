/**
 * Smoke test: Cloudflare R2 storage dla xml_documents.
 *
 * Pełny cykl: upload XML → upload UPO → head → get+verify hash → signed URL →
 * list → IfNoneMatch immutability → hash mismatch error path → cleanup.
 *
 * Wszystko w przestrzeni tenantId='__smoke__' + invoiceId z timestampem,
 * więc można odpalać wielokrotnie bez kolizji.
 *
 * Wymaga w .env.local: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET_NAME, R2_JURISDICTION (eu/default/fedramp).
 *
 * Uruchom:  pnpm r2:smoke
 */

import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from 'dotenv';

import { getR2Client, getR2Config } from '../lib/storage/r2-client';
import {
  deleteInvoiceXml,
  downloadInvoiceXml,
  getSignedInvoiceUrl,
  invoiceXmlExists,
  listInvoiceDocuments,
  uploadInvoiceUpo,
  uploadInvoiceXml,
} from '../lib/storage/r2';

config({ path: '.env.local' });

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ok(msg: string) {
  console.log(`${GREEN}✔${RESET} ${msg}`);
}
function fail(msg: string): never {
  console.error(`${RED}✘${RESET} ${msg}`);
  process.exit(1);
}
function info(msg: string) {
  console.log(`${DIM}${msg}${RESET}`);
}

async function main() {
  const cfg = getR2Config();
  info(`bucket:    ${cfg.bucketName}`);
  info(`endpoint:  ${cfg.endpoint}`);
  info(`accessKey: ${cfg.accessKeyId.slice(0, 8)}...${cfg.accessKeyId.slice(-4)}\n`);

  // Preflight: ListObjectsV2 z MaxKeys=1 to najlżejsza operacja object-level
  // którą scoped tokens mogą wykonać (HeadBucket wymaga account-level).
  try {
    await getR2Client().send(
      new ListObjectsV2Command({ Bucket: cfg.bucketName, MaxKeys: 1 }),
    );
    ok(`bucket "${cfg.bucketName}" dostępny dla tokena`);
  } catch (err) {
    const e = err as {
      name?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
    };
    fail(
      `preflight FAIL: ${e.name ?? 'Unknown'} ${e.$metadata?.httpStatusCode ?? '?'} ${e.message ?? ''}`,
    );
  }

  const tenantId = '__smoke__';
  const invoiceId = `${randomUUID()}`;
  const issueDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const invoiceXml =
    '<?xml version="1.0" encoding="UTF-8"?><Faktura><TEST>1</TEST></Faktura>';
  const upoXml = '<?xml version="1.0" encoding="UTF-8"?><UPO><TEST>1</TEST></UPO>';

  let invoicePath = '';
  let upoPath = '';

  try {
    // ─── upload XML ─────────────────────────────────────────────
    const invoiceResult = await uploadInvoiceXml(
      tenantId,
      invoiceId,
      issueDate,
      invoiceXml,
      { metadata: { 'smoke-test': '1' } },
    );
    invoicePath = invoiceResult.storagePath;
    ok(
      `uploadInvoiceXml: ${invoicePath} (${invoiceResult.sizeBytes}B, ` +
        `sha256=${invoiceResult.sha256Hash.slice(0, 12)}…, etag=${invoiceResult.etag})`,
    );

    // ─── upload UPO ─────────────────────────────────────────────
    const upoResult = await uploadInvoiceUpo(
      tenantId,
      invoiceId,
      issueDate,
      upoXml,
    );
    upoPath = upoResult.storagePath;
    ok(`uploadInvoiceUpo: ${upoPath} (${upoResult.sizeBytes}B)`);

    // ─── exists ──────────────────────────────────────────────────
    if (!(await invoiceXmlExists(invoicePath))) {
      fail('invoiceXmlExists: false po uploadzie');
    }
    ok('invoiceXmlExists: true');

    // ─── download + verify hash ─────────────────────────────────
    const downloaded = await downloadInvoiceXml(
      invoicePath,
      invoiceResult.sha256Hash,
      tenantId,
    );
    if (downloaded !== invoiceXml) {
      fail(`download mismatch: got ${downloaded.length}B, expected ${invoiceXml.length}B`);
    }
    ok('downloadInvoiceXml: bit-exact + SHA-256 match');

    // ─── download z ZŁYM hashem → musi rzucić ───────────────────
    try {
      await downloadInvoiceXml(invoicePath, '0'.repeat(64), tenantId);
      fail('downloadInvoiceXml powinno rzucić przy złym hashu');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('hash mismatch')) {
        fail(`oczekiwałem hash mismatch error, dostałem: ${err}`);
      }
      ok('downloadInvoiceXml: wykrywa korupcję danych (hash mismatch)');
    }

    // ─── signed URL ─────────────────────────────────────────────
    const signedUrl = await getSignedInvoiceUrl(invoicePath, tenantId, 60);
    if (!signedUrl.startsWith('https://') || !signedUrl.includes(invoiceId)) {
      fail(`signed URL wygląda źle: ${signedUrl.slice(0, 120)}`);
    }
    ok(`getSignedInvoiceUrl: ${signedUrl.slice(0, 80)}…`);

    // ─── list ────────────────────────────────────────────────────
    const [year, month] = issueDate.split('-');
    const listing = await listInvoiceDocuments({
      tenantId,
      year: Number(year),
      month: Number(month),
      pageSize: 50,
    });
    const foundInvoice = listing.documents.find(
      (d) => d.storagePath === invoicePath && d.documentType === 'invoice',
    );
    const foundUpo = listing.documents.find(
      (d) => d.storagePath === upoPath && d.documentType === 'upo',
    );
    if (!foundInvoice) fail('listInvoiceDocuments: nie ma XML-a faktury');
    if (!foundUpo) fail('listInvoiceDocuments: nie ma UPO');
    ok(
      `listInvoiceDocuments: znaleziono invoice + UPO ` +
        `(łącznie ${listing.documents.length} w ${year}-${month})`,
    );

    // ─── niezmienność (IfNoneMatch=*, C-12) ─────────────────────
    // Ten test sprawdza to, czego atrapy nie potwierdzą: warunkowy PUT na
    // prawdziwym magazynie (produkcyjny MinIO, 412 na zajętym kluczu).
    const retried = await uploadInvoiceXml(tenantId, invoiceId, issueDate, invoiceXml);
    if (retried.storagePath !== invoicePath) {
      fail('ponowienie z tymi samymi bajtami powinno trafić w ten sam klucz');
    }
    ok('ponowienie z tymi samymi bajtami: sukces po porównaniu pliku');

    try {
      await uploadInvoiceXml(tenantId, invoiceId, issueDate, `${invoiceXml}<!-- inny -->`);
      fail('inne bajty pod tym samym kluczem powinny rzucić XmlArchiveConflictError');
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'XmlArchiveConflictError') {
        fail(`oczekiwałem XmlArchiveConflictError, dostałem: ${name ?? err}`);
      }
      ok('inne bajty pod tym samym kluczem: konflikt, plik bez zmian');
    }
  } finally {
    // ─── cleanup ────────────────────────────────────────────────
    try {
      if (invoicePath) await deleteInvoiceXml(invoicePath);
      if (upoPath) await deleteInvoiceXml(upoPath);
      ok(`cleanup: deleteInvoiceXml × 2`);
    } catch (err) {
      console.warn(`${RED}cleanup FAIL (usuń ręcznie):${RESET}`, err);
    }
  }

  console.log(`\n${GREEN}R2 smoke test PASS${RESET}`);
}

main().catch((err) => {
  console.error(`\n${RED}R2 smoke test FAIL${RESET}`);
  console.error(err);
  process.exit(1);
});
