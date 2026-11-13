import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan skalowania, sesja 11 (REQ-08, CAC-V01): lekkie akcje statusu dla
 * odpytywania historii eksportów, importów i archiwum dokumentów. Zamiast
 * pełnego `router.refresh()` co takt przeglądarka pyta o same statusy.
 *
 * - Klient z sesji użytkownika (RLS z aktywną firmą z nagłówka
 *   `x-active-org`, archiwum tylko owner/admin), nie service_role.
 * - Odpowiedź to tylko `id` i `status`, nawet gdy baza odda więcej.
 * - Identyfikatory przychodzą z przeglądarki: lista 1–100 UUID, sprawdzona
 *   przed zapytaniem; zła lista to odmowa bez zapytania do bazy.
 * - Błąd bazy jest chwilowy (UI pyta dalej) i bez treści: do logu sam kod.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  in: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

import {
  getDocumentArchiveStatusesAction,
  getExportJobStatusesAction,
  getImportJobStatusesAction,
} from '@/app/actions/job-statuses';
import { STATUS_IDS_MAX } from '@/lib/polling/read-statuses';

const A = '0190aaaa-0000-4000-8000-000000000001';
const B = '0190aaaa-0000-4000-8000-000000000002';
const uuid = (i: number) => `0190aaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.createClient.mockReset().mockResolvedValue({ from: mocks.from });
  mocks.from.mockReset().mockReturnValue({ select: mocks.select });
  mocks.select.mockReset().mockReturnValue({ in: mocks.in });
  mocks.in.mockReset().mockResolvedValue({ data: [], error: null });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('Akcje statusu — odczyt', () => {
  it.each([
    ['eksporty', getExportJobStatusesAction, 'export_jobs'],
    ['importy', getImportJobStatusesAction, 'import_jobs'],
    ['archiwum dokumentów', getDocumentArchiveStatusesAction, 'document_archives'],
  ] as const)('%s: klient z sesji użytkownika, tylko id i status zadań z listy', async (_, action, table) => {
    mocks.in.mockResolvedValue({
      data: [{ id: A, status: 'generating', error_message: 'nie dla przeglądarki' }],
      error: null,
    });

    const result = await action([A, B]);

    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.from).toHaveBeenCalledWith(table);
    expect(mocks.select).toHaveBeenCalledWith('id, status');
    expect(mocks.in).toHaveBeenCalledWith('id', [A, B]);
    // Zadania B nie ma w odpowiedzi (np. usunięte albo spoza firmy): przeglądarka uzna to za zmianę.
    expect(result).toEqual({ success: true, statuses: [{ id: A, status: 'generating' }] });
  });

  it('powtórzone id idzie do bazy raz', async () => {
    await getExportJobStatusesAction([A, A, B]);
    expect(mocks.in).toHaveBeenCalledWith('id', [A, B]);
  });

  it(`${STATUS_IDS_MAX} różnych id przechodzi`, async () => {
    const ids = Array.from({ length: STATUS_IDS_MAX }, (_, i) => uuid(i));
    const result = await getImportJobStatusesAction(ids);
    expect(result).toEqual({ success: true, statuses: [] });
    expect(mocks.in).toHaveBeenCalledWith('id', ids);
  });
});

describe('Akcje statusu — identyfikatory z przeglądarki', () => {
  it.each([
    ['nie lista', 'abc'],
    ['brak', undefined],
    ['pusta lista', []],
    ['nie UUID', [A, 'job-1']],
    ['liczba zamiast id', [1]],
    ['za dużo id', Array.from({ length: STATUS_IDS_MAX + 1 }, (_, i) => uuid(i))],
  ])('%s → odmowa bez zapytania do bazy', async (_, ids) => {
    const result = await getExportJobStatusesAction(ids);
    expect(result).toEqual({ success: false, retryable: false });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe('Akcje statusu — błąd bazy', () => {
  it('chwilowy, bez treści błędu dla przeglądarki; w logu sam kod', async () => {
    mocks.in.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout', details: 'export_jobs' },
    });

    const result = await getExportJobStatusesAction([A]);

    expect(result).toEqual({ success: false, retryable: true });
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).toContain('57014');
    expect(logged).not.toContain('canceling statement');
  });

  it.each([
    ['42501', 'permission denied for table export_jobs'],
    ['PGRST301', 'No suitable key or wrong key type'],
    // PostgREST 13+ (produkcja: 14) zgłasza wygasły token jako PGRST303.
    ['PGRST303', 'JWT expired'],
  ])('brak dostępu (%s: rola anon, zły albo wygasły token) to nie chwilowy błąd', async (code, message) => {
    mocks.in.mockResolvedValue({ data: null, error: { code, message } });

    const result = await getExportJobStatusesAction([A]);

    // Przeglądarka odświeży stronę raz (bramka logowania) i przestanie pytać.
    expect(result).toEqual({ success: false, retryable: false });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(message);
  });

  it('odrzucone zapytanie (sieć do bazy) też jest chwilowe', async () => {
    mocks.in.mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED 10.0.0.5:5432'));

    const result = await getDocumentArchiveStatusesAction([A]);

    expect(result).toEqual({ success: false, retryable: true });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('ECONNREFUSED');
  });
});
