// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sesja 4 planu skalowania (HOR-V1, LIM-08): import CSV szedł przez Server
 * Action, która przyjmuje najwyżej 1 MiB (domyślny limit Next), więc okno
 * zatrzymywało plik ponad 1 MB przed wysłaniem.
 *
 * Sesja 31 (decyzja Bartosza 03.11, wariant b): plik idzie trasą
 * `/api/uploads/import` z własnym limitem 10 MB, bez globalnego
 * `bodySizeLimit`. Okno sprawdza ten sam limit przed wysłaniem, po polsku,
 * a odmowa trasy (limit wgrań, sesja) wraca jako jej komunikat.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const server = vi.hoisted(() => ({
  respond: vi.fn<(form: FormData) => Promise<Response>>(),
  requests: [] as Array<{ url: string; init: RequestInit }>,
}));
vi.mock('sonner', () => ({ toast }));

import { FileImportDialog } from '@/components/onboarding/file-import-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB_ID = '22222222-2222-4222-8222-222222222222';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const assign = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server.requests = [];
  server.respond.mockResolvedValue(Response.json({ success: true, importJobId: JOB_ID }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      server.requests.push({ url, init });
      return server.respond(init.body as FormData);
    }),
  );
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, configurable: true });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<FileImportDialog source="fakturownia_csv" tenantId="org-1" onClose={() => {}} />);
  });
}

async function chooseAndStart(file: File) {
  await open();
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const start = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Rozpocznij import'))!;
  await act(async () => {
    start.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const csv = (size: number) => new File([new Uint8Array(size)], 'faktury-2025.csv', { type: 'text/csv' });

function onlyToast(): string {
  expect(toast.error).toHaveBeenCalledOnce();
  return String(toast.error.mock.calls[0]![0]);
}

function sentForm(): FormData {
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]).toMatchObject({ url: '/api/uploads/import', init: { method: 'POST' } });
  return server.requests[0]!.init.body as FormData;
}

describe('FileImportDialog — limit wgrywania pliku', () => {
  it('CSV 3 MB idzie trasą wgrywania z polami źródła i firmy, potem strona postępu', async () => {
    const file = csv(3_000_000);
    await chooseAndStart(file);

    const form = sentForm();
    expect(form.get('file')).toBe(file);
    expect(form.get('source')).toBe('fakturownia_csv');
    expect(form.get('tenantId')).toBe('org-1');
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Import rozpoczęty');
    expect(assign).toHaveBeenCalledWith(`/onboarding/progress/${JOB_ID}`);
  });

  it('CSV 10,5 MB → komunikat o limicie 10 MB, bez wysyłki', async () => {
    await chooseAndStart(csv(10_500_000));

    expect(server.requests).toEqual([]);
    const message = onlyToast();
    expect(message).toContain('Plik ma 10,5 MB');
    expect(message).toContain('najwyżej 10 MB');
    // Wybrany plik pokazany w tych samych jednostkach co komunikat.
    expect(document.body.textContent).toContain('10,5 MB');
  });

  it('CSV dokładnie 10 MB idzie', async () => {
    await chooseAndStart(csv(10_000_000));

    expect(sentForm().get('file')).toBeInstanceOf(File);
  });

  it('podpis pola podaje limit trasy: max 10 MB', async () => {
    await open();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Kliknij aby wybrać plik');
    expect(text).toContain('max 10 MB');
    expect(text).not.toContain('max 1 MB');
  });

  it('odmowa trasy z komunikatem → ten komunikat, bez przejścia', async () => {
    server.respond.mockResolvedValue(Response.json({ success: false, error: 'Plik nie wygląda na eksport z Fakturowni.' }, { status: 400 }));
    await chooseAndStart(csv(300 * 1024));

    expect(onlyToast()).toBe('Plik nie wygląda na eksport z Fakturowni.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('sieć zawodzi → polski komunikat zamiast tekstu przeglądarki', async () => {
    server.respond.mockRejectedValue(new TypeError('Failed to fetch'));
    await chooseAndStart(csv(300 * 1024));

    const message = onlyToast();
    expect(message).not.toContain('Failed to fetch');
    expect(message).toMatch(/Nie udało się wysłać/);
  });

  it('odpowiedź bez JSON (np. 502 bramki) → polski komunikat', async () => {
    server.respond.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
    await chooseAndStart(csv(300 * 1024));

    const message = onlyToast();
    expect(message).toMatch(/Nie udało się wysłać/);
    expect(assign).not.toHaveBeenCalled();
  });

  it('sukces bez identyfikatora zadania → błąd zamiast przejścia na /onboarding/progress/undefined', async () => {
    server.respond.mockResolvedValue(Response.json({ success: true }));
    await chooseAndStart(csv(300 * 1024));

    expect(onlyToast()).toMatch(/Nie udało się wysłać/);
    expect(assign).not.toHaveBeenCalled();
  });
});
