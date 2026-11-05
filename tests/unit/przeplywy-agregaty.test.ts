import { describe, expect, it } from 'vitest';

import {
  buildCashFlowChart,
  cashFlowOperations,
  monthFlows,
  nextMonthStart,
  topCashFlowSources,
  upcomingInflows,
  yearsWindowStart,
} from '@/lib/dashboard/cash-movements';
import type { CostEntry } from '@/lib/dashboard/costs';
import type { InflowEntry } from '@/lib/dashboard/inflows';

/**
 * Czyste agregaty kart `/przeplywy` (plan Finora P2, etap E5) na wynikach
 * `getInflows` i `getCosts` (§2.4 pkt 12). Brzegi: korekta kosztu in minus,
 * zaliczka + ROZ jako dwa wpływy, B2C, przełom miesiąca i roku, „dziś”
 * w Warszawie. Wykres, kafel, źródła i operacje liczą same prawdziwe pieniądze,
 * a otwarte faktury z terminem od dziś to Spodziewane wpływy.
 */

let seq = 0;
/** Wpływ z prawdziwą zapłatą (dzień = dzień zapłaty); termin i wystawienie — przez `fields`. */
function inflow(date: string, amount: number, fields: Partial<InflowEntry> = {}): InflowEntry {
  seq += 1;
  return {
    id: `inv-${String(seq).padStart(4, '0')}`,
    date,
    basis: 'paid',
    amount,
    outstanding: 0,
    dueDate: null,
    invoiceKind: 'regular',
    internalNumber: `FV/${seq}`,
    buyerKey: 'nip:1111111111',
    buyerName: 'Alfa spółka z ograniczoną odpowiedzialnością',
    buyerNip: '1111111111',
    consumers: false,
    ...fields,
  };
}

function cost(issueDate: string, outflow: number, fields: Partial<CostEntry> = {}): CostEntry {
  seq += 1;
  return {
    id: `exp-${String(seq).padStart(4, '0')}`,
    issueDate,
    // Pola dodane przez E6/E7 do `CostEntry` (zbiorcze scalenie etapów).
    source: 'manual',
    vat: 0,
    sellerNip: '2222222222',
    sellerName: 'Dostawca S.A.',
    cost: outflow,
    outflow,
    vatDeductible: 0,
    documentNumber: `D/${seq}`,
    categoryLabel: 'Paliwo',
    isReviewed: true,
    ...fields,
  };
}

const TODAY = '2026-10-20'; // wtorek

describe('buildCashFlowChart — Tydzień / Miesiąc / Rok', () => {
  it('siedem tygodni pn–nd z bieżącym, wpływy i wydatki w swoich tygodniach', () => {
    const chart = buildCashFlowChart(
      [inflow('2026-10-19', 100), inflow('2026-10-18', 50), inflow('2026-09-01', 999)],
      [cost('2026-10-25', 30), cost('2026-09-07', 20)],
      TODAY,
    );
    expect(chart.week.map((b) => b.key)).toEqual([
      '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19',
    ]);
    expect(chart.week.at(-1)).toMatchObject({ label: '19.10', period: '19.10–25.10.2026', inflow: 100, outflow: 30, inflowCount: 1 });
    expect(chart.week.at(-2)).toMatchObject({ inflow: 50, outflow: 0 });
    expect(chart.week[0]).toMatchObject({ inflow: 0, outflow: 20 });
    // 1.09 to poniedziałek tygodnia sprzed okna — poza wykresem, nie w pierwszym słupku.
    expect(chart.week.reduce((s, b) => s + b.inflow, 0)).toBe(150);
  });

  it('siedem miesięcy z bieżącym, podpisy po polsku, przez przełom roku', () => {
    const chart = buildCashFlowChart([inflow('2026-12-31', 10), inflow('2026-07-01', 5)], [cost('2027-02-10', 7)], '2027-02-14');
    expect(chart.month.map((b) => b.key)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    expect(chart.month.map((b) => b.label)).toEqual(['Sie', 'Wrz', 'Paź', 'Lis', 'Gru', 'Sty', 'Lut']);
    expect(chart.month[4]).toMatchObject({ period: 'grudzień 2026', inflow: 10 });
    expect(chart.month.at(-1)).toMatchObject({ outflow: 7 });
  });

  it('lata: od pierwszego z danymi do bieżącego, najwyżej pięć', () => {
    const chart = buildCashFlowChart([inflow('2024-05-05', 10)], [cost('2026-01-02', 3), cost('2019-01-01', 99)], TODAY);
    expect(chart.year.map((b) => [b.key, b.inflow, b.outflow])).toEqual([
      ['2024', 10, 0],
      ['2025', 0, 0],
      ['2026', 0, 3],
    ]);
  });

  it('bez żadnych ruchów: tylko bieżący rok', () => {
    expect(buildCashFlowChart([], [], TODAY).year.map((b) => b.key)).toEqual(['2026']);
  });

  it('korekta kosztu in minus obniża wydatki, sumy do groszy', () => {
    const chart = buildCashFlowChart([], [cost('2026-10-01', 100.1), cost('2026-10-02', -0.1), cost('2026-10-03', 0.2)], TODAY);
    expect(chart.month.at(-1)!.outflow).toBe(100.2);
  });
});

describe('monthFlows — Wpłynęło / Wydano w tym miesiącu', () => {
  it('kwota, poprzedni miesiąc, zmiana i suma narastająca do dziś', () => {
    const { inflow: inflowFlow, outflow } = monthFlows(
      [inflow('2026-10-02', 100), inflow('2026-10-20', 50), inflow('2026-09-15', 120), inflow('2026-10-25', 999)],
      [cost('2026-10-05', 40), cost('2026-09-30', 80)],
      TODAY,
    );
    // Wpływ z dniem po dziś (25.10) jeszcze nie wpłynął — kafel i krzywa kończą się dziś.
    // Koszty bez zmian: cały miesiąc, jak słupek miesiąca na wykresie.
    expect(inflowFlow).toMatchObject({ amount: 150, prevAmount: 120, count: 2 });
    expect(inflowFlow.changePct).toBeCloseTo(25);
    expect(inflowFlow.daily).toHaveLength(20);
    expect(inflowFlow.daily[0]).toEqual({ date: '2026-10-01', value: 0 });
    expect(inflowFlow.daily[1]).toEqual({ date: '2026-10-02', value: 100 });
    expect(inflowFlow.daily.at(-1)).toEqual({ date: '2026-10-20', value: 150 });
    expect(outflow).toMatchObject({ amount: 40, prevAmount: 80, count: 1 });
    expect(outflow.changePct).toBeCloseTo(-50);
  });

  it('bez późniejszych dokumentów wykres kończy się dziś', () => {
    const flow = monthFlows([inflow('2026-10-02', 100)], [], TODAY).inflow;
    expect(flow.daily).toHaveLength(20);
    expect(flow.daily.at(-1)).toEqual({ date: '2026-10-20', value: 100 });
  });

  it('bez poprzedniego miesiąca procent nie istnieje', () => {
    expect(monthFlows([inflow('2026-10-02', 100)], [], TODAY).inflow.changePct).toBeNull();
  });

  it('styczeń porównuje się z grudniem poprzedniego roku', () => {
    const flow = monthFlows([inflow('2026-12-10', 200), inflow('2027-01-03', 100)], [], '2027-01-05').inflow;
    expect(flow).toMatchObject({ amount: 100, prevAmount: 200, count: 1 });
  });

  it('miesiąc bez wpłat: count 0 (karta pokazuje pusty stan, nie „0 zł”)', () => {
    expect(monthFlows([inflow('2026-09-02', 100)], [], TODAY).inflow).toMatchObject({ amount: 0, count: 0 });
  });
});

describe('topCashFlowSources — skąd i dokąd płyną pieniądze', () => {
  it('klienci i dostawcy razem malejąco, udział w sumie swojej strony', () => {
    const sources = topCashFlowSources(
      [
        inflow('2026-10-01', 1000, { buyerKey: 'nip:1', buyerName: 'Alfa spółka z ograniczoną odpowiedzialnością', buyerNip: '1' }),
        inflow('2026-10-02', 500, { buyerKey: 'nip:1', buyerName: 'Alfa sp. z o.o. (nowa nazwa)', buyerNip: '1' }),
        inflow('2026-10-03', 500, { buyerKey: 'b2c', buyerName: 'Jan', buyerNip: null, consumers: true }),
      ],
      [cost('2026-10-04', 800, { sellerNip: '22-22', sellerName: 'Dostawca S.A.' }), cost('2026-10-05', 200, { sellerNip: null, sellerName: 'Sklep' })],
      TODAY,
    );
    expect(sources.map((s) => [s.name, s.direction, s.amount, s.share, s.count])).toEqual([
      ['Alfa sp. z o.o. (nowa nazwa)', 'in', 1500, 75, 2],
      ['Dostawca S.A.', 'out', 800, 80, 1],
      ['Konsumenci', 'in', 500, 25, 1],
      ['Sklep', 'out', 200, 20, 1],
    ]);
    expect(sources[1]!.nip).toBe('2222');
  });

  it('zaliczka i ROZ tego samego klienta to dwie wpłaty, razem 4 000 zł', () => {
    const [top] = topCashFlowSources(
      [inflow('2026-10-03', 1000, { invoiceKind: 'advance' }), inflow('2026-10-04', 3000, { invoiceKind: 'final' })],
      [],
      TODAY,
    );
    expect(top).toMatchObject({ amount: 4000, count: 2, share: 100 });
  });

  it('grupa z sumą ≤ 0 (sama korekta in minus) nie jest źródłem; limit pięciu', () => {
    const sources = topCashFlowSources(
      Array.from({ length: 7 }, (_, i) => inflow('2026-10-01', 10 * (i + 1), { buyerKey: `nip:${i}`, buyerName: `K${i}` })),
      [cost('2026-10-01', -50, { sellerNip: '9' })],
      TODAY,
    );
    expect(sources).toHaveLength(5);
    expect(sources.every((s) => s.direction === 'in')).toBe(true);
    expect(sources[0]!.name).toBe('K6');
  });
});

describe('upcomingInflows — spodziewane wpływy w 30 dni', () => {
  // Wejście to otwarte faktury z `getInflows`, nie należności `getReceivables`.
  const receivable = (id: string, dueDate: string | null, outstanding: number): InflowEntry => inflow(dueDate ?? '2026-10-01', 100, {
    id, internalNumber: `FV/${id}`, buyerName: 'Gamma spółka akcyjna', basis: dueDate ? 'due' : 'issued', dueDate, outstanding,
  });

  it('od dziś do +30 dni włącznie, najbliższy termin pierwszy', () => {
    const result = upcomingInflows(
      [
        receivable('a', '2026-11-19', 30), // +30 — w oknie
        receivable('b', '2026-11-20', 40), // +31 — poza
        receivable('c', '2026-10-20', 10), // dziś
        receivable('d', '2026-10-19', 99), // termin minął — należność po terminie, nie spodziewany wpływ
        receivable('e', null, 77), // bez terminu — nie wiadomo, kiedy spodziewać się pieniędzy
        receivable('f', '2026-10-21', 20),
      ],
      TODAY,
    );
    expect(result.items.map((i) => [i.id, i.daysLeft, i.amount])).toEqual([['c', 0, 10], ['f', 1, 20], ['a', 30, 30]]);
    expect(result.items[0]!.name).toBe('Gamma S.A.');
    expect(result).toMatchObject({ count: 3, total: 60 });
  });

  it('przez przełom roku i limit pozycji', () => {
    const result = upcomingInflows(
      Array.from({ length: 7 }, (_, i) => receivable(`r${i}`, `2027-01-0${i + 1}`, 1)),
      '2026-12-30',
      30,
      5,
    );
    expect(result.items).toHaveLength(5);
    expect(result.count).toBe(7);
    expect(result.items[0]!.daysLeft).toBe(2);
  });
});

describe('cashFlowOperations — ostatnie i wszystkie operacje', () => {
  it('wpływy i wydatki razem od najnowszego, kategorie, statusy, linki', () => {
    const rows = cashFlowOperations(
      [inflow('2026-10-10', 300, { id: 'inv-a', invoiceKind: 'advance' }), inflow('2026-10-12', 100, { id: 'inv-b', consumers: true, buyerName: null })],
      [
        cost('2026-10-10', 50, { id: 'exp-a', isReviewed: false, categoryLabel: null }),
        cost('2026-10-11', 0, { id: 'exp-zero' }),
        cost('2026-10-09', -20, { id: 'exp-kor' }),
      ],
      TODAY,
    );
    expect(rows.map((r) => [r.id, r.date, r.category, r.status, r.amount, r.href])).toEqual([
      ['in:inv-b', '2026-10-12', 'Sprzedaż', 'paid', 100, '/invoices/inv-b'],
      ['in:inv-a', '2026-10-10', 'Zaliczka', 'paid', 300, '/invoices/inv-a'],
      ['out:exp-a', '2026-10-10', 'Bez kategorii', 'pending', 50, '/expenses/exp-a'],
      ['out:exp-kor', '2026-10-09', 'Paliwo', 'reviewed', -20, '/expenses/exp-kor'],
    ]);
    expect(rows[0]!.counterparty).toBe('Konsumenci');
    expect(rows[1]!.counterparty).toBe('Alfa sp. z o.o.');
  });
});

describe('okna odczytu', () => {
  it('następny miesiąc i pięć lat wstecz', () => {
    expect(nextMonthStart('2026-12-31')).toBe('2027-01-01');
    expect(nextMonthStart('2026-10-20')).toBe('2026-11-01');
    expect(yearsWindowStart('2026-10-20')).toBe('2022-01-01');
  });
});
