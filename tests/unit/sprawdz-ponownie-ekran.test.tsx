// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR D (stos na #248): przycisk „Sprawdź ponownie” na karcie
 * faktury w `failed / KSEF_DUPLICATE_RECONCILE`, gdy brakuje danych
 * oryginału. Do PR D karta pokazywała dla tych powodów samą notę („sprawdzimy
 * ponownie automatycznie, zwykle w ciągu 2 dni”) i klient nie miał jak
 * przyspieszyć sprawdzenia.
 *
 * Widok liczy serwer (`duplicateRecheckView`) i przekazuje karcie w
 * `ksef_duplicate_recheck`; komponent nie liczy polityki, tylko ją pokazuje:
 * numer KSeF, „numer nadany {dzień}”, wskazówkę o uprawnieniu InvoiceRead
 * (tylko przy 403), przycisk (właściciel/administrator, `useTransition` + toast
 * jak przyciski sąsiednie), „Nie wystawiaj tej faktury ponownie.”; dla członka
 * firmy dane tylko do odczytu i prośba o właściciela.
 *
 * Prawdziwe: `InvoiceDetailView`, `KsefDuplicateRecheck`, `describeDuplicateOriginal`.
 * Zastąpione: akcje serwerowe, Realtime, `next/navigation`, `sonner`, panel
 * decyzji, pasek akcji, karta błędu.
 */

const m = vi.hoisted(() => ({
  recheck: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch = { on: () => ch, subscribe: () => ch };
    return { channel: () => ch, removeChannel: vi.fn() };
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: m.toastError } }));
vi.mock('@/components/invoices/actions-detail', () => ({
  recheckKsefDuplicateAction: m.recheck,
  decideKsefDuplicateAction: vi.fn(),
  downloadInvoiceXmlAction: vi.fn(),
  resendInvoiceAction: vi.fn(),
  resetInvoiceToDraftAction: vi.fn(),
  emailInvoiceAction: vi.fn(),
}));
vi.mock('@/components/invoices/invoice-actions', () => ({ InvoiceActions: () => null }));
vi.mock('@/components/invoices/upo-download', () => ({ UpoDownload: () => null }));
vi.mock('@/components/invoices/error-display', () => ({
  InvoiceErrorDisplay: ({ errorMessage }: { errorMessage: string }) => <div data-testid="karta-bledu">{errorMessage}</div>,
}));
vi.mock('@/components/invoices/ksef-duplicate-decision', () => ({
  KsefDuplicateDecision: () => <div data-testid="panel-decyzji">panel decyzji</div>,
}));

import { InvoiceDetailView, type InvoiceDetailInitial } from '@/components/invoices/invoice-detail-view';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { describeDuplicateOriginal, parseDuplicateCheck } from '@/lib/ksef/duplicate-check';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';

import { K, decidableView, duplicateCheck } from './helpers/decyzja-klienta';

const NR = 'FV/12/10/2026';
const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
const TEXTS = () => DUPLICATE_DECISION_TEXTS.RECHECK;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  m.recheck.mockResolvedValue({ success: true, message: TEXTS().QUEUED(NR) });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type RecheckProp = NonNullable<InvoiceDetailInitial extends { ksef_duplicate_recheck?: infer R } ? R : never>;

function recheckView(over: Partial<RecheckProp> = {}): RecheckProp {
  return {
    kind: 'recheck',
    reason: 'download-pending',
    invoiceNumber: NR,
    originalKsefNumber: K,
    assignedDay: '2026-10-01',
    grantInvoiceRead: false,
    cooldownMsLeft: null,
    refusal: null,
    ...over,
  } as RecheckProp;
}

function initialOf(over: Partial<Record<string, unknown>> = {}, check: Record<string, unknown> | null = duplicateCheck({ reason: 'download-pending', httpStatus: 503 })): InvoiceDetailInitial {
  return {
    id: 'inv-1',
    internal_number: NR,
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-10-02',
    sale_date: '2026-10-02',
    ksef_status: 'failed',
    ksef_number: null,
    ksef_accepted_at: null,
    xml_storage_path: null,
    net_total: '100.00',
    vat_total: '23.00',
    gross_total: '123.00',
    notes: null,
    last_error: 'KSeF ma już fakturę o tym numerze — do uzgodnienia.',
    last_error_code: 'KSEF_DUPLICATE_RECONCILE',
    last_error_field: null,
    last_error_suggestion: null,
    seller_data: { nip: '5260001246', name: 'Moja Firma', address: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer_data: { nip: '1234567890', name: 'Nabywca testowy', address: { addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
    payment_data: null,
    lines: [],
    currency: 'PLN',
    split_payment: false,
    amount_due: 123,
    can_correct: false,
    qr: null,
    upo_status: null,
    can_manage_send: true,
    ksef_duplicate_original: describeDuplicateOriginal(NR, K, parseDuplicateCheck(check)),
    ksef_duplicate_decision: null,
    ksef_duplicate_recheck: recheckView(),
    ksef_retired_draft: null,
    ksef_resend_facts: STORED,
    ksef_environment_known: true,
    ...over,
  } as unknown as InvoiceDetailInitial;
}

function render(initial: InvoiceDetailInitial): string {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InvoiceDetailView initial={initial} />));
  return (host.textContent ?? '').replace(/ /g, ' ');
}

function buttonsLabelled(label: string): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll('button') ?? []).filter((b) => (b.textContent ?? '').trim() === label);
}

const LABEL = 'Sprawdź ponownie';

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('PR D: przycisk „Sprawdź ponownie” na karcie', () => {
  it.each([
    ['download-refused (403)', 'download-refused', true, duplicateCheck({ reason: 'download-refused', httpStatus: 403 })],
    ['download-pending', 'download-pending', false, duplicateCheck({ reason: 'download-pending', httpStatus: 503 })],
    ['storage-pending', 'storage-pending', false, duplicateCheck({ reason: 'storage-pending' })],
    ['archive-pending', 'archive-pending', false, duplicateCheck({ reason: 'archive-pending' })],
    ['no-check', 'no-check', false, null],
  ] as const)('%s: właściciel/administrator widzi K, dzień nadania, przycisk i „Nie wystawiaj”; wskazówka InvoiceRead tylko przy 403', (_name, reason, grant, check) => {
    const t = render(initialOf({ ksef_duplicate_recheck: recheckView({ reason, grantInvoiceRead: grant }) }, check));
    expect(t).toContain(K);
    expect(t).toContain('2026-10-01');
    expect(t).toContain(TEXTS().INTRO(NR, K, '2026-10-01'));
    expect(buttonsLabelled(LABEL)).toHaveLength(1);
    expect(buttonsLabelled(LABEL)[0]!.disabled).toBe(false);
    expect(t).toContain('Nie wystawiaj tej faktury ponownie.');
    // Obok panelu duplikatu nie ma karty błędu z tekstem runnera (jak dotąd).
    expect(host!.querySelector('[data-testid="karta-bledu"]')).toBeNull();
    if (grant) {
      expect(t).toContain(TEXTS().HINT_403);
      expect(t).toContain('InvoiceRead');
      expect(t).toContain('Aplikacji Podatnika KSeF');
    } else {
      expect(t).not.toContain('InvoiceRead');
    }
  });

  it('403: wskazówka dla klienta z certyfikatem (FaktWay nie ma tokenu): uprawnienia w Aplikacji Podatnika albo ponowne podłączenie KSeF w Ustawieniach', () => {
    const t = render(
      initialOf(
        { ksef_duplicate_recheck: recheckView({ reason: 'download-refused', grantInvoiceRead: true }) },
        duplicateCheck({ reason: 'download-refused', httpStatus: 403 }),
      ),
    );
    // Klient łączy FaktWay z KSeF certyfikatem (components/settings/actions.ts zapisuje tylko 'xades'): tokenu nie ma gdzie nadać.
    expect(TEXTS().HINT_403).not.toMatch(/token/i);
    expect(t).toContain(TEXTS().HINT_403);
    expect(t).not.toMatch(/token/i);
    expect(t).toContain('Dane logowania KSeF w FaktWay nie mają uprawnienia do odczytu faktur');
    expect(t).toContain('InvoiceRead');
    expect(t).toContain('Aplikacji Podatnika KSeF');
    expect(t).toContain('podłącz KSeF ponownie w Ustawieniach → KSeF');
    // Wskazówka kończy się wyjściem: po naprawie uprawnienia klient klika przycisk.
    expect(TEXTS().HINT_403).toContain('Sprawdź ponownie');
    expect(TEXTS().HINT_403).not.toContain('—');
    expect(buttonsLabelled(LABEL)).toHaveLength(1);
  });

  it('inne środowisko: „Dane oryginału pochodzą z innego środowiska KSeF” i przycisk', () => {
    const t = render(initialOf({ ksef_duplicate_recheck: recheckView({ reason: 'env-mismatch' }) }, duplicateCheck({ env: 'production' })));
    expect(t).toContain('Dane oryginału pochodzą z innego środowiska KSeF');
    expect(buttonsLabelled(LABEL)).toHaveLength(1);
    expect(t).toContain('Nie wystawiaj tej faktury ponownie.');
  });

  it('inne środowisko z powodem decyzyjnym (no-own-file): bez obietnicy automatycznego sprawdzenia, której cron I5 nie spełni', () => {
    // Blokada SQL (00156) nie patrzy na środowisko: no-own-file z innego środowiska to I5D, a cron I5 bierze tylko I5.
    // Karta nie może obiecywać „automatycznie, zwykle w ciągu 2 dni” — klient czekałby bez końca.
    const t = render(
      initialOf({ ksef_duplicate_recheck: recheckView({ reason: 'env-mismatch' }) }, duplicateCheck({ env: 'production', reason: 'no-own-file' })),
    );
    expect(t).toContain(TEXTS().ENV_MISMATCH);
    expect(t).not.toContain(TEXTS().WHAT_NEXT);
    expect(t).not.toMatch(/automatycznie/i);
    expect(t).not.toContain('w ciągu 2 dni');
    expect(buttonsLabelled(LABEL)).toHaveLength(1);
    expect(buttonsLabelled(LABEL)[0]!.disabled).toBe(false);
    expect(t).toContain('Nie wystawiaj tej faktury ponownie.');
  });

  it('powody pobrania i brak zapisu sprawdzenia: cron I5 je uzgadnia, więc „automatycznie, zwykle w ciągu 2 dni” zostaje', () => {
    for (const reason of ['download-refused', 'download-pending', 'storage-pending', 'archive-pending', 'no-check'] as const) {
      const t = render(initialOf({ ksef_duplicate_recheck: recheckView({ reason }) }));
      expect(t, reason).toContain(TEXTS().WHAT_NEXT);
    }
  });

  it('kliknięcie: akcja z identyfikatorem faktury, toast z sukcesem i odświeżenie strony', async () => {
    render(initialOf());
    await click(buttonsLabelled(LABEL)[0]!);
    expect(m.recheck).toHaveBeenCalledTimes(1);
    expect(m.recheck).toHaveBeenCalledWith('inv-1');
    expect(m.toastSuccess).toHaveBeenCalledWith(TEXTS().QUEUED(NR));
    expect(m.refresh).toHaveBeenCalled();
  });

  it('odmowa akcji: toast z błędem (zdanie z serwera), strona też się odświeża', async () => {
    m.recheck.mockResolvedValue({ success: false, error: TEXTS().COOLDOWN(NR, 4) });
    render(initialOf());
    await click(buttonsLabelled(LABEL)[0]!);
    expect(m.toastError).toHaveBeenCalledWith(TEXTS().COOLDOWN(NR, 4));
    expect(m.toastSuccess).not.toHaveBeenCalled();
    expect(m.refresh).toHaveBeenCalled();
  });

  it('członek firmy: dane tylko do odczytu, prośba o właściciela, BEZ przycisku', () => {
    const t = render(
      initialOf({
        can_manage_send: false,
        ksef_duplicate_recheck: recheckView({ refusal: { code: 'role', message: TEXTS().ROLE } }),
      }),
    );
    expect(t).toContain(K);
    expect(t).toContain('Poproś właściciela lub administratora firmy');
    expect(buttonsLabelled(LABEL)).toHaveLength(0);
    expect(t).toContain('Nie wystawiaj tej faktury ponownie.');
  });

  it('cooldown: zdanie z minutami do końca, przycisk nieaktywny', () => {
    const t = render(
      initialOf({ ksef_duplicate_recheck: recheckView({ refusal: { code: 'cooldown', message: TEXTS().COOLDOWN(NR, 6) } }) }),
    );
    expect(t).toContain(TEXTS().COOLDOWN(NR, 6));
    const buttons = buttonsLabelled(LABEL);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  describe('koniec cooldownu odświeża kartę sam (przycisk nie czeka na ręczne F5)', () => {
    const MIN = 60_000;
    const cooldownCard = (ms: number | null) =>
      initialOf({
        ksef_duplicate_recheck: recheckView({
          cooldownMsLeft: ms,
          refusal: ms === null ? null : { code: 'cooldown', message: TEXTS().COOLDOWN(NR, Math.ceil(ms / MIN)) },
        }),
      });

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('po upływie czasu z widoku (liczonego przez serwer) strona się odświeża i serwer wydaje przycisk bez cooldownu', () => {
      render(cooldownCard(9 * MIN));
      expect(buttonsLabelled(LABEL)[0]!.disabled).toBe(true);
      act(() => {
        vi.advanceTimersByTime(9 * MIN - 1);
      });
      expect(m.refresh).not.toHaveBeenCalled();
      // Zapas na rozjazd zegarów aplikacji i bazy: odświeżenie dopiero po końcu cooldownu, nie tuż przed.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(m.refresh).toHaveBeenCalledTimes(1);
    });

    it('czas liczony od widoku z serwera, nie od zegara przeglądarki: rozjazd zegarów nie zapętla odświeżeń', () => {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z')); // zegar klienta daleko od zegara serwera
      render(cooldownCard(3 * MIN));
      act(() => {
        vi.advanceTimersByTime(3 * MIN - 1);
      });
      expect(m.refresh).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(m.refresh).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(m.refresh).toHaveBeenCalledTimes(1);
    });

    it('bez cooldownu (przycisk aktywny, odmowa roli itd.) nie ma żadnego timera ani odświeżania', () => {
      render(cooldownCard(null));
      act(() => {
        vi.advanceTimersByTime(60 * MIN);
      });
      expect(m.refresh).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('opuszczenie karty przed końcem cooldownu kasuje timer', () => {
      render(cooldownCard(5 * MIN));
      act(() => root?.unmount());
      root = null;
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(10 * MIN);
      });
      expect(m.refresh).not.toHaveBeenCalled();
    });
  });

  it('powód z panelem decyzji: panel decyzji, BEZ przycisku „Sprawdź ponownie”', () => {
    const t = render(
      initialOf(
        { ksef_duplicate_recheck: null, ksef_duplicate_decision: decidableView() },
        duplicateCheck(),
      ),
    );
    expect(host!.querySelector('[data-testid="panel-decyzji"]')).not.toBeNull();
    expect(buttonsLabelled(LABEL)).toHaveLength(0);
    expect(t).not.toContain(TEXTS().INTRO(NR, K, '2026-10-01'));
  });

  it('powód deterministyczny (bez panelu i bez przycisku): zostaje nota karty', () => {
    const check = duplicateCheck({ reason: 'archive-conflict' });
    const t = render(initialOf({ ksef_duplicate_recheck: null }, check));
    expect(buttonsLabelled(LABEL)).toHaveLength(0);
    expect(t).toContain(describeDuplicateOriginal(NR, K, parseDuplicateCheck(check)).note);
  });

  it('po zmianie stanu faktury (Realtime) widok „Sprawdź ponownie” znika razem z panelem duplikatu', () => {
    const t = render(initialOf({ ksef_status: 'queued', last_error_code: null, last_error: null }));
    expect(buttonsLabelled(LABEL)).toHaveLength(0);
    expect(t).not.toContain(TEXTS().INTRO(NR, K, '2026-10-01'));
  });
});
