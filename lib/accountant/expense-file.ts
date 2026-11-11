import 'server-only';

import { NextResponse } from 'next/server';

import {
  checkPortalLimit,
  PORTAL_FILE_URL_TTL_SECONDS,
  PORTAL_RESPONSE_HEADERS,
  PORTAL_TEXTS,
  portalLimitedResponse,
  portalTextResponse,
  portalTokenParam,
  resolvePortalAccess,
} from '@/lib/accountant/portal-access';
import { logAuditSystem } from '@/lib/audit/log-system';
import { getSignedFileUrl } from '@/lib/storage/signed-file-url';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';
import { isUuid } from '@/lib/supabase/active-org';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Plik dokumentu kosztu w portalu księgowej (krok 6.2): `/accountant/<token>/
 * expenses/<id>/view` (podgląd w przeglądarce, każdy poziom dostępu) i
 * `/download` (załącznik, tylko poziom „download”). Trasa sprawdza wszystko
 * przy każdym kliknięciu i przekierowuje (303) na krótki podpisany adres
 * magazynu, więc adres magazynu nie trafia do HTML portalu, a po minucie
 * przestaje działać (jak pliki strony faktury dla nabywcy, PR #552).
 */

export type ExpenseFileKind = 'photo' | 'xml';
export type ExpenseFileMode = 'view' | 'download';

/**
 * Zdjęcia kosztów, które przyjmuje odczyt (`detectExpensePhotoType`), z końcówką
 * nazwy pliku. Inny typ nie idzie do przeglądarki (żadnego HTML ani SVG z magazynu).
 */
const PHOTO_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf'],
]);

export interface ExpenseFileFields {
  source: string;
  source_file_path: string | null;
  source_file_mime: string | null;
  ksef_invoice_id: string | null;
}

export interface LinkedInvoiceFile {
  id: string;
  xml_storage_path: string | null;
}

/**
 * Jaki plik ma koszt w portalu: XML z KSeF (oryginał faktury zakupu), a gdy
 * go nie ma, zdjęcie z odczytu (jak ekran wydatku: tylko źródło „zdjęcie”).
 * Ścieżka spoza folderu firmy albo nieznany typ zdjęcia to brak pliku. Tę
 * samą regułę stosują lista (czy pokazać link) i trasa (co podpisać).
 */
export function expenseFileKind(
  expense: ExpenseFileFields,
  invoice: LinkedInvoiceFile | null,
  tenantId: string,
): ExpenseFileKind | null {
  if (
    expense.ksef_invoice_id &&
    invoice?.id === expense.ksef_invoice_id &&
    invoice.xml_storage_path &&
    isTenantStoragePath(invoice.xml_storage_path, tenantId)
  ) {
    return 'xml';
  }
  if (
    expense.source === 'ocr_photo' &&
    expense.source_file_path &&
    expense.source_file_mime &&
    PHOTO_EXTENSIONS.has(expense.source_file_mime) &&
    isTenantStoragePath(expense.source_file_path, tenantId)
  ) {
    return 'photo';
  }
  return null;
}

/** Nazwa pobieranego pliku z numeru dokumentu, tylko bezpieczne znaki (`FV/10/2026` → `FV-10-2026.xml`). */
export function expenseDownloadName(documentNumber: string | null, extension: string): string {
  const base =
    (documentNumber ?? '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'koszt';
  return `${base}.${extension}`;
}

interface ExpenseFileRow extends ExpenseFileFields {
  id: string;
  tenant_id: string;
  document_number: string | null;
}

interface InvoiceFileRow extends LinkedInvoiceFile {
  tenant_id: string;
}

export async function serveExpenseFile(
  params: Promise<{ token: string; expenseId: string }>,
  mode: ExpenseFileMode,
): Promise<NextResponse> {
  // Limit przed odczytem tokenu: zalew zapytań nie dochodzi do bazy.
  const limit = await checkPortalLimit();
  if (!limit.allowed) return portalLimitedResponse(limit.retryAfter);

  const { token, expenseId } = await params;
  const admin = createAdminClient();
  const access = await resolvePortalAccess(admin, portalTokenParam(token));
  if (!access) return portalTextResponse(403, PORTAL_TEXTS.DENIED);
  if (mode === 'download' && access.access_level !== 'download') {
    return portalTextResponse(403, PORTAL_TEXTS.VIEW_ONLY);
  }
  if (!isUuid(expenseId)) return portalTextResponse(404, PORTAL_TEXTS.NO_FILE);

  const tenantId = access.tenant_id;
  const { data: expenseData, error: expenseError } = await admin
    .from('expenses')
    .select('id, tenant_id, source, document_number, source_file_path, source_file_mime, ksef_invoice_id')
    .eq('id', expenseId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (expenseError) return portalTextResponse(503, PORTAL_TEXTS.UNAVAILABLE);
  const expense = expenseData as ExpenseFileRow | null;
  if (!expense || expense.tenant_id !== tenantId) return portalTextResponse(404, PORTAL_TEXTS.NO_FILE);

  let invoice: InvoiceFileRow | null = null;
  if (expense.ksef_invoice_id) {
    const { data, error } = await admin
      .from('invoices')
      .select('id, tenant_id, xml_storage_path')
      .eq('id', expense.ksef_invoice_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) return portalTextResponse(503, PORTAL_TEXTS.UNAVAILABLE);
    const row = data as InvoiceFileRow | null;
    invoice = row?.tenant_id === tenantId ? row : null;
  }

  const kind = expenseFileKind(expense, invoice, tenantId);
  if (!kind) return portalTextResponse(404, PORTAL_TEXTS.NO_FILE);

  let storagePath: string;
  let contentType: string;
  let extension: string;
  if (kind === 'xml' && invoice?.xml_storage_path) {
    // Ten sam związek pliku z fakturą i firmą co przy XML faktury w portalu.
    const { data: xmlDoc, error } = await admin
      .from('xml_documents')
      .select('sha256_hash')
      .eq('storage_path', invoice.xml_storage_path)
      .eq('tenant_id', tenantId)
      .eq('invoice_id', invoice.id)
      .maybeSingle();
    if (error) return portalTextResponse(503, PORTAL_TEXTS.UNAVAILABLE);
    if (!xmlDoc?.sha256_hash) return portalTextResponse(404, PORTAL_TEXTS.NO_FILE);
    storagePath = invoice.xml_storage_path;
    // Podgląd jako zwykły tekst: przeglądarka nie wykona arkusza stylów ani skryptu z pliku.
    contentType = mode === 'view' ? 'text/plain; charset=utf-8' : 'application/xml';
    extension = 'xml';
  } else if (kind === 'photo' && expense.source_file_path && expense.source_file_mime) {
    storagePath = expense.source_file_path;
    contentType = expense.source_file_mime;
    extension = PHOTO_EXTENSIONS.get(expense.source_file_mime) ?? 'bin';
  } else {
    return portalTextResponse(404, PORTAL_TEXTS.NO_FILE);
  }

  const contentDisposition =
    mode === 'view' ? 'inline' : `attachment; filename="${expenseDownloadName(expense.document_number, extension)}"`;

  let signedUrl: string;
  try {
    signedUrl = await getSignedFileUrl(storagePath, tenantId, {
      expiresInSeconds: PORTAL_FILE_URL_TTL_SECONDS,
      contentType,
      contentDisposition,
    });
  } catch {
    console.error('[accountant/expense-file] sign_failed');
    return portalTextResponse(503, PORTAL_TEXTS.UNAVAILABLE);
  }

  await logAuditSystem({
    action: mode === 'view' ? 'accountant.expense_file_viewed' : 'accountant.expense_file_downloaded',
    tenantId,
    entityType: 'expense',
    entityId: expense.id,
    metadata: { via: 'accountant_access', accessId: access.id, file: kind },
  });

  return new NextResponse(null, { status: 303, headers: { Location: signedUrl, ...PORTAL_RESPONSE_HEADERS } });
}
