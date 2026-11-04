import { FileText } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { pulpitErrorMessage } from '@/components/dashboard/pulpit/pulpit-grid';
import { contractorSearchFilter } from '@/lib/contractors/edit';
import { normalizeNip, receivablesByNip, type ContractorReceivables } from '@/lib/contractors/overview';
import { RECEIVABLES_NOTE } from '@/lib/dashboard/receivables';
import { sanitizeSearch } from '@/lib/invoices/list-query';
import { getPageContext } from '@/lib/supabase/page-context';

import { ContractorStatTiles, foreignCurrencyNote, loadReceivables } from './_components/contractor-stat-tiles';
import { ContractorsTable, type ContractorTableRow } from './_components/contractors-table';

export const dynamic = 'force-dynamic';

/**
 * Kontrahenci (P13, PLAN-FINORA §5): kafle i tabela w układzie Invoice List
 * Finory. Lista i wyszukiwanie jak dotąd (do 200 pozycji, szukanie w bazie
 * po nazwie i NIP — F-011); kolumny „Należności” i „Po terminie” to
 * `getReceivables` (§2.4 pkt 11) rozłożone po NIP nabywcy.
 */
export default async function ContractorsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase, tenantId } = await getPageContext();
  const sp = (await searchParams) ?? {};
  const q = sanitizeSearch(Array.isArray(sp.q) ? sp.q[0] ?? '' : sp.q ?? '');

  // Wyszukiwanie po nazwie i NIP w bazie, nie na załadowanej stronie (F-011).
  let query = supabase
    .from('contractors')
    .select(
      'id, nip, name, address, email, vat_status, last_validation_at, validation_warning, last_used_at, reminder_excluded, reminder_exclusion_reason'
    )
    .eq('tenant_id', tenantId);
  const search = contractorSearchFilter(q);
  if (search) query = query.or(search);
  const { data: contractors } = await query
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .limit(200);

  const hasContractors = Boolean(contractors && contractors.length > 0);

  // Należności per kontrahent. Błąd (np. strażnik środowiska) nie chowa listy:
  // kolumny dostają „—”, a nad tabelą jest komunikat (jak fakty listy faktur, E3).
  let byNip: Map<string, ContractorReceivables> | null = null;
  let receivablesError: string | null = null;
  let skippedForeign: string | null = null;
  if (hasContractors) {
    try {
      const receivables = await loadReceivables(supabase, tenantId);
      byNip = receivablesByNip(receivables);
      skippedForeign = foreignCurrencyNote(receivables.foreignCurrencyCount);
    } catch (error) {
      receivablesError = pulpitErrorMessage(error);
    }
  }

  const rows: ContractorTableRow[] = (contractors ?? []).map((contractor) => {
    const nip = normalizeNip(contractor.nip);
    return {
      id: contractor.id,
      nip: contractor.nip,
      name: contractor.name,
      address: contractor.address as ContractorTableRow['address'],
      email: contractor.email,
      vat_status: contractor.vat_status,
      validation_warning: contractor.validation_warning,
      reminder_excluded: contractor.reminder_excluded,
      receivables: byNip === null ? null : (nip ? byNip.get(nip) : undefined) ?? { outstanding: 0, overdueCount: 0 },
    };
  });

  return (
    // `ff-page-fill`: karta z tabelą sięga do stopki pustym arkuszem (poprawka Bartosza 21.10.2026).
    <div className="ff-page-fill flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Kontrahenci</h1>
        <p className="text-muted-foreground text-sm">
          Zapisani automatycznie z faktur. Dane pobierane z bazy GUS REGON
        </p>
      </div>

      <ContractorStatTiles supabase={supabase} tenantId={tenantId} />

      {!hasContractors && !q ? (
        <EmptyState
          icon={FileText}
          title="Brak kontrahentów"
          description="Kontrahenci zostaną dodani automatycznie przy wystawianiu pierwszej faktury"
          primaryAction={{ type: 'link', label: 'Wystaw fakturę', href: '/invoices/new', icon: FileText }}
        />
      ) : (
        <>
          {receivablesError ? (
            <Alert>
              <AlertTitle>Nie udało się policzyć należności</AlertTitle>
              <AlertDescription>
                Kolumny „Należności” i „Po terminie” są chwilowo puste: {receivablesError}
              </AlertDescription>
            </Alert>
          ) : null}
          <Card className="flex-1 shadow-none">
            <ContractorsTable
              contractors={rows}
              q={q}
              emptyText={q ? `Brak kontrahentów dla „${q}”.` : 'Brak wyników.'}
              note={`Należności i „Po terminie”: ${RECEIVABLES_NOTE.toLowerCase()}.${skippedForeign ? ` ${skippedForeign}.` : ''} Pokazujemy do 200 kontrahentów, od ostatnio użytych.`}
            />
          </Card>
        </>
      )}
    </div>
  );
}
