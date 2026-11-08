// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-005 (audyt bloku 1): wybór faktury do korekty.
 *
 * Do tej poprawki strona brała 50 najnowszych przyjętych faktur i 500 korekt
 * firmy. Starszej faktury nie dało się skorygować wcale: nie było jej na
 * liście, a `?parentId=<id>` formularz po cichu ignorował (szukał tylko
 * w tych 50). Przy ponad 500 korektach reguła K4 liczyła się na uciętej
 * liście, więc rodzic z korektą w toku wracał do wyboru.
 *
 * Prawdziwe: strona, jej loader, formularz korekty, `readCompletePages`,
 * `searchOrFilter`. Zastąpione: klient Supabase (baza w pamięci z `count`
 * i `range`), akcje serwera formularza, router i powiadomienia.
 */

const mocks = vi.hoisted(() => ({
  getActiveOrgIdFromCookies: vi.fn(),
  getContext: vi.fn(),
  db: null as null | { from: (table: string) => unknown },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.db }));
vi.mock('@/lib/supabase/active-org', () => ({
  getActiveOrgIdFromCookies: mocks.getActiveOrgIdFromCookies,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/correction-actions', () => ({
  getCorrectionParentContextAction: mocks.getContext,
  saveCorrectionDraftAction: vi.fn(),
  saveAndSendCorrectionAction: vi.fn(),
}));

import NewCorrectionPage from '@/app/(dashboard)/invoices/new/correction/page';
import { openCorrectionMessage } from '@/lib/invoices/correction-parents';
import { memoryClient, type Row } from './helpers/baza-w-pamieci';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
/** Domyślne środowisko testów (vitest.config: KSEF_ENV=test). */
const ENV = 'test';

const seller = {
  nip: '1234567890',
  name: 'Moja Firma',
  address: { addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa', countryCode: 'PL' },
};
const buyer = {
  type: 'b2b' as const,
  idType: 'nip' as const,
  nip: '1234567890',
  name: 'Klient PL',
  address: { addressLine1: 'ul. Klienta 2', addressLine2: '00-002 Warszawa', countryCode: 'PL' },
};

/** Identyfikator rosnący z numerem — baza w pamięci sortuje po jednym kluczu. */
const invoiceId = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const number = (n: number) => `FV/${n}/2026`;

/** Faktura n-ta: im większe n, tym późniejsza data wystawienia. */
function accepted(n: number, patch: Row = {}): Row {
  const day = new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  return {
    id: invoiceId(n),
    tenant_id: TENANT,
    direction: 'outgoing',
    invoice_kind: 'regular',
    ksef_status: 'accepted',
    ksef_environment: ENV,
    ksef_number: `1234567890-${day.replaceAll('-', '')}-0100A0B0C0D0-${String(n).padStart(2, '0')}`,
    internal_number: number(n),
    issue_date: day,
    gross_total: 123,
    buyer_data: { nip: '1234567890', name: 'Klient PL' },
    parent_invoice_id: null,
    ...patch,
  };
}

function correction(id: string, parentN: number, ksefStatus: string): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'outgoing',
    invoice_kind: 'correction',
    ksef_status: ksefStatus,
    ksef_environment: ENV,
    ksef_number: null,
    internal_number: `KOR/${id}`,
    issue_date: '2026-10-01',
    parent_invoice_id: invoiceId(parentN),
  };
}

/** 60 przyjętych faktur: najnowsze 50 to n = 11…60, n = 10 jest 51. od góry. */
function sixtyAccepted(): Row[] {
  return Array.from({ length: 60 }, (_, i) => accepted(i + 1));
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function useDb(invoices: Row[]) {
  mocks.db = memoryClient({ invoices });
}

async function renderPage(params: { parentId?: string; q?: string } = {}): Promise<HTMLDivElement> {
  const element = (await NewCorrectionPage({ searchParams: Promise.resolve(params) })) as ReactElement;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  // Kontekst faktury pierwotnej przychodzi asynchronicznie z akcji.
  await act(async () => {});
  return host;
}

/** Numery faktur w tabeli wyboru (pierwsza kolumna). */
function pickerNumbers(el: HTMLElement): string[] {
  return [...el.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveOrgIdFromCookies.mockResolvedValue(TENANT);
  mocks.getContext.mockImplementation(async (parentId: string) => ({
    success: true,
    issueDate: '2026-01-11',
    internalNumber: parentId,
    ksefNumber: 'ksef',
    grossTotal: 123,
    seller,
    buyer,
    npIiAllowed: false,
    allowedCorrectionTypes: 'all',
    linesBefore: [{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    linesAfter: [{ name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('F-005: faktura spoza 50 najnowszych', () => {
  it('parentId 51. faktury od góry otwiera jej korektę (do poprawki: lista wyboru bez niej)', async () => {
    useDb(sixtyAccepted());

    const el = await renderPage({ parentId: invoiceId(10) });

    expect(mocks.getContext).toHaveBeenCalledWith(invoiceId(10));
    expect(el.querySelector('h1')?.textContent).toBe(`Korekta faktury ${number(10)}`);
  });

  it('bez parentId lista ma 50 najnowszych i mówi, jak znaleźć starszą', async () => {
    useDb(sixtyAccepted());

    const el = await renderPage();

    const numbers = pickerNumbers(el);
    expect(numbers).toHaveLength(50);
    expect(numbers[0]).toBe(number(60));
    expect(numbers).not.toContain(number(10));
    expect(el.textContent).toContain('Pokazujemy 50 najnowszych przyjętych faktur');
  });

  it('wyszukiwanie po numerze znajduje fakturę starszą niż 50 najnowszych', async () => {
    useDb(sixtyAccepted());

    const el = await renderPage({ q: number(3) });

    expect(pickerNumbers(el)).toEqual([number(3)]);
    expect(el.querySelector<HTMLInputElement>('input[name="q"]')?.value).toBe(number(3));
  });

  it('wyszukiwanie bez wyników mówi o frazie, nie o braku faktur', async () => {
    useDb(sixtyAccepted());

    const el = await renderPage({ q: 'FV/999/2026' });

    expect(pickerNumbers(el)).toEqual([]);
    expect(el.textContent).toContain('Brak przyjętych faktur pasujących do „FV/999/2026”');
    expect(el.textContent).not.toContain('Nie masz jeszcze żadnych zaakceptowanych faktur');
  });
});

describe('F-005: parentId, którego nie da się skorygować — komunikat zamiast cichego powrotu do listy', () => {
  function refusal(el: HTMLElement): string {
    return el.querySelector('[role="alert"]')?.textContent ?? '';
  }

  it('faktura w kolejce do KSeF: nazwa faktury i co zrobić', async () => {
    useDb([...sixtyAccepted(), accepted(61, { internal_number: 'FV/Q/2026', ksef_status: 'queued', ksef_number: null })]);

    const el = await renderPage({ parentId: invoiceId(61) });

    expect(mocks.getContext).not.toHaveBeenCalled();
    expect(refusal(el)).toContain('Faktura FV/Q/2026 nie jest przyjęta w KSeF (w kolejce do KSeF)');
    expect(refusal(el)).toContain('gdy KSeF ją przyjmie');
    expect(pickerNumbers(el)).not.toContain('FV/Q/2026');
  });

  it('szkic: zamiast korekty popraw szkic', async () => {
    useDb([accepted(1, { internal_number: 'FV/S/2026', ksef_status: 'draft', ksef_number: null })]);

    const el = await renderPage({ parentId: invoiceId(1) });

    expect(refusal(el)).toContain('Faktura FV/S/2026 to szkic');
  });

  it('faktura z innego środowiska KSeF', async () => {
    useDb([accepted(1, { ksef_environment: 'production' })]);

    const el = await renderPage({ parentId: invoiceId(1) });

    expect(refusal(el)).toContain(`Faktura ${number(1)} nie ma numeru KSeF w bieżącym środowisku`);
  });

  it('korekta wskazana jako rodzic: wskaż fakturę pierwotną', async () => {
    useDb([...sixtyAccepted(), correction(invoiceId(70), 1, 'accepted')]);

    const el = await renderPage({ parentId: invoiceId(70) });

    expect(refusal(el)).toContain(`Faktury KOR/${invoiceId(70)} nie skorygujesz tym formularzem`);
    expect(refusal(el)).toContain('wskaż fakturę pierwotną');
  });

  it('faktura innej firmy albo zły identyfikator: „nie znaleźliśmy”', async () => {
    useDb([accepted(1, { tenant_id: OTHER_TENANT })]);

    for (const parentId of [invoiceId(1), 'nie-uuid']) {
      const el = await renderPage({ parentId });
      expect(refusal(el)).toContain('Nie znaleźliśmy faktury wskazanej do korekty');
      act(() => root?.unmount());
      host?.remove();
    }
    root = null;
    host = null;
  });

  it('K4: najnowsza faktura z korektą w toku — komunikat K4 z numerem korekty', async () => {
    useDb([...sixtyAccepted(), correction('kor-open', 60, 'failed')]);

    const el = await renderPage({ parentId: invoiceId(60) });

    expect(mocks.getContext).not.toHaveBeenCalled();
    expect(refusal(el)).toBe(openCorrectionMessage(number(60), { internal_number: 'KOR/kor-open', ksef_status: 'failed' }));
    expect(pickerNumbers(el)).not.toContain(number(60));
  });

  it('K4: stara faktura (spoza 50) z korektą w toku — ten sam komunikat', async () => {
    useDb([...sixtyAccepted(), correction('kor-open', 10, 'queued')]);

    const el = await renderPage({ parentId: invoiceId(10) });

    expect(refusal(el)).toBe(openCorrectionMessage(number(10), { internal_number: 'KOR/kor-open', ksef_status: 'queued' }));
  });
});

describe('F-005: ponad 500 korekt w firmie', () => {
  it('rodzic z korektą w toku nie wraca na listę, gdy jego korekta jest 601. w firmie (do poprawki: limit 500)', async () => {
    // 600 przyjętych korekt (nie blokują) do faktur z listy, korekta w toku na końcu.
    const many = Array.from({ length: 600 }, (_, i) =>
      correction(`kor-${String(i).padStart(4, '0')}`, 11 + (i % 50), 'accepted'));
    useDb([...sixtyAccepted(), ...many, correction('kor-open', 60, 'sending')]);

    const el = await renderPage();

    const numbers = pickerNumbers(el);
    expect(numbers).not.toContain(number(60));
    expect(numbers).toContain(number(59));
    expect(numbers).toHaveLength(49);
  });
});
