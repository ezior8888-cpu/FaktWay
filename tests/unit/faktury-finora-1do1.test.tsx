// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora E3b: /invoices i /invoices/[id] wiernie jak Finora.
 *
 *  - kafle = JEDNA karta `StatsCards` (dwie grupy po dwie statystyki,
 *    separatory), każda statystyka w osobnym slocie (§2.4 pkt 15), kwoty
 *    skrócone z pełną kwotą w `title`, treść wyjątku przez `pulpitErrorMessage`;
 *  - pasek narzędzi w klasach Finory; pole paczki PDF nie należy do formularza filtrów;
 *  - tabela: wiersz nagłówka `h-14 border-t`, daty DD.MM.RRRR, plakietka KSeF
 *    w stylu `Badge` Finory (bez `--ff-*`);
 *  - „Wyślij e-mailem” to arkusz Finory z polem „Do” (adres nabywcy z dokumentu).
 *
 * Wzór: `tests/unit/lista-faktur-ekran.test.tsx` (dane liczy `lib/**`, tu widok).
 */

const stats = vi.hoisted(() => ({
  countContractors: vi.fn(),
  countInvoicesThisMonth: vi.fn(),
  paidThisMonth: vi.fn(),
  getReceivables: vi.fn(),
}));
const email = vi.hoisted(() => ({ emailInvoiceAction: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

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
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/invoices/actions-detail', () => ({
  downloadInvoiceXmlAction: vi.fn(),
  emailInvoiceAction: email.emailInvoiceAction,
}));
vi.mock('@/components/invoices/draft-actions', () => ({ deleteDraftInvoiceAction: vi.fn() }));

import {
  ContractorsTile,
  PaidThisMonthTile,
  ReceivablesTile,
  StatCell,
  StatsCardsGrid,
} from '@/app/(dashboard)/invoices/_components/invoice-stat-tiles';
import { InvoicesTable } from '@/app/(dashboard)/invoices/_components/invoices-table';
import { InvoicesToolbar } from '@/app/(dashboard)/invoices/_components/invoices-toolbar';
import InvoiceNotFound from '@/app/(dashboard)/invoices/[id]/not-found';
import { EmailInvoiceButton } from '@/components/invoices/email-invoice-button';
import type { InvoiceRow } from '@/components/invoices/invoice-row-types';
import { StatusBadge } from '@/components/invoices/status-badge';
import { BatchPdfDownload } from '@/components/invoices/batch-pdf-download';
import { PaymentIndicator } from '@/app/(dashboard)/invoices/_components/payment-indicator';
import { PULPIT_GENERIC_ERROR } from '@/components/dashboard/pulpit/pulpit-grid';
import { formatPlCompactMoney, formatPlMoney } from '@/lib/format/pl';
import { formatInvoiceDate } from '@/lib/invoices/display-date';
import { parseInvoiceListParams } from '@/lib/invoices/list-query';
import type { InvoiceListRowFacts } from '@/lib/invoices/list-row-facts';
import { RiUserLine } from '@remixicon/react';
import { tekstBezZnacznikow } from './helpers/tekst-html';

const tile = { supabase: {} as never, tenantId: 'ten-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('podgląd: brak faktury (Finora „Invoice Not Found”)', () => {
  it('Empty z tytułem, opisem i linkiem do listy, w panelu', () => {
    const html = renderToStaticMarkup(<InvoiceNotFound />);
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain('Nie znaleziono faktury');
    expect(html).toMatch(/<a[^>]*href="\/invoices"[^>]*>Wróć do listy faktur<\/a>/);
  });
});

describe('formatInvoiceDate (§7.1: DD.MM.RRRR)', () => {
  it('data z bazy, znacznik czasu, brak i coś, co nie jest datą', () => {
    expect(formatInvoiceDate('2026-10-02')).toBe('02.10.2026');
    expect(formatInvoiceDate('2026-10-02T05:12:33Z')).toBe('02.10.2026');
    expect(formatInvoiceDate(null)).toBe('—');
    expect(formatInvoiceDate(undefined)).toBe('—');
    expect(formatInvoiceDate('')).toBe('—');
    expect(formatInvoiceDate('wkrótce')).toBe('wkrótce');
  });
});

describe('kafle: jedna karta StatsCards Finory', () => {
  const cell = (key: string, label: string) => ({
    key,
    node: <StatCell label={label} value="1" icon={RiUserLine} />,
  });

  it('jedna karta, dwie grupy po dwie statystyki, separatory jak w `views/stats-cards.tsx`', () => {
    const div = document.createElement('div');
    div.innerHTML = renderToStaticMarkup(
      <StatsCardsGrid cells={[cell('a', 'A'), cell('b', 'B'), cell('c', 'C'), cell('d', 'D')]} />,
    );
    expect(div.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    const row = div.querySelector('[data-slot="card-content"] > div') as HTMLElement;
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'gap-5', 'max-xl:flex-col']));
    const groups = [...row.children].filter((el) => el.className.includes('max-sm:flex-col'));
    expect(groups).toHaveLength(2);
    // Separator między grupami (poziomy < xl, pionowy od xl) i w każdej grupie (poziomy < sm, pionowy od sm).
    expect(div.querySelectorAll('[data-slot="separator"]').length).toBe(6);
    for (const label of ['A', 'B', 'C', 'D']) expect(div.textContent).toContain(label);
  });

  it('komórka: wartość text-2xl, etykieta, ikona po prawej w kwadracie bg-muted', () => {
    const html = renderToStaticMarkup(<StatCell label="Kontrahenci" value="12" icon={RiUserLine} />);
    expect(html).toMatch(/<h4 class="text-foreground text-2xl font-medium tabular-nums"[^>]*>12<\/h4>/);
    expect(html.indexOf('Kontrahenci')).toBeLessThan(html.indexOf('bg-muted flex size-10'));
  });

  it('kwota skrócona (tys. zł), pełna kwota w title', async () => {
    stats.paidThisMonth.mockResolvedValue(45678.9);
    const html = renderToStaticMarkup(await PaidThisMonthTile(tile));
    expect(html).toContain(`>${formatPlCompactMoney(45678.9)}<`);
    expect(html).toContain(`title="${formatPlMoney(45678.9)} zł"`);
  });

  it('pusty stan „Opłacone” bez kwoty i bez title', async () => {
    stats.paidThisMonth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await PaidThisMonthTile(tile));
    expect(html).toContain('>—<');
    expect(html).not.toContain('title=');
  });

  it('błąd odczytu z ogonem PostgREST-a: klient widzi polską część, bez angielskiego tekstu', async () => {
    stats.getReceivables.mockRejectedValue(
      new Error('Nie można odczytać należności: permission denied for table invoices'),
    );
    const html = renderToStaticMarkup(await ReceivablesTile(tile));
    expect(html).toContain('Nie można odczytać należności');
    expect(html).not.toContain('permission denied');
    expect(html).toContain('href="/przeplywy"');
  });

  it('błąd programu: ogólny komunikat, nie treść wyjątku', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stats.countContractors.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'count')"));
    const html = renderToStaticMarkup(await ContractorsTile(tile));
    expect(html).toContain(PULPIT_GENERIC_ERROR);
    expect(html).not.toContain('Cannot read');
    spy.mockRestore();
  });
});

describe('pasek narzędzi w klasach Finory', () => {
  const div = document.createElement('div');
  div.innerHTML = renderToStaticMarkup(<InvoicesToolbar params={parseInvoiceListParams({})} filtered={false} />);
  const form = div.querySelector('form') as HTMLFormElement;

  // Lista 1:1 z Finory (21.10.2026): klasy Finory są na rzędzie wewnątrz formularza (nie na samym <form>),
  // a pod rzędem jest zwinięty panel `filtry-faktur` z pozostałymi filtrami i paczką PDF za miesiąc.
  it('rząd Finory: lewa grupa (Pokaż, Wystaw fakturę), prawa (szukaj, status, przycisk filtrów)', () => {
    const [row] = [...form.children] as HTMLElement[];
    expect(row?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex', 'gap-6', 'p-4', 'pt-0', 'max-lg:flex-col', 'lg:items-center', 'lg:justify-between']),
    );
    const [left, right] = [...(row?.children ?? [])] as HTMLElement[];
    expect(left?.textContent).toContain('Pokaż');
    expect(left?.querySelector('a[href="/invoices/new"]')?.textContent).toBe('Wystaw fakturę');
    // PDF za miesiąc nie stoi już w lewej grupie (jest w panelu filtrów).
    expect(left?.textContent).not.toContain('PDF za miesiąc');
    expect(right?.className).toContain('lg:justify-end');
    expect(right?.querySelector('input[name="q"]')).not.toBeNull();
    expect(right?.textContent).toContain('Status KSeF');
    // Filtry dodatkowe nie są w prawej grupie rzędu — tylko status i przycisk „Filtry”.
    expect(right?.querySelector('input[name="platnosc"]')).toBeNull();
    expect(right?.querySelector('input[name="rodzaj"]')).toBeNull();
    expect(right?.querySelector('input[name="od"]')).toBeNull();
    expect(right?.querySelector('button[type="submit"]')).toBeNull();
  });

  it('przycisk „Filtry” (ikona) steruje zwiniętym panelem `filtry-faktur` w tym samym formularzu GET', () => {
    const toggle = form.querySelector('button[aria-controls="filtry-faktur"]');
    expect(toggle?.getAttribute('aria-label')).toBe('Filtry');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('type')).toBe('button');
    const panel = form.querySelector('#filtry-faktur') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.hasAttribute('hidden')).toBe(true);
    // Panel jest w formularzu (Enter w wyszukiwarce nie gubi płatności, rodzaju ani dat) i niesie resztę filtrów.
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('action')).toBe('/invoices');
    expect(panel.parentElement).toBe(form);
    for (const name of ['platnosc', 'rodzaj', 'od', 'do']) {
      expect(panel.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect(panel.textContent).toContain('Płatność');
    expect(panel.textContent).toContain('Rodzaj');
    expect([...panel.querySelectorAll('button[type="submit"]')].map((b) => b.textContent)).toEqual(['Filtruj']);
    // PDF za miesiąc to teraz część panelu filtrów.
    expect(panel.querySelector('#batch-month')).not.toBeNull();
  });

  it('pole miesiąca paczki PDF nie należy do formularza filtrów (bez name, z obcym `form`)', () => {
    const month = div.querySelector('#batch-month') as HTMLInputElement;
    expect(month).not.toBeNull();
    expect(month.getAttribute('name')).toBeNull();
    expect(month.getAttribute('form')).toBe('paczka-pdf-za-miesiac');
    const zip = [...div.querySelectorAll('button')].find((b) => b.textContent?.includes('ZIP'));
    expect(zip?.getAttribute('type')).toBe('button');
  });
});

function invoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv-1',
    internal_number: 'FV/1/2026',
    issue_date: '2026-10-01',
    buyer_data: { name: 'Acme sp. z o.o.', nip: '1234567890' },
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

describe('tabela Finory', () => {
  const render = (rows: InvoiceRow[], f: Record<string, InvoiceListRowFacts>) => {
    const div = document.createElement('div');
    div.innerHTML = renderToStaticMarkup(
      <InvoicesTable
        invoices={rows}
        facts={f}
        today="2026-10-17"
        selectedIds={new Set()}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
      />,
    );
    return div;
  };

  it('nagłówek `h-14 border-t`, komórki `h-14`, kolumna akcji wyśrodkowana', () => {
    const div = render([invoice()], { 'inv-1': facts() });
    const head = div.querySelector('thead tr') as HTMLElement;
    expect(head.className).toContain('h-14');
    expect(head.className).toContain('border-t');
    const ths = [...div.querySelectorAll('th')];
    expect(ths.map((th) => th.textContent)).toEqual(['', 'Numer', 'Płatność', 'Nabywca', 'Brutto', 'Wystawiona', 'Termin', 'Do zapłaty', 'Akcje']);
    expect(ths[ths.length - 1]?.className).toContain('last:text-center');
    expect(div.querySelector('tbody td')?.className).toContain('h-14');
  });

  it('daty DD.MM.RRRR (wystawienie i termin), nie ISO z bazy', () => {
    const text = render([invoice()], { 'inv-1': facts() }).textContent ?? '';
    expect(text).toContain('01.10.2026');
    expect(text).toContain('15.10.2026');
    expect(text).not.toContain('2026-10-01');
  });

  it('brak terminu: „—”', () => {
    const text = render([invoice({ payment_due_date: null })], { 'inv-1': facts({ payment: null, outstanding: null }) }).textContent;
    expect(text).toContain('—');
  });

  it('płatność w kółku Avatar Finory (opłacona: zielone ✓, po terminie: czerwony)', () => {
    const paid = render([invoice({ payment_status: 'paid' })], { 'inv-1': facts({ payment: 'paid', outstanding: 0 }) });
    expect(paid.querySelector('[data-slot="avatar"][title="Opłacona"]')).not.toBeNull();
    const overdue = render([invoice()], { 'inv-1': facts({ payment: 'overdue' }) });
    const fallback = overdue.querySelector('[data-slot="avatar"][title="Po terminie"] [data-slot="avatar-fallback"]');
    expect(fallback?.className).toContain('bg-destructive/10');
  });
});

describe('plakietka KSeF w stylu Badge Finory', () => {
  it('przyjęta: zielona, `h-auto rounded-sm`, bez zmiennych --ff-*', () => {
    const html = renderToStaticMarkup(<StatusBadge status="accepted" />);
    expect(html).toContain('Zaakceptowana');
    expect(html).toContain('h-auto');
    expect(html).toContain('rounded-sm');
    expect(html).toContain('bg-green-600/10');
    expect(html).not.toMatch(/--ff-|ff-/);
  });

  it('w kolejce: spinner, bez kropki', () => {
    const html = renderToStaticMarkup(<StatusBadge status="queued" />);
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('rounded-full');
  });

  it('błąd treści: czerwona (destructive)', () => {
    const html = renderToStaticMarkup(<StatusBadge status="rejected" />);
    expect(html).toContain('bg-destructive/10');
    expect(html).toContain('Odrzucona');
  });
});

describe('„Wyślij e-mailem” — arkusz Finory', () => {
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

  const openSheet = (defaultEmail: string | null) => {
    act(() => root.render(<EmailInvoiceButton invoiceId="inv-1" defaultEmail={defaultEmail} />));
    const trigger = host.querySelector('button') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Wyślij e-mailem');
    act(() => trigger.click());
    const sheet = document.body.querySelector('[data-slot="sheet-content"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    return sheet;
  };

  const submit = async (sheet: HTMLElement) => {
    const send = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Wyślij');
    expect(send?.getAttribute('form')).toBe(sheet.querySelector('form')?.id);
    await act(async () => {
      sheet.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  it('pole „Do” z adresem nabywcy, plakietka załącznika, tytuł po polsku', () => {
    const sheet = openSheet('klient@example.com');
    expect((sheet.querySelector('input[type="email"]') as HTMLInputElement).value).toBe('klient@example.com');
    expect(sheet.textContent).toContain('Faktura w załączniku (PDF)');
    expect(sheet.querySelector('[data-slot="sheet-title"]')?.textContent).toBe('Wyślij e-mailem');
    // Bez pól, które niczego by nie zmieniły (nadawca, temat i treść są po stronie serwera).
    expect(sheet.querySelectorAll('input, textarea')).toHaveLength(1);
  });

  it('wysyłka woła akcję serwera z adresem z pola i zamyka arkusz', async () => {
    email.emailInvoiceAction.mockResolvedValue({ success: true });
    const sheet = openSheet('klient@example.com');
    await submit(sheet);
    expect(email.emailInvoiceAction).toHaveBeenCalledWith('inv-1', 'klient@example.com');
    expect(toast.success).toHaveBeenCalledWith('Faktura wysłana.');
  });

  it('zły adres: komunikat przy polu, bez wywołania akcji', async () => {
    const sheet = openSheet(null);
    const input = sheet.querySelector('input[type="email"]') as HTMLInputElement;
    expect(input.value).toBe('');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'nie-adres');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit(sheet);
    expect(email.emailInvoiceAction).not.toHaveBeenCalled();
    expect(sheet.textContent).toContain('Podaj poprawny adres e-mail.');
  });

  it('odmowa serwera: toast z treścią odmowy, arkusz zostaje', async () => {
    email.emailInvoiceAction.mockResolvedValue({ success: false, error: 'Osiągnięto limit 30 wysyłek faktur mailem na godzinę. Spróbuj później.' });
    const sheet = openSheet('klient@example.com');
    await submit(sheet);
    expect(toast.error).toHaveBeenCalledWith('Osiągnięto limit 30 wysyłek faktur mailem na godzinę. Spróbuj później.');
    expect(document.body.querySelector('[data-slot="sheet-content"]')).not.toBeNull();
  });
});

describe('dostępność poprawek E (WCAG)', () => {
  it('paczka PDF: widoczny tekst przycisku opisuje cel (3.3.2), nie samo „ZIP”', () => {
    const html = renderToStaticMarkup(<BatchPdfDownload />);
    const button = html.match(/<button[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(tekstBezZnacznikow(button)).toContain('PDF za miesiąc');
  });

  it('ikony płatności w kółku: jasny motyw w odcieniu 700 (kontrast 1.4.11), dark bez zmian', () => {
    const paid = renderToStaticMarkup(<PaymentIndicator state="paid" />);
    const unpaid = renderToStaticMarkup(<PaymentIndicator state="unpaid" />);
    expect(paid).toMatch(/\btext-green-700\b/);
    expect(paid).not.toMatch(/\btext-green-600\b/);
    expect(paid).toContain('dark:text-green-400');
    expect(unpaid).toMatch(/\btext-amber-700\b/);
    expect(unpaid).not.toMatch(/\btext-amber-600\b/);
    expect(unpaid).toContain('dark:text-amber-400');
  });

  it('arkusz e-mail: pole „Do” nazwane widoczną etykietą, bez aria-label (2.5.3)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(host);
    act(() => root.render(<EmailInvoiceButton invoiceId="inv-1" defaultEmail="a@b.pl" />));
    act(() => (host.querySelector('button') as HTMLButtonElement).click());
    const input = document.body.querySelector('input[type="email"]') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
