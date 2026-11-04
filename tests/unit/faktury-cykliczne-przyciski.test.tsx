import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora E9 (N1, P3/P4/P11): wejścia do faktur cyklicznych spoza
 * `/invoices/recurring` — baner na `/invoices`, „Duplikuj” i „Ustaw jako
 * cykliczną” w akcjach faktury, „Zrób fakturę cykliczną” przy stałym
 * kliencie — oraz komunikaty strony. Przycisk, który prowadzi do odmowy,
 * jest gorszy niż brak przycisku, więc widoczność liczą te same warunki co
 * akcja tworzenia pozycji (`templateRejection`).
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions-detail', () => ({ downloadInvoiceXmlAction: vi.fn() }));
vi.mock('@/components/invoices/draft-actions', () => ({ deleteDraftInvoiceAction: vi.fn(), sendDraftInvoiceAction: vi.fn() }));
vi.mock('@/components/invoices/email-invoice-button', () => ({ EmailInvoiceButton: () => null }));
vi.mock('@/components/invoices/failed-invoice-actions', () => ({ FailedInvoiceActions: () => null }));
vi.mock('@/components/invoices/draft-invoice-actions', () => ({ DraftInvoiceActions: () => null }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
vi.mock('@/app/actions/recurring-invoices', () => ({
  createRecurringInvoiceAction: vi.fn(),
  updateRecurringInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/recurring-invoice-templates', () => ({ searchRecurringTemplatesAction: vi.fn() }));

import {
  RecurringDueBanner,
  RecurringDueBannerView,
  recurringDueText,
} from '@/app/(dashboard)/invoices/_components/recurring-due-banner';
import { rowMenuEntries } from '@/app/(dashboard)/invoices/_components/invoice-row-actions';
import {
  defaultRecurringName,
  templateLabel,
} from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-invoice-sheet';
// Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — karta „Stali klienci” to teraz kopia
// Finory z `finora-1do1/`, a wiersze przygotowuje adapter `toSubscriptionItems`.
import { toSubscriptionItems } from '@/components/analizy/adapters';
import SubscriptionsCard from '@/components/analizy/finora-1do1/subscriptions-card';
import { InvoiceActions } from '@/components/invoices/invoice-actions';
import { monthKeysEnding } from '@/lib/analytics-finance/months';
import { recurringClients } from '@/lib/analytics-finance/recurring';
import type { SaleInvoice } from '@/lib/analytics-finance/sales';
import { RECURRING_GENERIC_ERROR, recurringErrorMessage } from '@/lib/invoices/recurring/error-message';
import { dayOfMonthFromDate, previewNextRun } from '@/lib/invoices/recurring/preview';
import {
  canDuplicateInvoice,
  canSetAsRecurring,
  duplicateInvoiceHref,
  setAsRecurringHref,
} from '@/lib/invoices/recurring/visibility';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import type { PageContext } from '@/lib/supabase/page-context';

const ID = '7f1c2d3e-4b5a-4c6d-8e7f-901234567890';

/** Faktura, która spełnia warunki wzoru N1. */
const WZOR = {
  direction: 'outgoing',
  origin: 'app',
  invoice_kind: 'regular',
  invoice_type: 'VAT',
  ksef_status: 'accepted',
  currency: 'PLN',
} as const;

describe('baner na /invoices — liczebniki (lib/i18n/plural)', () => {
  it.each([
    [1, '1 faktura cykliczna czeka na wystawienie'],
    [2, '2 faktury cykliczne czekają na wystawienie'],
    [4, '4 faktury cykliczne czekają na wystawienie'],
    [5, '5 faktur cyklicznych czeka na wystawienie'],
    [12, '12 faktur cyklicznych czeka na wystawienie'],
    [22, '22 faktury cykliczne czekają na wystawienie'],
  ])('%i → „%s”', (count, text) => {
    expect(recurringDueText(count)).toBe(text);
    const html = renderToStaticMarkup(<RecurringDueBannerView count={count} />);
    expect(html).toContain(text);
    expect(html).toContain('href="/invoices/recurring"');
    expect(html).toContain('Zobacz faktury cykliczne');
  });

  it('0 — nic (bez pustego banera)', () => {
    expect(renderToStaticMarkup(<RecurringDueBannerView count={0} />)).toBe('');
  });

  /** Klient PostgREST z jednym zapytaniem `count` — tylko na potrzeby licznika. */
  function countClient(result: { count: number | null; error: unknown } | Error): PageContext['supabase'] {
    const chain = {
      select: () => chain,
      eq: () => chain,
      lte: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
    };
    return { from: () => chain } as unknown as PageContext['supabase'];
  }

  it('licznik z bazy: 3 → baner; błąd odczytu albo wyjątek → cicho nic, lista faktur działa dalej', async () => {
    const ok = await RecurringDueBanner({ supabase: countClient({ count: 3, error: null }), tenantId: 't', today: '2026-10-20' });
    expect(renderToStaticMarkup(<>{ok}</>)).toContain('3 faktury cykliczne czekają na wystawienie');

    const failed = await RecurringDueBanner({
      supabase: countClient({ count: null, error: { code: 'PGRST205' } }),
      tenantId: 't',
      today: '2026-10-20',
    });
    expect(failed).toBeNull();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = await RecurringDueBanner({ supabase: countClient(new Error('fetch failed')), tenantId: 't', today: '2026-10-20' });
    expect(thrown).toBeNull();
    spy.mockRestore();
  });
});

describe('widoczność przycisków (warunki wzoru N1)', () => {
  it('„Ustaw jako cykliczną” tylko dla przyjętej zwykłej faktury VAT w PLN z FaktWay', () => {
    expect(canSetAsRecurring(WZOR)).toBe(true);
    expect(canSetAsRecurring({ ...WZOR, direction: 'incoming' })).toBe(false);
    expect(canSetAsRecurring({ ...WZOR, origin: 'import' })).toBe(false);
    expect(canSetAsRecurring({ ...WZOR, invoice_kind: 'correction', invoice_type: 'KOR' })).toBe(false);
    expect(canSetAsRecurring({ ...WZOR, invoice_kind: 'advance', invoice_type: 'ZAL' })).toBe(false);
    expect(canSetAsRecurring({ ...WZOR, invoice_kind: 'final', invoice_type: 'ROZ' })).toBe(false);
    expect(canSetAsRecurring({ ...WZOR, invoice_type: 'UPR' })).toBe(false);
    for (const status of ['draft', 'queued', 'sending', 'rejected', 'failed', 'offline_queued']) {
      expect(canSetAsRecurring({ ...WZOR, ksef_status: status }), status).toBe(false);
    }
    expect(canSetAsRecurring({ ...WZOR, currency: 'EUR' })).toBe(false);
    // Brak waluty albo pochodzenia w wierszu to brak dowodu — przycisk ukryty.
    expect(canSetAsRecurring({ ...WZOR, currency: null })).toBe(false);
    expect(canSetAsRecurring({ ...WZOR, origin: undefined })).toBe(false);
  });

  it('„Duplikuj” dla zwykłej faktury z FaktWay (także szkicu i odrzuconej), nie dla korekty, zaliczki, końcowej ani importu', () => {
    expect(canDuplicateInvoice(WZOR)).toBe(true);
    expect(canDuplicateInvoice({ ...WZOR, ksef_status: 'draft' })).toBe(true);
    expect(canDuplicateInvoice({ ...WZOR, ksef_status: 'rejected', currency: 'EUR' })).toBe(true);
    expect(canDuplicateInvoice({ ...WZOR, invoice_kind: 'correction' })).toBe(false);
    expect(canDuplicateInvoice({ ...WZOR, invoice_kind: 'advance' })).toBe(false);
    expect(canDuplicateInvoice({ ...WZOR, invoice_kind: 'final' })).toBe(false);
    expect(canDuplicateInvoice({ ...WZOR, origin: 'import' })).toBe(false);
    expect(canDuplicateInvoice({ ...WZOR, direction: 'incoming' })).toBe(false);
  });

  it('adresy: Duplikuj → formularz z ?wzor=, Ustaw jako cykliczną → arkusz z ?wzor=', () => {
    expect(duplicateInvoiceHref(ID)).toBe(`/invoices/new/regular?wzor=${ID}`);
    expect(setAsRecurringHref(ID)).toBe(`/invoices/recurring?wzor=${ID}`);
  });

  it('menu „⋯” wiersza listy faktur (P3): Duplikuj i Ustaw jako cykliczną tylko tam, gdzie wolno', () => {
    const row = { ...WZOR, xml_storage_path: 'x.xml' };
    expect(rowMenuEntries(row, { canCorrect: true })).toEqual(['correction', 'duplicate', 'recurring', 'xml']);
    expect(rowMenuEntries({ ...row, ksef_status: 'draft' }, undefined)).toEqual(['duplicate', 'xml', 'delete']);
    expect(rowMenuEntries({ ...row, invoice_kind: 'correction', invoice_type: 'KOR' }, undefined)).toEqual(['xml']);
    expect(rowMenuEntries({ ...row, origin: 'import' }, undefined)).toEqual(['xml']);
  });
});

describe('podgląd faktury (P4): „Ustaw jako cykliczną” w karcie „Dokument”', () => {
  const FACTS: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
  const render = (canSetRecurring: boolean | undefined) =>
    renderToStaticMarkup(
      <InvoiceActions
        section="secondary"
        invoice={{
          id: ID,
          ksef_status: 'accepted',
          xml_storage_path: null,
          invoice_type: 'VAT',
          invoice_kind: 'regular',
          ksef_resend_facts: FACTS,
          ksef_environment_known: true,
          can_set_recurring: canSetRecurring,
        }}
      />,
    );

  it('link do arkusza z wybranym wzorem, gdy strona policzyła, że faktura może być wzorem', () => {
    const html = render(true);
    expect(html).toContain('Ustaw jako cykliczną');
    expect(html).toContain(`href="/invoices/recurring?wzor=${ID}"`);
  });

  it('bez flagi albo z false — przycisku nie ma', () => {
    expect(render(false)).not.toContain('Ustaw jako cykliczną');
    expect(render(undefined)).not.toContain('Ustaw jako cykliczną');
  });
});

describe('podgląd faktury: „Duplikuj” w karcie „Dokument” (telefon nie ma menu „⋯” tabeli)', () => {
  const FACTS: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
  const render = (canDuplicate: boolean | undefined) =>
    renderToStaticMarkup(
      <InvoiceActions
        section="secondary"
        invoice={{
          id: ID,
          ksef_status: 'accepted',
          xml_storage_path: null,
          invoice_type: 'VAT',
          invoice_kind: 'regular',
          ksef_resend_facts: FACTS,
          ksef_environment_known: true,
          can_duplicate: canDuplicate,
        }}
      />,
    );

  it('link do formularza z wzorem, gdy strona policzyła, że fakturę wolno zduplikować', () => {
    const html = render(true);
    expect(html).toContain('Duplikuj');
    expect(html).toContain(`href="${duplicateInvoiceHref(ID)}"`);
  });

  it('bez flagi albo z false: przycisku nie ma', () => {
    expect(render(false)).not.toContain('Duplikuj');
    expect(render(undefined)).not.toContain('Duplikuj');
  });
});

describe('„Stali klienci” (P11): „Zrób fakturę cykliczną” z najnowszej faktury-wzoru klienta', () => {
  const months = monthKeysEnding('2026-10', 4);
  let seq = 0;
  const sale = (over: Partial<SaleInvoice> = {}): SaleInvoice => ({
    id: `s-${++seq}`,
    issueDate: '2026-10-05',
    number: 'FV/1',
    kind: 'regular',
    net: 100,
    documentGross: 123,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Stały spółka akcyjna' },
    is_b2c: false,
    origin: 'app',
    invoiceType: 'VAT',
    ...over,
  });

  it('id najnowszej faktury spełniającej warunki wzoru — korekta i import nie są wzorem', () => {
    const rows = [
      sale({ id: 'lip', issueDate: '2026-07-05' }),
      sale({ id: 'sie', issueDate: '2026-08-05' }),
      sale({ id: 'wrz-import', issueDate: '2026-09-05', origin: 'import' }),
      sale({ id: 'wrz-kor', issueDate: '2026-09-20', kind: 'correction', invoiceType: 'KOR', net: -10 }),
    ];
    expect(recurringClients(rows, months)).toEqual([
      expect.objectContaining({ key: 'nip:1234567890', templateInvoiceId: 'sie' }),
    ]);
  });

  it('klient bez żadnej faktury-wzoru (same importy) — bez id, przycisk ukryty', () => {
    const rows = ['2026-07-05', '2026-08-05', '2026-09-05'].map((d) => sale({ issueDate: d, origin: 'import' }));
    const [item] = recurringClients(rows, months);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('templateInvoiceId');
  });

  it('„Konsumenci” (wielu nabywców B2C pod jednym kluczem) — bez wzoru, bo faktura jednej osoby nie pasuje do „klienta”', () => {
    const rows = ['2026-07-05', '2026-08-05', '2026-09-05'].map((d, i) =>
      sale({ issueDate: d, is_b2c: true, buyer_nip: null, buyer_data: { name: `Osoba ${i}` } }),
    );
    const [item] = recurringClients(rows, months);
    expect(item?.name).toBe('Konsumenci');
    expect(item).not.toHaveProperty('templateInvoiceId');
  });

  const EMPTY = { message: 'Brak stałych klientów' };

  it('karta: link przy kliencie z wzorem, bez linku przy kliencie bez wzoru', () => {
    const html = renderToStaticMarkup(
      <SubscriptionsCard
        title="Stali klienci"
        description="d"
        empty={EMPTY}
        data={toSubscriptionItems(
          [
            { key: 'nip:1', name: 'Stały S.A.', averageAmount: 200, typicalDay: 6, months: 3, templateInvoiceId: ID },
            { key: 'nip:2', name: 'Inny', averageAmount: 50, typicalDay: 2, months: 3 },
          ],
          'client',
        )}
      />,
    );
    expect(html).toContain(`href="/invoices/recurring?wzor=${ID}"`);
    expect(html).toContain('aria-label="Zrób fakturę cykliczną dla: Stały S.A."');
    expect((html.match(/Zrób fakturę cykliczną</g) ?? []).length).toBe(1);
  });
});

describe('strona /invoices/recurring — komunikaty i arkusz', () => {
  it('błąd odczytu: polski komunikat warstwy danych przechodzi, reszta to ogólny tekst (nie surowy error.message)', () => {
    expect(recurringErrorMessage(new Error('Nie udało się wczytać faktur cyklicznych. Odśwież stronę za chwilę.'))).toBe(
      'Nie udało się wczytać faktur cyklicznych. Odśwież stronę za chwilę.',
    );
    expect(recurringErrorMessage(new Error('relation "recurring_invoices" does not exist'))).toBe(RECURRING_GENERIC_ERROR);
    expect(recurringErrorMessage('x')).toBe(RECURRING_GENERIC_ERROR);
  });

  it('podpis wzoru w arkuszu: numer · kontrahent (skrócona forma) · brutto · data DD.MM.RRRR', () => {
    const candidate = {
      id: ID,
      internalNumber: 'FV/7/10/2026',
      issueDate: '2026-10-07',
      grossTotal: 1230,
      contractorName: 'Acme spółka z ograniczoną odpowiedzialnością',
    };
    expect(templateLabel(candidate)).toBe('FV/7/10/2026 · Acme sp. z o.o. · 1230,00 zł · 07.10.2026');
    expect(defaultRecurringName(candidate)).toBe('Acme sp. z o.o.');
    expect(defaultRecurringName({ ...candidate, contractorName: null })).toBe('Faktura FV/7/10/2026');
  });

  it('„Następne wystawienie” w arkuszu: te same funkcje harmonogramu co zapis; dzień spoza 1–28 → brak podglądu', () => {
    expect(previewNextRun({ today: '2026-10-20', frequency: 'monthly', dayOfMonth: 25 })).toEqual({
      date: '2026-10-25',
      periodLabel: 'październik 2026',
    });
    expect(previewNextRun({ today: '2026-10-20', frequency: 'monthly', dayOfMonth: 29 })).toBeNull();
    expect(previewNextRun({ today: '2026-10-20', frequency: 'monthly', dayOfMonth: Number.NaN })).toBeNull();
    // Dzień z daty wzoru: 31 → 28 (nie ma go w każdym miesiącu).
    expect(dayOfMonthFromDate('2026-10-31')).toBe(28);
  });
});
