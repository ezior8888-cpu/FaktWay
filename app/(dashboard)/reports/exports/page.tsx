import { Suspense } from 'react';
import Link from 'next/link';

import { ExportHistorySkeleton, RecentExports } from '@/components/exports/export-history';
import type { ManualExportJobWithFiles } from '@/components/exports/export-formats';
import { parseExportPreset } from '@/components/exports/export-period';
import { ExportsScreen } from '@/components/exports/exports-center';
import { NewExportForm } from '@/components/exports/new-export-form';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { parseExpenseMonth } from '@/lib/expenses/month';
import { readTenantTaxOffice } from '@/lib/exports/tax-office';
import { getPageContext, type PageContext } from '@/lib/supabase/page-context';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** Historia ręcznych eksportów — to samo zapytanie co od P13, ale błąd już nie ginie. */
async function RecentExportsSection({ supabase, tenantId }: Pick<PageContext, 'supabase' | 'tenantId'>) {
  const { data: recentJobs, error } = await supabase
    .from('export_jobs')
    .select(
      `
      *,
      export_files(id, filename, format, size_bytes, download_count)
    `,
    )
    .eq('tenant_id', tenantId)
    .eq('trigger_source', 'manual')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    // Dawniej pusta lista — klient myślał, że eksportów nie ma.
    return (
      <div className="px-4">
        <Alert variant="destructive">
          <AlertTitle>Nie udało się wczytać historii</AlertTitle>
          <AlertAction>
            {/* `cn` (tailwind-merge) usuwa bazowe `border-transparent` — bez tego wygrywało z
                `border-border` (późniejsze w CSS) i w jasnym motywie „Odśwież” było gołym tekstem
                (poprawka Bartosza 21.10.2026: przeprojektowanie Księgowości). */}
            <Link href="/reports/exports" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              Odśwież
            </Link>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  return <RecentExports jobs={(recentJobs ?? []) as ManualExportJobWithFiles[]} />;
}

/**
 * Eksport (poprawka Bartosza 21.10.2026: przeprojektowanie Księgowości):
 * zakładka „Eksport” Księgowości — karta „Nowy plik” i historia w karcie
 * z zakładkami. Adres `?period=RRRR-MM&format=…` (przycisk „Eksport KPiR”)
 * albo `?od=&do=&format=` (naprawy z historii) wypełnia formularz;
 * domyślnie KPiR Excel za poprzedni miesiąc.
 *
 * Jedyny nowy odczyt to urząd skarbowy firmy (JPK_FA bez niego i tak
 * odmówi). Gdy odczyt się nie uda, nie wiemy — nic nie blokujemy.
 */
export default async function ExportsCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; od?: string; do?: string; format?: string }>;
}) {
  const params = await searchParams;
  const { supabase, tenantId } = await getPageContext();

  const currentMonth = parseExpenseMonth(undefined);
  const preset = parseExportPreset(params, currentMonth);
  const taxOfficeSet = await readTenantTaxOffice(supabase, tenantId).then(
    (code) => code !== null,
    () => undefined,
  );
  // Nowy link (np. „Wybierz CSV” z historii) to nowy formularz, nie stary stan.
  const presetKey = `${preset.format}:${preset.from}:${preset.to}`;

  return (
    <ExportsScreen
      form={
        <NewExportForm
          key={presetKey}
          initialFormat={preset.format}
          initialPeriod={preset.period}
          currentMonth={currentMonth}
          taxOfficeSet={taxOfficeSet}
        />
      }
      history={
        <Suspense fallback={<ExportHistorySkeleton />}>
          <RecentExportsSection supabase={supabase} tenantId={tenantId} />
        </Suspense>
      }
    />
  );
}
