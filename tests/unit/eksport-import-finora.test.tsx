import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/app/actions/exports', () => ({ startExportAction: vi.fn(), downloadExportFileAction: vi.fn() }));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: ctx.get }));
// Okno importu z pliku i wstrzymanie historii wołają akcje serwera — tu tylko render.
vi.mock('@/app/actions/import-danych', () => ({ startFileImportAction: vi.fn(), setKsefHistoryPausedAction: vi.fn() }));
vi.mock('@/lib/ksef/history-sync/status', () => ({ readKsefHistorySyncStatus: ctx.read }));

import ImportDanychPage from '@/app/(dashboard)/import-danych/page';
import {
  ExportsCenter,
  NewExportForm,
  RecentExports,
  type ManualExportJobWithFiles,
} from '@/components/exports/exports-center';

/**
 * Eksport i Import danych (P13): karty z ikonami w stylu Accounts Finory.
 *
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości) — świadome
 * zmiany oczekiwań: kafelki formatów to grupa radiowa (zaznaczenie widać po
 * atrybutach Base UI, nie po „Wybrany” / `aria-pressed`), pod nazwą jest
 * przeznaczenie pliku („Księga dla księgowej”) zamiast rodzaju („Plik XML”),
 * domyślny jest KPiR, okres w historii czyta się „Wrzesień 2026”, a pola
 * wyboru są tylko tam, gdzie zmieniają plik (CSV). Sens bez zmian: formaty,
 * „Wygeneruj plik”, historia z „Pobierz” i powodem błędu.
 */

function job(overrides: Partial<ManualExportJobWithFiles> = {}): ManualExportJobWithFiles {
  return {
    id: 'job-1', tenant_id: 't', format: 'jpk_fa', status: 'completed', period_start: '2026-09-01',
    period_end: '2026-09-30', invoices_count: 12, error_message: null, trigger_source: 'manual',
    export_files: [{ id: 'f1', filename: 'jpk.xml', format: 'jpk_fa', size_bytes: 10, download_count: 0 }],
    ...overrides,
  } as ManualExportJobWithFiles;
}

/** Atrybuty `<span role="radio">` Base UI z SSR, po kolei. */
const radios = (html: string) => [...html.matchAll(/<span([^>]*role="radio"[^>]*)>/g)].map(([, attrs]) => attrs!);

describe('Eksport — karty formatów w stylu Accounts', () => {
  const html = renderToStaticMarkup(<ExportsCenter recentJobs={[job()]} currentMonth="2026-10" />);
  // Formularz stoi przed kartą z zakładkami, historia w niej. Wiersz historii (wrzesień)
  // i domyślny okres formularza (też wrzesień) mają te same napisy — bez podziału
  // sprawdzenie jednego przechodziłoby dzięki drugiemu.
  // Rząd zakładek Księgowości stoi od 25.10.2026 w `reports/layout.tsx`;
  // kartę historii poznajemy po `id`.
  const nav = html.indexOf('id="historia"');
  const form = html.slice(0, nav);
  const history = html.slice(nav);

  it('nagłówek, kafelki formatów z przeznaczeniem pliku i zaznaczonym KPiR', () => {
    expect(html).toContain('<h1 class="sr-only">Eksport danych księgowych</h1>');
    expect(html).toContain('JPK_FA(4)');
    expect(html).toContain('KPiR Excel');
    expect(html).toContain('CSV uniwersalny');
    expect(html).toContain('Księga dla księgowej');
    expect(html).toContain('Urząd, Symfonia, Wapro');
    expect(html).toContain('Optima, Subiekt i inne programy');
    expect(html).toContain('Wygeneruj plik');

    // Grupa „Format pliku”: dokładnie jedno radio zaznaczone — to przy KPiR.
    expect(html).toContain('role="radiogroup" data-slot="radio-group" aria-label="Format pliku"');
    const formatGroup = html.slice(html.indexOf('aria-label="Format pliku"'), html.indexOf('aria-label="Rodzaj okresu"'));
    const checked = radios(formatGroup).filter((attrs) => attrs.includes('aria-checked="true"'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('data-checked=""');
    const kpirTile = /<input type="radio" id="[^"]*" [^>]*checked="" value="kpir_excel"\/>/.exec(formatGroup);
    expect(kpirTile).not.toBeNull();
    expect(radios(formatGroup).filter((attrs) => attrs.includes('data-unchecked=""'))).toHaveLength(2);

    // Domyślny okres: poprzedni miesiąc, czytelnie — w samym formularzu.
    expect(nav).toBeGreaterThan(0);
    expect(form).toContain('Wrzesień 2026');
    expect(form).toContain('01.09.2026 – 30.09.2026');
    expect(form).not.toContain('Październik 2026');

    // Dawny wygląd przycisków-kart zniknął.
    expect(html).not.toContain('Wybrany');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('Plik XML');
    expect(html).not.toContain('Arkusz Excel');
  });

  it('pola wyboru tylko przy CSV (przy KPiR zakres jest stały)', () => {
    expect(html).not.toContain('role="checkbox"');
    const csv = renderToStaticMarkup(<NewExportForm initialFormat="csv_universal" currentMonth="2026-10" />);
    expect(csv.match(/role="checkbox"/g)).toHaveLength(3);
    expect(csv).toContain('Faktury wystawione');
    expect(csv).toContain('Faktury otrzymane');
  });

  it('historia: okres, liczba faktur, status i „Pobierz” przy gotowym pliku', () => {
    expect(history).toContain('Wrzesień 2026');
    expect(history).toContain('title="01.09.2026 – 30.09.2026"');
    expect(history).toContain('12 faktur');
    expect(history).toContain('Gotowe');
    expect(history).toContain('Pobierz');
    expect(html).not.toContain('01.09.2026 — 30.09.2026');
  });

  it('okres „Inny” odwrócony: oba pola dat wskazują komunikat o błędzie (aria-describedby)', () => {
    // Samo aria-invalid dawało czytnikowi „nieprawidłowe” bez powodu; powód był tylko
    // pod wyłączonym przyciskiem, do którego klawiaturą się nie dojdzie.
    const reversed = renderToStaticMarkup(
      <NewExportForm currentMonth="2026-10" initialPeriod={{ mode: 'custom', from: '2026-09-30', to: '2026-09-01' }} />,
    );
    const error = /<p id="([^"]+)"[^>]*>Koniec okresu jest przed początkiem\.<\/p>/.exec(reversed);
    expect(error, 'komunikat bez id').not.toBeNull();
    const dates = [...reversed.matchAll(/<input[^>]*type="date"[^>]*>/g)].map(([tag]) => tag);
    expect(dates).toHaveLength(2);
    for (const tag of dates) {
      expect(tag).toContain('aria-invalid="true"');
      expect(tag).toContain(`aria-describedby="${error![1]}"`);
    }

    // Puste pole: odsyłacz do linii „Wybierz obie daty.”, drugie pole bez odsyłacza.
    const blank = renderToStaticMarkup(
      <NewExportForm currentMonth="2026-10" initialPeriod={{ mode: 'custom', from: '', to: '2026-09-15' }} />,
    );
    const hint = /<p id="([^"]+)"[^>]*>Wybierz obie daty\.<\/p>/.exec(blank);
    expect(hint, 'linia zakresu bez id').not.toBeNull();
    const [fromTag, toTag] = [...blank.matchAll(/<input[^>]*type="date"[^>]*>/g)].map(([tag]) => tag);
    expect(fromTag).toContain(`aria-describedby="${hint![1]}"`);
    expect(toTag).not.toContain('aria-describedby');

    // Poprawny zakres: ani błędu, ani odsyłacza.
    const valid = renderToStaticMarkup(
      <NewExportForm currentMonth="2026-10" initialPeriod={{ mode: 'custom', from: '2026-09-01', to: '2026-09-15' }} />,
    );
    expect(valid).not.toContain('Koniec okresu jest przed początkiem.');
    expect(valid).not.toContain('aria-describedby');
  });

  it('bez dawnego wyglądu: szkło, ikony Material', () => {
    expect(html).not.toContain('ff-glass-pane');
    expect(html).not.toContain('material-symbols');
    expect(html).not.toContain('backdrop-blur');
  });

  it('pusta historia, nieudany eksport z powodem i gotowy bez pliku', () => {
    const empty = renderToStaticMarkup(<RecentExports jobs={[]} />);
    expect(empty).toContain('Brak eksportów');
    expect(empty).not.toContain('po lewej');
    const failed = renderToStaticMarkup(<RecentExports jobs={[job({ status: 'failed', error_message: 'JPK wstrzymany: brak urzędu', export_files: [] })]} />);
    expect(failed).toContain('JPK wstrzymany: brak urzędu');
    expect(failed).toContain('Błąd');
    expect(failed).not.toContain('Pobierz');
    const blank = renderToStaticMarkup(<RecentExports jobs={[job({ export_files: [] })]} />);
    expect(blank).toContain('Pusty');
    expect(blank).toContain('Brak dokumentów w tym okresie');
    expect(blank).not.toContain('Gotowe');
    expect(blank).not.toContain('Pobierz');
  });

  it('powłoka: zawartość zakładki, karta historii sięga stopki, zakładki w layoucie', () => {
    expect(html).toMatch(/^<div class="ff-tab-panel flex flex-1 flex-col gap-6"><h1 class="sr-only">/);
    const historyCard = /<div[^>]*id="historia"[^>]*>/.exec(html)?.[0] ?? '';
    expect(historyCard).toContain('data-slot="card"');
    expect(historyCard).toMatch(/class="[^"]*\bflex-1\b/);
    expect(html).not.toContain('<nav aria-label="Księgowość"');
  });
});

/**
 * Klient z dwoma odczytami strony: `tenants` (`.single()`) i ostatnie
 * `import_jobs` (`.order().limit()`). Poprawka Bartosza 22.10.2026 (import
 * danych w stylu Finory): strona czyta też historię importów.
 */
function tenantClient(row: Record<string, unknown> | null, jobs: Record<string, unknown>[] = []) {
  return {
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        single: async () => ({ data: row, error: null }),
        limit: async () => ({ data: table === 'import_jobs' ? jobs : [], error: null }),
      };
      return builder;
    },
  };
}

/**
 * Poprawka Bartosza 22.10.2026 (import danych w stylu Finory) i decyzja
 * Bartosza 22.10.2026 (Magiczny import znika) — świadome zmiany oczekiwań:
 * zamiast karty „Magiczny import z KSeF” jest karta „Historia z KSeF”
 * z plakietką „Automatycznie” (bez certyfikatu „Wymaga certyfikatu”
 * i wyjście do `/settings/ksef` — „Wgraj certyfikat KSeF”). Startu importu
 * z KSeF nie ma wcale; firma z NIP-em widoczna jak dotąd.
 */
const KSEF_STREAM = {
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
const KSEF_WAITING = {
  environment: 'test' as const,
  outgoing: { ...KSEF_STREAM, direction: 'outgoing' as const },
  incoming: { ...KSEF_STREAM, direction: 'incoming' as const },
  rateLimitedUntil: null,
  clientPausedAt: null,
  error: null,
  blocked: [],
  blockedTotal: 0,
  deferred: [],
  deferredTotal: 0,
  periodsChangedAfterExport: [],
};

describe('Import danych — karty źródeł w stylu Accounts', () => {
  it('z certyfikatem: karta „Historia z KSeF” pobiera automatycznie, bez startu Magicznego importu', async () => {
    ctx.read.mockResolvedValue({ ok: true, status: KSEF_WAITING });
    ctx.get.mockResolvedValue({
      // Certyfikat potwierdzony dla skonfigurowanego środowiska (KSEF_ENV=test) — tylko
      // wtedy cron pobiera historię (poprawka po przeglądzie, decyzja Bartosza 22.10.2026).
      supabase: tenantClient({
        name: 'Firma',
        nip: '1234567890',
        has_ksef_credentials: true,
        ksef_verified_at: '2026-10-01T08:00:00Z',
        ksef_verified_environment: 'test',
      }),
      tenantId: 'org-1',
      role: 'owner',
    });
    const html = renderToStaticMarkup(await ImportDanychPage({}));
    expect(html).toContain('Historia z KSeF');
    expect(html).toContain('Automatycznie');
    expect(html).toContain('Zaczniemy w ciągu 30 minut od wgrania certyfikatu.');
    expect(html).not.toContain('/onboarding/magic-import');
    expect(html).not.toContain('Magiczny');
    expect(html).toContain('NIP <span class="font-mono">1234567890</span>');
  });

  it('bez certyfikatu: plakietka i link do ustawień KSeF, bez startu importu', async () => {
    ctx.read.mockResolvedValue({ ok: true, status: KSEF_WAITING });
    ctx.get.mockResolvedValue({
      supabase: tenantClient({ name: 'Firma', nip: null, has_ksef_credentials: false }),
      tenantId: 'org-1',
      role: 'owner',
    });
    const html = renderToStaticMarkup(await ImportDanychPage({}));
    expect(html).toContain('Wymaga certyfikatu');
    expect(html).toContain('Wgraj certyfikat KSeF');
    expect(html).toContain('href="/settings/ksef"');
    expect(html).not.toContain('/onboarding/magic-import');
    expect(html).not.toContain('ff-glass-pane');
  });
});
