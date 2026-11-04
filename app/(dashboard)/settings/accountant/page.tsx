import {
  AccountantAccessList,
  type AccountantAccessPublicRow,
} from '@/components/settings/accountant-list';
import { CoPilotSettingsForm } from '@/components/exports/co-pilot-settings-form';
import { FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { TaxOfficeForm } from '@/components/settings/tax-office-form';
import { Separator } from '@/components/ui/separator';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { getPageContextWithRole } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

function toPublicAccesses(
  rows: Record<string, unknown>[] | null,
): AccountantAccessPublicRow[] {
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    accountant_name: String(r.accountant_name ?? ''),
    accountant_email: String(r.accountant_email ?? ''),
    access_level: String(r.access_level ?? ''),
    expires_at: String(r.expires_at ?? ''),
    use_count: Number(r.use_count ?? 0),
    created_at: String(r.created_at ?? ''),
    revoked_at: r.revoked_at != null ? String(r.revoked_at) : null,
    last_used_at: r.last_used_at != null ? String(r.last_used_at) : null,
  }));
}

export default async function AccountantAccessPage() {
  const { supabase, tenantId } = await getPageContextWithRole(
    'owner',
    '/settings',
  );

  const [{ data: settings }, { data: recentJobs }, { data: raw }, taxOfficeCode] =
    await Promise.all([
      supabase
        .from('accountant_settings')
        .select('*')
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      supabase
        .from('export_jobs')
        .select(
          'id, format, status, period_start, period_end, created_at, invoices_count, emailed_at',
        )
        .eq('tenant_id', tenantId)
        .eq('trigger_source', 'co_pilot_monthly')
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('accountant_access')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', {
          ascending: false,
        }),
      // Osobno i odpornie — przed migracją 00092 kolumny nie ma.
      readTenantTaxOffice(supabase, tenantId),
    ]);

  const accesses = toPublicAccesses(raw ?? []);

  // Zakładka „Księgowa” (plan P14, bez odpowiednika w Finorze) złożona
  // z sekcji Finory rozdzielonych `Separator`: urząd skarbowy, Co-Pilot,
  // linki dla księgowej (jak `connected-accounts`).
  return (
    <FieldGroup>
      <div>
        <FieldLabel>Dostęp dla księgowej</FieldLabel>
        <FieldDescription>
          Generuj ograniczone czasowo linki do udostępnienia faktur biuru
          rachunkowemu i — jako właściciel — skonfiguruj automatyczny Co-Pilot
          miesięczny.
        </FieldDescription>
      </div>

      <TaxOfficeForm initialCode={taxOfficeCode} />

      <Separator />

      <CoPilotSettingsForm
        key={settings?.updated_at ?? 'defaults'}
        initialSettings={settings ?? null}
        recentJobs={recentJobs ?? []}
      />

      <Separator />

      <AccountantAccessList accesses={accesses} />
    </FieldGroup>
  );
}
