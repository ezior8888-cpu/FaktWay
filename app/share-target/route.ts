import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';

import { acceptExpenseDocument } from '@/lib/expenses/accept-upload';
import { shareTargetNoticeHref, type ShareTargetNotice } from '@/lib/expenses/share-target-notice';
import {
  authorizeUpload,
  checkUploadHeaders,
  checkUploadRate,
  isServerSideRefusal,
  logUploadRefusal,
  readUploadForm,
  reserveUploadBytes,
  uploadCaller,
  type UploadRefusal,
} from '@/lib/uploads/server';

export const dynamic = 'force-dynamic';

const ROUTE = '/share-target';

/**
 * Web Share Target (PWA): przeglądarka wysyła POST multipart z polem `photo`.
 * Trasa jest POZA proxy (`proxy.ts`, matcher; plan skalowania, sesja 31):
 * proxy czytało całe ciało i trzymało w pamięci jego kopię do 10 MiB, zanim
 * trasa ruszyła, a większe ciało docierało ucięte i `formData()` rzucał
 * (500). Bez proxy trasa sama sprawdza sesję (bez sesji — logowanie, jak
 * dotąd; ciało i tak przepada) i odmawia po `Content-Length` przed odczytem
 * ciała (`lib/uploads/server.ts`).
 *
 * Limity jak przy „Dodaj wydatek”: zdjęcie do 7 MB (próg odczytu OCR; tu
 * zdjęcie nie jest zmniejszane), PDF do 10 MB. Wspólny z panelem limit wgrań
 * i budżet bajtów w procesie.
 *
 * WYNIK LĄDUJE W WĄTKU AGENTA, nie w Wydatkach (krok 22 toru B). Klient
 * udostępnia zdjęcie paragonu i ma zobaczyć gotowy koszt tam, gdzie agent
 * mówi wszystko inne — bez wchodzenia w menu. Parametr `paragon` niesie
 * identyfikator zadania OCR, żeby wątek mógł pokazać stan przetwarzania.
 * Odmowy z sesji 31 (za duży plik, limit wgrań, zajęty serwer) prowadzą na
 * Koszty z komunikatem (`components/expenses/share-target-notice.tsx`):
 * tam jest „Dodaj wydatek”, który zdjęcia zmniejsza sam.
 *
 * Gdy odczyt utknie, kartę z drogą wyjścia tworzy silnik po trzech minutach
 * (`findStuckOcrJobs`) — interfejs jej nie wymyśla, tylko wyświetla.
 */
export async function POST(req: NextRequest) {
  const to = (pathAndQuery: string) =>
    NextResponse.redirect(new URL(pathAndQuery, req.url), { status: 303, headers: { 'Cache-Control': 'no-store' } });
  const flo = (paragon: string) => to(`/flo?paragon=${encodeURIComponent(paragon)}`);
  const notice = (value: ShareTargetNotice) => to(shareTargetNoticeHref(value));
  let refund: (() => Promise<void>) | null = null;
  const refused = async (refusal: UploadRefusal) => {
    if (refund && isServerSideRefusal(refusal)) await refund();
    logUploadRefusal(ROUTE, refusal);
    if (refusal.reason === 'too_large') return notice({ kind: 'za-duze', size: refusal.size });
    if (refusal.reason === 'rate_limited') return notice({ kind: 'limit', retryAfter: refusal.retryAfter });
    if (refusal.reason === 'busy') return notice({ kind: 'zajete' });
    return flo('blad');
  };

  try {
    const auth = await authorizeUpload({ maintenanceGate: false });
    if (!auth.ok) {
      if (auth.reason !== 'unauthenticated') return refused(auth);
      logUploadRefusal(ROUTE, auth);
      return to('/login?redirect=%2Fflo');
    }

    const headers = checkUploadHeaders(req, { checkOrigin: false });
    if (!headers.ok) return refused(headers);

    const rate = await checkUploadRate('expense', auth.ctx);
    if (!rate.ok) return refused(rate);
    refund = rate.refund;

    const slot = reserveUploadBytes(headers.contentLength, uploadCaller(auth.ctx));
    if (!slot.ok) return refused(slot);
    try {
      const body = await readUploadForm(req, headers.contentLength);
      if (!body.ok) return refused(body);

      const photo = body.form.get('photo');
      if (!(photo instanceof File) || photo.size === 0) return flo('brak-zdjecia');

      const result = await acceptExpenseDocument({ userId: auth.ctx.user.id, tenantId: auth.ctx.tenantId, file: photo });
      if (result.success) return flo(result.ocrJobId);
      if (result.tooLarge) {
        return notice({ kind: 'za-duze', size: result.tooLarge.size, document: result.tooLarge.kind });
      }
      if (result.status >= 500) await refund();
      return flo('blad');
    } finally {
      slot.release();
    }
  } catch (error) {
    await refund?.();
    Sentry.captureException(error, { tags: { route: ROUTE } });
    return flo('blad');
  }
}
