import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { PageContext } from '@/lib/supabase/page-context';
import { getMonthlyFigures, getSalesSeries } from '@/lib/dashboard/monthly-figures';

/**
 * Plan Finora §2.4 pkt 10: `getMonthlyFigures` i `getSalesSeries` brały
 * miesiąc z `now.getMonth()`, czyli w strefie procesu. Serwer i worker
 * chodzą w UTC, więc 1. dnia miesiąca między 00:00 a 02:00 czasu polskiego
 * „ten miesiąc” był jeszcze poprzednim: faktura z dziś nie trafiała do
 * liczb miesiąca, nazwa miesiąca i termin VAT były o miesiąc wcześniejsze.
 * Miesiąc ma być ten z `todayInWarsaw(now)`, jak na `/przeplywy`,
 * niezależnie od strefy serwera.
 */

type Row = Record<string, unknown>;

let rows: Row[];

function database(): PageContext['supabase'] {
  return {
    from(table: string) {
      const predicates: Array<(row: Row) => boolean> = [];
      let columns: string[] | null = null;
      let head = false;
      let sortKey: string | null = null;
      let window: [number, number] | null = null;
      const query = {
        select(selection = '*', options?: { head?: boolean }) {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.includes('*') ? null : parts;
          head = Boolean(options?.head);
          return query;
        },
        is(key: string, value: unknown) {
          predicates.push((r) => (value === null ? r[key] == null : r[key] === value));
          return query;
        },
        range(from: number, to: number) { window = [from, to]; return query; },
        eq(key: string, value: unknown) { predicates.push((r) => r[key] === value); return query; },
        in(key: string, values: unknown[]) { predicates.push((r) => values.includes(r[key])); return query; },
        gte(key: string, value: string) { predicates.push((r) => String(r[key]) >= value); return query; },
        lt(key: string, value: string) { predicates.push((r) => String(r[key]) < value); return query; },
        order(key: string) { sortKey = key; return query; },
        then(resolve: (v: unknown) => unknown) {
          if (table !== 'invoices') return Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
          const matching = rows.filter((r) => predicates.every((p) => p(r)));
          if (sortKey) {
            const k = sortKey;
            matching.sort((a, b) => String(a[k]).localeCompare(String(b[k])));
          }
          const page = window ? matching.slice(window[0], window[1] + 1) : matching;
          const data = page.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
          return Promise.resolve({ data: head ? null : data, count: matching.length, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as PageContext['supabase'];
}

const TENANT = 'firma-a';

function invoice(id: string, issueDate: string, gross: number, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    invoice_kind: 'vat',
    advance_invoice_ids: null,
    currency: 'PLN',
    issue_date: issueDate,
    net_total: gross / 1.23,
    vat_total: gross - gross / 1.23,
    gross_total: gross,
    ...fields,
  };
}

/** 1 października 2026, 00:30 czasu polskiego (CEST, UTC+2). */
const PIERWSZY_PAZDZIERNIKA_0030 = new Date('2026-09-30T22:30:00Z');
/** 1 stycznia 2027, 00:30 czasu polskiego (CET, UTC+1). */
const NOWY_ROK_0030 = new Date('2026-12-31T23:30:00Z');
/** 30 września 2026, 12:00 czasu polskiego — na Kiritimati (UTC+14) to już 1 października. */
const TRZYDZIESTY_WRZESNIA_POLUDNIE = new Date('2026-09-30T10:00:00Z');

const ORIGINAL_TZ = process.env.TZ;

function runInZone(zone: string) {
  // Node przelicza strefę przy każdym przypisaniu `process.env.TZ`.
  process.env.TZ = zone;
}

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('pulpit — miesiąc w Europe/Warsaw, nie w strefie serwera (§2.4 pkt 10)', () => {
  beforeEach(() => {
    runInZone('UTC');
    rows = [
      invoice('wrz-1', '2026-09-12', 1230),
      invoice('paz-1', '2026-10-01', 2460),
      invoice('szkic-paz', '2026-10-01', 999, { ksef_status: 'draft', ksef_environment: null }),
    ];
  });

  it('1. dnia miesiąca o 00:30 w Polsce liczby miesiąca są już z nowego miesiąca (serwer w UTC)', async () => {
    const figures = await getMonthlyFigures(database(), TENANT, PIERWSZY_PAZDZIERNIKA_0030);

    expect(figures.monthName).toBe('październik 2026');
    expect(figures.acceptedCount).toBe(1);
    expect(figures.totalGross).toBe(2460);
    expect(figures.prevAcceptedCount).toBe(1);
    expect(figures.hasPrevMonth).toBe(true);
    expect(figures.momCountPct).toBe(0);
    expect(figures.momGrossPct).toBe(100);
    expect(figures.draftCount).toBe(1);
  });

  it('termin VAT to 25. dzień NASTĘPNEGO miesiąca po polskim „dziś”, a dni liczą się od polskiej daty', async () => {
    const figures = await getMonthlyFigures(database(), TENANT, PIERWSZY_PAZDZIERNIKA_0030);

    expect(figures.vatDueLabel).toBe('25.11.2026');
    // 1.10 → 25.11: 30 dni października + 25 dni listopada.
    expect(figures.daysToVatDue).toBe(55);
  });

  it('wykres sprzedaży kończy się na polskim bieżącym miesiącu', async () => {
    const series = await getSalesSeries(database(), TENANT, PIERWSZY_PAZDZIERNIKA_0030);

    expect(series.currentMonthKey).toBe('2026-10');
    expect(series.months.map((m) => m.key)).toEqual([
      '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(series.months.at(-1)?.label).toBe('Paź');
    expect(series.currentSeries.at(-1)).toBe(2460);
    expect(series.currentSeries.at(-2)).toBe(1230);
  });

  it('w Nowy Rok o 00:30 rok i „najlepszy miesiąc roku” są już z nowego roku', async () => {
    rows = [
      invoice('gru-1', '2026-12-10', 50_000),
      invoice('sty-1', '2027-01-01', 1230),
    ];

    const figures = await getMonthlyFigures(database(), TENANT, NOWY_ROK_0030);
    const series = await getSalesSeries(database(), TENANT, NOWY_ROK_0030);

    expect(figures.monthName).toBe('styczeń 2027');
    expect(figures.acceptedCount).toBe(1);
    expect(figures.prevAcceptedCount).toBe(1);
    // Grudzień 2026 to inny rok: styczeń jest najlepszym miesiącem 2027.
    expect(figures.isBestMonthOfYear).toBe(true);
    expect(figures.vatDueLabel).toBe('25.02.2027');
    expect(figures.daysToVatDue).toBe(55);
    expect(series.currentMonthKey).toBe('2027-01');
    expect(series.months[0]?.key).toBe('2026-08');
    expect(series.currentSeries.at(-1)).toBe(1230);
    expect(series.prevSeries.at(-1)).toBe(0);
  });

  it('serwer w strefie „przed” Polską też nie przesuwa miesiąca do przodu', async () => {
    runInZone('Pacific/Kiritimati');

    const figures = await getMonthlyFigures(database(), TENANT, TRZYDZIESTY_WRZESNIA_POLUDNIE);
    const series = await getSalesSeries(database(), TENANT, TRZYDZIESTY_WRZESNIA_POLUDNIE);

    expect(figures.monthName).toBe('wrzesień 2026');
    expect(figures.acceptedCount).toBe(1);
    expect(figures.totalGross).toBe(1230);
    expect(figures.vatDueLabel).toBe('25.10.2026');
    expect(figures.daysToVatDue).toBe(25);
    expect(series.currentMonthKey).toBe('2026-09');
  });

  it('w środku dnia wynik jest ten sam w każdej strefie serwera', async () => {
    const midday = new Date('2026-10-15T10:00:00Z');
    const results = [];
    for (const zone of ['UTC', 'Europe/Warsaw', 'America/New_York', 'Pacific/Kiritimati']) {
      runInZone(zone);
      const figures = await getMonthlyFigures(database(), TENANT, midday);
      const series = await getSalesSeries(database(), TENANT, midday);
      results.push({
        monthName: figures.monthName,
        vatDueLabel: figures.vatDueLabel,
        daysToVatDue: figures.daysToVatDue,
        currentMonthKey: series.currentMonthKey,
        labels: series.months.map((m) => m.label).join(','),
      });
    }

    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({
      monthName: 'październik 2026',
      vatDueLabel: '25.11.2026',
      daysToVatDue: 41,
      currentMonthKey: '2026-10',
      labels: 'Maj,Cze,Lip,Sie,Wrz,Paź',
    });
  });
});
