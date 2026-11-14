import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { loadCompanyPdfLogo } from '@/lib/pdf/logo-odczyt';
import { getQuote } from '@/lib/proformy/baza';
import { quotePdfFilename, quotePdfInput, renderQuotePdf } from '@/lib/proformy/pdf';
import { resolveApiUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { createClient } from '@/lib/supabase/server';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/proformy/[id]/pdf: PDF wystawionej proformy albo oferty (krok 2.4).
 *
 * Firma pochodzi ze zweryfikowanego członkostwa (`resolveApiUserAndActiveOrg`),
 * a dokument czyta klient z sesji, więc RLS 00198 i filtr `tenant_id` dają
 * „nie znaleziono” dla dokumentu innej firmy. PDF powstaje za każdym razem
 * z danych dokumentu (bez pamięci podręcznej w magazynie plików): wystawionego
 * dokumentu nie zmienia nikt, a plik jest powtarzalny.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ctx = await resolveApiUserAndActiveOrg();
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  try {
    const supabase = await createClient();
    const quote = await getQuote(supabase, ctx.tenantId, id);
    if (!quote) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const input = quotePdfInput(quote);
    if (!input) {
      return NextResponse.json({ error: 'Najpierw wystaw dokument. Szkic nie ma numeru ani PDF.' }, { status: 409 });
    }
    // Logo firmy z ustawień (krok 2.2); bez pliku albo przy błędzie PDF bez logo.
    const { logo } = await loadCompanyPdfLogo(ctx.tenantId);
    const pdf = await renderQuotePdf(input, { logo });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${quotePdfFilename(input.kind, input.number)}"`,
        // PDF dokumentu to dane kontrahenta: bez pamięci podręcznej przeglądarki.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'proformy/pdf' } });
    return NextResponse.json({ error: 'pdf_generation_failed' }, { status: 500 });
  }
}
