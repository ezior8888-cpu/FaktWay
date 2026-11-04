import { notFound } from 'next/navigation';
import { Eye, Download } from 'lucide-react';

import { AccountantExportButtons } from '@/components/exports/accountant-export-buttons';
import { loadAccountantPortal } from '@/lib/accountant/load-accountant-portal';
import { AccountantInvoiceList } from '@/components/accountant/invoice-list';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestampDatePl } from '@/lib/format/iso-date';

export const dynamic = 'force-dynamic';

/**
 * Portal księgowej (oglądają go ludzie spoza firmy). Plan Finora §2.2/E8:
 * tylko Card i Table Finory, bez szkieletu panelu. `referrer: 'no-referrer'`
 * z `app/accountant/layout.tsx` zostaje — token jest w adresie.
 */
export default async function AccountantPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token: tokenParam } = await params;
  const rawToken = decodeURIComponent(tokenParam);
  const data = await loadAccountantPortal(rawToken);

  if (!data) notFound();

  const { access, tenant, invoices } = data;

  return (
    <div className="bg-background text-foreground min-h-screen p-4 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <Card className="shadow-none">
          <CardContent className="flex flex-wrap items-start justify-between gap-6">
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs">Faktury udostępnione przez</p>
              <h1 className="text-2xl font-semibold tracking-tight">{tenant?.name}</h1>
              <p className="text-muted-foreground font-mono text-sm">NIP: {tenant?.nip}</p>
            </div>
            <div className="space-y-1.5 text-right">
              <Badge variant="secondary" className="font-normal">
                {access.access_level === 'download' ? (
                  <>
                    <Download aria-hidden />
                    Z pobieraniem
                  </>
                ) : (
                  <>
                    <Eye aria-hidden />
                    Tylko podgląd
                  </>
                )}
              </Badge>
              <p className="text-muted-foreground text-xs">
                Dostęp dla:{' '}
                <span className="text-foreground font-medium">{access.accountant_name}</span>
              </p>
              <p className="text-muted-foreground text-xs">
                Wygasa: {formatTimestampDatePl(access.expires_at)}
              </p>
            </div>
          </CardContent>
        </Card>

        {access.access_level === 'download' ? (
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">Pobierz dane księgowe</CardTitle>
            </CardHeader>
            <CardContent>
              <AccountantExportButtons
                tenantId={access.tenant_id}
                accessToken={rawToken}
              />
            </CardContent>
          </Card>
        ) : null}

        <AccountantInvoiceList
          invoices={invoices ?? []}
          canDownload={access.access_level === 'download'}
          token={rawToken}
        />

        <div className="pt-4 pb-2 text-center">
          <p className="text-muted-foreground text-xs">Powered by FaktWay</p>
        </div>
      </div>
    </div>
  );
}
