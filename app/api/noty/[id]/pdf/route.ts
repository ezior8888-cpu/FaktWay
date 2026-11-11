import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { getNote } from '@/lib/noty/baza';
import { notePdfFilename, notePdfInput, renderNotePdf } from '@/lib/noty/pdf';
import { resolveApiUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { createClient } from '@/lib/supabase/server';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/noty/[id]/pdf: PDF wystawionej noty (krok 2.9, część 1).
 *
 * Firma pochodzi ze zweryfikowanego członkostwa (`resolveApiUserAndActiveOrg`),
 * a notę czyta klient z sesji, więc RLS 00193 i filtr `tenant_id` dają „nie
 * znaleziono” dla noty innej firmy. PDF powstaje za każdym razem z danych
 * noty (bez pamięci podręcznej w magazynie plików): wystawionej noty nie
 * zmienia nikt, a plik jest powtarzalny.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ctx = await resolveApiUserAndActiveOrg();
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  try {
    const supabase = await createClient();
    const note = await getNote(supabase, ctx.tenantId, id);
    if (!note) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const input = notePdfInput(note);
    if (!input) {
      return NextResponse.json({ error: 'Najpierw wystaw notę. Szkic nie ma numeru ani PDF.' }, { status: 409 });
    }
    const pdf = await renderNotePdf(input);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${notePdfFilename(input.number)}"`,
        // PDF noty to dane kontrahenta: bez pamięci podręcznej przeglądarki.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'noty/pdf' } });
    return NextResponse.json({ error: 'pdf_generation_failed' }, { status: 500 });
  }
}
