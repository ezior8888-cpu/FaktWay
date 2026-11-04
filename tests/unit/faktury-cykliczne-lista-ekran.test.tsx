import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora E9 / P6: ekran `/invoices/recurring` w układzie
 * `invoices-recurring` Finory — tabela od `lg` (kolumny, plakietki statusu,
 * „Wystaw teraz” jako link), karty poniżej `lg`, sortowanie z `aria-sort`,
 * pusty stan z przyciskiem „+ Nowa faktura cykliczna”. Dane (kwoty, daty,
 * status) liczy warstwa danych; tu sprawdzamy, co z nich widzi człowiek.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/recurring-invoices', () => ({
  createRecurringInvoiceAction: vi.fn(),
  updateRecurringInvoiceAction: vi.fn(),
  pauseRecurringInvoiceAction: vi.fn(),
  resumeRecurringInvoiceAction: vi.fn(),
  deleteRecurringInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/recurring-invoice-templates', () => ({ searchRecurringTemplatesAction: vi.fn() }));

import { RecurringInvoicesView } from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-invoices-view';
import {
  RECURRING_STATUS_STYLES,
  RecurringStatusBadge,
} from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-status-badge';
import type { RecurringInvoiceListItem } from '@/lib/invoices/recurring/queries';

const ID_A = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
const ID_B = '4b3c2d1e-0f9a-4b8c-9d7e-6f5a4b3c2d1e';
const ID_C = '5c4d3e2f-1a0b-4c9d-8e8f-7a6b5c4d3e2f';
const TPL = '7f1c2d3e-4b5a-4c6d-8e7f-901234567890';

function item(overrides: Partial<RecurringInvoiceListItem> = {}): RecurringInvoiceListItem {
  return {
    id: ID_A,
    tenant_id: 'firma-a',
    template_invoice_id: TPL,
    name: 'Abonament Acme',
    frequency: 'monthly',
    day_of_month: 10,
    next_run_date: '2026-11-10',
    active: true,
    created_by: null,
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-10-01T08:00:00Z',
    status: 'active',
    period: '2026-11',
    contractorName: 'Acme spółka z ograniczoną odpowiedzialnością',
    templateNumber: 'FV/7/10/2026',
    templateGrossTotal: 1230,
    ...overrides,
  };
}

const THREE = [
  item(),
  item({
    id: ID_B, name: 'Serwis kwartalny', frequency: 'quarterly', day_of_month: 5, next_run_date: '2026-10-05',
    status: 'due', period: '2026-Q4', contractorName: 'Beta', templateGrossTotal: 4500.5,
  }),
  item({
    id: ID_C, name: 'Licencja roczna', frequency: 'yearly', day_of_month: 1, next_run_date: '2027-01-01',
    active: false, status: 'paused', period: '2027', contractorName: null, templateGrossTotal: null,
  }),
];

function view(items: RecurringInvoiceListItem[], props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <RecurringInvoicesView items={items} today="2026-10-20" candidates={[]} {...props} />,
  );
}

describe('P6 — tabela faktur cyklicznych', () => {
  it('kolumny Finory po polsku, w kolejności planu', () => {
    const html = view(THREE);
    const heads = ['Szablon', 'Kontrahent', 'Częstotliwość', 'Następne wystawienie', 'Kwota brutto wzoru', 'Status', 'Akcje'];
    let at = -1;
    for (const head of heads) {
      const next = html.indexOf(`>${head}<`);
      expect(next, head).toBeGreaterThan(at);
      at = next;
    }
  });

  it('wiersz: nazwa, numer wzoru, kontrahent ze skróconą formą prawną, częstotliwość, data DD.MM.RRRR, kwota po polsku', () => {
    const html = view([item()]);
    expect(html).toContain('Abonament Acme');
    expect(html).toContain('FV/7/10/2026');
    expect(html).toContain('Acme sp. z o.o.');
    expect(html).toContain('title="Acme spółka z ograniczoną odpowiedzialnością"');
    expect(html).toContain('Co miesiąc');
    expect(html).toContain('w dniu 10.');
    expect(html).toContain('10.11.2026');
    expect(html).toContain('za listopad 2026');
    expect(html).toContain('1230,00 zł');
    expect(html).not.toContain('2026-11-10');
    expect(html).not.toContain('$');
  });

  it('częstotliwości i okresy: co kwartał, co rok; brak kwoty i kontrahenta to „—”', () => {
    const html = view(THREE);
    expect(html).toContain('Co kwartał');
    expect(html).toContain('za IV kwartał 2026');
    expect(html).toContain('Co rok');
    expect(html).toContain('za rok 2027');
    expect(html).toContain('4500,50 zł');
    expect(html).toContain('>—<');
  });

  it('plakietki statusu: Aktywna, Do wystawienia, Wstrzymana — z kolorami Finory i kontrastem AA', () => {
    const html = view(THREE);
    expect(html).toContain('>Aktywna<');
    expect(html).toContain('>Do wystawienia<');
    expect(html).toContain('>Wstrzymana<');
    // Jasny motyw: tło Finory (`*-600/10`), tekst ciemniejszy niż `*-600` z szablonu — kontrast AA
    // policzony w komentarzu `recurring-status-badge.tsx` (green-700 daje tam 4,41:1, więc 800).
    expect(RECURRING_STATUS_STYLES.active).toContain('bg-green-600/10');
    expect(RECURRING_STATUS_STYLES.active).toContain('text-green-800');
    expect(RECURRING_STATUS_STYLES.paused).toContain('bg-amber-600/10');
    // Wstrzymana: amber-700 miał 4,41:1 na wierszu w stanie hover (`bg-muted/50`), więc 800 — policzone
    // z oklch w `faktury-cykliczne-lista-kontrast.test.tsx`.
    expect(RECURRING_STATUS_STYLES.paused).toContain('text-amber-800');
    expect(RECURRING_STATUS_STYLES.paused).not.toContain('text-amber-700');
    // „Do wystawienia” (stanu nie ma w Finorze): pełny kolor główny, biały tekst 5,10:1.
    expect(RECURRING_STATUS_STYLES.due).toContain('bg-primary text-primary-foreground');
    for (const style of Object.values(RECURRING_STATUS_STYLES)) expect(style).not.toMatch(/(^|\s)text-\w+-600/);
    expect(renderToStaticMarkup(<RecurringStatusBadge status="due" />)).toContain('Do wystawienia');
  });

  it('„Wystaw teraz” to link do formularza z pozycją; dla wstrzymanej nieaktywny przycisk bez linku', () => {
    const html = view(THREE);
    expect(html).toContain(`href="/invoices/new/regular?cykliczna=${ID_A}"`);
    expect(html).toContain(`href="/invoices/new/regular?cykliczna=${ID_B}"`);
    expect(html).not.toContain(`cykliczna=${ID_C}`);
    expect(html).toContain('aria-label="Wystaw teraz fakturę „Abonament Acme”"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Wystaw teraz — „Licencja roczna” jest wstrzymana/);
  });

  it('karta na telefonie: „Wystaw teraz” z widocznym napisem (bez podpowiedzi po najechaniu), nazwa dostępna zawiera ten napis', () => {
    const html = view([item()]);
    const cards = html.slice(html.indexOf('lg:hidden'));
    expect(cards).toContain(`href="/invoices/new/regular?cykliczna=${ID_A}"`);
    expect(cards).toContain('aria-label="Wystaw teraz fakturę „Abonament Acme”"');
    expect(cards).toMatch(/<\/svg>Wystaw teraz<\/a>/);
  });

  it('akcje: Usuń i menu „⋯” z nazwami dostępnymi dla czytnika', () => {
    const html = view([item()]);
    expect(html).toContain('aria-label="Usuń fakturę cykliczną „Abonament Acme”"');
    expect(html).toContain('aria-label="Więcej akcji dla „Abonament Acme”"');
  });

  it('sortowalne nagłówki mają aria-sort, kolumna akcji nie', () => {
    const html = view(THREE);
    expect((html.match(/aria-sort="none"/g) ?? []).length).toBe(6);
    expect(html).not.toContain('aria-sort="ascending"');
  });

  it('tabela tylko od lg, poniżej karty z tymi samymi wierszami i akcjami (bez przewijania w bok)', () => {
    const html = view(THREE);
    expect(html).toContain('hidden lg:block');
    expect(html).toContain('lg:hidden');
    // Nazwa i link „Wystaw teraz” są i w tabeli, i w karcie.
    expect((html.match(/Serwis kwartalny/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((html.match(new RegExp(`cykliczna=${ID_B}`, 'g')) ?? []).length).toBe(2);
    expect(html).not.toContain('overflow-x-scroll');
  });

  it('pasek narzędzi: Pokaż N, „+ Nowa faktura cykliczna”, wyszukiwarka i filtr statusu; stopka z pozycjami', () => {
    const html = view(THREE);
    expect(html).toContain('+ Nowa faktura cykliczna');
    expect(html).toContain('Szukaj po nazwie lub kontrahencie');
    expect(html).toContain('Status faktury cyklicznej');
    expect(html).toContain('Pokaż');
    expect(html).toMatch(/Pozycje\s*<span>1–3<\/span>\s*z\s*<span>3<\/span>/);
    expect(html).toContain('Poprzednia');
    expect(html).toContain('Następna');
  });
});

describe('C9 — długie nazwy się ucinają, nie rozpychają tabeli', () => {
  const LONG_NAME = 'Abonament miesięczny za obsługę księgową i doradztwo podatkowe dla spółki '.repeat(2).trim();
  const LONG_CONTRACTOR =
    'Przedsiębiorstwo Produkcyjno-Handlowo-Usługowe Bardzo Długa Nazwa Kontrahenta z KSeF spółka z ograniczoną odpowiedzialnością';

  it('nazwa szablonu, numer wzoru i kontrahent w tabeli mają `max-w-*` obok `truncate` (jak contractors-table)', () => {
    const html = view([item({ name: LONG_NAME, contractorName: LONG_CONTRACTOR })]);
    const table = html.slice(0, html.indexOf('lg:hidden'));
    // Każdy span `truncate` w komórkach tabeli ma ograniczoną szerokość; w `table-layout: auto`
    // sam `truncate` niczego nie ucina, bo komórka rośnie do pełnej długości tekstu.
    const truncated = [...table.matchAll(/<span class="([^"]*\btruncate\b[^"]*)"/g)].map((m) => m[1]);
    expect(truncated.length).toBe(3);
    for (const classes of truncated) expect(classes, classes).toMatch(/(^|\s)max-w-\d+(\s|$)/);
    expect(table).toContain(`title="${LONG_NAME}"`);
  });
});

describe('P6 — pusty stan i komunikaty', () => {
  it('brak pozycji: tekst, przycisk „+ Nowa faktura cykliczna”, bez tabeli', () => {
    const html = view([]);
    expect(html).toContain('Brak faktur cyklicznych');
    expect(html).toContain('+ Nowa faktura cykliczna');
    expect(html).toContain('Fakturę zawsze sprawdzasz i wysyłasz sam');
    expect(html).not.toContain('Kwota brutto wzoru');
  });

  it('komunikat o wzorze z adresu pokazuje się nad tabelą', () => {
    const html = view(THREE, { templateNotice: 'Nie znaleźliśmy tej faktury wśród możliwych wzorów.' });
    expect(html).toContain('Nie wybraliśmy faktury-wzoru');
    expect(html).toContain('Nie znaleźliśmy tej faktury wśród możliwych wzorów.');
  });
});
