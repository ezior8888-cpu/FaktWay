import * as Sentry from '@sentry/nextjs';

import { startFileImport } from '@/lib/import/start-file-import';
import { UPLOAD_FAILED_MESSAGE } from '@/lib/upload-limit';
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

const ROUTE = '/api/uploads/import';

/**
 * POST /api/uploads/import — CSV z czterech programów z okna importu
 * (`components/onboarding/file-import-dialog.tsx`), pola `file`, `source`,
 * `tenantId`. Odpowiedź: `{ success: true, importJobId }` albo
 * `{ success: false, error }`.
 *
 * Plan skalowania, sesja 31: zamiast Server Action (najwyżej 1 MiB ciała),
 * z własnym limitem 10 MB. Trasa jest poza proxy (`proxy.ts`), więc bramka
 * (`lib/uploads/server.ts`) sama sprawdza Origin, rozmiar przed odczytem
 * ciała, sesję, 2FA, firmę, przerwę techniczną (także w onboardingu, jak
 * proxy), limit wgrań, wgrania naraz i budżet bajtów w procesie.
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

  try {
    const auth = await authorizeUpload({ maintenanceGate: true });
    if (!auth.ok) return refused(auth);
    const rate = await checkUploadRate('import', auth.ctx);
    if (!rate.ok) return refused(rate);
    refund = rate.refund;

    const slot = reserveUploadBytes(headers.contentLength, uploadCaller(auth.ctx));
    if (!slot.ok) return refused(slot);
    try {
      const body = await readUploadForm(req, headers.contentLength);
      if (!body.ok) return refused(body);

      const result = await startFileImport(auth.ctx, body.form);
      if (!result.success) {
        if (result.status >= 500) await refund();
        return uploadJson({ success: false, error: result.error }, result.status);
      }
      return uploadJson({ success: true, importJobId: result.importJobId }, 200);
    } finally {
      slot.release();
    }
  } catch (error) {
    await refund?.();
    Sentry.captureException(error, { tags: { route: ROUTE } });
    return uploadJson({ success: false, error: UPLOAD_FAILED_MESSAGE }, 500);
  }
}
