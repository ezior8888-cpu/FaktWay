import Link from 'next/link';

import { AdvanceInvoiceForm } from '@/components/invoices/advance-form';
import { SellerProfileBlock } from '@/components/invoices/seller-profile-block';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { loadTenantSellerForForms } from '@/lib/invoices/load-tenant-seller';
import {
  advanceInvoiceFromQuote,
  loadQuoteSource,
  type AdvancePrefillValues,
  type ConversionNotice,
} from '@/lib/proformy/zamiana';
import { getPageContext } from '@/lib/supabase/page-context';

type SearchParams = Record<string, string | string[] | undefined>;

function param(params: SearchParams, key: string): string | null {
  const v = params[key];
  const value = Array.isArray(v) ? v[0] : v;
  return value?.trim() ? value.trim() : null;
}

/**
 * Faktura zaliczkowa. `?proforma=<id>` (krok 2.4): „Wystaw fakturę zaliczkową”
 * z proformy albo oferty wypełnia formularz danymi dokumentu i ukrytym
 * powiązaniem; nic nie zapisuje i nie wysyła do KSeF. Gdy z dokumentu jest już
 * faktura, tylko z `&kolejna=1` (potwierdzenie na ekranie dokumentu). Dokument
 * z kilkoma stawkami albo ze stawką spoza formularza zaliczki: pusty formularz
 * z komunikatem i linkiem do dokumentu.
 */
export default async function NewAdvanceInvoicePage({
  searchParams,
}: { searchParams?: Promise<SearchParams> }) {
  const loaded = await loadTenantSellerForForms();
  if (!loaded) return <SellerProfileBlock />;

  const params = (await searchParams) ?? {};
  const proformaId = param(params, 'proforma');
  let notice: ConversionNotice | null = null;
  let fromQuote: { initialValues: AdvancePrefillValues; salesQuoteId: string; salesQuoteSeq: string } | null = null;
  if (proformaId) {
    const { supabase, tenantId } = await getPageContext();
    const source = await loadQuoteSource(supabase, tenantId, proformaId, param(params, 'kolejna') === '1');
    if (!source.ok) {
      notice = source.notice;
    } else {
      const mapped = advanceInvoiceFromQuote(source.source);
      notice = mapped.notice;
      if (mapped.ok) {
        fromQuote = {
          initialValues: mapped.initialValues,
          salesQuoteId: source.source.quote.id,
          salesQuoteSeq: String(source.source.seq),
        };
      }
    }
  }

  // P5: szerokość daje siatka Finory w formularzu (dokument + kolumna 18rem).
  // UX-01: firma sprzedawcy idzie do formularza — zapis sprawdzi, że to wciąż aktywna firma;
  // `key` montuje formularz od nowa po przełączeniu firmy w tej karcie.
  const form = (
    <AdvanceInvoiceForm
      key={loaded.tenantId}
      initialSeller={loaded.seller}
      tenantId={loaded.tenantId}
      {...(fromQuote
        ? { initialValues: fromQuote.initialValues, salesQuoteId: fromQuote.salesQuoteId, salesQuoteSeq: fromQuote.salesQuoteSeq }
        : {})}
    />
  );
  if (!notice) return form;

  return (
    <div className="space-y-4">
      <Alert variant={notice.tone === 'error' ? 'destructive' : 'default'}>
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription>
          <p>{notice.text}</p>
          {notice.link ? (
            <Link href={notice.link.href} className="font-medium">
              {notice.link.label}
            </Link>
          ) : null}
        </AlertDescription>
      </Alert>
      {form}
    </div>
  );
}
