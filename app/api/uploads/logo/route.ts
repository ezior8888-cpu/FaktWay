import * as Sentry from '@sentry/nextjs';

import { acceptCompanyLogoUpload, LOGO_EDIT_ROLES, LOGO_ROLE_MESSAGE } from '@/lib/invoices/logo-firmy';
import { formatUploadSize, LOGO_BODY_LIMIT_BYTES, LOGO_FILE_LIMIT_LABEL, UPLOAD_FAILED_MESSAGE } from '@/lib/upload-limit';
import {
  authorizeUpload,
  checkUploadHeaders,
  checkUploadRate,
  isServerSideRefusal,
  logUploadRefusal,
  readUploadForm,
  refusalJson,
  reserveUploadBytes,
  uploadCaller,
  uploadJson,
  type UploadRefusal,
} from '@/lib/uploads/server';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/uploads/logo';

/**
 * POST /api/uploads/logo: logo firmy na fakturze z Ustawień → Firma
 * (`components/settings/company-logo-form.tsx`), pola `logo` i `tenantId`
 * (plan kompletnej aplikacji, krok 2.2, część 1). Odpowiedź:
 * `{ success: true, logo: { previewUrl, format, width, height } }` albo
 * `{ success: false, error }`.
 *
 * Trasa jest poza proxy (`proxy.ts`, AGENTS.md, niezmiennik 7), więc bramka
 * (`lib/uploads/server.ts`) sama sprawdza Origin, rozmiar przed odczytem
 * ciała (tu limit logo, 2 MB), sesję, 2FA, firmę, przerwę techniczną, limit
 * wgrań, wgrania naraz i budżet bajtów w procesie. Rola przed odczytem
 * ciała: logo zmienia właściciel i administrator, jak dane firmy. Typ pliku
 * z jego bajtów, zapis i audyt: `lib/invoices/logo-firmy.ts`.
 */
export async function POST(req: Request): Promise<Response> {
  let refund: (() => Promise<void>) | null = null;
  const refused = async (refusal: UploadRefusal) => {
    if (refund && isServerSideRefusal(refusal)) await refund();
    logUploadRefusal(ROUTE, refusal);
    return refusalJson(refusal);
  };

  const headers = checkUploadHeaders(req, { checkOrigin: true });
  if (!headers.ok) return refused(headers);
  if (headers.contentLength !== null && headers.contentLength > LOGO_BODY_LIMIT_BYTES) {
    return refused({
      ok: false,
      status: 413,
      reason: 'too_large',
      error: `Plik ma ${formatUploadSize(headers.contentLength)}, a logo może mieć najwyżej ${LOGO_FILE_LIMIT_LABEL}.`,
      size: headers.contentLength,
    });
  }

  try {
    const auth = await authorizeUpload({ maintenanceGate: true });
    if (!auth.ok) return refused(auth);
    if (!LOGO_EDIT_ROLES.includes(auth.ctx.role)) {
      return refused({ ok: false, status: 403, reason: 'forbidden', error: LOGO_ROLE_MESSAGE });
    }
    const rate = await checkUploadRate('logo', auth.ctx);
    if (!rate.ok) return refused(rate);
    refund = rate.refund;

    const slot = reserveUploadBytes(headers.contentLength, uploadCaller(auth.ctx));
    if (!slot.ok) return refused(slot);
    try {
      const body = await readUploadForm(req, headers.contentLength);
      if (!body.ok) return refused(body);

      const result = await acceptCompanyLogoUpload(auth.ctx, body.form);
      if (!result.success) {
        if (result.status >= 500) await refund();
        return uploadJson({ success: false, error: result.error }, result.status);
      }
      return uploadJson({ success: true, logo: result.logo }, 200);
    } finally {
      slot.release();
    }
  } catch (error) {
    await refund?.();
    Sentry.captureException(error, { tags: { route: ROUTE } });
    return uploadJson({ success: false, error: UPLOAD_FAILED_MESSAGE }, 500);
  }
}
