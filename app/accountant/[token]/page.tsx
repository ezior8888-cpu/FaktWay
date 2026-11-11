import { notFound } from 'next/navigation';

import { AccountantExportButtons } from '@/components/exports/accountant-export-buttons';
import { loadAccountantPortal } from '@/lib/accountant/load-accountant-portal';
import { checkPortalLimit, parsePortalPage, portalTokenParam } from '@/lib/accountant/portal-access';
import { AccountantInvoiceList } from '@/components/accountant/invoice-list';
import {
  PortalHeader,
  PortalLimitedNotice,
  PortalPagination,
  PortalShell,
  PortalTabs,
  portalHref,
} from '@/components/accountant/portal-parts';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

/**
 * Portal księgowej (oglądają go ludzie spoza firmy). Plan Finora §2.2/E8:
 * tylko Card i Table Finory, bez szkieletu panelu. `referrer: 'no-referrer'`
 * z `app/accountant/layout.tsx` zostaje — token jest w adresie.
 *
 * Krok 6.2 planu kompletnej aplikacji: zakładka „Koszty” obok dokumentów
 * (`/accountant/<token>/expenses`), lista dokumentów strona po stronie
 * (`?strona=N`) i limit prób na adres IP przed odczytem tokenu.
 */
export default async function AccountantPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ strona?: string | string[] }>;
}) {
  const { token: tokenParam } = await params;
  const { strona } = await searchParams;

  const limit = await checkPortalLimit();
  if (!limit.allowed) {
    return (
      <PortalShell>
        <PortalLimitedNotice />
      </PortalShell>
    );
  }

  const rawToken = portalTokenParam(tokenParam);
  const data = await loadAccountantPortal(rawToken, { page: parsePortalPage(strona) });

  if (!data) notFound();

  const { access, tenant, invoices, invoicesPage, invoicesError } = data;
  const documentsHref = portalHref(rawToken, 'documents');

  return (
    <PortalShell>
      <PortalHeader access={access} tenant={tenant} />

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

      <PortalTabs token={rawToken} active="documents" />

      {invoicesError ? (
        <Alert variant="destructive">
          <AlertTitle>Nie udało się wczytać dokumentów. Odśwież stronę za chwilę.</AlertTitle>
        </Alert>
      ) : (
        <AccountantInvoiceList
          invoices={invoices}
          total={invoicesPage.total}
          canDownload={access.access_level === 'download'}
          token={rawToken}
          footer={
            <PortalPagination
              page={invoicesPage}
              label="Strony listy dokumentów"
              hrefFor={(page) => `${documentsHref}?strona=${page}`}
            />
          }
        />
      )}
    </PortalShell>
  );
}
