import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { getCashReportData, getCompanyParty } from '@/lib/kasa/baza';
import { buildCashReport, parseCashPeriodStrict, type CashParty } from '@/lib/kasa/model';
import { cashReportPdfFilename, renderCashReportPdf } from '@/lib/kasa/pdf';
import { CASH_REGISTER_MISSING_PDF } from '@/lib/kasa/teksty';
import { resolveApiUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { createClient } from '@/lib/supabase/server';

/** Nagłówek raportu, gdy dane firmy w Ustawieniach są niepełne (raport i tak się drukuje). */
const COMPANY_FALLBACK: CashParty = {
  name: 'Dane firmy do uzupełnienia w Ustawieniach',
  nip: null,
  countryCode: 'PL',
  addressLine1: '',
  addressLine2: '',
};

/**
 * GET /api/kasa/raport/pdf?od=RRRR-MM-DD&do=RRRR-MM-DD: raport kasowy za okres
 * (krok 3.7): stan na początek, wpłaty, wypłaty, stan na koniec i lista
 * dowodów. Dla każdego członka aktywnej firmy, także księgowej. Firma ze
 * zweryfikowanego członkostwa, odczyt przez RLS (RPC `cash_report`). Zły okres
 * to 400 z komunikatem, kasa nieotwarta to 409 z drogą wyjścia, nieznany
 * kształt odpowiedzi to 500, a nie pusty raport.
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await resolveApiUserAndActiveOrg();
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const url = new URL(req.url);
  const period = parseCashPeriodStrict({ od: url.searchParams.get('od'), do: url.searchParams.get('do'), today: todayInWarsaw() });
  if (!period.ok) return NextResponse.json({ error: period.error }, { status: 400 });

  try {
    const supabase = await createClient();
    const data = await getCashReportData(supabase, period.from, period.to);
    if (!data.register) return NextResponse.json({ error: CASH_REGISTER_MISSING_PDF }, { status: 409 });
    // Przed dniem rozpoczęcia kasy nie ma dowodów: raport zaczyna się od tego dnia.
    const from = period.from < data.register.openingDate ? data.register.openingDate : period.from;
    const report = buildCashReport({
      from,
      to: period.to,
      openingDate: data.register.openingDate,
      balanceBefore: data.balanceBefore,
      documents: data.documents,
    });
    const company = (await getCompanyParty(supabase, ctx.tenantId)) ?? COMPANY_FALLBACK;
    const pdf = await renderCashReportPdf({ report, company, generatedAt: new Date().toISOString() });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${cashReportPdfFilename(from, period.to)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'kasa/raport/pdf' } });
    return NextResponse.json({ error: 'pdf_generation_failed' }, { status: 500 });
  }
}
