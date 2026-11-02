import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-086 (audyt bloku 1): lista faktur pokazywała sztywno 100 najnowszych
 * pozycji — bez wyszukiwania, filtrów i stron. Starszych faktur nie dało się
 * znaleźć. Teraz filtry i stronicowanie idą do bazy (pełny zbiór).
 */

const calls = vi.hoisted(() => [] as Array<[string, unknown[]]>);
const result = vi.hoisted(() => ({ data: [] as unknown[], count: 0 }));

vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order']) {
      chain[m] = (...args: unknown[]) => { calls.push([m, args]); return chain; };
    }
    chain.range = async (...args: unknown[]) => {
      calls.push(['range', args]);
      return { data: result.data, error: null, count: result.count };
    };
    return { supabase: chain, tenantId: 'ten-1' };
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import InvoicesPage from '@/app/(dashboard)/invoices/page';
import {
  amountFromSearch,
  INVOICE_KIND_FILTERS,
  INVOICE_PAGE_SIZES,
  INVOICE_PAYMENT_FILTERS,
  invoiceListHref,
  isFilteredList,
  orFilterString,
  pageRange,
  parseInvoiceListParams,
  paymentFilterSpec,
  sanitizeSearch,
  searchOrFilter,
  type PaymentFilterOp,
} from '@/lib/invoices/list-query';

beforeEach(() => {
  calls.length = 0;
  result.data = [];
  result.count = 0;
});

const called = (m: string) => calls.filter(([name]) => name === m).map(([, args]) => args);

describe('parametry listy z adresu', () => {
  it('domyślnie: bez frazy, wszystkie statusy, strona 1', () => {
    // Lista 1:1 z Finory (21.10.2026): domyślnie „Pokaż 10” (było 50).
    expect(parseInvoiceListParams({})).toEqual({ q: '', status: 'wszystkie', from: null, to: null, page: 1, payment: 'wszystkie', kind: 'wszystkie', perPage: 10 });
  });

  it('odrzuca złe wartości zamiast przekazać je do zapytania', () => {
    expect(parseInvoiceListParams({ status: 'cokolwiek', od: '2026-02-31', do: 'wczoraj', strona: '-3' }))
      // Lista 1:1 z Finory (21.10.2026): domyślne „Pokaż 10” (było 50).
      .toEqual({ q: '', status: 'wszystkie', from: null, to: null, page: 1, payment: 'wszystkie', kind: 'wszystkie', perPage: 10 });
  });

  it('czyta poprawne filtry', () => {
    expect(parseInvoiceListParams({ q: ' FV/1 ', status: 'bledy', od: '2026-09-01', do: '2026-09-30', strona: '2' }))
      // Lista 1:1 z Finory (21.10.2026): domyślne „Pokaż 10” (było 50).
      .toEqual({ q: 'FV/1', status: 'bledy', from: '2026-09-01', to: '2026-09-30', page: 2, payment: 'wszystkie', kind: 'wszystkie', perPage: 10 });
  });
});

describe('fraza wyszukiwania', () => {
  it('usuwa znaki składni filtra i symbole wieloznaczne', () => {
    expect(sanitizeSearch('a,b(c)"d\\e%f*g')).toBe('a b c d e f g');
  });

  it('rozpoznaje kwotę', () => {
    expect(amountFromSearch('1230')).toBe(1230);
    expect(amountFromSearch('1 230,50')).toBe(1230.5);
    expect(amountFromSearch('FV/1')).toBeNull();
  });

  it('tekst: numer i nazwa nabywcy', () => {
    expect(searchOrFilter('Kowalski')).toBe('internal_number.ilike.%Kowalski%,buyer_data->>name.ilike.%Kowalski%');
  });

  it('cyfry: także NIP nabywcy i kwota brutto', () => {
    expect(searchOrFilter('526-000-12-46')).toContain('buyer_nip.ilike.%5260001246%');
    expect(searchOrFilter('1230')).toContain('gross_total.eq.1230.00');
  });

  it('pusta fraza — bez filtra', () => {
    expect(searchOrFilter('  ,() ')).toBeNull();
  });
});

describe('strony i adresy', () => {
  it('zakres wierszy strony', () => {
    // Lista 1:1 z Finory (21.10.2026): strona domyślnie ma 10 pozycji (było 50: 0–49 i 100–149).
    expect(pageRange(1)).toEqual([0, 9]);
    expect(pageRange(3)).toEqual([20, 29]);
  });

  it('adres pomija wartości domyślne', () => {
    const p = parseInvoiceListParams({ q: 'FV', status: 'przyjete' });
    expect(invoiceListHref(p, { page: 2 })).toBe('/invoices?q=FV&status=przyjete&strona=2');
    expect(invoiceListHref(parseInvoiceListParams({}))).toBe('/invoices');
  });
});

describe('P3: płatność, rodzaj i liczba na stronie (PLAN-FINORA §5)', () => {
  it('czyta platnosc, rodzaj i na_stronie', () => {
    expect(parseInvoiceListParams({ platnosc: 'po_terminie', rodzaj: 'advance', na_stronie: '10' }))
      .toMatchObject({ payment: 'po_terminie', kind: 'advance', perPage: 10 });
    expect(parseInvoiceListParams({ platnosc: 'oplacone', rodzaj: 'correction', na_stronie: '25' }))
      .toMatchObject({ payment: 'oplacone', kind: 'correction', perPage: 25 });
    // Lista 1:1 z Finory (21.10.2026): bez na_stronie → domyślne 10 (było 50); nowy rozmiar 5 i 50 czytane wprost.
    expect(parseInvoiceListParams({ platnosc: 'nieoplacone', rodzaj: 'final' }))
      .toMatchObject({ payment: 'nieoplacone', kind: 'final', perPage: 10 });
    expect(parseInvoiceListParams({ na_stronie: '5' }).perPage).toBe(5);
    expect(parseInvoiceListParams({ na_stronie: '50' }).perPage).toBe(50);
    expect(parseInvoiceListParams({ rodzaj: 'regular' }).kind).toBe('regular');
  });

  // Lista 1:1 z Finory (21.10.2026): domyślne „Pokaż 10” zamiast 50 (stare linki z błędną wartością dalej działają).
  it('złe wartości → domyślne (10 na stronie, stare linki działają)', () => {
    expect(parseInvoiceListParams({ platnosc: 'zaplacone', rodzaj: 'VAT', na_stronie: '100' }))
      .toMatchObject({ payment: 'wszystkie', kind: 'wszystkie', perPage: 10 });
    expect(parseInvoiceListParams({ na_stronie: '0' }).perPage).toBe(10);
    expect(parseInvoiceListParams({ na_stronie: '10abc' }).perPage).toBe(10);
    expect(parseInvoiceListParams({ rodzaj: 'wszystkie', platnosc: 'wszystkie' }))
      .toMatchObject({ payment: 'wszystkie', kind: 'wszystkie' });
  });

  it('słowniki filtrów: polskie etykiety, rozmiary 5/10/25/50', () => {
    expect(Object.keys(INVOICE_PAYMENT_FILTERS)).toEqual(['wszystkie', 'oplacone', 'nieoplacone', 'po_terminie']);
    expect(Object.keys(INVOICE_KIND_FILTERS)).toEqual(['wszystkie', 'regular', 'advance', 'correction', 'final']);
    expect(INVOICE_KIND_FILTERS.advance.label).toBe('Zaliczkowa');
    expect(INVOICE_PAYMENT_FILTERS.po_terminie.label).toBe('Po terminie');
    // Lista 1:1 z Finory (21.10.2026): wybór „Pokaż” to 5 / 10 / 25 / 50 (było 10 / 25 / 50).
    expect(INVOICE_PAGE_SIZES).toEqual([5, 10, 25, 50]);
  });

  it('pageRange z rozmiarem strony', () => {
    expect(pageRange(2, 10)).toEqual([10, 19]);
    expect(pageRange(3, 25)).toEqual([50, 74]);
  });

  it('platnosc i rodzaj to filtry, na_stronie nie', () => {
    expect(isFilteredList(parseInvoiceListParams({}))).toBe(false);
    // Lista 1:1 z Finory (21.10.2026): 10 jest teraz domyślne, więc „nie-filtr” sprawdzamy też na wartości niedomyślnej (25).
    expect(isFilteredList(parseInvoiceListParams({ na_stronie: '10' }))).toBe(false);
    expect(isFilteredList(parseInvoiceListParams({ na_stronie: '25' }))).toBe(false);
    expect(isFilteredList(parseInvoiceListParams({ platnosc: 'oplacone' }))).toBe(true);
    expect(isFilteredList(parseInvoiceListParams({ rodzaj: 'final' }))).toBe(true);
  });

  it('adres: nowe parametry, na_stronie=10 (domyślne) pominięte', () => {
    const p = parseInvoiceListParams({ q: 'FV', platnosc: 'po_terminie', rodzaj: 'advance', na_stronie: '25', strona: '2' });
    expect(invoiceListHref(p)).toBe('/invoices?q=FV&platnosc=po_terminie&rodzaj=advance&na_stronie=25&strona=2');
    // Lista 1:1 z Finory (21.10.2026): w adresie pomijane jest domyślne na_stronie=10 (było 50); 50 jest już jawne.
    expect(invoiceListHref(parseInvoiceListParams({ na_stronie: '10' }))).toBe('/invoices');
    expect(invoiceListHref(parseInvoiceListParams({ na_stronie: '50' }))).toBe('/invoices?na_stronie=50');
    expect(invoiceListHref(p, { page: 3 })).toBe('/invoices?q=FV&platnosc=po_terminie&rodzaj=advance&na_stronie=25&strona=3');
  });

  it('zmiana na_stronie zeruje stronę', () => {
    const p = parseInvoiceListParams({ status: 'przyjete', strona: '4', na_stronie: '25' });
    // Lista 1:1 z Finory (21.10.2026): domyślne na_stronie=10 znika z adresu, 50 pojawia się jawnie (było odwrotnie).
    expect(invoiceListHref(p, { perPage: 10 })).toBe('/invoices?status=przyjete');
    expect(invoiceListHref(p, { perPage: 50 })).toBe('/invoices?status=przyjete&na_stronie=50');
    expect(invoiceListHref(p, { perPage: 25 })).toBe('/invoices?status=przyjete&na_stronie=25&strona=4');
    expect(invoiceListHref(p, { perPage: 10, page: 2 })).toBe('/invoices?status=przyjete&strona=2');
  });

  it('zmiana filtra płatności lub rodzaju zeruje stronę', () => {
    const p = parseInvoiceListParams({ strona: '3' });
    expect(invoiceListHref(p, { payment: 'oplacone' })).toBe('/invoices?platnosc=oplacone');
    expect(invoiceListHref(p, { kind: 'final' })).toBe('/invoices?rodzaj=final');
  });

  // Warunki §2.4 pkt 11 dostarcza strona (`receivableBaseFilterOps`); tu
  // sprawdzamy, że filtr płatności zawsze je niesie i wylicza je leniwie.
  const BASE: PaymentFilterOp[] = [
    { op: 'eq', column: 'origin', value: 'app' },
    { op: 'eq', column: 'ksef_status', value: 'accepted' },
  ];
  const base = vi.fn(() => BASE);

  it('filtr płatności → warunki PostgREST (zawsze z warunkami należności)', () => {
    expect(paymentFilterSpec('wszystkie', '2026-10-17', base)).toBeNull();
    expect(base).not.toHaveBeenCalled();
    expect(paymentFilterSpec('oplacone', '2026-10-17', base)).toEqual([
      ...BASE,
      { op: 'eq', column: 'payment_status', value: 'paid' },
    ]);
    expect(paymentFilterSpec('nieoplacone', '2026-10-17', base)).toEqual([
      ...BASE,
      { op: 'in', column: 'payment_status', value: ['unpaid', 'partial', 'overdue'] },
    ]);
  });

  it('po terminie z daty (dziś w Warszawie podane z zewnątrz), nie ze statusu overdue', () => {
    expect(paymentFilterSpec('po_terminie', '2026-10-18', base)).toEqual([
      ...BASE,
      { op: 'lt', column: 'payment_due_date', value: '2026-10-18' },
      { op: 'neq', column: 'payment_status', value: 'paid' },
    ]);
  });

  it('po terminie bez poprawnej daty „dziś” — błąd, nie filtr bez daty', () => {
    expect(() => paymentFilterSpec('po_terminie', '', base)).toThrow();
    expect(() => paymentFilterSpec('po_terminie', '2026-10-17T00:00:00Z', base)).toThrow();
  });

  it('warunek or() z gałęzi: gałąź z kilku warunków → and(...), wartości listy w nawiasie', () => {
    expect(orFilterString([
      [{ op: 'eq', column: 'invoice_kind', value: 'regular' }, { op: 'in', column: 'invoice_type', value: ['VAT', 'UPR'] }],
      [{ op: 'eq', column: 'invoice_kind', value: 'advance' }, { op: 'in', column: 'invoice_type', value: ['ZAL'] }],
    ])).toBe('and(invoice_kind.eq.regular,invoice_type.in.(VAT,UPR)),and(invoice_kind.eq.advance,invoice_type.in.(ZAL))');
    expect(orFilterString([
      [{ op: 'is', column: 'currency', value: null }],
      [{ op: 'eq', column: 'currency', value: 'PLN' }],
    ])).toBe('currency.is.null,currency.eq.PLN');
  });

  it('warunek or() ze znakiem składni w wartości — błąd, nie zepsuty filtr', () => {
    expect(() => orFilterString([[{ op: 'eq', column: 'currency', value: 'PLN,EUR' }]])).toThrow();
    expect(() => orFilterString([[{ op: 'in', column: 'invoice_type', value: ['VAT)'] }]])).toThrow();
  });
});

describe('strona /invoices — zapytanie do bazy', () => {
  it('bez filtrów: pierwsza strona, liczba wszystkich pozycji', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({}) });
    expect(called('select')[0]![1]).toEqual({ count: 'exact' });
    // Lista 1:1 z Finory (21.10.2026): pierwsza strona to 10 pozycji (było 0–49).
    expect(called('range')).toEqual([[0, 9]]);
    expect(called('in')).toEqual([]);
    expect(called('or')).toEqual([]);
  });

  it('filtry trafiają do zapytania, strona 3 → wiersze 20–29', async () => {
    await InvoicesPage({
      searchParams: Promise.resolve({ q: 'FV/1', status: 'przyjete', od: '2026-09-01', do: '2026-09-30', strona: '3' }),
    });
    expect(called('eq')).toEqual(expect.arrayContaining([['tenant_id', 'ten-1'], ['direction', 'outgoing']]));
    expect(called('in')).toEqual([['ksef_status', ['accepted']]]);
    expect(called('gte')).toEqual([['issue_date', '2026-09-01']]);
    expect(called('lte')).toEqual([['issue_date', '2026-09-30']]);
    expect(called('or')).toEqual([['internal_number.ilike.%FV/1%,buyer_data->>name.ilike.%FV/1%']]);
    // Lista 1:1 z Finory (21.10.2026): 10 na stronę, więc strona 3 to wiersze 20–29 (było 100–149).
    expect(called('range')).toEqual([[20, 29]]);
  });

  it('P3: zapytanie niesie kolumny płatności, błędu KSeF i faktów wiersza', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({}) });
    const columns = String(called('select')[0]![0]);
    for (const col of ['payment_status', 'payment_due_date', 'paid_amount', 'currency', 'invoice_kind', 'last_error_code', 'ksef_environment', 'payment_data', 'ksef_number']) {
      expect(columns).toContain(col);
    }
  });

  it('P3: rodzaj → eq(invoice_kind), płatność „opłacone” → zapłacona albo z datą zapłaty z FA(3)', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({ rodzaj: 'advance', platnosc: 'oplacone' }) });
    expect(called('eq')).toEqual(expect.arrayContaining([['invoice_kind', 'advance']]));
    expect(called('or')).toContainEqual(['payment_status.eq.paid,fa3_data->parsed->>paidDate.not.is.null']);
    expect(called('lt')).toEqual([]);
  });

  // Zapłata to fakt bez względu na pochodzenie: „Zapłacone” działa też na imporcie (00158), więc filtr
  // „Opłacone” nie ma warunku `origin` ani rodzaju. Nadal tylko sprzedaż przyjęta w aktywnym środowisku.
  it('„Opłacone” bez warunków należności, ale tylko przyjęta sprzedaż z aktywnego środowiska', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({ platnosc: 'oplacone' }) });
    expect(called('eq')).toEqual(expect.arrayContaining([
      ['direction', 'outgoing'],
      ['ksef_status', 'accepted'],
      ['ksef_environment', 'test'], // KSEF_ENV z vitest.config.ts
    ]));
    expect(called('eq')).not.toContainEqual(['origin', 'app']);
    expect(called('gt')).toEqual([]);
  });

  it('P3: nieopłacone → in(payment_status, unpaid/partial/overdue)', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({ platnosc: 'nieoplacone' }) });
    expect(called('in')).toEqual([['payment_status', ['unpaid', 'partial', 'overdue']]]);
  });

  // C1 (rewizja E3): filtr płatności bez warunków §2.4 pkt 11 listował
  // importy, szkice i korekty jako nieopłacone / po terminie, choć ich wiersze
  // pokazują „—”, a kafel „Do zapłaty” ich nie liczy.
  it.each(['nieoplacone', 'po_terminie'])('C1: filtr %s niesie warunki należności (§2.4 pkt 11)', async (platnosc) => {
    await InvoicesPage({ searchParams: Promise.resolve({ platnosc }) });
    expect(called('eq')).toEqual(expect.arrayContaining([
      ['origin', 'app'],
      ['ksef_status', 'accepted'],
      ['ksef_environment', 'test'], // KSEF_ENV z vitest.config.ts
    ]));
    expect(called('gt')).toContainEqual(['gross_total', 0]);
    expect(called('or')).toEqual(expect.arrayContaining([
      ['currency.is.null,currency.eq.PLN'],
      ['and(invoice_kind.eq.regular,invoice_type.in.(VAT,UPR)),and(invoice_kind.eq.advance,invoice_type.in.(ZAL)),and(invoice_kind.eq.final,invoice_type.in.(ROZ))'],
    ]));
  });

  it('C1: bez filtra płatności lista nie zawęża się do należności', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({}) });
    expect(called('eq')).not.toContainEqual(['origin', 'app']);
    expect(called('gt')).toEqual([]);
  });

  it('C1: wyszukiwanie i warunki należności to osobne or() (PostgREST łączy je przez AND)', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({ q: 'FV/1', platnosc: 'po_terminie' }) });
    expect(called('or')).toContainEqual(['internal_number.ilike.%FV/1%,buyer_data->>name.ilike.%FV/1%']);
    expect(called('or')).toHaveLength(3);
  });

  it('P3: po terminie liczone z daty (dziś w Warszawie), nie ze statusu overdue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T22:30:00Z')); // 18.10 00:30 w Warszawie
    try {
      await InvoicesPage({ searchParams: Promise.resolve({ platnosc: 'po_terminie' }) });
    } finally {
      vi.useRealTimers();
    }
    expect(called('lt')).toEqual([['payment_due_date', '2026-10-18']]);
    expect(called('neq')).toEqual([['payment_status', 'paid']]);
    expect(called('eq')).not.toContainEqual(['payment_status', 'overdue']);
  });

  it('P3: na_stronie ustala zakres wierszy (10 → strona 2 = 10–19)', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({ na_stronie: '10', strona: '2' }) });
    expect(called('range')).toEqual([[10, 19]]);
  });

  // Lista 1:1 z Finory (21.10.2026): 10 jest teraz domyślne, więc samo „10 → 10–19” nie dowodzi,
  // że na_stronie jest czytane — dopisane sprawdzenie na wartościach niedomyślnych (5 i 25).
  it('P3: na_stronie niedomyślne ustala zakres wierszy (25 → strona 2 = 25–49, 5 → strona 3 = 10–14)', async () => {
    await InvoicesPage({ searchParams: Promise.resolve({ na_stronie: '25', strona: '2' }) });
    expect(called('range')).toEqual([[25, 49]]);
    calls.length = 0;
    await InvoicesPage({ searchParams: Promise.resolve({ na_stronie: '5', strona: '3' }) });
    expect(called('range')).toEqual([[10, 14]]);
  });
});
