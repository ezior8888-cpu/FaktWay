import { Suspense } from 'react';
import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { InvoicesTabs } from '@/components/invoices/invoices-tabs';
import { Card } from '@/components/ui/card';
import { receivableBaseFilterOps, settledFilterOps } from '@/lib/dashboard/receivables';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  INVOICE_PAYMENT_FILTERS,
  INVOICE_STATUS_FILTERS,
  invoiceListHref,
  isFilteredList,
  orFilterString,
  pageRange,
  parseInvoiceListParams,
  paymentFilterSpec,
  searchOrFilter,
  type PaymentFilterOp,
} from '@/lib/invoices/list-query';
import {
  LIST_ROW_FACT_COLUMNS,
  loadInvoiceListRowFacts,
  type InvoiceListRowFacts,
  type ListRowFactsRow,
} from '@/lib/invoices/list-row-facts';
import { canChangeInvoicePayment } from '@/lib/invoices/manual-payment';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { getPageContext } from '@/lib/supabase/page-context';
import type { InvoiceFactsById, InvoiceRow } from '@/components/invoices/invoice-row-types';
import { InvoiceStatTiles } from './_components/invoice-stat-tiles';
import { InvoicesPagination } from './_components/invoices-pagination';
import { InvoicesPullToRefresh } from './_components/invoices-pull-to-refresh';
import { InvoicesToolbar } from './_components/invoices-toolbar';
import { RecurringDueBanner } from './_components/recurring-due-banner';

export const dynamic = 'force-dynamic';

/** Kolumny listy: widok wiersza + pola płatności i błędu KSeF + fakty §2.4 pkt 11. */
const LIST_COLUMNS = `id, internal_number, issue_date, buyer_data, gross_total, ksef_status, ksef_number, created_at, xml_storage_path, payment_status, payment_due_date, paid_amount, currency, invoice_kind, last_error_code, ${LIST_ROW_FACT_COLUMNS}`;

type ListQueryRow = InvoiceRow & ListRowFactsRow;

/**
 * Lista faktur wystawionych (P3, PLAN-FINORA §5): kafle, pasek filtrów,
 * tabela Finory od `lg` i karty na telefonie. Serwer jest właścicielem
 * danych, filtrów i stronicowania — parametry w adresie (formularz GET działa
 * bez JS, stan da się zapisać w zakładkach). Wyszukiwanie, filtry i strony
 * liczy baza na pełnym zbiorze (F-086).
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase, tenantId, role } = await getPageContext();
  const params = parseInvoiceListParams((await searchParams) ?? {});
  const today = todayInWarsaw();
  const [rangeFrom, rangeTo] = pageRange(params.page, params.perPage);

  let query = supabase
    .from('invoices')
    .select(LIST_COLUMNS, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing');
  const statuses = INVOICE_STATUS_FILTERS[params.status].statuses;
  if (statuses) query = query.in('ksef_status', [...statuses]);
  if (params.kind !== 'wszystkie') query = query.eq('invoice_kind', params.kind);
  // Filtr płatności tylko na fakturach z §2.4 pkt 11 (C1); środowisko KSeF
  // czytamy dopiero, gdy filtr jest wybrany. Bez środowiska nie pokazujemy
  // listy bez filtra udającej filtrowaną — komunikat i link bez tego filtra
  // (AGENTS.md pkt 4: blokada z wyjściem).
  let paymentOps: PaymentFilterOp[] | null = null;
  let paymentFilterError = false;
  try {
    paymentOps = paymentFilterSpec(
      params.payment,
      today,
      () => receivableBaseFilterOps(requireConfiguredKsefEnvironment()),
      () => settledFilterOps(requireConfiguredKsefEnvironment()),
    );
  } catch (e) {
    console.error('[invoices] filtr płatności bez środowiska KSeF', e);
    paymentFilterError = true;
  }
  for (const cond of paymentOps ?? []) {
    switch (cond.op) {
      case 'eq':
        query = query.eq(cond.column, cond.value);
        break;
      case 'neq':
        query = query.neq(cond.column, cond.value);
        break;
      case 'lt':
        query = query.lt(cond.column, cond.value);
        break;
      case 'gt':
        query = query.gt(cond.column, cond.value);
        break;
      case 'gte':
        query = query.gte(cond.column, cond.value);
        break;
      case 'in':
        query = query.in(cond.column, [...cond.value]);
        break;
      case 'or':
        query = query.or(orFilterString(cond.anyOf));
        break;
    }
  }
  if (params.from) query = query.gte('issue_date', params.from);
  if (params.to) query = query.lte('issue_date', params.to);
  const search = searchOrFilter(params.q);
  if (search) query = query.or(search);

  const { data: invoices, error, count } = paymentFilterError
    ? { data: null, error: null, count: 0 }
    : await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(rangeFrom, rangeTo);

  const rows = (invoices ?? []) as unknown as ListQueryRow[];
  const total = count ?? rows.length;
  const filtered = isFilteredList(params);

  // Fakty wierszy tej strony (≤ 50): ikona płatności, „Do zapłaty”, „Korekta”.
  // Błąd odczytu nie chowa listy — wiersze dostają „—”, a kafle mają własne granice błędów.
  let facts = new Map<string, InvoiceListRowFacts>();
  let factsError: string | null = null;
  if (!error && rows.length > 0) {
    try {
      facts = await loadInvoiceListRowFacts(supabase, tenantId, rows);
    } catch (e) {
      factsError = e instanceof Error ? e.message : 'Nie udało się policzyć płatności';
    }
  }
  const factsById: InvoiceFactsById = Object.fromEntries(facts);

  // Układ `invoices-list/index.tsx` Finory: kafle, potem JEDNA karta z paskiem
  // narzędzi, tabelą (od `lg`; niżej karty wierszy, §7.2) i stopką z paginacją.
  // Strona nie ma widocznego nagłówka, jak w szablonie — tytuł dla czytników ekranu.
  // Poprawka 21.10.2026: pierwszy rząd karty to zakładki Faktur, a karta sięga
  // do stopki pustym arkuszem (`ff-page-fill`, rośnie obszar tabeli nad paginacją).
  return (
    <div className="ff-page-fill flex flex-col gap-6">
      <h1 className="sr-only">Faktury wystawione</h1>

      {/* N1: ile faktur cyklicznych czeka na wystawienie. Własny odczyt w Suspense — nie wstrzymuje listy, a jego błąd jej nie psuje. */}
      <Suspense fallback={null}>
        <RecurringDueBanner supabase={supabase} tenantId={tenantId} today={today} />
      </Suspense>

      <InvoiceStatTiles supabase={supabase} tenantId={tenantId} />

      <Card className="flex-1 pt-0">
        <InvoicesTabs active="wystawione" />
        <div className="flex w-full flex-1 flex-col pt-2">
          <div className="flex-1 border-b">
            <InvoicesToolbar params={params} filtered={filtered} />

            {paymentFilterError ? (
              <div className="px-4 pb-4">
                <Alert variant="destructive">
                  <AlertTitle>Filtr płatności jest chwilowo niedostępny</AlertTitle>
                  <AlertDescription>
                    <p>
                      Filtr „{INVOICE_PAYMENT_FILTERS[params.payment].label}” wymaga ustawionego środowiska KSeF
                      w konfiguracji serwera, a go brakuje. Pozostałe filtry działają; zgłoś to w pomocy FaktWay.
                    </p>
                    <Link href={invoiceListHref(params, { payment: 'wszystkie' })} className="font-medium underline">
                      Pokaż faktury bez filtra płatności
                    </Link>
                  </AlertDescription>
                </Alert>
              </div>
            ) : error ? (
              <div className="px-4 pb-4">
                <Alert variant="destructive">
                  <AlertTitle>Nie udało się pobrać faktur: {error.message}</AlertTitle>
                </Alert>
              </div>
            ) : (
              <>
                {factsError ? (
                  <div className="px-4 pb-4">
                    <Alert>
                      <AlertTitle>Nie udało się policzyć płatności</AlertTitle>
                      <AlertDescription>
                        Kolumny „Płatność”, „Do zapłaty” i akcja „Korekta” są chwilowo ukryte: {factsError}
                      </AlertDescription>
                    </Alert>
                  </div>
                ) : null}
                <InvoicesPullToRefresh
                  tenantId={tenantId}
                  initialInvoices={rows}
                  facts={factsById}
                  today={today}
                  canMarkPaid={canChangeInvoicePayment(role)}
                  filtered={filtered}
                  summary={total === 0 ? undefined : 'Sortowanie wg daty utworzenia'}
                />
              </>
            )}
          </div>
          {!paymentFilterError && !error && total > 0 ? <InvoicesPagination params={params} total={total} /> : null}
        </div>
      </Card>
    </div>
  );
}
