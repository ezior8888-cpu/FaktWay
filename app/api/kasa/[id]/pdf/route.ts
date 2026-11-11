import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { getCashDocument } from '@/lib/kasa/baza';
import { cashDocumentPdfFilename, renderCashDocumentPdf } from '@/lib/kasa/pdf';
import { resolveApiUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { createClient } from '@/lib/supabase/server';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/kasa/[id]/pdf: PDF dowodu kasowego KP albo KW (krok 3.7), także dla
 * księgowej (wgląd). Firma pochodzi ze zweryfikowanego członkostwa
 * (`resolveApiUserAndActiveOrg`), a dowód czyta klient z sesji, więc RLS 00194
 * i filtr `tenant_id` dają „nie znaleziono” dla dowodu innej firmy. PDF
 * powstaje za każdym razem z danych dowodu: wystawionego dowodu nie zmienia
 * nikt, a plik jest powtarzalny.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ctx = await resolveApiUserAndActiveOrg();
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  try {
    const supabase = await createClient();
    const cash = await getCashDocument(supabase, ctx.tenantId, id);
    if (!cash) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const pdf = await renderCashDocumentPdf(cash);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${cashDocumentPdfFilename(cash.number)}"`,
        // Dowód kasowy to dane strony operacji: bez pamięci podręcznej przeglądarki.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'kasa/pdf' } });
    return NextResponse.json({ error: 'pdf_generation_failed' }, { status: 500 });
  }
}
