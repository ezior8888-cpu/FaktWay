import { ImportCenter, ImportHeader } from '@/components/import-danych/import-center';
import { IMPORT_HISTORY_COLUMNS, IMPORT_HISTORY_LIMIT } from '@/components/import-danych/import-model';
import { pauseErrorFromParam } from '@/components/import-danych/ksef-history-model';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { hasConfiguredKsefProof } from '@/lib/ksef/claim-environment';
import { readKsefHistorySyncStatus } from '@/lib/ksef/history-sync/status';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Import danych — centrum importu w stylu Accounts Finory (poprawka Bartosza
 * 22.10.2026: import danych w stylu Finory).
 *
 * Decyzja Bartosza 22.10.2026: Magiczny import znika. Karta „Historia z KSeF”
 * pokazuje automatyczne pobieranie całej historii z KSeF (sprzedaż i zakupy,
 * potem na bieżąco sprzedaż spoza FaktWay), a „Przeprowadzka z innego
 * programu” — import pliku CSV z czterech dużych programów.
 *
 * Tylko odczyty, wszystkie klientem użytkownika (RLS): `tenants` (flaga
 * `has_ksef_credentials` i potwierdzenie certyfikatu `ksef_verified_at`
 * + `ksef_verified_environment`, nigdy zaszyfrowany blob — AUD-103), ostatnie
 * `import_jobs` (`import_jobs_tenant_isolation`) i stan synchronizacji
 * historii (`readKsefHistorySyncStatus` — tylko kolumny dostępne dla klienta,
 * bez szczegółów błędów). Wstrzymanie pobierania: formularz karty
 * → `setKsefHistoryPausedAction` (właściciel, 2FA); błąd wraca jako
 * `?wstrzymanie=blad`, brak 2FA jako `?wstrzymanie=2fa`.
 *
 * Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): cron pobiera
 * historię tylko firmom z certyfikatem potwierdzonym dla KSEF_ENV, więc karta
 * dostaje to samo potwierdzenie (`hasConfiguredKsefProof`) — bez niego prosi
 * o ponowne wgranie certyfikatu zamiast obiecywać start.
 */
export default async function ImportDanychPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const { supabase, tenantId, role } = await getPageContext();
  const params = (await searchParams) ?? {};
  const pauseError = pauseErrorFromParam(params.wstrzymanie);

  if (!tenantId) {
    return (
      <div className="ff-page-fill flex flex-col gap-6">
        <ImportHeader />
        <Alert>
          <AlertDescription>
            Import uruchomisz po założeniu organizacji i konfiguracji certyfikatu KSeF.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const [{ data: tenant }, history, ksefHistory] = await Promise.all([
    supabase
      .from('tenants')
      .select('name, nip, has_ksef_credentials, ksef_verified_at, ksef_verified_environment')
      .eq('id', tenantId)
      .single(),
    supabase
      .from('import_jobs')
      .select(IMPORT_HISTORY_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(IMPORT_HISTORY_LIMIT),
    readKsefHistorySyncStatus(supabase, tenantId).catch((error: unknown) => {
      console.error('[import-danych] stan historii KSeF:', error instanceof Error ? error.name : 'błąd');
      return { ok: false } as const;
    }),
  ]);

  if (history.error) console.error('[import-danych] historia importów:', history.error.message);

  return (
    <ImportCenter
      tenantId={tenantId}
      tenantName={tenant?.name}
      nip={tenant?.nip}
      hasCertificate={!!tenant?.has_ksef_credentials}
      certificateConfirmed={hasConfiguredKsefProof(tenant?.ksef_verified_at, tenant?.ksef_verified_environment)}
      jobs={history.error ? null : (history.data ?? [])}
      ksefHistory={ksefHistory.ok ? ksefHistory.status : null}
      isOwner={role === 'owner'}
      pauseError={pauseError}
    />
  );
}
