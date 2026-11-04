import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { formatPlCompactMoney, formatPlMoney } from '@/lib/format/pl';
import { FinanceCard } from '@/components/dashboard/pulpit/finance-card';
import { NetRevenueCard } from '@/components/dashboard/pulpit/net-revenue-card';
import { VatLimitCard } from '@/components/dashboard/pulpit/vat-limit-card';
import { VatDueCard } from '@/components/dashboard/pulpit/vat-due-card';
import { PULPIT_EMPTY } from '@/components/dashboard/pulpit/card-states';

/** SSR wstawia <!-- --> między sąsiednie węzły tekstowe — usuwamy je. */
function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node).replace(/<!-- -->/g, '');
}

const m12 = Array.from({ length: 12 }, (_, i) => ({ key: `2026-${i + 1}`, label: `M${i + 1}` }));
const m6 = m12.slice(6);
const nums = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

const report = { revenue: 45600, costs: 12000, profit: 33600, monthlyAverageNet: 41234.5 };

describe('FinanceCard', () => {
  const base = {
    months: m12,
    net: nums(12, i => 1000 * (i + 1)),
    costs: nums(12, i => 500 * (i + 1)),
    report,
    costsHint: 'none' as const,
  };

  it('stan z danymi: podpisy, kwoty, link do przepływów', () => {
    const out = html(<FinanceCard {...base} />);
    expect(out).toContain('Przychody i koszty');
    expect(out).toContain('Ostatnie 12 miesięcy');
    expect(out).toContain('Przychody netto');
    expect(out).toContain('Koszty');
    expect(out).toContain('Ten miesiąc');
    expect(out).toContain('Zysk');
    expect(out).toContain('Średnio miesięcznie:');
    expect(out).toContain('33 600,00 zł');
    expect(out).toContain('title="33 600,00 zł"');
    expect(out).toMatch(/<a[^>]*href="\/przeplywy"[^>]*>Zobacz przepływy<\/a>/);
    expect(out).not.toContain('$');
    expect(out).not.toContain(PULPIT_EMPTY.connectKsef);
  });

  it('strata: tytuł „Strata”, kwota bez minusa w kolorze destructive', () => {
    const out = html(<FinanceCard {...base} report={{ ...report, profit: -1500 }} />);
    expect(out).toContain('Strata');
    expect(out).not.toContain('>Zysk<');
    expect(out).toContain('1500,00 zł');
    expect(out).not.toMatch(/[-−]1\s?500,00 zł/);
    expect(out).toMatch(/text-destructive[^>]*title="1500,00 zł"|title="1500,00 zł"[^>]*text-destructive/);
  });

  it('jeden miesiąc z wartością (nie bieżący): pokazuje ten miesiąc z etykietą', () => {
    const net = nums(12, i => (i === 10 ? 5000 : 0));
    const out = html(<FinanceCard {...base} net={net} costs={nums(12, () => 0)} />);
    expect(out).toContain('title="5000,00 zł"');
    expect(out).toContain('Przychody netto · M11');
  });

  it('brak średniej: tekst zastępczy', () => {
    const out = html(<FinanceCard {...base} report={{ ...report, monthlyAverageNet: null }} />);
    expect(out).toContain('Średnia pojawi się po pierwszym pełnym miesiącu');
  });

  it('link „Podłącz KSeF…” gdy connect-ksef', () => {
    const out = html(<FinanceCard {...base} costsHint="connect-ksef" />);
    expect(out).toContain(PULPIT_EMPTY.connectKsef);
    expect(out).toContain(`href="${PULPIT_EMPTY.connectKsefHref}"`);
  });

  it('wszystko 0: pusty stan z „Wystaw fakturę”, prawa część z zerami', () => {
    const out = html(
      <FinanceCard
        {...base}
        net={nums(12, () => 0)}
        costs={nums(12, () => 0)}
        report={{ revenue: 0, costs: 0, profit: 0, monthlyAverageNet: null }}
      />,
    );
    expect(out).toContain(PULPIT_EMPTY.noInvoices);
    expect(out).toContain('Wystaw fakturę');
    expect(out).toContain('0,00 zł');
    expect(out).toContain('Zobacz przepływy');
  });

  it('jeden miesiąc z wartością: wartość bieżąca i tekst o drugim miesiącu', () => {
    const net = nums(12, i => (i === 11 ? 2500 : 0));
    const out = html(<FinanceCard {...base} net={net} costs={nums(12, () => 0)} />);
    expect(out).toContain(PULPIT_EMPTY.trendAfterSecondMonth);
    expect(out).toContain('title="2500,00 zł"');
  });
});

describe('NetRevenueCard', () => {
  it('z danymi: wartość bieżąca, procent, opis', () => {
    const out = html(
      <NetRevenueCard months={m6} net={[1, 2, 3, 4, 5, 45600]} changePct={12} />,
    );
    expect(out).toContain('Przychód netto');
    expect(out).toContain('+12%');
    expect(out).toContain('text-green-700');
    expect(out).not.toContain('text-green-600');
    expect(out).toContain('title="45 600,00 zł"');
    expect(out).not.toContain('$');
  });

  it('spadek jest czerwony, null bez procentu', () => {
    const down = html(<NetRevenueCard months={m6} net={[1, 2, 3, 4, 5, 6]} changePct={-8} />);
    expect(down).toContain('−8%');
    expect(down).toContain('text-destructive');
    const none = html(<NetRevenueCard months={m6} net={[1, 2, 3, 4, 5, 6]} changePct={null} />);
    expect(none).not.toMatch(/\d%</);
  });

  it('puste stany: wszystko 0 i jeden miesiąc', () => {
    const zero = html(<NetRevenueCard months={m6} net={[0, 0, 0, 0, 0, 0]} changePct={null} />);
    expect(zero).toContain(PULPIT_EMPTY.noInvoices);
    const one = html(<NetRevenueCard months={m6} net={[0, 0, 0, 0, 0, 900]} changePct={null} />);
    expect(one).toContain(PULPIT_EMPTY.trendAfterSecondMonth);
  });
});

describe('VatDueCard', () => {
  const net6 = [10, 20, 30, 40, 50, 60];
  const props = { months: m6, vatDueLabel: '25 listopada', daysToVatDue: 7, net: net6 };

  it('z danymi: tytuł, opis, wartość, termin i odmiana dni', () => {
    const out = html(<VatDueCard {...props} vat={[1, 2, 3, 4, 5, 10500]} />);
    expect(out).toContain('VAT należny');
    expect(out).toContain('6 mies.');
    expect(out).toContain('title="10 500,00 zł"');
    expect(out).toContain('Termin: 25 listopada');
    expect(out).toContain('za 7 dni');
    expect(out).not.toContain('$');
  });

  it('odmiana: 1 dzień, 0 dziś', () => {
    expect(html(<VatDueCard {...props} daysToVatDue={1} vat={[1, 2, 3, 4, 5, 6]} />)).toContain('za 1 dzień');
    expect(html(<VatDueCard {...props} daysToVatDue={0} vat={[1, 2, 3, 4, 5, 6]} />)).toContain('dziś');
  });

  it('mniej niż 2 miesiące: bez wykresu, wartość i termin zostają', () => {
    const out = html(<VatDueCard {...props} net={[0, 0, 0, 0, 0, 800]} vat={[0, 0, 0, 0, 0, 800]} />);
    expect(out).toContain(PULPIT_EMPTY.trendAfterSecondMonth);
    expect(out).toContain('title="800,00 zł"');
    expect(out).toContain('Termin: 25 listopada');
  });

  it('VAT = 0 przy sprzedaży w 6 miesiącach (np/zw/0%): wykres, bez tekstu o drugim miesiącu', () => {
    const out = html(<VatDueCard {...props} vat={[0, 0, 0, 0, 0, 0]} />);
    expect(out).not.toContain(PULPIT_EMPTY.trendAfterSecondMonth);
    expect(out).not.toContain(PULPIT_EMPTY.noInvoices);
  });

  it('brak sprzedaży: pusty stan noInvoices z akcją', () => {
    const out = html(<VatDueCard {...props} net={[0, 0, 0, 0, 0, 0]} vat={[0, 0, 0, 0, 0, 0]} />);
    expect(out).toContain(PULPIT_EMPTY.noInvoices);
    expect(out).toContain('href="/invoices/new"');
  });
});

describe('VatLimitCard', () => {
  const months = m12.slice(0, 4);
  const cumulative = [1000, 3000, 6000, 10000];
  const mkLimit = (over: Partial<NonNullable<React.ComponentProps<typeof VatLimitCard>['limit']>> = {}) => ({
    effectiveLimit: 240000,
    prorated: false,
    activeDays: 365,
    daysInYear: 365,
    pct: 63.4,
    remaining: 88000,
    level: 60 as const,
    formula: '240 000 zł × 365/365',
    crossesOn: null as string | null,
    ...over,
  });
  const base = { months, cumulative, used: 152000, annualLimit: 240000, startedOn: null as string | null };

  it('z limitem: kwoty, procent bez plusa, stopka bez daty', () => {
    const out = html(<VatLimitCard {...base} limit={mkLimit()} />);
    expect(out).toContain('Limit zwolnienia z VAT');
    expect(out).toContain('Sprzedaż z faktur w KSeF od 1 stycznia');
    expect(out).toContain(`${formatPlCompactMoney(152000)} z ${formatPlCompactMoney(240000)}`);
    expect(out).toContain(`title="${formatPlMoney(152000)} zł z ${formatPlMoney(240000)} zł"`);
    expect(out).toContain('63%');
    expect(out).not.toContain('+63');
    expect(out).toContain('text-amber-700');
    expect(out).toContain('Przy obecnym tempie limit wystarczy do końca roku');
    expect(out).not.toContain('Limit proporcjonalny');
    expect(out).not.toContain('$');
  });

  it('kolory według poziomu: ok, 80, 90, 100', () => {
    expect(html(<VatLimitCard {...base} limit={mkLimit({ level: 'ok', pct: 10 })} />)).toMatch(/text-muted-foreground[^>]*>10%</);
    expect(html(<VatLimitCard {...base} limit={mkLimit({ level: 80, pct: 82 })} />)).toContain('dark:text-amber-400');
    const o90 = html(<VatLimitCard {...base} limit={mkLimit({ level: 90, pct: 93 })} />);
    expect(o90).toMatch(/text-destructive[^>]*>93%</);
    const o100 = html(<VatLimitCard {...base} limit={mkLimit({ level: 100, pct: 104.4 })} />);
    expect(o100).toMatch(/text-destructive[^>]*>104%</);
  });

  it('stopka: data przekroczenia i przekroczony limit', () => {
    const soon = html(<VatLimitCard {...base} limit={mkLimit({ crossesOn: '2026-11-05' })} />);
    expect(soon).toContain('Przy obecnym tempie limit skończy się ok. 05.11.2026');
    const over = html(<VatLimitCard {...base} limit={mkLimit({ level: 100, pct: 101, crossesOn: '2026-11-05' })} />);
    expect(over).toContain('Limit przekroczony. Sprawdź z księgową rejestrację do VAT.');
    expect(over).not.toContain('skończy się');
  });

  it('limit proporcjonalny: dopisek z datą startu i wzorem w title', () => {
    const out = html(
      <VatLimitCard
        {...base}
        startedOn="2026-03-15"
        limit={mkLimit({ prorated: true, activeDays: 292, formula: 'wzór X' })}
      />,
    );
    expect(out).toContain('Limit proporcjonalny: działalność od 15.03.2026');
    expect(out).toContain('title="wzór X"');
  });

  it('bez daty startu: link do ustawień, bez procentu', () => {
    const out = html(<VatLimitCard {...base} limit={null} />);
    expect(out).toContain('Podaj datę rozpoczęcia działalności, a policzymy wykorzystanie limitu.');
    expect(out).toMatch(/<a[^>]*href="\/settings#data-rozpoczecia"[^>]*>Uzupełnij w ustawieniach<\/a>/);
    expect(out).toContain(`title="${formatPlMoney(152000)} zł"`);
    expect(out).not.toMatch(/>\d+%</);
    expect(out).not.toContain('$');
  });

  it('brak sprzedaży: noInvoices i limit na ten rok', () => {
    const z = [0, 0, 0, 0];
    const out = html(<VatLimitCard {...base} cumulative={z} used={0} limit={mkLimit({ effectiveLimit: 200000 })} />);
    expect(out).toContain(PULPIT_EMPTY.noInvoices);
    expect(out).toContain('href="/invoices/new"');
    expect(out).toContain(`Limit na ten rok: ${formatPlMoney(200000)} zł`);
  });

  it('styczeń: trendAfterSecondMonth, kwoty, procent i stopka zostają', () => {
    const out = html(
      <VatLimitCard {...base} months={months.slice(0, 1)} cumulative={[2500]} used={2500} limit={mkLimit({ pct: 1.04, level: 'ok' })} />,
    );
    expect(out).toContain(PULPIT_EMPTY.trendAfterSecondMonth);
    expect(out).toContain('1%');
    expect(out).toContain('Przy obecnym tempie limit wystarczy do końca roku');
    expect(out).not.toContain('$');
  });

  const KASA = 'Sprzedaż bez faktury (np. z kasy fiskalnej) i z faktur spoza FaktWay dolicz sam.';

  it('lowerBound 100: pełny limit przekroczony, na czerwono', () => {
    const out = html(
      <VatLimitCard {...base} limit={null} lowerBound={{ pct: 120, level: 100, remaining: 0 }} />,
    );
    expect(out).toMatch(/text-destructive[^>]*>Sprzedaż przekroczyła pełny roczny limit /);
    expect(out).toContain(`${formatPlMoney(240000)} zł. Sprawdź z księgową rejestrację do VAT.`);
    expect(out).toContain('href="/settings#data-rozpoczecia"');
  });

  it('lowerBound 60: „Co najmniej N%” w kolorze progu; ok bez dopisku', () => {
    const out = html(
      <VatLimitCard {...base} limit={null} lowerBound={{ pct: 63.9, level: 60, remaining: 80000 }} />,
    );
    expect(out).toContain('Co najmniej 63% pełnego limitu — podaj datę rozpoczęcia, jeśli firma ruszyła w tym roku.');
    expect(out).toContain('text-amber-700');
    const ok = html(<VatLimitCard {...base} limit={null} lowerBound={{ pct: 10, level: 'ok', remaining: 1 }} />);
    expect(ok).not.toContain('Co najmniej');
    expect(ok).toContain('Podaj datę rozpoczęcia działalności');
  });

  it('procent w dół: 99,6 % to „99%”, 59,6 % to „59%”, bez „Limit przekroczony”', () => {
    const a = html(<VatLimitCard {...base} limit={mkLimit({ level: 90, pct: 99.6, remaining: 900 })} />);
    expect(a).toMatch(/>99%</);
    expect(a).not.toContain('Limit przekroczony');
    const b = html(<VatLimitCard {...base} limit={mkLimit({ level: 'ok', pct: 59.6 })} />);
    expect(b).toMatch(/>59%</);
  });

  it('remaining 0 bez przekroczenia: limit wykorzystany w całości', () => {
    const out = html(<VatLimitCard {...base} limit={mkLimit({ level: 90, pct: 100, remaining: 0 })} />);
    expect(out).toContain('wykorzystany w całości');
    expect(out).toMatch(/text-destructive[^>]*>Limit wykorzystany w całości/);
    expect(out).not.toContain('Przy obecnym tempie');
  });

  it('zastrzeżenie o sprzedaży bez faktury we wszystkich wariantach', () => {
    const z = [0, 0, 0, 0];
    expect(html(<VatLimitCard {...base} limit={mkLimit()} />)).toContain(KASA);
    expect(html(<VatLimitCard {...base} limit={null} />)).toContain(KASA);
    expect(html(<VatLimitCard {...base} cumulative={z} used={0} limit={null} />)).toContain(KASA);
  });

  it('pusty stan bez daty: brak „Limit na ten rok”, pełny limit i link', () => {
    const z = [0, 0, 0, 0];
    const out = html(<VatLimitCard {...base} cumulative={z} used={0} limit={null} />);
    expect(out).not.toContain('Limit na ten rok');
    expect(out).toContain(`Pełny limit roczny: ${formatPlMoney(240000)} zł — mniejszy, jeśli działalność ruszyła w tym roku`);
    expect(out).toMatch(/<a[^>]*href="\/settings#data-rozpoczecia"[^>]*>Uzupełnij datę rozpoczęcia działalności<\/a>/);
  });

  it('wzór widoczny zwykłym tekstem, także przy pełnym roku', () => {
    const out = html(<VatLimitCard {...base} limit={mkLimit()} />);
    expect(out).toContain('Wzór: 240 000 zł × 365/365');
  });

  it('kolory serii zależne od motywu: ChartStyle ma wariant .dark', () => {
    const out = html(<VatLimitCard {...base} limit={mkLimit()} />);
    expect(out).toMatch(/\.dark[^}]*--color-sales:\s*var\(--chart-1\)/);
    expect(out).toMatch(/--color-sales:\s*var\(--chart-5\)/);
    const due = html(<VatDueCard months={m6} net={[1, 2, 3, 4, 5, 6]} vat={[1, 2, 3, 4, 5, 6]} vatDueLabel="x" daysToVatDue={3} />);
    expect(due).toMatch(/\.dark[^}]*--color-vat:\s*var\(--chart-1\)/);
    const fin = html(
      <FinanceCard months={m12} net={nums(12, (i) => 1000 * (i + 1))} costs={nums(12, (i) => 500 * (i + 1))} report={report} costsHint="none" />,
    );
    // Koszty w ciemnym na foreground: chart-2 obok przychodów (chart-1) miał 1,45:1.
    expect(fin).toMatch(/\.dark[^}]*--color-costs:\s*var\(--foreground\)/);
  });

  it('sprzedaż ujemna (sama korekta in minus w styczniu): procent 0%, nie „-1%”', () => {
    const out = html(
      <VatLimitCard {...base} cumulative={[-2400, -2400]} months={months.slice(0, 2)} used={-2400}
        limit={mkLimit({ pct: -1, remaining: 242400, level: 'ok' })} />,
    );
    expect(out).toMatch(/>0%</);
    expect(out).not.toMatch(/>-\d+%</);
    expect(out).not.toContain('\u22121%');
  });
});
