import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: ctx.get }));
vi.mock('@/lib/ksef/history-sync/status', () => ({ readKsefHistorySyncStatus: ctx.read }));
// Okno importu z pliku i wstrzymanie historii wołają akcje serwera — tu tylko render.
vi.mock('@/app/actions/import-danych', () => ({ startFileImportAction: vi.fn(), setKsefHistoryPausedAction: vi.fn() }));

import ImportDanychPage from '@/app/(dashboard)/import-danych/page';
import { ImportCenter } from '@/components/import-danych/import-center';
import {
  completedSummary,
  failureNote,
  FILE_SOURCES,
  formatIsoDay,
  formatWarsawDay,
  IMPORT_HISTORY_LIMIT,
  importProgressHref,
  isRunning,
  jobStatusGroup,
  progressPercent,
  sourceDetail,
  sourceLabel,
  statusGroup,
  summarizeImports,
  warningCount,
  type ImportHistoryJob,
} from '@/components/import-danych/import-model';

/**
 * Centrum importu `/import-danych` (poprawka Bartosza 22.10.2026: import
 * danych w stylu Finory): kafle z liczbami, karta „Historia z KSeF”, karty
 * „Przeprowadzka z innego programu” i historia importów w karcie do stopki.
 *
 * Decyzja Bartosza 22.10.2026 — świadome zmiany oczekiwań: Magiczny import
 * znika (bez karty KSeF i bez adresu `/onboarding/magic-import`), z pliku
 * zostają cztery programy (bez „Inny program (JPK_FA)”), dawny ręczny import
 * z KSeF to „Import z KSeF (ręczny)”, a taki, który utknął „w toku”, jest
 * przerwany. Kafle rozdzielają KSeF od plików (osobny test:
 * `import-danych-ksef-historia.test.tsx`).
 */

const KSEF_WAITING = {
  environment: 'test' as const,
  outgoing: ksefStream('outgoing'),
  incoming: ksefStream('incoming'),
  rateLimitedUntil: null,
  clientPausedAt: null,
  error: null,
  blocked: [],
  blockedTotal: 0,
  deferred: [],
  deferredTotal: 0,
  periodsChangedAfterExport: [],
};

function ksefStream(direction: 'outgoing' | 'incoming') {
  return {
    direction,
    phase: 'waiting' as const,
    enabledAt: null,
    historyFloor: '2022-01-01T00:00:00.000Z',
    coveredFrom: null,
    backfillCompletedAt: null,
    capacityReached: false,
    stuck: false,
    lastSuccessAt: null,
    counts: { pending: 0, imported: 0, repaired: 0, skipped: 0, retiredDraft: 0, deferred: 0, blocked: 0 },
    measuredPerHour: null,
    estimatedFinishAt: null,
  };
}

function job(overrides: Partial<ImportHistoryJob> = {}): ImportHistoryJob {
  return {
    id: 'imp-1',
    source: 'ksef_history',
    direction: 'issued',
    date_from: '2026-04-01',
    date_to: '2026-09-30',
    status: 'completed',
    progress_percent: 100,
    progress_message: 'Import zakończony',
    invoices_imported: 0,
    contractors_created: 0,
    contractors_updated: 0,
    products_created: 0,
    warnings: [],
    source_filename: null,
    created_at: '2026-10-01T08:00:00Z',
    completed_at: '2026-10-01T08:01:00Z',
    ...overrides,
  };
}

describe('model widoku importu', () => {
  it('statusy: kroki joba to „w toku”, nieznany status nie udaje sukcesu', () => {
    for (const s of ['pending', 'queued', 'parsing', 'extracting', 'deduplicating', 'inserting']) {
      expect(statusGroup(s)).toBe('running');
    }
    expect(statusGroup('completed')).toBe('completed');
    expect(statusGroup('failed')).toBe('failed');
    expect(statusGroup('cancelled')).toBe('cancelled');
    expect(statusGroup('cos-nowego')).toBe('failed');
  });

  it('źródła: nazwy jak w onboardingu, dawne wiersze czytelne, nieznane i puste nie wywracają listy', () => {
    expect(sourceLabel('ksef_history')).toBe('Import z KSeF (ręczny)');
    expect(sourceLabel('fakturownia_csv')).toBe('Fakturownia');
    // „Inny program (JPK_FA)” zniknął z ekranu, dawne wiersze zostają podpisane.
    expect(sourceLabel('jpk_fa')).toBe('Plik JPK_FA');
    expect(sourceLabel(null)).toBe('Import');
    expect(sourceLabel('xyz')).toBe('Import');
    expect(FILE_SOURCES.map((s) => s.id)).toEqual(['fakturownia_csv', 'infakt_csv', 'wfirma_csv', 'ifirma_csv']);
  });

  it('dawny ręczny import z KSeF „w toku” jest przerwany: bez odpytywania, bez udawanego postępu', () => {
    const legacy = job({ status: 'extracting', completed_at: null });
    expect(statusGroup(legacy.status)).toBe('running');
    expect(jobStatusGroup(legacy)).toBe('cancelled');
    expect(isRunning(legacy)).toBe(false);
    // Import z pliku w toku dalej jest w toku.
    expect(isRunning(job({ source: 'infakt_csv', status: 'parsing' }))).toBe(true);
    // Zakończony dawny import zostaje zakończony.
    expect(jobStatusGroup(job())).toBe('completed');
  });

  it('podpis źródła: nazwa pliku albo zakres dat KSeF, przy zakupach z kierunkiem', () => {
    expect(sourceDetail(job({ source: 'infakt_csv', source_filename: 'eksport.csv' }))).toBe('eksport.csv');
    expect(sourceDetail(job())).toBe('01.04.2026 – 30.09.2026');
    expect(sourceDetail(job({ direction: 'received' }))).toBe('01.04.2026 – 30.09.2026 · otrzymane');
    expect(sourceDetail(job({ date_from: null, date_to: null }))).toBeNull();
  });

  it('wynik zakończonego importu po polsku; same zera to „Brak nowych faktur”', () => {
    expect(completedSummary(job({ invoices_imported: 1 }))).toBe('1 faktura');
    expect(
      completedSummary(job({ invoices_imported: 22, contractors_created: 2, contractors_updated: 1, products_created: 5 })),
    ).toBe('22 faktury · 3 kontrahenci · 5 produktów');
    expect(completedSummary(job({ invoices_imported: 124, contractors_created: 18, products_created: 1 }))).toBe(
      '124 faktury · 18 kontrahentów · 1 produkt',
    );
    expect(completedSummary(job())).toBe('Brak nowych faktur');
    expect(completedSummary(job({ invoices_imported: null, contractors_created: null }))).toBe('Brak nowych faktur');
  });

  it('błąd: powód z joba albo ogólny, plus to, co mimo błędu zapisano', () => {
    expect(failureNote(job({ status: 'failed', progress_message: 'Zawęź zakres dat i ponów import.' }))).toEqual({
      reason: 'Zawęź zakres dat i ponów import.',
      saved: null,
    });
    expect(failureNote(job({ status: 'failed', progress_message: '  ', invoices_imported: 1 }))).toEqual({
      reason: 'Import się nie udał.',
      saved: 'Zapisano 1 fakturę',
    });
    expect(failureNote(job({ status: 'failed', progress_message: null, invoices_imported: 37 })).saved).toBe('Zapisano 37 faktur');
  });

  it('sumy kafli: faktury też z częściowo nieudanych, kontrahenci i produkty tylko nowi', () => {
    const jobs = [
      job({ id: 'a', status: 'extracting', completed_at: null }),
      job({ id: 'b', invoices_imported: 10, contractors_created: 2, contractors_updated: 7, products_created: 4 }),
      job({ id: 'c', status: 'failed', invoices_imported: 5 }),
      job({ id: 'd', source: 'fakturownia_csv', invoices_imported: 3, contractors_created: 1, products_created: 1 }),
    ];
    const summary = summarizeImports(jobs);
    expect(summary).toMatchObject({ invoices: 18, contractors: 3, products: 5, partial: false });
    // Decyzja Bartosza 22.10.2026: pliki osobno, dawny ręczny import z KSeF osobno (wg kierunku).
    expect(summary).toMatchObject({ fileInvoices: 3, fileContractors: 1, legacyKsefIssued: 15, legacyKsefReceived: 0 });
    // Najnowszy ZAKOŃCZONY — nie ten w toku ani nieudany.
    expect(summary.lastCompleted?.id).toBe('b');
    expect(summarizeImports([job({ status: 'failed' })]).lastCompleted).toBeNull();
    // Pełna lista (limit zapytania) — kafle mówią, że to suma z ostatnich importów.
    expect(summarizeImports(Array.from({ length: IMPORT_HISTORY_LIMIT }, (_, i) => job({ id: `j${i}` }))).partial).toBe(true);
  });

  it('pomocnicze: procent w granicach, daty po polsku w czasie warszawskim, ostrzeżenia tylko tekstowe', () => {
    expect(progressPercent({ progress_percent: 45.4 })).toBe(45);
    expect(progressPercent({ progress_percent: 140 })).toBe(100);
    expect(progressPercent({ progress_percent: -3 })).toBe(0);
    expect(formatIsoDay('2026-04-01')).toBe('01.04.2026');
    expect(formatIsoDay('zle')).toBe('zle');
    // 22:30 UTC 12.10 to już 13.10 w Polsce (CEST).
    expect(formatWarsawDay('2026-10-12T22:30:00Z')).toBe('13.10.2026');
    expect(warningCount(job({ warnings: ['a', 2, 'b', null] }))).toBe(2);
    expect(warningCount(job({ warnings: {} }))).toBe(0);
  });

  it('adres istniejącej ścieżki: postęp joba', () => {
    expect(importProgressHref('imp-1')).toBe('/onboarding/progress/imp-1');
  });
});

describe('ekran Centrum importu', () => {
  const props = {
    tenantId: 'org-1',
    tenantName: 'Firma',
    nip: '1234567890',
    hasCertificate: true,
    certificateConfirmed: true,
    ksefHistory: KSEF_WAITING,
    isOwner: true,
  };

  it('z historią: kafle z sumami, historia ze statusami i linkami do szczegółów, karta do stopki', () => {
    const html = renderToStaticMarkup(
      <ImportCenter
        {...props}
        jobs={[
          job({ id: 'run-1', source: 'fakturownia_csv', source_filename: 'eksport.csv', status: 'extracting', progress_percent: 45, completed_at: null }),
          job({ id: 'ok-1', source: 'infakt_csv', source_filename: 'infakt.csv', invoices_imported: 124, contractors_created: 18, products_created: 40, warnings: ['w1', 'w2'] }),
          job({ id: 'err-1', source: 'wfirma_csv', source_filename: 'wfirma.csv', status: 'failed', progress_message: 'Plik nie wygląda na eksport z wFirmy.' }),
          job({ id: 'old-1', status: 'extracting', completed_at: null }),
          // Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): nieudany dawny
          // import z KSeF nie każe „ponowić” importu, którego już nie ma.
          job({ id: 'old-2', status: 'failed', progress_message: 'Lista faktur KSeF jest niepełna. Zawęź zakres dat i ponów import.' }),
        ]}
      />,
    );
    expect(html).toMatch(/^<div class="ff-page-fill flex flex-col gap-6">/);
    expect(html).toContain('<h1 class="text-2xl font-semibold">Import danych</h1>');
    expect(html).toContain('Faktury z KSeF pobieramy automatycznie. Z poprzedniego programu przeniesiesz je plikiem.');
    // Kafle: pliki z `import_jobs`, KSeF ze stanu synchronizacji.
    expect(html).toContain('Zaimportowane z plików');
    expect(html).toContain('>124</h4>');
    expect(html).toContain('>18</h4>');
    expect(html).toContain('Historia z KSeF');
    // Historia.
    expect(html).toContain('Historia importów');
    expect(html).toContain('W toku');
    expect(html).toContain('Pobieranie faktur');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('Gotowe');
    expect(html).toContain('124 faktury · 18 kontrahentów · 40 produktów');
    expect(html).toContain('2 ostrzeżenia');
    expect(html).toContain('Błąd');
    expect(html).toContain('Plik nie wygląda na eksport z wFirmy.');
    expect(html).not.toContain('ponów import');
    expect(html).toContain('href="/onboarding/progress/run-1"');
    expect(html).toContain('href="/onboarding/progress/ok-1"');
    expect(html).toContain('>Postęp<');
    expect(html).toContain('>Szczegóły<');
    // Dawny ręczny import z KSeF „w toku” — przerwany, z notką.
    expect(html).toContain('Import z KSeF (ręczny)');
    expect(html).toContain('Anulowano');
    expect(html).toContain('Przerwany — zastąpiony automatyczną historią z KSeF');
    // Ostatnie dziecko korzenia to karta historii (sięga stopki).
    expect(html).toMatch(/<div data-slot="card"[^>]*class="[^"]*flex-1[^"]*"><div class="flex w-full flex-1 flex-col">/);
  });

  it('przeprowadzka: cztery programy, każdy z nazwą od tytułu karty; karty Magicznego importu nie ma', () => {
    const html = renderToStaticMarkup(<ImportCenter {...props} jobs={[]} />);
    expect(html).toContain('Przeprowadzka z innego programu');
    expect(html).toContain('Jednorazowo: plik CSV z eksportu faktur.');
    for (const name of ['Fakturownia', 'inFakt', 'wFirma', 'iFirma']) {
      expect(html).toContain(`aria-label="${name} — wgraj plik CSV"`);
    }
    expect(html).not.toContain('Inny program');
    expect(html).not.toContain('JPK_FA');
    expect(html).not.toContain('/onboarding/magic-import');
    expect(html).not.toContain('Magiczny');
    expect(html.match(/>Wgraj plik</g)).toHaveLength(4);
    expect(html).toContain('grid grid-cols-2 gap-4 xl:grid-cols-4');
  });

  it('bez certyfikatu: karta „Historia z KSeF” prowadzi do ustawień KSeF, import z pliku zostaje', () => {
    const html = renderToStaticMarkup(<ImportCenter {...props} hasCertificate={false} jobs={[]} />);
    expect(html).toContain('href="/settings/ksef"');
    expect(html).toContain('Wymaga certyfikatu');
    expect(html).not.toContain('/onboarding/magic-import');
    expect(html.match(/>Wgraj plik</g)).toHaveLength(4);
  });

  it('pierwsza wizyta: bez kafli z zerami, pusta historia z trzema krokami', () => {
    const html = renderToStaticMarkup(<ImportCenter {...props} jobs={[]} />);
    expect(html).not.toContain('Zaimportowane z plików');
    expect(html).toContain('Brak importów');
    expect(html).toContain('Wgraj certyfikat KSeF');
    expect(html).toContain('Historię z KSeF pobieramy sami');
    expect(html).toContain('Pliki z innego programu wgrasz tu raz');
  });

  it('historia nie do wczytania: bez kafli (nie znamy liczb), komunikat z „Odśwież”, źródła dalej działają', () => {
    const html = renderToStaticMarkup(<ImportCenter {...props} jobs={null} />);
    expect(html).not.toContain('Zaimportowane z plików');
    expect(html).toContain('Nie udało się wczytać historii');
    expect(html).toMatch(/href="\/import-danych"[^>]*>Odśwież<\/a>/);
    expect(html.match(/>Wgraj plik</g)).toHaveLength(4);
  });
});

describe('strona /import-danych — odczyty', () => {
  type Call = { table: string; select?: string; eq: [string, unknown][]; order?: [string, unknown]; limit?: number };
  let calls: Call[];

  function recordingClient(opts: { tenant: Record<string, unknown>; jobs?: ImportHistoryJob[]; jobsError?: { message: string } }) {
    return {
      from: (table: string) => {
        const call: Call = { table, eq: [] };
        calls.push(call);
        const builder = {
          select: (columns: string) => ((call.select = columns), builder),
          eq: (column: string, value: unknown) => (call.eq.push([column, value]), builder),
          order: (column: string, options: unknown) => ((call.order = [column, options]), builder),
          single: async () => ({ data: opts.tenant, error: null }),
          limit: async (count: number) => {
            call.limit = count;
            return opts.jobsError ? { data: null, error: opts.jobsError } : { data: opts.jobs ?? [], error: null };
          },
        };
        return builder;
      },
    };
  }

  beforeEach(() => {
    calls = [];
    ctx.read.mockReset();
    ctx.read.mockResolvedValue({ ok: true, status: KSEF_WAITING });
  });

  it('flaga certyfikatu i ostatnie importy firmy, od najnowszych, bez ścieżki pliku w magazynie', async () => {
    ctx.get.mockResolvedValue({
      supabase: recordingClient({
        tenant: { name: 'Firma', nip: '1234567890', has_ksef_credentials: true },
        jobs: [job({ source: 'wfirma_csv', source_filename: 'wfirma.csv', invoices_imported: 7 })],
      }),
      tenantId: 'org-1',
      role: 'owner',
    });
    const html = renderToStaticMarkup(await ImportDanychPage({}));

    const tenants = calls.find((c) => c.table === 'tenants');
    // Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): także potwierdzenie
    // certyfikatu — cron pobiera historię tylko z potwierdzeniem dla KSEF_ENV.
    // Nigdy zaszyfrowany blob (AUD-103).
    expect(tenants?.select).toBe('name, nip, has_ksef_credentials, ksef_verified_at, ksef_verified_environment');
    expect(tenants?.select).not.toContain('ksef_credentials_encrypted');
    const history = calls.find((c) => c.table === 'import_jobs');
    expect(history?.eq).toEqual([['tenant_id', 'org-1']]);
    expect(history?.order).toEqual(['created_at', { ascending: false }]);
    expect(history?.limit).toBe(IMPORT_HISTORY_LIMIT);
    expect(history?.select).not.toContain('source_file_path');
    expect(history?.select).not.toContain('triggered_by');

    expect(html).toContain('>7</h4>');
    expect(html).toContain('7 faktur');
  });

  it('błąd odczytu historii nie zabiera startu importu', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      ctx.get.mockResolvedValue({
        supabase: recordingClient({
          tenant: { name: 'Firma', nip: '1234567890', has_ksef_credentials: true },
          jobsError: { message: 'permission denied' },
        }),
        tenantId: 'org-1',
        role: 'owner',
      });
      const html = renderToStaticMarkup(await ImportDanychPage({}));
      expect(html).toContain('Nie udało się wczytać historii');
      expect(html.match(/>Wgraj plik</g)).toHaveLength(4);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
