import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import PQueue from 'p-queue';

import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { packageZip, type PackagedFile } from '@/lib/exports/zip-packager';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveApiUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * GET /api/invoices/batch-pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 * — ZIP z PDF wszystkich faktur wystawionych w okresie (Faza 33 Krok 7).
 *
 * GET /api/invoices/batch-pdf?ids=<uuid>,<uuid>,…
 * — ZIP z PDF zaznaczonych faktur („Pobierz PDF zaznaczonych”, P3 planu
 * Finora). Dokładnie jeden tryb na żądanie. Id spoza firmy (albo faktura
 * zakupowa) daje 404 `not_found` bez wskazania, które — i bez generowania
 * czegokolwiek, także PDF faktur własnych z tego samego zaznaczenia.
 *
 * Limit 100 faktur na paczkę — przy większej liczbie generowanie
 * przekroczyłoby timeout funkcji serverless. Cache PDF w R2 (Krok 3)
 * sprawia, że kolejne pobranie tego samego miesiąca jest szybkie.
 *
 * KRYTYCZNE: lista faktur idzie przez admin client (omija RLS), więc tenant
 * MUSI być zweryfikowany membership (`resolveApiUserAndActiveOrg`), nie samym
 * formatem cookie — inaczej spreparowane cookie z obcym org_id pozwoliłoby
 * pobrać WSZYSTKIE faktury cudzej organizacji z danego okresu.
 */
const MAX_INVOICES = 100;
// Render pdfkit jest CPU/IO-bound (fonty + R2 round-trip przy cache miss).
// Sekwencyjnie 100 sztuk przy zimnym cache ocierało się o timeout funkcji —
// 4 równoległe rendery mieszczą paczkę z zapasem, nie zajeżdżając pamięci.
const PDF_RENDER_CONCURRENCY = 4;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * AUD-119: paczki generuje proces aplikacji, który dzieli pamięć app-1
 * z workerem. Limit na firmę (3 paczki / 10 min) i na proces (2 naraz) —
 * dalsze żądania dostają 429 zamiast kolejnych 100 PDF w pamięci.
 */
const BATCHES_PER_TENANT = 3;
const BATCH_WINDOW_SECONDS = 600;
const MAX_BATCHES_IN_FLIGHT = 2;
let batchesInFlight = 0;

interface InvoiceRow {
  id: string;
  internal_number: string | null;
}

/** Wąski widok klienta admina — tylko łańcuchy używane przez oba tryby. */
interface InvoiceQuery {
  eq: (k: string, v: string) => InvoiceQuery;
  gte: (k: string, v: string) => InvoiceQuery;
  lte: (k: string, v: string) => InvoiceQuery;
  in: (k: string, v: readonly string[]) => InvoiceQuery;
  limit: (n: number) => PromiseLike<{
    data: InvoiceRow[] | null;
    error: { message: string } | null;
  }>;
}
interface AdminInvoices {
  from: (n: 'invoices') => { select: (c: string) => InvoiceQuery };
}

type BatchSelection =
  | { mode: 'range'; from: string; to: string }
  | { mode: 'ids'; ids: string[] };

/**
 * `ids`: 1..MAX_INVOICES identyfikatorów UUID po przecinku; wielkość liter
 * bez znaczenia, powtórzenia liczone raz. Wszystko inne to `invalid_ids` —
 * wartość nie trafia do filtra PostgREST, jeśli nie jest czystym UUID.
 */
function parseSelection(url: URL): BatchSelection | { error: 'invalid_range' | 'invalid_ids' } {
  const params = url.searchParams;
  const hasIds = params.has('ids');
  const hasRange = params.has('from') || params.has('to');
  if (hasIds && hasRange) return { error: 'invalid_range' };
  if (hasIds) {
    const parts = (params.get('ids') ?? '').split(',').map((part) => part.trim().toLowerCase());
    if (parts.some((part) => !UUID_RE.test(part))) return { error: 'invalid_ids' };
    const ids = [...new Set(parts)];
    if (ids.length === 0 || ids.length > MAX_INVOICES) return { error: 'invalid_ids' };
    return { mode: 'ids', ids };
  }
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return { error: 'invalid_range' };
  return { mode: 'range', from, to };
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await resolveApiUserAndActiveOrg();
  if (!ctx.ok) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const tenantId = ctx.tenantId;

  // Sprawdzenie i zajęcie miejsca bez `await` pomiędzy — inaczej równoległe
  // żądania przeszłyby razem przed zwiększeniem licznika.
  if (batchesInFlight >= MAX_BATCHES_IN_FLIGHT) {
    return NextResponse.json({ error: 'busy' }, { status: 429, headers: { 'Retry-After': '30' } });
  }
  batchesInFlight += 1;
  try {
    return await buildBatch(req, tenantId);
  } finally {
    batchesInFlight -= 1;
  }
}

async function buildBatch(req: Request, tenantId: string): Promise<Response> {
  const quota = await checkRateLimit({
    bucket: 'batch_pdf',
    identifier: tenantId,
    limit: BATCHES_PER_TENANT,
    windowSeconds: BATCH_WINDOW_SECONDS,
  });
  if (!quota.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(Math.max(1, quota.retryAfter)) } },
    );
  }

  const selection = parseSelection(new URL(req.url));
  if ('error' in selection) {
    return NextResponse.json({ error: selection.error }, { status: 400 });
  }

  try {
    const admin = createAdminClient() as unknown as AdminInvoices;
    // Klient admina omija RLS — granicą firmy jest `tenant_id` w zapytaniu.
    const base = admin
      .from('invoices')
      .select('id, internal_number')
      .eq('tenant_id', tenantId)
      .eq('direction', 'outgoing');
    const res = selection.mode === 'range'
      ? await base
        .gte('issue_date', selection.from)
        .lte('issue_date', selection.to)
        .limit(MAX_INVOICES + 1)
      : await base
        .in('id', selection.ids)
        .limit(MAX_INVOICES + 1);

    if (res.error) {
      throw new Error(`invoices query: ${res.error.message}`);
    }
    let invoices = res.data ?? [];
    if (selection.mode === 'ids') {
      // Każde zaznaczone id musi wrócić jako faktura tej firmy. Brak choćby
      // jednego (obca firma, zakup, usunięta) = 404 bez wskazania, które.
      const order = new Map(selection.ids.map((id, index) => [id, index]));
      const found = new Set(invoices.map((inv) => inv.id));
      if (invoices.length !== selection.ids.length || found.size !== selection.ids.length ||
          invoices.some((inv) => !order.has(inv.id))) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      invoices = [...invoices].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    }
    if (invoices.length === 0) {
      return NextResponse.json({ error: 'no_invoices' }, { status: 404 });
    }
    if (invoices.length > MAX_INVOICES) {
      return NextResponse.json(
        { error: 'too_many', limit: MAX_INVOICES },
        { status: 413 },
      );
    }

    const queue = new PQueue({ concurrency: PDF_RENDER_CONCURRENCY });
    const results = await Promise.all(
      invoices.map((inv) =>
        queue.add(() => generateInvoicePdf(inv.id, tenantId)),
      ),
    );

    // Paczka nie może wyglądać na kompletną, gdy choć jedna faktura offline
    // nie ma jeszcze wymaganych dwóch kodów QR.
    if (results.some((result) => result && !result.success && result.code === 'OFFLINE_QR_UNAVAILABLE')) {
      return NextResponse.json({ error: 'offline_qr_unavailable' }, { status: 409 });
    }
    if (results.some((result) => result && !result.success && result.code === 'PDF_STATE_CHANGED')) {
      return NextResponse.json({ error: 'pdf_state_changed' }, { status: 409 });
    }

    // Kolejność plików w ZIP = kolejność zapytania (Promise.all zachowuje ją
    // niezależnie od tego, w jakiej kolejności skończyły się rendery).
    // Pojedyncza faktura, której nie da się wyrenderować, nie blokuje
    // całej paczki — pomijamy ją po cichu (rzadkie, np. niespójne dane).
    const files: PackagedFile[] = [];
    for (const result of results) {
      if (result && result.success) {
        files.push({ filename: result.filename, content: result.pdf });
      }
    }

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'generation_failed' },
        { status: 500 },
      );
    }

    const zip = await packageZip(files);
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename(selection, files.length)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'invoices/batch-pdf' } });
    return NextResponse.json({ error: 'batch_failed' }, { status: 500 });
  }
}

function zipFilename(selection: BatchSelection, count: number): string {
  return selection.mode === 'range'
    ? `Faktury_${selection.from}_${selection.to}.zip`
    : `Faktury_zaznaczone_${count}.zip`;
}
