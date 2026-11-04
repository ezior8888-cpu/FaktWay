import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { KpirFinanceCard } from '@/components/przeplywy/finora/chart-finance';
import { TaxSavingsGoalCard } from '@/components/przeplywy/finora/statistics-savings-goal-card';
import { KpirView, type KpirExpenseRow } from '@/components/expenses/kpir-view';
import { getCashFlowData } from '@/lib/dashboard/cash-flow';
import type { PageContext } from '@/lib/supabase/page-context';
import { memoryClient } from './helpers/baza-w-pamieci';
import { kpirCostAmount, nonDeductedVat } from '@/lib/categorization/kpir-cost';
import { formatPlMoney } from '@/lib/format/pl';
import { kpirTotals } from '@/lib/reports/kpir-data';

/**
 * Koszt w KPiR = netto + VAT, którego NIE WOLNO odliczyć (art. 23 ust. 1
 * pkt 43 lit. a PIT). Do 27.09 KPiR i „Przepływy” brały netto zawsze —
 * paragon za 1 230 zł szedł jako 1 000 zł kosztu.
 */

const now = new Date();
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

function wydatek(o: Partial<KpirExpenseRow>): KpirExpenseRow {
  return {
    id: `exp-${Math.random().toString(36).slice(2)}`,
    issue_date: `${ym}-10`,
    seller_name: 'Dostawca',
    document_number: 'FV/1',
    category_label: 'Paliwo',
    kpir_column: 'col_13',
    is_deductible: true,
    net_amount: 0,
    vat_amount: 0,
    gross_amount: 0,
    vat_deductible_amount: 0,
    document_type: 'invoice',
    ...o,
  } as KpirExpenseRow;
}

// OCR zapisuje odliczenie = cały VAT także dla paragonu — reguła nie może
// na tym polegać.
const paragon = wydatek({ document_type: 'receipt', net_amount: 1000, vat_amount: 230, gross_amount: 1230, vat_deductible_amount: 230 });
const faktura = wydatek({ document_type: 'invoice', net_amount: 500, vat_amount: 115, gross_amount: 615, vat_deductible_amount: 115 });
const bezOdliczenia = wydatek({ document_type: 'invoice', net_amount: 200, vat_amount: 46, gross_amount: 246, vat_deductible_amount: 0 });
const polowa = wydatek({ document_type: 'invoice', net_amount: 400, vat_amount: 92, gross_amount: 492, vat_deductible_amount: 46 });

describe('kpirCostAmount — reguła', () => {
  it.each([
    ['paragon: VAT bez prawa do odliczenia wchodzi w koszt', paragon, 1230, 230],
    ['faktura czynnego podatnika z pełnym odliczeniem: netto', faktura, 500, 0],
    ['faktura bez odliczenia (np. firma zwolniona): brutto', bezOdliczenia, 246, 46],
    ['odliczenie częściowe (samochód 50%): netto + reszta VAT', polowa, 446, 46],
    ['dokument „inny” nie daje odliczenia', wydatek({ document_type: 'other', net_amount: 100, vat_amount: 23, vat_deductible_amount: 23 }), 123, 23],
    ['odliczenie większe niż VAT nie obniża kosztu poniżej netto', wydatek({ net_amount: 100, vat_amount: 23, vat_deductible_amount: 50 }), 100, 0],
    // Korekty zakupu „in minus” (#68) — ze znakiem.
    ['korekta z pełnym odliczeniem: koszt −netto', wydatek({ net_amount: -100, vat_amount: -23, vat_deductible_amount: -23 }), -100, 0],
    ['korekta bez odliczenia (firma zwolniona): koszt −brutto', wydatek({ net_amount: -100, vat_amount: -23, vat_deductible_amount: 0 }), -123, -23],
    ['korekta: odliczenie ze złym znakiem nie zawyża kosztu', wydatek({ net_amount: -100, vat_amount: -23, vat_deductible_amount: 23 }), -123, -23],
    ['kwoty z bazy jako tekst (NUMERIC)', wydatek({ document_type: 'receipt', net_amount: '10.10' as unknown as number, vat_amount: '2.32' as unknown as number }), 12.42, 2.32],
  ])('%s', (_opis, e, koszt, vatWKoszcie) => {
    expect(kpirCostAmount(e)).toBe(koszt);
    expect(nonDeductedVat(e)).toBe(vatWKoszcie);
  });
});

describe('KPiR w aplikacji', () => {
  // W każdej kolumnie kosztów dokument z VAT bez odliczenia — suma łapie
  // cofnięcie reguły w dowolnej kolumnie.
  const html = renderToStaticMarkup(
    <KpirView
      month={now.getMonth() + 1}
      year={now.getFullYear()}
      expenses={[
        paragon, // kol. 13: 1230
        faktura, // kol. 13: 500
        { ...bezOdliczenia, kpir_column: 'col_10' }, // 246
        { ...polowa, kpir_column: 'col_11' }, // 446
        wydatek({ kpir_column: 'col_12', document_type: 'receipt', net_amount: 100, vat_amount: 23 }), // 123
        wydatek({ kpir_column: 'col_15', document_type: 'receipt', net_amount: 10, vat_amount: 2.3 }), // 12.30
      ]}
      invoices={[]}
    />,
  );

  it('suma kosztów liczy VAT bez odliczenia we wszystkich kolumnach', () => {
    expect(html).toContain(formatPlMoney(2557.3));
    expect(html).not.toContain(formatPlMoney(2210)); // same netto
  });

  it('kpirTotals (sumy, z których liczy widok): każda kolumna z VAT bez odliczenia', () => {
    const sumy = kpirTotals([
      paragon, faktura,
      { ...bezOdliczenia, kpir_column: 'col_10' },
      { ...polowa, kpir_column: 'col_11' },
      wydatek({ kpir_column: 'col_12', document_type: 'receipt', net_amount: 100, vat_amount: 23 }),
      wydatek({ kpir_column: 'col_15', document_type: 'receipt', net_amount: 10, vat_amount: 2.3 }),
    ], []);
    expect(sumy).toMatchObject({ col_10: 246, col_11: 446, col_12: 123, col_13: 1730 });
    expect(sumy.col_15).toBeCloseTo(12.3, 10);
    expect(sumy.totalExpenses).toBeCloseTo(2557.3, 10);
    expect(sumy.totalExpenses).not.toBeCloseTo(2210, 2);
  });

  it('wiersz paragonu pokazuje koszt i ile w nim VAT bez odliczenia', () => {
    expect(html).toContain(formatPlMoney(1230));
    expect(html).toContain(`w tym VAT bez odliczenia ${formatPlMoney(230)}`);
  });
});

describe('Przepływy: zysk i szacowany podatek jak w KPiR', () => {
  // Od E5 (plan Finora) liczby `/przeplywy` liczy `getCashFlowData` — ta sama
  // reguła kosztu (`getCosts` → `kpirCostAmount`) na prawdziwej ścieżce odczytu.
  async function przeplywy() {
    const supabase = memoryClient({
      invoices: [{
        id: 'fv-1', tenant_id: 'firma-a', direction: 'outgoing', ksef_status: 'accepted', ksef_environment: 'test',
        currency: 'PLN', invoice_kind: 'regular', advance_invoice_ids: [], issue_date: `${ym}-05`,
        net_total: 5000, gross_total: 6150,
      }],
      expenses: [{ ...paragon, tenant_id: 'firma-a', source: 'manual', ksef_invoice_id: null, is_reviewed: true }],
    }) as unknown as PageContext['supabase'];
    return getCashFlowData(supabase, 'firma-a', new Date());
  }

  it('zysk = 5000 − 1230, podatek 19% od niego', async () => {
    const data = await przeplywy();
    expect(data.report.profit).toBe(3770);
    expect(data.taxEstimate.amount).toBe(716.3);

    const html = renderToStaticMarkup(
      <>
        <KpirFinanceCard
          months={data.months}
          revenue={data.revenue}
          costs={data.costs}
          profit={data.profit}
          report={data.report}
          revenueChangePct={data.revenueChangePct}
          costsHint="none"
        />
        <TaxSavingsGoalCard estimate={data.taxEstimate} />
      </>,
    );
    expect(html).toContain(formatPlMoney(3770));
    expect(html).toContain(formatPlMoney(716.3));
    expect(html).not.toContain(formatPlMoney(4000));
  });
});
