import { prerender } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/app/actions/exports', () => ({ startExportAction: vi.fn(), downloadExportFileAction: vi.fn() }));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: mocks.db(), tenantId: 'firma-a' }),
}));

import ExportsCenterPage from '@/app/(dashboard)/reports/exports/page';
import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * Strona Eksportu na prawdziwej ścieżce (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości). Sprawdza to, czego nie widać w samych
 * komponentach:
 * - błąd odczytu historii daje baner z „Odśwież”, a nie pustą listę
 *   (dawniej błąd ginął i klient myślał, że eksportów nie ma);
 * - urząd skarbowy: brak → JPK_FA zablokowany z wyjściem „Ustaw”; nieudany
 *   odczyt → nie wiemy, więc nic nie blokujemy (niezmiennik 22);
 * - link „Eksport KPiR” (`?period=RRRR-MM&format=kpir_excel`) wypełnia
 *   formularz, przyszłość jest przycinana, domyślnie KPiR za poprzedni
 *   miesiąc (niezmiennik 23).
 *
 * Zegar stoi na listopadzie 2026, żeby domyślny miesiąc (październik) różnił
 * się od miesiąca z linku (wrzesień) — inaczej test linku niczego nie dowodzi.
 */

/** Zapytania do wskazanych tabel kończą się błędem bazy; reszta jak w pamięci. */
function client(tables: MemoryTables, failing: readonly string[] = []) {
  const db = memoryClient(tables);
  type Query = { then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise<unknown> };
  return {
    from(table: string) {
      const query = db.from(table) as unknown as Query;
      if (failing.includes(table)) {
        query.then = (ok, fail) =>
          Promise.resolve({ data: null, error: { message: 'awaria odczytu', code: 'XX000' }, count: null }).then(ok, fail);
      }
      return query;
    },
  };
}

function eksport(o: Row): Row {
  return {
    tenant_id: 'firma-a', format: 'jpk_fa', status: 'completed', trigger_source: 'manual',
    period_start: '2026-09-01', period_end: '2026-09-30', invoices_count: 12, error_message: null,
    progress_message: null, include_issued: true, include_received: false, include_corrections: true,
    created_at: '2026-10-01T08:00:00Z',
    export_files: [{ id: 'f1', filename: 'jpk.xml', format: 'jpk_fa', size_bytes: 2048, download_count: 0 }],
    ...o,
  };
}

const firma = (taxOfficeCode: string | null): Row => ({ id: 'firma-a', tax_office_code: taxOfficeCode });

/** Pełny SSR razem z historią za `Suspense` (prerender czeka na wszystkie granice). */
async function renderPage(searchParams: Record<string, string> = {}) {
  const page = await ExportsCenterPage({ searchParams: Promise.resolve(searchParams) });
  const { prelude } = await prerender(page);
  const html = await new Response(prelude).text();
  // Formularz stoi przed kartą historii. Rząd zakładek Księgowości jest od
  // 25.10.2026 w `reports/layout.tsx`, więc kartę historii poznajemy po `id`.
  const nav = html.indexOf('id="historia"');
  expect(nav).toBeGreaterThan(0);
  expect(html).not.toContain('<nav aria-label="Księgowość"');
  return { form: html.slice(0, nav), history: html.slice(nav) };
}

/** Wartość zaznaczonego kafelka w grupie „Format pliku” (ukryte radio Base UI z `checked`). */
function checkedFormat(form: string): string | undefined {
  const group = form.slice(form.indexOf('aria-label="Format pliku"'), form.indexOf('aria-label="Rodzaj okresu"'));
  return [...group.matchAll(/<input type="radio"[^>]*?checked=""[^>]*?value="([^"]+)"/g)].map(([, value]) => value)[0];
}

/** Atrybut `disabled` (nie klasa `disabled:…` z wariantu przycisku). */
const DISABLED = / disabled=""/;

/** Znacznik przycisku „Wygeneruj plik”. */
function generateButton(form: string): string {
  const tag = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Wygeneruj plik<\/button>/.exec(form)?.[0];
  expect(tag, 'brak przycisku „Wygeneruj plik”').toBeDefined();
  return tag!.slice(0, tag!.indexOf('>') + 1);
}

beforeEach(() => {
  mocks.db.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('strona Eksport — historia', () => {
  it('ręczne eksporty tej firmy, bez cudzych i bez automatycznych', async () => {
    mocks.db.mockReturnValue(client({
      tenants: [firma('1433')],
      export_jobs: [
        eksport({ id: 'moj' }),
        eksport({ id: 'cudzy', tenant_id: 'firma-b', format: 'csv_universal' }),
        eksport({ id: 'auto', trigger_source: 'co_pilot_monthly', format: 'kpir_excel' }),
      ],
    }));
    const { history } = await renderPage();
    expect(history).toContain('JPK_FA(4)');
    expect(history).toContain('12 faktur');
    expect(history).not.toContain('CSV uniwersalny');
    expect(history).not.toContain('KPiR Excel');
    expect(history).not.toContain('Nie udało się wczytać historii');
  });

  it('błąd odczytu: baner „Nie udało się wczytać historii” z „Odśwież”, nie pusta lista', async () => {
    mocks.db.mockReturnValue(client({ tenants: [firma('1433')], export_jobs: [eksport({ id: 'moj' })] }, ['export_jobs']));
    const { history } = await renderPage();
    expect(history).toContain('Nie udało się wczytać historii');
    expect(history).not.toContain('Brak eksportów');
    const link = /<a [^>]*href="\/reports\/exports"[^>]*>Odśwież<\/a>/.exec(history)?.[0];
    expect(link, 'brak linku „Odśwież”').toBeDefined();
    // Obramowanie przycisku „outline”: bez tailwind-merge bazowe `border-transparent`
    // (późniejsze w CSS) przykrywało `border-border` i w jasnym motywie link wyglądał jak goły tekst.
    expect(link).toContain('border-border');
    expect(link).not.toContain('border-transparent');
  });
});

describe('strona Eksport — urząd skarbowy (JPK_FA)', () => {
  it('brak urzędu: JPK_FA zablokowany z powodem i wyjściem „Ustaw”', async () => {
    mocks.db.mockReturnValue(client({ tenants: [firma(null)], export_jobs: [] }));
    const { form } = await renderPage({ format: 'jpk_fa' });
    expect(checkedFormat(form)).toBe('jpk_fa');
    expect(form).toContain('Brak urzędu skarbowego');
    expect(form).toContain('href="/settings/accountant"');
    expect(form).toContain('Najpierw ustaw urząd skarbowy.');
    expect(generateButton(form)).toMatch(DISABLED);
  });

  it('nieudany odczyt urzędu: nie wiemy, więc nic nie blokujemy', async () => {
    mocks.db.mockReturnValue(client({ tenants: [firma(null)], export_jobs: [] }, ['tenants']));
    const { form } = await renderPage({ format: 'jpk_fa' });
    expect(checkedFormat(form)).toBe('jpk_fa');
    expect(form).not.toContain('Brak urzędu skarbowego');
    expect(form).not.toContain('Najpierw ustaw urząd skarbowy.');
    expect(generateButton(form)).not.toMatch(DISABLED);
  });

  it('urząd ustawiony: bez podpowiedzi i bez blokady', async () => {
    mocks.db.mockReturnValue(client({ tenants: [firma('1433')], export_jobs: [] }));
    const { form } = await renderPage({ format: 'jpk_fa' });
    expect(form).not.toContain('Brak urzędu skarbowego');
    expect(generateButton(form)).not.toMatch(DISABLED);
  });
});

describe('strona Eksport — wypełnienie formularza z adresu', () => {
  beforeEach(() => {
    mocks.db.mockReturnValue(client({ tenants: [firma('1433')], export_jobs: [] }));
  });

  it('domyślnie KPiR Excel za poprzedni miesiąc', async () => {
    const { form } = await renderPage();
    expect(checkedFormat(form)).toBe('kpir_excel');
    expect(form).toContain('Październik 2026');
    expect(form).toContain('01.10.2026 – 31.10.2026');
  });

  it('link „Eksport KPiR”: KPiR Excel i wrzesień zamiast domyślnego października', async () => {
    const { form } = await renderPage({ period: '2026-09', format: 'kpir_excel' });
    expect(checkedFormat(form)).toBe('kpir_excel');
    expect(form).toContain('Wrzesień 2026');
    expect(form).toContain('01.09.2026 – 30.09.2026');
    expect(form).not.toContain('Październik 2026');
  });

  it('format i kwartał z adresu naprawy (`od`/`do`)', async () => {
    const { form } = await renderPage({ od: '2026-07-01', do: '2026-09-30', format: 'csv_universal' });
    expect(checkedFormat(form)).toBe('csv_universal');
    expect(form).toContain('III kw. 2026');
    expect(form).toContain('01.07.2026 – 30.09.2026');
  });

  it('miesiąc z przyszłości przycięty do bieżącego, śmieci pominięte', async () => {
    const future = await renderPage({ period: '2027-03', format: 'kpir_excel' });
    expect(future.form).toContain('Listopad 2026');
    expect(future.form).not.toContain('2027');

    const junk = await renderPage({ period: '2026-13', format: 'jpk_v7m' });
    expect(checkedFormat(junk.form)).toBe('kpir_excel');
    expect(junk.form).toContain('Październik 2026');
  });
});
