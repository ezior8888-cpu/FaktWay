// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P3 (PLAN-FINORA §5): ekran /invoices — kafle, tabela Finory od `lg`,
 * paginacja linkami, pasek filtrów (formularz GET) i puste stany.
 * Dane liczy warstwa danych (`lib/invoices/list-*.ts`, `receivables.ts`);
 * tu sprawdzamy, co z nich widzi człowiek.
 */

const stats = vi.hoisted(() => ({
  countContractors: vi.fn(),
  countInvoicesThisMonth: vi.fn(),
  paidThisMonth: vi.fn(),
  getReceivables: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const actions = vi.hoisted(() => ({
  downloadInvoiceXmlAction: vi.fn(),
  deleteDraftInvoiceAction: vi.fn(),
}));

vi.mock('@/lib/invoices/list-stats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/list-stats')>()),
  countContractors: stats.countContractors,
  countInvoicesThisMonth: stats.countInvoicesThisMonth,
  paidThisMonth: stats.paidThisMonth,
}));
vi.mock('@/lib/dashboard/receivables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard/receivables')>()),
  getReceivables: stats.getReceivables,
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/invoices/actions-detail', () => ({
  downloadInvoiceXmlAction: actions.downloadInvoiceXmlAction,
}));
vi.mock('@/components/invoices/draft-actions', () => ({
  deleteDraftInvoiceAction: actions.deleteDraftInvoiceAction,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: vi.fn(),
  }),
}));

import { InvoiceList } from '@/components/invoices/invoice-list';
import type { InvoiceRow } from '@/components/invoices/invoice-row-types';
import { InvoiceRowActions, rowMenuEntries } from '@/app/(dashboard)/invoices/_components/invoice-row-actions';
import { InvoicesPagination } from '@/app/(dashboard)/invoices/_components/invoices-pagination';
import { InvoicesTable } from '@/app/(dashboard)/invoices/_components/invoices-table';
import { InvoicesToolbar } from '@/app/(dashboard)/invoices/_components/invoices-toolbar';
import {
  ContractorsTile,
  InvoicesThisMonthTile,
  PaidThisMonthTile,
  ReceivablesTile,
} from '@/app/(dashboard)/invoices/_components/invoice-stat-tiles';
import { RECEIVABLES_NOTE } from '@/lib/dashboard/receivables';
import { formatPlMoney } from '@/lib/format/pl';
import type { InvoiceListRowFacts } from '@/lib/invoices/list-row-facts';
import { PAID_EMPTY_STATE, PAID_NOTE } from '@/lib/invoices/list-stats';
import { parseInvoiceListParams } from '@/lib/invoices/list-query';

const TODAY = '2026-10-17';
const tile = { supabase: {} as never, tenantId: 'ten-1' };

function invoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv-1',
    internal_number: 'FV/1/2026',
    issue_date: '2026-10-01',
    buyer_data: { name: 'Acme spółka z ograniczoną odpowiedzialnością', nip: '1234567890' },
    gross_total: 1230,
    ksef_status: 'accepted',
    ksef_number: '1234567890-20261001-ABC',
    created_at: '2026-10-01T10:00:00Z',
    xml_storage_path: 'ten-1/inv-1.xml',
    payment_status: 'unpaid',
    payment_due_date: '2026-10-15',
    paid_amount: 0,
    currency: 'PLN',
    invoice_kind: 'regular',
    last_error_code: null,
    ...over,
  };
}

const facts = (over: Partial<InvoiceListRowFacts> = {}): InvoiceListRowFacts => ({
  payment: 'unpaid',
  outstanding: 1230,
  canCorrect: false,
  canMarkPaid: false,
  ...over,
});

function table(rows: InvoiceRow[], factsById: Record<string, InvoiceListRowFacts>): string {
  return renderToStaticMarkup(
    <InvoicesTable
      invoices={rows}
      facts={factsById}
      today={TODAY}
      selectedIds={new Set()}
      onToggleRow={() => {}}
      onToggleAll={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('kafle (każdy to osobny Server Component)', () => {
  it('Kontrahenci: liczba z bazy', async () => {
    stats.countContractors.mockResolvedValue(12);
    const html = renderToStaticMarkup(await ContractorsTile(tile));
    expect(html).toContain('Kontrahenci');
    expect(html).toContain('>12<');
  });

  it('Faktury w tym miesiącu: przyjęte + notka o szkicach poza KSeF', async () => {
    stats.countInvoicesThisMonth.mockResolvedValue({ accepted: 7, drafts: 2 });
    const html = renderToStaticMarkup(await InvoicesThisMonthTile(tile));
    expect(html).toContain('Faktury w tym miesiącu');
    expect(html).toContain('>7<');
    expect(html).toContain('+ 2 szkice poza KSeF');
  });

  it('bez szkiców nie ma notki', async () => {
    stats.countInvoicesThisMonth.mockResolvedValue({ accepted: 7, drafts: 0 });
    expect(renderToStaticMarkup(await InvoicesThisMonthTile(tile))).not.toContain('poza KSeF');
  });

  it('Opłacone: kwota + podpis „według oznaczonych wpłat”', async () => {
    stats.paidThisMonth.mockResolvedValue(18000.5);
    const html = renderToStaticMarkup(await PaidThisMonthTile(tile));
    expect(html).toContain('Opłacone w tym miesiącu');
    expect(html).toContain(`${formatPlMoney(18000.5)} zł`);
    expect(html).toContain(PAID_NOTE);
  });

  it('Opłacone bez wpłat: komunikat zamiast „0,00 zł”', async () => {
    stats.paidThisMonth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await PaidThisMonthTile(tile));
    expect(html).toContain(PAID_EMPTY_STATE);
    expect(html).not.toContain('0,00');
  });

  it('Do zapłaty: suma, podpis i informacja o walutach obcych', async () => {
    stats.getReceivables.mockResolvedValue({ total: 4500.25, foreignCurrencyCount: 2 });
    const html = renderToStaticMarkup(await ReceivablesTile(tile));
    expect(html).toContain('Do zapłaty');
    expect(html).toContain(`${formatPlMoney(4500.25)} zł`);
    expect(html).toContain(RECEIVABLES_NOTE);
    expect(html).toContain('Pominięto 2 faktury w walucie obcej');
  });

  it('Do zapłaty bez walut obcych: bez notki o pominięciu', async () => {
    stats.getReceivables.mockResolvedValue({ total: 0, foreignCurrencyCount: 0 });
    expect(renderToStaticMarkup(await ReceivablesTile(tile))).not.toContain('Pominięto');
  });

  it('błąd strażnika: komunikat z wyjątku i link do /przeplywy, bez rzucania', async () => {
    stats.getReceivables.mockRejectedValue(new Error('Przyjęte faktury wymagają uzgodnienia środowiska KSeF'));
    const html = renderToStaticMarkup(await ReceivablesTile(tile));
    expect(html).toContain('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
    expect(html).toContain('href="/przeplywy"');
  });
});

describe('tabela (od lg)', () => {
  it('opłacona: ikona z opisem dla czytników i plakietka „Opłacona” w Do zapłaty', () => {
    const html = table(
      [invoice({ payment_status: 'paid', paid_amount: 1230 })],
      { 'inv-1': facts({ payment: 'paid', outstanding: 0 }) },
    );
    expect(html).toContain('<span class="sr-only">Opłacona</span>');
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain('Zaakceptowana');
  });

  it('po terminie: ikona „Po terminie” i kwota do zapłaty', () => {
    const html = table([invoice()], { 'inv-1': facts({ payment: 'overdue', outstanding: 1230 }) });
    expect(html).toContain('<span class="sr-only">Po terminie</span>');
    expect(html).toContain(`${formatPlMoney(1230)} zł`);
    expect(html).not.toContain('data-slot="badge"');
  });

  it('nieopłacona przed terminem', () => {
    const html = table(
      [invoice({ payment_due_date: '2026-10-30' })],
      { 'inv-1': facts({ payment: 'unpaid' }) },
    );
    expect(html).toContain('<span class="sr-only">Nieopłacona</span>');
  });

  it('stan płatności liczony przy renderze z daty, nie z payment_status', () => {
    // Wyzwalacz ustawia „overdue” tylko przy zapisie — wiersz zostaje „unpaid”.
    const html = table([invoice({ payment_status: 'unpaid', payment_due_date: '2026-10-16' })], {
      'inv-1': facts({ payment: 'unpaid' }),
    });
    expect(html).toContain('<span class="sr-only">Po terminie</span>');
  });

  it('brak faktów płatności (szkic, import, korekta, EUR): „—” w Płatność i Do zapłaty', () => {
    const html = table(
      [invoice({ ksef_status: 'draft', ksef_number: null, xml_storage_path: null })],
      { 'inv-1': facts({ payment: null, outstanding: null }) },
    );
    expect(html).not.toContain('sr-only">Opłacona');
    expect(html).not.toContain('sr-only">Po terminie');
    expect(html).not.toContain('sr-only">Nieopłacona');
    expect((html.match(/>—</g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('EUR: kod waluty zamiast „zł”', () => {
    const html = table(
      [invoice({ currency: 'EUR', gross_total: 100.5 })],
      { 'inv-1': facts({ payment: null, outstanding: null }) },
    );
    expect(html).toContain(`${formatPlMoney(100.5)} EUR`);
    expect(html).not.toContain(`${formatPlMoney(100.5)} zł`);
  });

  it('PLN: „zł”, nie „PLN”', () => {
    const html = table([invoice()], { 'inv-1': facts() });
    expect(html).toContain(`${formatPlMoney(1230)} zł`);
    expect(html).not.toContain('PLN');
  });

  it('plakietka KSeF dostaje last_error_code (zgodnie z podglądem)', () => {
    const html = table(
      [invoice({ ksef_status: 'failed', last_error_code: 'ENV_MISMATCH' })],
      { 'inv-1': facts({ payment: null, outstanding: null }) },
    );
    expect(html).toContain('Inne środowisko KSeF');
  });

  it('nabywca: inicjały, skrócona forma prawna, pełna nazwa w title, NIP', () => {
    const html = table([invoice()], { 'inv-1': facts() });
    expect(html).toContain('Acme sp. z o.o.');
    expect(html).toContain('title="Acme spółka z ograniczoną odpowiedzialnością"');
    expect(html).toContain('1234567890');
    expect(html).toContain('>A<');
  });

  it('numer jest linkiem do podglądu, są kolumny Finory i zaznaczanie', () => {
    const html = table([invoice()], { 'inv-1': facts() });
    expect(html).toContain('href="/invoices/inv-1"');
    for (const head of ['Numer', 'Płatność', 'Nabywca', 'Brutto', 'Wystawiona', 'Termin', 'Do zapłaty', 'Akcje']) {
      expect(html).toContain(head);
    }
    expect(html).toContain('aria-label="Zaznacz wszystkie faktury na stronie"');
    expect(html).toContain('aria-label="Zaznacz fakturę FV/1/2026"');
  });
});

describe('menu wiersza (⋯)', () => {
  it('Korekta tylko gdy canCorrect', () => {
    expect(rowMenuEntries(invoice(), facts({ canCorrect: true }))).toContain('correction');
    expect(rowMenuEntries(invoice(), facts({ canCorrect: false }))).not.toContain('correction');
    expect(rowMenuEntries(invoice(), undefined)).not.toContain('correction');
  });

  it('Pobierz XML tylko z xml_storage_path', () => {
    expect(rowMenuEntries(invoice(), facts())).toContain('xml');
    expect(rowMenuEntries(invoice({ xml_storage_path: null }), facts())).not.toContain('xml');
  });

  it('Usuń tylko dla szkicu', () => {
    expect(rowMenuEntries(invoice({ ksef_status: 'draft' }), facts())).toContain('delete');
    for (const s of ['accepted', 'queued', 'sending', 'rejected', 'failed', 'offline_queued']) {
      expect(rowMenuEntries(invoice({ ksef_status: s }), facts())).not.toContain('delete');
    }
  });

  describe('otwarte menu w DOM', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    });
    afterEach(() => {
      act(() => root.unmount());
      host.remove();
    });

    const open = (inv: InvoiceRow, f: InvoiceListRowFacts) => {
      act(() => {
        root.render(<InvoiceRowActions invoice={inv} facts={f} defaultMenuOpen />);
      });
      return document.body.textContent ?? '';
    };

    it('pokazuje Korektę, XML i Usuń tam, gdzie wolno, w grupie z etykietą', () => {
      const text = open(invoice({ ksef_status: 'draft' }), facts({ canCorrect: true }));
      expect(text).toContain('Korekta');
      expect(text).toContain('Pobierz XML');
      expect(text).toContain('Usuń');
      const href = document.body.querySelector('a[href^="/invoices/new/correction"]')?.getAttribute('href');
      expect(href).toBe('/invoices/new/correction?parentId=inv-1');
      expect(document.body.querySelector('[data-slot="dropdown-menu-group"] [data-slot="dropdown-menu-label"]')).not.toBeNull();
    });

    it('przyjęta bez canCorrect: bez Korekty i bez Usuń', () => {
      const text = open(invoice(), facts({ canCorrect: false }));
      expect(text).not.toContain('Korekta');
      expect(text).not.toContain('Usuń');
      expect(text).toContain('Pobierz XML');
    });

    it('Usuń pyta o potwierdzenie, a odmowę akcji pokazuje w toaście', async () => {
      actions.deleteDraftInvoiceAction.mockResolvedValue({ success: false, error: 'Szkic wycofany zostaje.' });
      open(invoice({ ksef_status: 'draft' }), facts());
      const del = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('Usuń'));
      expect(del).toBeTruthy();
      await act(async () => { (del as HTMLElement).click(); });
      expect(actions.deleteDraftInvoiceAction).not.toHaveBeenCalled();
      const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Usuń szkic');
      expect(confirm).toBeTruthy();
      await act(async () => { (confirm as HTMLElement).click(); });
      expect(actions.deleteDraftInvoiceAction).toHaveBeenCalledWith('inv-1');
      expect(toast.error).toHaveBeenCalledWith('Szkic wycofany zostaje.');
    });
  });
});

describe('puste stany (e2e/tests/04-empty-states.spec.ts)', () => {
  it('brak faktur: dokładne teksty i oba linki', () => {
    const html = renderToStaticMarkup(
      <InvoiceList tenantId="ten-1" initialInvoices={[]} facts={{}} today={TODAY} />,
    );
    expect(html).toContain('Brak faktur wystawionych');
    expect(html).toMatch(/<a[^>]*href="\/invoices\/new"[^>]*>[\s\S]*Wystaw pierwszą fakturę/);
    expect(html).toMatch(/<a[^>]*href="\/onboarding\/import-source"[^>]*>[\s\S]*Importuj historię/);
  });

  it('po filtrach: „Brak faktur dla tych filtrów” i „Wyczyść filtry”', () => {
    const html = renderToStaticMarkup(
      <InvoiceList tenantId="ten-1" initialInvoices={[]} facts={{}} today={TODAY} filtered />,
    );
    expect(html).toContain('Brak faktur dla tych filtrów');
    expect(html).toMatch(/<a[^>]*href="\/invoices"[^>]*>[\s\S]*Wyczyść filtry/);
    expect(html).not.toContain('Brak faktur wystawionych');
  });

  it('bez szkła: żadnych klas glass/backdrop', () => {
    const html = renderToStaticMarkup(
      <InvoiceList tenantId="ten-1" initialInvoices={[]} facts={{}} today={TODAY} />,
    );
    expect(html).not.toMatch(/glass|backdrop-blur|rounded-3xl/);
  });
});

describe('lista z danymi: telefon i komputer, zaznaczanie', () => {
  it('karty (lg:hidden) i tabela (hidden lg:block) w jednym renderze', () => {
    const html = renderToStaticMarkup(
      <InvoiceList tenantId="ten-1" initialInvoices={[invoice()]} facts={{ 'inv-1': facts() }} today={TODAY} />,
    );
    expect(html).toMatch(/class="[^"]*lg:hidden[^"]*"/);
    expect(html).toMatch(/class="[^"]*hidden[^"]*lg:block[^"]*"/);
    expect(html).not.toMatch(/glass|backdrop-blur/);
  });

  it('karta telefonu niesie płatność i Do zapłaty', () => {
    const html = renderToStaticMarkup(
      <InvoiceList
        tenantId="ten-1"
        initialInvoices={[invoice()]}
        facts={{ 'inv-1': facts({ payment: 'overdue', outstanding: 500 }) }}
        today={TODAY}
      />,
    );
    expect(html).toContain('Po terminie');
    expect(html).toContain(`Do zapłaty: ${formatPlMoney(500)} zł`);
  });
});

describe('paginacja linkami', () => {
  it('linki zachowują filtry, napisy po polsku, zakres pozycji', () => {
    const params = parseInvoiceListParams({ q: 'FV', status: 'przyjete', platnosc: 'po_terminie', na_stronie: '25', strona: '2' });
    const html = renderToStaticMarkup(<InvoicesPagination params={params} total={230} />);
    expect(html).toContain('aria-label="Strony listy faktur"');
    expect(html).toContain('Pozycje 26–50 z 230');
    expect(html).toContain('Poprzednia');
    expect(html).toContain('Następna');
    expect(html).toContain('href="/invoices?q=FV&amp;status=przyjete&amp;platnosc=po_terminie&amp;na_stronie=25"');
    expect(html).toContain('href="/invoices?q=FV&amp;status=przyjete&amp;platnosc=po_terminie&amp;na_stronie=25&amp;strona=3"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('<button');
  });

  // Lista 1:1 z Finory (21.10.2026): nawigacja (Poprzednia / numery / Następna) jest ZAWSZE, gdy są pozycje,
  // także przy jednej stronie (było: bez nawigacji). Domyślnie 10 na stronę, więc „jedna strona” to total ≤ 10
  // (było total=12 przy 50 na stronę); obie strzałki są wtedy nieaktywne, a jedyny numer to bieżąca strona.
  it('jedna strona: nawigacja jest (jak w Finorze), strzałki nieaktywne, z zakresem pozycji', () => {
    const html = renderToStaticMarkup(<InvoicesPagination params={parseInvoiceListParams({})} total={7} />);
    expect(html).toContain('Pozycje 1–7 z 7');
    expect(html).toContain('aria-label="Strony listy faktur"');
    expect(html).toContain('Poprzednia');
    expect(html).toContain('Następna');
    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).not.toContain('href="/invoices?strona=2"');
  });

  // Lista 1:1 z Finory (21.10.2026): nawigacja tylko gdy total > 0 — pusta lista ma sam napis „Brak pozycji”.
  it('pusta lista: „Brak pozycji”, bez nawigacji', () => {
    const html = renderToStaticMarkup(<InvoicesPagination params={parseInvoiceListParams({})} total={0} />);
    expect(html).toContain('Brak pozycji');
    expect(html).not.toContain('Strony listy faktur');
  });

  it('pierwsza strona: „Poprzednia” nieaktywna (bez linku)', () => {
    const html = renderToStaticMarkup(<InvoicesPagination params={parseInvoiceListParams({})} total={230} />);
    expect(html).toMatch(/aria-disabled="true"[^>]*>[\s\S]*?Poprzednia/);
    expect(html).toContain('href="/invoices?strona=2"');
  });
});

describe('pasek filtrów (formularz GET, działa bez JS)', () => {
  const params = parseInvoiceListParams({ q: 'Acme', status: 'przyjete', platnosc: 'oplacone', rodzaj: 'advance', od: '2026-09-01', do: '2026-09-30' });
  const html = renderToStaticMarkup(<InvoicesToolbar params={params} filtered />);

  it('GET na /invoices z polami q, od, do', () => {
    expect(html).toMatch(/<form[^>]*method="get"[^>]*action="\/invoices"|<form[^>]*action="\/invoices"[^>]*method="get"/);
    expect(html).toMatch(/name="q"[^>]*value="Acme"|value="Acme"[^>]*name="q"/);
    expect(html).toMatch(/name="od"/);
    expect(html).toMatch(/name="do"/);
    expect(html).toContain('placeholder="Szukaj po numerze lub kontrahencie"');
  });

  it('selecty Base UI wysyłają wartości przez ukryte pola', () => {
    for (const [name, value] of [['status', 'przyjete'], ['platnosc', 'oplacone'], ['rodzaj', 'advance']] as const) {
      expect(html).toMatch(new RegExp(`<input[^>]*name="${name}"[^>]*value="${value}"|<input[^>]*value="${value}"[^>]*name="${name}"`));
    }
  });

  it('teksty: Filtruj, Wyczyść (przy filtrach), Wystaw fakturę → /invoices/new', () => {
    expect(html).toContain('Filtruj');
    expect(html).toContain('Wyczyść');
    expect(html).toMatch(/<a[^>]*href="\/invoices\/new"[^>]*>[\s\S]*Wystaw fakturę/);
    for (const label of ['Status KSeF', 'Płatność', 'Rodzaj', 'Pokaż']) expect(html).toContain(label);
  });

  it('bez filtrów nie ma „Wyczyść”', () => {
    const clean = renderToStaticMarkup(<InvoicesToolbar params={parseInvoiceListParams({})} filtered={false} />);
    expect(clean).not.toContain('Wyczyść');
  });
});
