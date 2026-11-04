import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PageContext } from '@/lib/supabase/page-context';
import {
  buildVatLimitOverview,
  getVatLimit,
  vatLimitLevel,
  vatLimitReadStart,
} from '@/lib/dashboard/vat-limit';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import { MAX_SALE_DAYS_AFTER_ISSUE } from '@/lib/invoices/sale-date';

/**
 * Karta „Limit zwolnienia z VAT” (plan Finora P1, opcja A z 19.10.2026).
 * Sprzedaż według §2.4 planu, limit i prognoza z `lib/flo/functions/vat-limit.ts`.
 * Atrapa bazy honoruje filtry, liczbę rekordów i strony jak PostgREST.
 */

type Row = Record<string, unknown>;

let rows: Row[];
let tenant: { business_started_on?: unknown; error?: { code: string; message: string } };

function database(): PageContext['supabase'] {
  return {
    from(table: string) {
      const predicates: Array<(row: Row) => boolean> = [];
      let columns: string[] | null = null;
      let head = false;
      let sortKey: string | null = null;
      let window: [number, number] | null = null;
      const result = () => {
        const matching = rows.filter((r) => predicates.every((p) => p(r)));
        if (sortKey) {
          const k = sortKey;
          matching.sort((a, b) => String(a[k]).localeCompare(String(b[k])));
        }
        // PostgREST ucina odpowiedź po 1000 wierszy niezależnie od zakresu.
        const page = (window ? matching.slice(window[0], window[1] + 1) : matching).slice(0, 1000);
        const data = page.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
        return { data: head ? null : data, count: matching.length, error: null };
      };
      const query = {
        select(selection = '*', options?: { head?: boolean }) {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.includes('*') ? null : parts;
          head = Boolean(options?.head);
          return query;
        },
        eq(key: string, value: unknown) { predicates.push((r) => r[key] === value); return query; },
        is(key: string, value: unknown) {
          predicates.push((r) => (value === null ? r[key] == null : r[key] === value));
          return query;
        },
        in(key: string, values: unknown[]) { predicates.push((r) => values.includes(r[key])); return query; },
        gte(key: string, value: string) { predicates.push((r) => String(r[key]) >= value); return query; },
        lt(key: string, value: string) { predicates.push((r) => String(r[key]) < value); return query; },
        order(key: string) { sortKey = key; return query; },
        range(from: number, to: number) { window = [from, to]; return query; },
        maybeSingle() {
          if (table !== 'tenants') throw new Error(`maybeSingle na ${table}`);
          if (tenant.error) return Promise.resolve({ data: null, error: tenant.error });
          return Promise.resolve({ data: { business_started_on: tenant.business_started_on ?? null }, error: null });
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          if (table !== 'invoices') return Promise.reject(new Error(`Nieoczekiwana tabela ${table}`)).then(resolve, reject);
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return query;
    },
  } as unknown as PageContext['supabase'];
}

const TENANT = 'firma-a';
/** 15 października 2026, południe w Polsce. */
const NOW = new Date('2026-10-15T10:00:00.000Z');

function invoice(id: string, fields: Row): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    invoice_kind: 'regular',
    advance_invoice_ids: null,
    currency: 'PLN',
    sale_date: null,
    ...fields,
  };
}

const sale = (id: string, issueDate: string, net: number, extra: Row = {}) =>
  invoice(id, { issue_date: issueDate, net_total: net, ...extra });

const monthValue = (o: { months: { key: string }[]; cumulative: number[] }, key: string) =>
  o.cumulative[o.months.findIndex((m) => m.key === key)];

beforeEach(() => {
  rows = [];
  tenant = { business_started_on: '2020-03-01' };
});

describe('limit zwolnienia z VAT — limit i procent', () => {
  it('firma działająca od lat ma pełny limit 240 000 zł', async () => {
    rows = [sale('a', '2026-02-10', 40_000), sale('b', '2026-05-20', 20_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.year).toBe(2026);
    expect(o.today).toBe('2026-10-15');
    expect(o.annualLimit).toBe(240_000);
    expect(o.startedOn).toBe('2020-03-01');
    expect(o.used).toBe(60_000);
    expect(o.limit).toMatchObject({
      effectiveLimit: 240_000,
      prorated: false,
      activeDays: 365,
      daysInYear: 365,
      remaining: 180_000,
      level: 'ok',
    });
    expect(o.limit!.pct).toBeCloseTo(25, 10);
    expect(o.limit!.formula).toContain('(pełny rok)');
  });

  it('firma założona 1.07 ma limit proporcjonalny: 240 000 × 184/365', async () => {
    tenant = { business_started_on: '2026-07-01' };
    rows = [sale('a', '2026-08-10', 60_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    // 1.07–31.12 = 31+31+30+31+30+31 = 184 dni; 240 000 × 184 / 365 = 120 986,30.
    expect(o.limit).toMatchObject({
      effectiveLimit: 120_986.3,
      prorated: true,
      activeDays: 184,
      daysInYear: 365,
      remaining: 60_986.3,
    });
    expect(o.limit!.pct).toBeCloseTo((60_000 / 120_986.3) * 100, 10);
    expect(o.limit!.formula).toContain('184/365 dni');
  });

  it('rok przestępny: firma od 1.03.2028 ma 240 000 × 306/366', () => {
    const o = buildVatLimitOverview([], new Map(), '2028-03-01', '2028-03-10', 240_000);

    // 1.03–31.12.2028 = 306 dni; 240 000 × 306 / 366 = 200 655,74.
    expect(o.limit).toMatchObject({ effectiveLimit: 200_655.74, activeDays: 306, daysInYear: 366 });
  });

  it('próg 80%: 200 000 zł z 240 000 zł to poziom 80', async () => {
    rows = [sale('a', '2026-03-01', 200_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.limit!.pct).toBeCloseTo(83.333, 2);
    expect(o.limit!.level).toBe(80);
  });

  it('przekroczenie: ponad 100% to poziom 100 i zero pozostałego limitu', async () => {
    rows = [sale('a', '2026-03-01', 200_000), sale('b', '2026-09-01', 50_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(250_000);
    expect(o.limit!.pct).toBeGreaterThan(100);
    expect(o.limit!.level).toBe(100);
    expect(o.limit!.remaining).toBe(0);
    // Limit już przekroczony — prognoza wskazuje dziś, nie „wystarczy”.
    expect(o.limit!.crossesOn).toBe('2026-10-15');
  });

  it('poziomy na granicach progów (sprzedaż i limit w złotych)', () => {
    expect(vatLimitLevel(0, 100)).toBe('ok');
    expect(vatLimitLevel(59.99, 100)).toBe('ok');
    expect(vatLimitLevel(60, 100)).toBe(60);
    expect(vatLimitLevel(79.99, 100)).toBe(60);
    expect(vatLimitLevel(80, 100)).toBe(80);
    expect(vatLimitLevel(90, 100)).toBe(90);
    expect(vatLimitLevel(99.99, 100)).toBe(90);
    // Art. 113 ust. 5: zwolnienie traci się dopiero, gdy sprzedaż PRZEKROCZY limit.
    expect(vatLimitLevel(100, 100)).toBe(90);
    expect(vatLimitLevel(100.01, 100)).toBe(100);
    expect(vatLimitLevel(250, 100)).toBe(100);
    expect(vatLimitLevel(-5, 100)).toBe('ok');
  });

  it('sprzedaż równa limitowi to jeszcze nie przekroczenie: 240 000,00 zł → poziom 90, zostaje 0', async () => {
    rows = [sale('a', '2026-03-01', 200_000), sale('b', '2026-09-01', 40_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(240_000);
    expect(o.limit!.level).toBe(90);
    expect(o.limit!.remaining).toBe(0);
  });

  it('grosz ponad limit to przekroczenie: 240 000,01 zł → poziom 100', async () => {
    rows = [sale('a', '2026-03-01', 200_000), sale('b', '2026-09-01', 40_000.01)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(240_000.01);
    expect(o.limit!.level).toBe(100);
    expect(o.limit!.remaining).toBe(0);
  });
});

describe('limit zwolnienia z VAT — co jest sprzedażą (§2.4)', () => {
  it('korekta in minus obniża wykorzystanie w swoim miesiącu', async () => {
    rows = [
      sale('a', '2026-02-10', 50_000),
      sale('k', '2026-06-05', -5_000, { invoice_kind: 'correction' }),
    ];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(45_000);
    expect(monthValue(o, '2026-05')).toBe(50_000);
    expect(monthValue(o, '2026-06')).toBe(45_000);
  });

  it('zaliczka 10 000 zł + ROZ 30 000 zł daje 30 000 zł, nie 40 000 zł', async () => {
    rows = [
      sale('zal', '2026-03-10', 10_000, { invoice_kind: 'advance' }),
      sale('roz', '2026-04-20', 30_000, { invoice_kind: 'final', advance_invoice_ids: ['zal'] }),
    ];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(30_000);
    expect(monthValue(o, '2026-03')).toBe(10_000);
    expect(monthValue(o, '2026-04')).toBe(30_000);
  });

  it('sprzedaż z 30.12 na fakturze z 3.01 należy do poprzedniego roku', async () => {
    rows = [
      sale('gr', '2026-01-03', 15_000, { sale_date: '2025-12-30' }),
      sale('a', '2026-01-10', 1_000),
    ];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(1_000);
  });

  it('data sprzedaży wcześniejsza niż wystawienie przesuwa miesiąc narastająco', async () => {
    rows = [sale('a', '2026-04-02', 7_000, { sale_date: '2026-03-28' })];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(monthValue(o, '2026-02')).toBe(0);
    expect(monthValue(o, '2026-03')).toBe(7_000);
    expect(monthValue(o, '2026-04')).toBe(7_000);
  });

  it('data sprzedaży późniejsza niż wystawienie też przesuwa — liczy się data sprzedaży (VAT)', async () => {
    rows = [sale('a', '2026-03-28', 7_000, { sale_date: '2026-04-05' })];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(monthValue(o, '2026-03')).toBe(0);
    expect(monthValue(o, '2026-04')).toBe(7_000);
    expect(o.used).toBe(7_000);
  });

  it('faktura z 10.12 poprzedniego roku za sprzedaż 15.01 liczy się do bieżącego roku', async () => {
    rows = [
      sale('zaliczona', '2025-12-10', 9_000, { sale_date: '2026-01-15' }),
      sale('stara', '2025-12-10', 50_000),
    ];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(9_000);
    expect(monthValue(o, '2026-01')).toBe(9_000);
  });

  it('niepoprawna data sprzedaży jest pomijana — liczy się wystawienie', async () => {
    rows = [
      sale('a', '2026-03-28', 7_000, { sale_date: '2026-13-40' }),
      sale('b', '2026-03-29', 1_000, { sale_date: '  ' }),
    ];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(monthValue(o, '2026-03')).toBe(8_000);
  });

  it('zdarzenie w przyszłym miesiącu bieżącego roku: w sumie, w bieżącym miesiącu wykresu', async () => {
    rows = [
      sale('a', '2026-03-01', 100_000),
      sale('przyszla', '2026-10-20', 20_000, { sale_date: '2026-11-20' }),
    ];

    const o = await getVatLimit(database(), TENANT, new Date('2026-10-25T10:00:00.000Z'));

    expect(o.months.at(-1)!.key).toBe('2026-10');
    expect(o.used).toBe(120_000);
    expect(monthValue(o, '2026-09')).toBe(100_000);
    expect(monthValue(o, '2026-10')).toBe(120_000);
    expect(o.limit!.pct).toBeCloseTo(50, 10);
    expect(o.limit!.remaining).toBe(120_000);
  });

  it('szkic, faktura z innego środowiska, zakup i cudza firma są pominięte', async () => {
    rows = [
      sale('a', '2026-02-10', 1_000),
      sale('szkic', '2026-02-11', 50_000, { ksef_status: 'draft', ksef_environment: null }),
      sale('prod', '2026-02-12', 60_000, { ksef_environment: 'production' }),
      sale('zakup', '2026-02-13', 70_000, { direction: 'incoming' }),
      sale('cudza', '2026-02-14', 80_000, { tenant_id: 'firma-b' }),
      sale('odrzucona', '2026-02-15', 90_000, { ksef_status: 'rejected' }),
    ];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(1_000);
  });

  it('faktura w EUR zatrzymuje kartę', async () => {
    rows = [sale('a', '2026-02-10', 1_000), sale('eur', '2026-03-01', 1_000, { currency: 'EUR' })];

    await expect(getVatLimit(database(), TENANT, NOW)).rejects.toBeInstanceOf(
      OutgoingInvoiceCurrencyNotSupportedError,
    );
  });

  it('okno odczytu zaczyna się MAX_SALE_DAYS_AFTER_ISSUE dni przed 1.01 — także dla strażnika środowiska', async () => {
    expect(vatLimitReadStart(2026)).toBe(
      new Date(Date.UTC(2026, 0, 1 - MAX_SALE_DAYS_AFTER_ISSUE)).toISOString().slice(0, 10),
    );
    expect(vatLimitReadStart(2026)).toBe('2025-11-02');

    rows = [sale('grudzien', '2025-12-10', 1_000, { ksef_environment: null, sale_date: '2026-01-15' })];
    await expect(getVatLimit(database(), TENANT, NOW)).rejects.toThrow(
      'Przyjęte faktury wymagają uzgodnienia środowiska KSeF',
    );

    // Przed oknem — poza zasięgiem nawet z datą sprzedaży w bieżącym roku.
    rows = [sale('za-wczesna', '2025-11-01', 1_000, { sale_date: '2026-01-01' })];
    expect((await getVatLimit(database(), TENANT, NOW)).used).toBe(0);
  });

  it('przyjęta faktura bez środowiska zatrzymuje kartę', async () => {
    rows = [sale('a', '2026-02-10', 1_000, { ksef_environment: null })];

    await expect(getVatLimit(database(), TENANT, NOW)).rejects.toThrow(
      'Przyjęte faktury wymagają uzgodnienia środowiska KSeF',
    );
  });

  it('ponad 1000 faktur — wszystkie strony wchodzą do sumy', async () => {
    rows = Array.from({ length: 1205 }, (_, i) =>
      sale(`f-${String(i).padStart(5, '0')}`, '2026-05-10', 100));

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(120_500);
  });

  it('grosze się nie rozjeżdżają: 0,10 + 0,20 − 0,30 daje 0', async () => {
    rows = [
      sale('a', '2026-02-01', 0.1),
      sale('b', '2026-02-02', 0.2),
      sale('k', '2026-02-03', -0.3, { invoice_kind: 'correction' }),
    ];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.used).toBe(0);
    expect(Object.is(o.used, -0)).toBe(false);
  });
});

describe('limit zwolnienia z VAT — data rozpoczęcia, prognoza, strefa', () => {
  it('bez daty rozpoczęcia: limit null, a sprzedaż i miesiące wypełnione', async () => {
    tenant = { business_started_on: null };
    rows = [sale('a', '2026-02-10', 12_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.startedOn).toBeNull();
    expect(o.limit).toBeNull();
    expect(o.used).toBe(12_000);
    expect(o.annualLimit).toBe(240_000);
    expect(o.months).toHaveLength(10);
    expect(o.cumulative).toHaveLength(10);
    expect(o.lowerBound).toEqual({ pct: 5, level: 'ok', remaining: 228_000 });
  });

  it('bez daty rozpoczęcia: dolna granica względem pełnego limitu rocznego', async () => {
    tenant = { business_started_on: null };

    rows = [sale('a', '2026-03-01', 200_000), sale('b', '2026-09-01', 50_000)];
    const over = await getVatLimit(database(), TENANT, NOW);
    expect(over.limit).toBeNull();
    expect(over.lowerBound!.level).toBe(100);
    expect(over.lowerBound!.remaining).toBe(0);
    expect(over.lowerBound!.pct).toBeCloseTo((250_000 / 240_000) * 100, 10);
    expect(over.lowerBound).not.toHaveProperty('crossesOn');

    rows = [sale('a', '2026-03-01', 150_000)];
    const mid = await getVatLimit(database(), TENANT, NOW);
    expect(mid.lowerBound!.level).toBe(60);
    expect(mid.lowerBound!.remaining).toBe(90_000);
    expect(mid.lowerBound!.pct).toBeCloseTo(62.5, 10);
  });

  it('dolna granica: równo pełny limit to poziom 90, grosz więcej — 100', async () => {
    tenant = { business_started_on: null };

    rows = [sale('a', '2026-03-01', 240_000)];
    expect((await getVatLimit(database(), TENANT, NOW)).lowerBound).toMatchObject({ level: 90, remaining: 0 });

    rows = [sale('a', '2026-03-01', 240_000.01)];
    expect((await getVatLimit(database(), TENANT, NOW)).lowerBound).toMatchObject({ level: 100, remaining: 0 });
  });

  it('przy znanej dacie rozpoczęcia dolnej granicy nie ma', async () => {
    rows = [sale('a', '2026-02-10', 12_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.limit).not.toBeNull();
    expect(o.lowerBound).toBeNull();
  });

  it('data rozpoczęcia z przyszłości (wpisana poza aplikacją) to data nieznana, nie „przekroczenie”', async () => {
    rows = [sale('a', '2026-02-10', 12_000)];
    for (const future of ['2026-11-01', '2027-03-01']) {
      tenant = { business_started_on: future };

      const o = await getVatLimit(database(), TENANT, NOW);

      expect(o.startedOn).toBeNull();
      expect(o.limit).toBeNull();
      expect(o.used).toBe(12_000);
      expect(o.lowerBound).toMatchObject({ level: 'ok', remaining: 228_000 });
    }
  });

  it('przed wgraniem 00153 (brak kolumny) karta prosi o datę zamiast się wywracać', async () => {
    tenant = { error: { code: '42703', message: 'column does not exist' } };

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.limit).toBeNull();
  });

  it('miesiące od stycznia do bieżącego, podpisy jak na wykresie sprzedaży', async () => {
    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.months.map((m) => m.key)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(o.months[0]!.label).toBe('Sty');
    expect(o.months[1]!.label).toBe('Lut');
    expect(o.months[9]!.label).toBe('Paź');
    expect(o.cumulative.every((v) => v === 0)).toBe(true);
    expect(o.used).toBe(0);
  });

  it('prognoza: przy tempie 200 000 zł do 15.10 limit skończy się 12.12', async () => {
    rows = [sale('a', '2026-03-01', 200_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    // 1.01–15.10 = 288 dni; 40 000 / (200 000 / 288) = 57,6 → 58 dni od 15.10.
    expect(o.limit!.crossesOn).toBe('2026-12-12');
  });

  it('prognoza: przy niskim tempie limit wystarczy do końca roku', async () => {
    rows = [sale('a', '2026-03-01', 10_000)];

    const o = await getVatLimit(database(), TENANT, NOW);

    expect(o.limit!.crossesOn).toBeNull();
  });

  it('brak parametrów na rok sprzed tabeli rzuca czytelny błąd', async () => {
    await expect(getVatLimit(database(), TENANT, new Date('2025-06-01T10:00:00Z'))).rejects.toThrow(
      'Brak parametrów limitu zwolnienia z VAT na ten rok',
    );
  });

  describe('strefa czasowa procesu UTC', () => {
    let previousTz: string | undefined;
    beforeEach(() => {
      previousTz = process.env.TZ;
      process.env.TZ = 'UTC';
    });
    afterEach(() => {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    });

    it('1.01 o 00:30 czasu polskiego liczy już nowy rok', async () => {
      rows = [sale('stary', '2026-12-31', 99_000), sale('nowy', '2027-01-01', 1_000)];

      // 31.12.2026 23:30 UTC = 1.01.2027 00:30 w Warszawie (CET, UTC+1).
      const o = await getVatLimit(database(), TENANT, new Date('2026-12-31T23:30:00.000Z'));

      expect(o.year).toBe(2027);
      expect(o.today).toBe('2027-01-01');
      expect(o.months).toEqual([{ key: '2027-01', label: 'Sty' }]);
      expect(o.used).toBe(1_000);
      expect(o.limit!.daysInYear).toBe(365);
    });
  });
});
