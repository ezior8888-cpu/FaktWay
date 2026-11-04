import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { resolveApiUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * GET /api/invoices/[id]/pdf — pobranie PDF faktury (Faza 33 Krok 4).
 *
 * PDF generowany z cache R2 (lub świeżo renderowany pdfkit przy cache miss).
 * `generateInvoicePdf` czyta fakturę admin clientem (omija RLS), więc tenant
 * MUSI pochodzić ze zweryfikowanego membership (`resolveApiUserAndActiveOrg`),
 * a nie z samego formatu cookie — inaczej spreparowane cookie z obcym org_id
 * pozwoliłoby pobrać PDF cudzej faktury (ownership check w `generateInvoicePdf`
 * porównuje do wartości z cookie).
 *
 * 409 z `{ error, link? }`: stan, w którym PDF nie powstanie (faktura offline bez KODU II,
 * zmiana stanu w trakcie, szkic wycofany). Przy szkicu wycofanym po zapisie oryginału z KSeF
 * `link` prowadzi do PDF faktury K (D-A4-1b-3 PR C, C8).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const ctx = await resolveApiUserAndActiveOrg();
  if (!ctx.ok) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const tenantId = ctx.tenantId;

  try {
    const result = await generateInvoicePdf(id, tenantId);

    if (!result.success) {
      const status =
        result.code === 'NOT_FOUND'
          ? 404
          : result.code === 'FORBIDDEN'
            ? 403
            : result.code === 'KSEF_NOT_VERIFIED'
              ? 403
              : result.code === 'OFFLINE_QR_UNAVAILABLE' || result.code === 'PDF_STATE_CHANGED' || result.code === 'RETIRED_DRAFT'
                ? 409
              : 400;
      // D-A4-1b-3 PR C (5.12): szkic wycofany po zapisie oryginału odsyła do PDF faktury K (`link`).
      return NextResponse.json(result.link ? { error: result.error, link: result.link } : { error: result.error }, { status });
    }

    return new NextResponse(new Uint8Array(result.pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        // PDF faktury to dane wrażliwe — nie cache'ujemy w przeglądarce.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'invoices/pdf', invoice_id: id },
    });
    return NextResponse.json(
      { error: 'pdf_generation_failed' },
      { status: 500 },
    );
  }
}
