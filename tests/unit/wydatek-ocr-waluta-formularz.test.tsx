// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E17b: koszt ze zdjęcia (OCR) w walucie obcej bez kursu NBP na ekranie.
 *
 * Do tej poprawki formularz i listy podpisywały kwotę w AED jako „zł”,
 * formularz nie mówił, że kwoty trzeba przeliczyć, a zaznaczenie
 * „Uwzględnij w KPiR” bez przeliczenia wpuszczało 100 AED jako 100 zł.
 *
 * Prawdziwe: `ExpenseEditForm`, `ExpenseDayCards`, `ExpensesTable`.
 * Zastąpione: akcje serwera, router i toast.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const actions = vi.hoisted(() => ({
  deleteExpenseAction: vi.fn(),
  reviewExpenseAction: vi.fn(),
  uploadExpensePhotoAction: vi.fn(),
  getOcrJobStatusAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/app/actions/expenses', () => actions);

import { ExpenseEditForm } from '@/components/expenses/expense-edit-form';
import { ExpenseDayCards, type ExpenseRow } from '@/components/expenses/expenses-list';
import { ExpensesTable } from '@/components/expenses/finora/expenses-table';

const aedTrace = {
  seller_name: 'Hotel Marina LLC',
  document_type: 'receipt',
  issue_date: '2026-10-20',
  currency: 'AED',
  net_amount: 95.24,
  vat_amount: 4.76,
  gross_amount: 100,
  ocr_confidence: 0.93,
};

function expense(id: string, fields: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id,
    tenant_id: 'firma-a',
    categorization_confidence: null,
    categorization_method: null,
    category_label: 'Podróże służbowe',
    created_at: '2026-10-20T10:00:00Z',
    created_by: null,
    document_number: 'R/2026/77',
    document_type: 'receipt',
    gross_amount: 100,
    is_deductible: false,
    is_reviewed: false,
    issue_date: '2026-10-20',
    kpir_column: 'col_13',
    ksef_invoice_id: null,
    net_amount: 95.24,
    notes: null,
    ocr_extracted_data: aedTrace,
    ocr_job_id: 'job-1',
    seller_address: null,
    seller_name: 'Hotel Marina LLC',
    seller_nip: null,
    source: 'ocr_photo',
    source_file_mime: null,
    source_file_path: null,
    updated_at: '2026-10-20T10:00:00Z',
    vat_amount: 4.76,
    vat_deductible_amount: 0,
    vat_rate: null,
    ...fields,
  };
}

/** Koszt w złotych (ręczny) do porównania sum dnia. */
const plnExpense = (id: string) => expense(id, {
  source: 'manual',
  ocr_extracted_data: null,
  ocr_job_id: null,
  gross_amount: 123,
  is_deductible: true,
  is_reviewed: true,
  seller_name: 'Telekom S.A.',
});

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe('formularz kosztu OCR w walucie bez kursu', () => {
  it('kwota w walucie dokumentu, ostrzeżenie i potwierdzenie złotych; bez „zł” przy AED', () => {
    const markup = html(<ExpenseEditForm expense={expense('e-1')} photoUrl={null} ksefCurrency={null} />);

    expect(markup).toContain('100,00 AED');
    expect(markup).not.toContain('100,00 zł');
    expect(markup).toContain('Kwoty z dokumentu są w AED, nie w złotych.');
    expect(markup).toContain('Kwoty netto, VAT i brutto są w złotych.');
    expect(markup).toContain('Brutto (AED)');
    expect(markup).toContain('Zapisz poza KPiR');
  });

  it('stary koszt AED już w KPiR (sprzed poprawki): prawdziwy stan i wyjście przy zablokowanym zapisie', () => {
    const legacy = expense('e-1', { is_deductible: true, is_reviewed: true });
    const markup = html(<ExpenseEditForm expense={legacy} photoUrl={null} ksefCurrency={null} />);

    expect(markup).toContain('Wydatek jest w KPiR, a kwoty mogą być w AED.');
    expect(markup).not.toContain('wydatek jest poza KPiR');
    expect(markup).toContain('Zaznacz, że kwoty są w złotych, albo wyłącz wydatek z KPiR.');
  });

  it('stary koszt z kwotami poprawionymi ręcznie bez potwierdzenia: „mogą być”, nie „są w AED”', () => {
    const edited = expense('e-1', { gross_amount: 108, net_amount: 102.86, vat_amount: 5.14, is_reviewed: true });
    const markup = html(<ExpenseEditForm expense={edited} photoUrl={null} ksefCurrency={null} />);

    expect(markup).toContain('Kwoty mogą być w AED, nie w złotych.');
    expect(markup).not.toContain('Kwoty z dokumentu są w AED');
    expect(markup).toContain('Zapis poza KPiR bez tego potwierdzenia zostawia wydatek do opisania.');
  });

  it('po potwierdzeniu złotych (ślad przy koszcie) formularz jak dla złotówek', () => {
    const confirmed = expense('e-1', {
      gross_amount: 108,
      is_deductible: true,
      is_reviewed: true,
      ocr_extracted_data: {
        ...aedTrace,
        pln_confirmation: { confirmed_by: 'u-1', confirmed_at: '2026-10-21T08:00:00.000Z' },
      },
    });
    const markup = html(<ExpenseEditForm expense={confirmed} photoUrl={null} ksefCurrency={null} />);

    expect(markup).toContain('108,00 zł');
    expect(markup).not.toContain('Kwoty z dokumentu są w AED');
    expect(markup).toContain('Zapisz zmiany');
  });

  it('dokument przeliczony kursem NBP: „zł” i bez ostrzeżenia, jak dotąd', () => {
    const fx = { currency: 'EUR', mid: 4.25, tableNo: '203/A/NBP/2026', effectiveDate: '2026-10-19', appliedFor: '2026-10-20' };
    const converted = expense('e-1', {
      gross_amount: 425,
      is_deductible: true,
      ocr_extracted_data: { ...aedTrace, currency: 'EUR', fx },
    });
    const markup = html(<ExpenseEditForm expense={converted} photoUrl={null} ksefCurrency={null} />);

    expect(markup).toContain('425,00 zł');
    expect(markup).not.toContain('nie w złotych');
  });
});

describe('formularz kosztu OCR w walucie bez kursu (przeglądarka)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    actions.reviewExpenseAction.mockReset();
    actions.reviewExpenseAction.mockResolvedValue({ success: true });
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  async function mount(node: ReactElement) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(node);
    });
  }

  /** Checkbox w etykiecie, której tekst zawiera `text`. */
  function checkboxIn(text: string): HTMLElement {
    const label = [...host!.querySelectorAll('label')].find((l) => l.textContent?.includes(text));
    const box = label?.querySelector<HTMLElement>('[role="checkbox"]');
    if (!box) throw new Error(`brak checkboxa przy „${text}”`);
    return box;
  }

  function button(text: string): HTMLButtonElement {
    const found = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (!found) throw new Error(`brak przycisku „${text}”`);
    return found;
  }

  async function click(el: HTMLElement) {
    await act(async () => {
      el.click();
    });
  }

  it('potwierdzenie złotych włącza KPiR, a „Zaakceptuj” wysyła potwierdzenie do serwera', async () => {
    await mount(<ExpenseEditForm expense={expense('e-1')} photoUrl={null} ksefCurrency={null} />);

    await click(checkboxIn('Kwoty netto, VAT i brutto są w złotych.'));
    expect(checkboxIn('Uwzględnij w KPiR').getAttribute('aria-checked')).toBe('true');
    expect(host!.textContent).toContain('Brutto (zł)');

    await click(button('Zaakceptuj'));
    expect(actions.reviewExpenseAction).toHaveBeenCalledWith(
      'e-1',
      expect.objectContaining({ is_deductible: true, confirmPlnAmounts: true }),
    );
  });

  it('bez potwierdzenia KPiR jest zablokowany, a zapis idzie poza KPiR', async () => {
    await mount(<ExpenseEditForm expense={expense('e-1')} photoUrl={null} ksefCurrency={null} />);

    const kpir = checkboxIn('Uwzględnij w KPiR');
    await click(kpir);
    expect(checkboxIn('Uwzględnij w KPiR').getAttribute('aria-checked')).toBe('false');

    await click(button('Zapisz poza KPiR'));
    expect(actions.reviewExpenseAction).toHaveBeenCalledWith(
      'e-1',
      expect.objectContaining({ is_deductible: false, confirmPlnAmounts: false }),
    );
  });

  it('kwota brutto równa kwocie w AED po potwierdzeniu: podpowiedź, żeby sprawdzić', async () => {
    await mount(<ExpenseEditForm expense={expense('e-1')} photoUrl={null} ksefCurrency={null} />);

    await click(checkboxIn('Kwoty netto, VAT i brutto są w złotych.'));
    expect(host!.textContent).toContain('Kwota brutto jest taka sama jak na dokumencie w AED.');
  });

  it('koszt KSeF nie dostaje pola potwierdzenia złotych (ścisły schemat KSeF)', async () => {
    const ksef = expense('e-1', {
      source: 'ksef_inbox',
      ksef_invoice_id: 'inv-1',
      ocr_extracted_data: null,
    });
    await mount(<ExpenseEditForm expense={ksef} photoUrl={null} ksefCurrency="PLN" />);

    await click(button('Zaakceptuj'));
    expect(actions.reviewExpenseAction).toHaveBeenCalledTimes(1);
    expect(actions.reviewExpenseAction.mock.calls[0]![1]).not.toHaveProperty('confirmPlnAmounts');
  });
});

describe('listy wydatków: waluta kwoty zamiast „zł”', () => {
  it('karty na telefonie: AED przy koszcie bez kursu, suma dnia tylko ze złotych', () => {
    const markup = html(
      <ExpenseDayCards
        expenses={[plnExpense('e-pln'), expense('e-aed')]}
        dayTotals={new Map([['2026-10-20', 123]])}
      />,
    );
    expect(markup).toContain('100,00 AED');
    expect(markup).not.toContain('100,00 zł');
    expect(markup).toContain('123,00 zł');
  });

  it('tabela: kolumna kwoty i suma dnia w kartach', () => {
    const markup = html(
      <ExpensesTable expenses={[plnExpense('e-pln'), expense('e-aed')]} listVariant="month" />,
    );
    expect(markup).toContain('100,00 AED');
    expect(markup).not.toContain('100,00 zł');
    // Suma dnia: 123 zł, nie 223 zł (100 AED to nie 100 zł).
    expect(markup).not.toContain('223,00 zł');
  });

  it('koszt KSeF ze śladem waluty bez kursu: kod waluty także na liście', () => {
    const ksef = expense('e-ksef', {
      source: 'ksef_inbox',
      ksef_invoice_id: 'inv-1',
      gross_amount: 1000,
      ocr_extracted_data: { source: 'ksef_inbox', currency: 'EUR', net_amount: 813, gross_amount: 1000, fx: null },
    });
    const markup = html(<ExpenseDayCards expenses={[ksef]} dayTotals={new Map()} />);
    expect(markup).toContain('1000,00 EUR');
    expect(markup).not.toContain('1000,00 zł');
  });

  it('koszt po potwierdzeniu złotych i koszt przeliczony kursem: „zł”', () => {
    const fx = { currency: 'EUR', mid: 4.25, tableNo: '203/A/NBP/2026', effectiveDate: '2026-10-19', appliedFor: '2026-10-20' };
    const markup = html(
      <ExpenseDayCards
        expenses={[
          expense('e-1', {
            gross_amount: 108,
            ocr_extracted_data: { ...aedTrace, pln_confirmation: { confirmed_by: 'u-1', confirmed_at: '2026-10-21T08:00:00.000Z' } },
          }),
          expense('e-2', { gross_amount: 425, ocr_extracted_data: { ...aedTrace, currency: 'EUR', fx } }),
        ]}
        dayTotals={new Map([['2026-10-20', 533]])}
      />,
    );
    expect(markup).toContain('108,00 zł');
    expect(markup).toContain('425,00 zł');
  });
});
