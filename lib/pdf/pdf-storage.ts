import { createHash } from 'node:crypto';

import {
  downloadFromR2,
  r2ObjectExists,
  uploadToR2,
} from '@/lib/storage/r2';

/**
 * Storage PDF faktur w R2 (Faza 33 Krok 3).
 *
 * Reużywa generycznych helperów z `lib/storage/r2.ts` (ten sam bucket
 * co XML faktur). Konwencja klucza spójna z XML — `.pdf` zamiast `.xml`:
 *   {tenantId}/{YYYY}/{MM}/{invoiceId}.v{rendererVersion}.pdf
 */

// A renderer change must invalidate old PDFs even when invoice.updated_at
// remains unchanged. v2 includes the VAT exemption basis on zw invoices.
// v3 (29.09): KOD I wg specyfikacji MF (link weryfikacyjny zamiast samego
// numeru KSeF) — obejmuje też wcześniejsze zmiany bez podbicia wersji
// (MPP, metoda kasowa, „Do zapłaty” przy ROZ).
// v4 (01.10): wyrazy „odwrotne obciążenie” przy pozycjach „oo”; na korekcie
// numer, data i numer KSeF faktury korygowanej (art. 106j ust. 2).
// v5: identyfikator cache zależy od KODU I i podpisu pod nim. Uzupełnienie
// hasha XML lub nadanie numeru KSeF nie może zwrócić starego PDF bez QR.
// v6 (02.11): stopka z adresem strony, bez długiego myślnika.
// v7 (08.11): tytuł przelewu z numerem KSeF w sekcji płatności (plan
// kompletnej aplikacji, krok 1.4). Bez podbicia przyjęte faktury z cache
// zostałyby bez tego wiersza.
const PDF_RENDERER_VERSION = 7;

function parseYearMonth(issueDate: string): { year: string; month: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new Error(
      `Invalid issueDate "${issueDate}": expected YYYY-MM-DD`,
    );
  }
  const [year, month] = issueDate.split('-');
  return { year: year!, month: month! };
}

/** Buduje klucz R2 dla PDF faktury. */
export function buildInvoicePdfKey(
  tenantId: string,
  invoiceId: string,
  issueDate: string,
  qrPayload: string | null = null,
  ksefNumber: string | null = null,
): string {
  const { year, month } = parseYearMonth(issueDate);
  const qrState = createHash('sha256')
    .update(JSON.stringify([qrPayload, ksefNumber]))
    .digest('hex')
    .slice(0, 32);
  return `${tenantId}/${year}/${month}/${invoiceId}.v${PDF_RENDERER_VERSION}.${qrState}.pdf`;
}

export async function uploadInvoicePdf(
  key: string,
  pdf: Buffer,
): Promise<void> {
  await uploadToR2(key, pdf, 'application/pdf');
}

export async function downloadInvoicePdf(key: string, tenantId: string): Promise<Buffer> {
  return downloadFromR2(key, tenantId);
}

export async function invoicePdfExists(key: string): Promise<boolean> {
  return r2ObjectExists(key);
}
