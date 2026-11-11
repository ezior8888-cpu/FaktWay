import { NextResponse } from 'next/server';

import { checkPortalLimit, portalLimitedResponse } from '@/lib/accountant/portal-access';
import { hashToken } from '@/lib/accountant/tokens';
import { logAuditSystem } from '@/lib/audit/log-system';
import { createAdminClient } from '@/lib/supabase/server';
import { downloadInvoiceXml } from '@/lib/storage/r2';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; invoiceId: string }> }
) {
  // Limit prób portalu (krok 6.2), przed odczytem tokenu z bazy.
  const limit = await checkPortalLimit();
  if (!limit.allowed) return portalLimitedResponse(limit.retryAfter);

  const { token, invoiceId } = await context.params;
  const trimmed = token.trim();
  if (!trimmed) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const hash = hashToken(trimmed);
  const supabase = createAdminClient();

  const { data: access } = await supabase
    .from('accountant_access')
    .select('id, tenant_id, access_level, expires_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle();

  if (
    !access ||
    access.revoked_at ||
    new Date(access.expires_at as string) < new Date() ||
    access.access_level !== 'download'
  ) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('id, internal_number, xml_storage_path')
    .eq('id', invoiceId)
    .eq('tenant_id', access.tenant_id as string)
    .maybeSingle();

  if (
    invErr ||
    !invoice?.xml_storage_path ||
    !isTenantStoragePath(invoice.xml_storage_path, access.tenant_id as string)
  ) {
    return NextResponse.json({ error: 'XML not found' }, { status: 404 });
  }

  const { data: xmlDoc, error: xmlErr } = await supabase
    .from('xml_documents')
    .select('sha256_hash')
    .eq('storage_path', invoice.xml_storage_path)
    .eq('tenant_id', access.tenant_id as string)
    .eq('invoice_id', invoice.id as string)
    .maybeSingle();

  if (xmlErr || !xmlDoc?.sha256_hash) {
    return NextResponse.json({ error: 'XML not found' }, { status: 404 });
  }

  let xml: string;
  try {
    xml = await downloadInvoiceXml(
      invoice.xml_storage_path,
      xmlDoc.sha256_hash as string,
      access.tenant_id as string,
    );
  } catch (e) {
    console.error('[accountant/download-xml]', e);
    return NextResponse.json({ error: 'Download failed' }, { status: 502 });
  }

  await logAuditSystem({
    action: 'invoice.xml_downloaded',
    tenantId: access.tenant_id as string,
    entityType: 'invoice',
    entityId: invoice.id as string,
    metadata: { via: 'accountant_access', accessId: access.id },
  });

  const baseName = (invoice.internal_number ?? invoiceId).replace(
    /[^a-zA-Z0-9_-]+/g,
    '-'
  );

  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${baseName}.xml"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
