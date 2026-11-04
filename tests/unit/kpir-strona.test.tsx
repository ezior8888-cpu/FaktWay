import { Children, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: vi.fn() }));
// Strona KPiR pyta o tryb danych (dane przykładowe przed weryfikacją KSeF) — tu firma zweryfikowana.
vi.mock('@/lib/demo/tryb-danych', () => ({ trybDanych: async () => ({ tryb: 'prawdziwe', stan: 'C', verifiedAt: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: mocks.db(), tenantId: 'firma-a' }),
}));

import KpirPage from '@/app/(dashboard)/reports/kpir/page';
import { KpirBlocked } from '@/components/reports/kpir/kpir-blocked';
import { blockingSaleInvoices } from '@/components/reports/kpir/kpir-model';
import { KpirToolbar } from '@/components/reports/kpir/kpir-toolbar';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * Strona KPiR na prawdziwej ścieżce odczytu (`getKpirData` na bazie
 * w pamięci). Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości):
 * - waluta nie do potwierdzenia → pasek miesiąca i „Raport wstrzymany”
 *   w karcie z zakładkami, z linkami do faktur, które to powodują — i bez
 *   żadnej kwoty w złotych;
 * - błąd odczytu zaliczek ROZ → baner z tytułem bez technicznego ogona,
 *   księga dalej widoczna, ROZ z „zaliczek nie odczytano”, bez marży;
 * - powłoka `ff-page-fill`, a `KpirView` jedynym dzieckiem z liczbowym `month`.
 */

function faktura(o: Row): Row {
  return {
    tenant_id: 'firma-a', direction: 'outgoing', invoice_kind: 'regular', ksef_status: 'accepted', ksef_environment: 'test',
    issue_date: '2026-09-10', sale_date: null, net_total: 0, vat_total: 0, gross_total: 0, currency: 'PLN',
    advance_invoice_ids: [], buyer_data: { name: 'Klient', nip: '1234567890' },
    ...o,
  };
}

function wydatek(o: Row): Row {
  return {
    tenant_id: 'firma-a', source: 'manual', ksef_invoice_id: null, is_deductible: true, issue_date: '2026-09-12',
    seller_name: 'Dostawca', seller_nip: '5260001246', document_number: 'ZAK/1', category_label: 'Paliwo',
    kpir_column: 'col_13', net_amount: 300, vat_amount: 69, gross_amount: 369, vat_deductible_amount: 69,
    document_type: 'invoice',
    ...o,
  };
}

/** Zapytanie o zaliczki ROZ (`fetchSettledAdvancesNet`) kończy się błędem bazy; reszta jak w pamięci. */
function failingAdvances(tables: MemoryTables) {
  const client = memoryClient(tables);
  type Query = { eq: (key: string, value: unknown) => Query; then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise<unknown> };
  return {
    from(table: string) {
      const query = client.from(table) as unknown as Query;
      if (table !== 'invoices') return query;
      let advances = false;
      const eq = query.eq;
      const then = query.then;
      query.eq = (key, value) => {
        if (key === 'invoice_kind' && value === 'advance') advances = true;
        return eq(key, value);
      };
      query.then = (ok, fail) => advances
        ? Promise.resolve({ data: null, error: { message: 'awaria odczytu' }, count: null }).then(ok, fail)
        : then(ok, fail);
      return query;
    },
  };
}

const wrzesien = { month: '9', year: '2026' };

beforeEach(() => {
  mocks.db.mockReset();
});

describe('strona KPiR', () => {
  it('sprzedaż w EUR: „Raport wstrzymany” z linkiem do faktury, przełącznik miesiąca, bez złotych', async () => {
    mocks.db.mockReturnValue(memoryClient({
      invoices: [
        faktura({ id: 'fv-eur', internal_number: 'FV/7/2026', currency: 'EUR', net_total: 1000, gross_total: 1230 }),
        faktura({ id: 'fv-pln', internal_number: 'FV/8/2026', net_total: 500, gross_total: 615 }),
      ],
      expenses: [wydatek({ id: 'k1' })],
    }));

    const page = await KpirPage({ searchParams: Promise.resolve(wrzesien) });
    const html = renderToStaticMarkup(page);

    // Zawartość zakładki (`.ff-tab-panel`); pełny arkusz daje `reports/layout.tsx`.
    expect(page.props.className).toContain('ff-tab-panel');
    expect(html).toContain('Raport wstrzymany');
    // Powód bez powtórzonego przedrostka, z wielkiej litery.
    expect(html).not.toContain('Raport wstrzymany:');
    expect(html).toContain('Faktura sprzedaży nie ma potwierdzonej waluty PLN');
    expect(html).toContain('href="/invoices/fv-eur"');
    expect(html).toContain('FV/7/2026');
    expect(html).not.toContain('href="/invoices/fv-pln"');
    expect(html).toContain('href="/invoices"');
    expect(html).toContain('aria-label="Miesiąc KPiR"');
    expect(html).toContain('Wrzesień 2026');
    // Zakładki Księgowości są w `reports/layout.tsx` (od 25.10.2026), nie w stronie.
    expect(html).not.toContain('aria-label="Księgowość"');
    // Żadnych kwot: ani karty wyniku, ani pierścienia, ani wierszy, ani eksportu.
    expect(html).not.toContain('zł');
    expect(html).not.toContain('Eksport KPiR');
    expect(html).not.toContain('Dochód');
    // Test strefy czasowej szuka `KpirView` po `month` — w blokadzie nikt go nie ma.
    const children = Children.toArray(page.props.children) as ReactElement<{ month?: unknown }>[];
    expect(children.some((child) => child.props?.month !== undefined)).toBe(false);
  });

  it('błąd odczytu zaliczek ROZ: baner z tytułem bez ogona, księga zostaje, bez marży', async () => {
    mocks.db.mockReturnValue(failingAdvances({
      invoices: [
        faktura({ id: 'zal-1', internal_number: 'ZAL/1', invoice_kind: 'advance', issue_date: '2026-05-10', net_total: 1000 }),
        faktura({ id: 'roz-1', internal_number: 'ROZ/1', invoice_kind: 'final', net_total: 5000, advance_invoice_ids: ['zal-1'] }),
        faktura({ id: 'fv-1', internal_number: 'FV/1', issue_date: '2026-09-12', net_total: 2000 }),
      ],
      expenses: [wydatek({ id: 'k1' })],
    }));

    const page = await KpirPage({ searchParams: Promise.resolve(wrzesien) });
    const html = renderToStaticMarkup(page);

    // Zawartość zakładki (`.ff-tab-panel`); pełny arkusz daje `reports/layout.tsx`.
    expect(page.props.className).toContain('ff-tab-panel');
    expect(html).toContain('Nie można odczytać zaliczek rozliczonych fakturą końcową');
    expect(html).not.toContain('awaria odczytu');
    expect(html).toContain('Kwoty faktur rozliczeniowych mogą być zawyżone.');
    expect(html).toContain('Odśwież');
    // Księga dalej jest — z uczciwym dopiskiem przy ROZ zamiast „minus zaliczki 0,00”.
    expect(html).toContain('Nr dowodu');
    expect(html).toContain('ROZ/1');
    expect(html).toContain('zaliczek nie odczytano');
    expect(html).not.toContain('minus zaliczki');
    expect(html).toContain('może być zawyżony');
    expect(html).not.toContain('Marża');
  });

  it('zwykły miesiąc: KpirView jedynym dzieckiem z liczbowym `month`, marża i eksport', async () => {
    mocks.db.mockReturnValue(memoryClient({
      invoices: [faktura({ id: 'fv-1', internal_number: 'FV/1', net_total: 2000, gross_total: 2460 })],
      expenses: [wydatek({ id: 'k1' })],
    }));

    const page = await KpirPage({ searchParams: Promise.resolve(wrzesien) });
    const children = Children.toArray(page.props.children) as ReactElement<{ month?: unknown; year?: unknown }>[];
    const withMonth = children.filter((child) => child.props?.month !== undefined);
    expect(withMonth).toHaveLength(1);
    expect(withMonth[0]!.props).toMatchObject({ month: 9, year: 2026 });
    // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): Next 16
    // trzyma stan strony bez parametrów adresu, więc bez klucza segment
    // „Do sprawdzenia” i filtr kolumny przechodziły na następny miesiąc.
    expect(String(withMonth[0]!.key)).toContain('2026-09');

    const html = renderToStaticMarkup(page);
    expect(html).toContain('<h1 class="sr-only">Książka przychodów i rozchodów</h1>');
    // 2000 − 300 = 1700 → 85%.
    expect(html).toContain('Marża 85%');
    expect(html).toContain('href="/reports/exports?period=2026-09&amp;format=kpir_excel"');
    expect(html).not.toContain('Raport wstrzymany');
  });
});

describe('strona KPiR — dwie przyczyny blokady naraz', () => {
  it('koszt KSeF w EUR bez przeglądu i sprzedaż w EUR: wyjście do kosztów i do faktury', async () => {
    mocks.db.mockReturnValue(memoryClient({
      invoices: [
        faktura({ id: 'fv-eur', internal_number: 'FV/7/2026', currency: 'EUR', net_total: 1000, gross_total: 1230 }),
        // Faktura zakupu ze skrzynki KSeF, do której należy koszt.
        faktura({ id: 'zak-eur', internal_number: 'ZAK/EUR/1', direction: 'incoming', currency: 'EUR' }),
      ],
      expenses: [wydatek({ id: 'k-ksef', source: 'ksef_inbox', ksef_invoice_id: 'zak-eur', is_reviewed: false, ocr_extracted_data: null })],
    }));

    const html = renderToStaticMarkup(await KpirPage({ searchParams: Promise.resolve(wrzesien) }));

    // Komunikat mówi o koszcie — musi być wyjście do kosztów, nie tylko do faktur.
    expect(html).toContain('Koszt ze skrzynki KSeF nie ma potwierdzonej waluty');
    expect(html).toContain('href="/expenses?miesiac=2026-09"');
    expect(html).toContain('href="/inbox"');
    expect(html).toContain('href="/invoices/fv-eur"');
    expect(html).not.toContain('zł');
  });
});

describe('KpirBlocked — wyjście z blokady', () => {
  it('koszt KSeF i faktury w obcej walucie naraz: oba wyjścia (poprawka 21.10.2026)', () => {
    const html = renderToStaticMarkup(
      <KpirBlocked
        message={new KsefExpenseCurrencyNotSupportedError().message}
        period="2026-09"
        blockingInvoices={blockingSaleInvoices([{ id: 'inv-1', internal_number: 'FV/1/09/2026', currency: 'EUR' } as never])}
      />,
    );
    expect(html).toContain('href="/expenses?miesiac=2026-09"');
    expect(html).toContain('Koszty miesiąca');
    expect(html).toContain('href="/inbox"');
    expect(html).toContain('href="/invoices/inv-1"');
    expect(html).toContain('FV/1/09/2026');
    expect(html).toContain('href="/invoices"');
  });

  it('linki wyjścia wyglądają jak przyciski: bez `border-transparent` obok obramowania (jasny motyw)', () => {
    // `buttonVariants` bez `cn()` zostawiał w klasie i `border-transparent`
    // (baza cva), i `border-border` (wariant) — w CSS wygrywał przezroczysty.
    for (const blockingInvoices of [[], [{ id: 'a', number: 'FV/a' }]]) {
      for (const message of [new KsefExpenseCurrencyNotSupportedError().message, 'Raport wstrzymany: faktura sprzedaży nie ma potwierdzonej waluty PLN.']) {
        const html = renderToStaticMarkup(<KpirBlocked message={message} period="2026-09" blockingInvoices={blockingInvoices} />);
        const outline = [...html.matchAll(/<a [^>]*class="([^"]*)"/g)]
          .map((m) => m[1]!.split(/\s+/))
          .filter((cls) => cls.includes('border-border'));
        // Co najmniej jeden link obrysowany (Skrzynka KSeF / faktury); żaden z dwoma kolorami ramki.
        expect(outline.length).toBeGreaterThan(0);
        for (const cls of outline) {
          expect(cls).not.toContain('border-transparent');
        }
      }
    }
  });

  it('koszt KSeF bez przeliczenia: koszty miesiąca i Skrzynka KSeF', () => {
    const html = renderToStaticMarkup(
      <KpirBlocked
        message="Raport wstrzymany: koszt ze skrzynki KSeF nie ma potwierdzonej waluty lub przeliczenia PLN. Sprawdź historyczne wydatki."
        period="2026-09"
        blockingInvoices={[]}
      />,
    );
    expect(html).toContain('Koszt ze skrzynki KSeF nie ma potwierdzonej waluty');
    expect(html).toContain('href="/expenses?miesiac=2026-09"');
    expect(html).toContain('Koszty miesiąca');
    expect(html).toContain('href="/inbox"');
    expect(html).toContain('Skrzynka KSeF');
    expect(html).not.toContain('href="/invoices');
  });

  it('najwyżej trzy faktury jako linki, dalej „Faktury”', () => {
    const html = renderToStaticMarkup(
      <KpirBlocked
        message="Raport wstrzymany: faktura sprzedaży nie ma potwierdzonej waluty PLN."
        period="2026-09"
        blockingInvoices={['a', 'b', 'c', 'd'].map((id) => ({ id, number: `FV/${id}` }))}
      />,
    );
    expect(html.match(/href="\/invoices\/[a-d]"/g)).toEqual(['href="/invoices/a"', 'href="/invoices/b"', 'href="/invoices/c"']);
    expect(html).toContain('href="/invoices"');
    expect(html).not.toContain('Koszty miesiąca');
  });
});

describe('KpirToolbar — poprzedni i następny miesiąc', () => {
  // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): lista
  // miesięcy sięga 24 miesiące wstecz — strzałki prowadzą dalej, jak dawne
  // przyciski „Poprzedni / Następny miesiąc”.
  it('strzałki prowadzą poza listę 24 miesięcy, także przez przełom roku', () => {
    const html = renderToStaticMarkup(<KpirToolbar period="2024-11" currentMonth="2026-10" monthTitle="Listopad 2024" />);
    expect(html).toMatch(/<a [^>]*href="\/reports\/kpir\?month=10&amp;year=2024"[^>]*aria-label="Poprzedni miesiąc"|<a [^>]*aria-label="Poprzedni miesiąc"[^>]*href="\/reports\/kpir\?month=10&amp;year=2024"/);
    expect(html).toContain('href="/reports/kpir?month=12&amp;year=2024"');
    expect(html).toContain('aria-label="Następny miesiąc"');

    const styczen = renderToStaticMarkup(<KpirToolbar period="2026-01" currentMonth="2026-10" monthTitle="Styczeń 2026" />);
    expect(styczen).toContain('href="/reports/kpir?month=12&amp;year=2025"');
    expect(styczen).toContain('href="/reports/kpir?month=2&amp;year=2026"');
  });
});
