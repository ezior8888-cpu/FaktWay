import { after } from 'next/server';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { requestInboxPollOnVisit } from '@/lib/ksef/inbox-activity';
import { getPageContext } from '@/lib/supabase/page-context';

import { buildInboxRows, INBOX_COLUMNS, loadInboxExpenseLinks, type InboxInvoiceRow } from './_components/inbox-rows';
import { InboxTable } from './_components/inbox-table';

export const dynamic = 'force-dynamic';

/**
 * Ile najnowszych faktur (po dacie przyjęcia w KSeF) pokazuje skrzynka. Bez
 * `export`: plik strony może eksportować tylko pola znane Next.js.
 */
const INBOX_LIMIT = 200;

/**
 * Skrzynka KSeF (plan Finora P9 ← Finora `/transactions`, ten sam układ co
 * Wydatki: kafle + karta z tabelą). Lista to rejestr faktur kosztowych ze
 * wszystkich środowisk KSeF, jak dotąd (`INBOX_LIMIT` najnowszych po dacie
 * przyjęcia w KSeF); kafle liczą osobne zapytania (§2.4 pkt 12) w osobnych
 * granicach błędu. Odczyt klientem z sesji (RLS) dla aktywnej firmy.
 *
 * Poprawka Bartosza 21.10.2026: zakładka „Skrzynka KSeF” ekranu Koszty, jak
 * zakładki Faktur — bez widocznego nagłówka i podtytułu (tytuł dla czytników
 * ekranu), karta z zakładkami sięga do stopki (`ff-page-fill`). Z podtytułu
 * „co 15 minut” mówi już kafel „Ostatnie pobranie z KSeF” (także przed
 * pierwszym pobraniem), a limit 200
 * pozycji — nota pod paginacją, tylko gdy lista go osiąga (stała nota była
 * brzydka).
 */
export default async function InboxPage() {
  const { supabase, tenantId } = await getPageContext();

  // Klient patrzy na Skrzynkę: przyspieszamy termin (najwyżej raz na 5 minut).
  // Po odpowiedzi, żeby wejście na stronę nie czekało na zapis.
  after(() => requestInboxPollOnVisit(tenantId));

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select(INBOX_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('direction', 'incoming')
    .order('ksef_accepted_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(INBOX_LIMIT);

  const invoiceRows = (invoices ?? []) as InboxInvoiceRow[];
  const links =
    !error && invoiceRows.length > 0
      ? await loadInboxExpenseLinks(supabase, tenantId, invoiceRows.map((row) => row.id))
      : [];
  const rows = buildInboxRows(invoiceRows, links);

  // Zawartość karty sekcji Kosztów: kafle, kartę i rząd zakładek daje
  // `(koszty)/layout.tsx` (poprawka Bartosza 25.10.2026 — przełączenie
  // zakładki zmienia tylko tabelę).
  return (
    <div className="ff-tab-panel flex w-full flex-1 flex-col pt-2">
      <h1 className="sr-only">Skrzynka KSeF</h1>

      {error ? (
        // Błąd w karcie sekcji — rząd zakładek nad nim prowadzi do Wydatków.
        <div className="px-4">
          <Alert variant="destructive">
            <AlertTitle>Nie udało się pobrać faktur: {error.message}</AlertTitle>
          </Alert>
        </div>
      ) : (
        <>
          <div className="flex w-full flex-1 flex-col">
            {links === null ? (
              <div className="px-4 pb-4">
                <Alert>
                  <AlertTitle>Nie udało się sprawdzić statusu faktur</AlertTitle>
                  <AlertDescription>
                    Kolumna „Status” i przejście do wydatku są chwilowo ukryte. Odśwież stronę za chwilę.
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
            <InboxTable rows={rows} statusUnavailable={links === null} />
          </div>
          {rows.length >= INBOX_LIMIT ? (
            <p className="text-muted-foreground px-4 text-xs">
              Pokazujemy {INBOX_LIMIT} najnowszych faktur według daty przyjęcia w KSeF.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
