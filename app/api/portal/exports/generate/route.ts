// app/api/portal/exports/generate/route.ts
// Synchronous endpoint dla portalu księgowej (zwraca plik bezpośrednio, bez kolejki Inngest).

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { hashToken } from '@/lib/accountant/tokens';
import { logAuditSystem } from '@/lib/audit/log-system';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { exportScopeFor } from '@/lib/exports/export-scope';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { MissingIssuerAddressError, readIssuerRegisteredAddress } from '@/lib/exports/issuer-address';
import { generateJpkFa, JpkDocumentNotSupportedError, JpkFaCorrectionNotSupportedError, JpkFaForeignCurrencyNotSupportedError } from '@/lib/exports/jpk-fa-generator';
import { assertJpkMatchesSchema, JpkSchemaError } from '@/lib/exports/jpk-schema-check';
import { MissingTaxOfficeError, readTenantTaxOffice } from '@/lib/exports/tax-office';
import { generateKpirXlsx } from '@/lib/exports/kpir-generator';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  tenantId: z.string().uuid(),
  format: z.enum(['jpk_fa', 'kpir_excel']),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** NIP + nazwy plików — tylko bezpieczne znaki. */
function safeNipSegment(nip: string): string {
  return nip.replace(/\D/g, '').slice(0, 14) || 'braknip';
}

export async function POST(req: NextRequest) {
  try {
    const accountantToken =
      req.headers.get('x-accountant-token')?.trim() ??
      req.headers.get('X-Accountant-Token')?.trim();

    if (!accountantToken) {
      return NextResponse.json({ error: 'Brak tokenu' }, { status: 401 });
    }

    const tokenHash = hashToken(accountantToken);
    const supabase = createAdminClient();

    const { data: accessRow, error: accessErr } = await supabase
      .from('accountant_access')
      .select('id, tenant_id, access_level, expires_at, revoked_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (accessErr || !accessRow) {
      return NextResponse.json({ error: 'Token nieprawidłowy' }, { status: 403 });
    }

    // Schemat: `revoked_at` (nullable), nie `is_revoked`.
    if (accessRow.revoked_at != null) {
      return NextResponse.json({ error: 'Token nieprawidłowy' }, { status: 403 });
    }

    if (
      accessRow.expires_at &&
      new Date(accessRow.expires_at as string) < new Date()
    ) {
      return NextResponse.json({ error: 'Token wygasł' }, { status: 403 });
    }

    if ((accessRow.access_level as string) !== 'download') {
      return NextResponse.json({ error: 'Brak uprawnień' }, { status: 403 });
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: 'Niepoprawne JSON body' }, { status: 400 });
    }

    const parsed = BodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            parsed.error.flatten().formErrors.join(', ') || parsed.error.message,
        },
        { status: 400 },
      );
    }

    const { tenantId, format, periodStart, periodEnd } = parsed.data;

    if (periodEnd < periodStart) {
      return NextResponse.json(
        { error: 'Okres nieprawidłowy — data końcowa przed początkiem' },
        { status: 400 },
      );
    }

    if (tenantId !== accessRow.tenant_id) {
      return NextResponse.json({ error: 'Brak uprawnień' }, { status: 403 });
    }

    const fwd = req.headers.get('x-forwarded-for');
    const clientIp =
      fwd?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
    const userAgent = req.headers.get('user-agent') ?? '';

    // Portal pobiera pełny zakres formatu — reguła ta sama co w runnerze (FIR-01).
    const scope = exportScopeFor(format, { includeIssued: true, includeReceived: true, includeCorrections: true });
    const data = await fetchInvoicesForExport({
      tenantId,
      periodStart,
      periodEnd,
      direction: scope.invoiceDirection,
      includeCorrections: scope.includeCorrections,
      includeExpenses: scope.includeExpenses,
    });

    const nipSeg = safeNipSegment(data.issuer.nip);

    let buffer: Buffer;
    let filename: string;
    let contentType: string;

    if (format === 'jpk_fa') {
      const taxOfficeCode = await readTenantTaxOffice(supabase, tenantId);
      if (!taxOfficeCode) {
        return NextResponse.json({ error: new MissingTaxOfficeError().message }, { status: 422 });
      }
      // JPK_FA(4): adres podatnika z województwem, powiatem i gminą — z GUS.
      const registeredAddress = await readIssuerRegisteredAddress(data.issuer.nip);
      if (!registeredAddress) {
        return NextResponse.json({ error: new MissingIssuerAddressError().message }, { status: 422 });
      }
      if (data.issuedInvoices.length === 0) {
        return NextResponse.json({ error: 'Brak faktur wystawionych w wybranym okresie.' }, { status: 422 });
      }
      let xml: string;
      try {
        // Tylko faktury WYSTAWIONE — JPK_FA nie obejmuje zakupów.
        xml = generateJpkFa({
          issuer: { ...data.issuer, taxOfficeCode, registeredAddress },
          periodStart,
          periodEnd,
          issuedInvoices: data.issuedInvoices,
        });
        await assertJpkMatchesSchema('JPK_FA', xml);
      } catch (e) {
        if (
          e instanceof JpkFaCorrectionNotSupportedError ||
          e instanceof JpkFaForeignCurrencyNotSupportedError ||
          e instanceof JpkDocumentNotSupportedError
        ) {
          return NextResponse.json({ error: e.message }, { status: 422 });
        }
        if (e instanceof JpkSchemaError) {
          // Błąd generatora, nie danych klienta — zgłoszenie do nas, bez treści pliku.
          const errorId = Sentry.captureException(new Error(`${e.kind}: plik niezgodny z XSD MF`), {
            tags: { area: 'accountant.portal_export', reason: 'jpk_xsd' },
            extra: { errors: e.details },
          });
          return NextResponse.json({ error: e.message, errorId }, { status: 422 });
        }
        throw e;
      }
      buffer = Buffer.from(xml, 'utf8');
      filename = `JPK_FA_${nipSeg}_${periodStart}_${periodEnd}.xml`;
      contentType = 'application/xml; charset=utf-8';
    } else {
      // Przychody z faktur wystawionych, koszty z listy wydatków — to samo
      // źródło co KPiR w aplikacji (do 26.09 koszty szły z faktur otrzymanych).
      try {
        buffer = await generateKpirXlsx({
          issuer: data.issuer,
          periodStart,
          periodEnd,
          issuedInvoices: data.issuedInvoices,
          expenses: data.expenses,
        });
      } catch (e) {
        if (e instanceof OutgoingInvoiceCurrencyNotSupportedError) {
          return NextResponse.json({ error: e.message }, { status: 422 });
        }
        throw e;
      }
      filename = `KPiR_${nipSeg}_${periodStart}_${periodEnd}.xlsx`;
      contentType =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    await logAuditSystem({
      action: 'accountant.portal_export',
      tenantId,
      entityType: 'accountant_access',
      entityId: accessRow.id as string,
      metadata: {
        kind: 'export_download',
        format,
        periodStart,
        periodEnd,
        ip_address: clientIp ?? 'unknown',
        user_agent: userAgent,
      },
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Filename': filename,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof KsefExpenseCurrencyNotSupportedError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    const errorId = Sentry.captureException(e, {
      tags: { area: 'accountant.portal_export' },
    });
    return NextResponse.json(
      {
        error: 'Nie udało się wygenerować pliku. Spróbuj ponownie później.',
        errorId,
      },
      { status: 500 },
    );
  }
}
