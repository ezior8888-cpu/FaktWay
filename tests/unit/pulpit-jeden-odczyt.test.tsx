import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Row, Tables } from '@/lib/demo/fake-postgrest';

/**
 * Sesja 19 planu skalowania (QRY-02, QAL-05, QRY-05, QRY-07, CPU-13): jedno
 * wejście na Pulpit czyta sprzedaż firmy RAZ, a wyniki kart się nie zmieniają.
 *
 * Prawdziwe: strona `/dashboard`, sloty kart, wszystkie loadery i atrapa
 * PostgREST z `lib/demo/fake-postgrest.ts` (ta sama, która obsługuje tryb
 * „przykład” na produkcji). Zastąpione: `getPageContext` i dowód KSeF (bez
 * sesji), `next/navigation` i pamięć `cache()` Reacta.
 *
 * `cache()` z Reacta poza renderem RSC niczego nie pamięta (samo przekazuje
 * wywołanie), więc tu dostaje pamięć jednego żądania: klucz to funkcja
 * i argumenty (wartości proste po wartości, obiekty po tożsamości — jak
 * w React). Wzór: `tests/unit/sesja-raz-na-render.test.tsx` (sesja 9).
 *
 * Złoty wzorzec: `tests/fixtures/pulpit-karty-przed-sesja-19.json` to propsy
 * kart (albo komunikat karty błędu) z kodu SPRZED sesji 19 (`main` 7a4f90ba),
 * zapisane dla każdego scenariusza niżej. Po zmianie te same scenariusze mają
 * dać te same propsy — liczba po liczbie. Wzorzec zapisuje się tylko na
 * żądanie: `PULPIT_WZORZEC=zapisz pnpm vitest run tests/unit/pulpit-jeden-odczyt`.
 */

const h = vi.hoisted(() => ({
  /** Pamięć bieżącego żądania RSC (`null` = poza renderem): drzewo funkcja → argumenty → wynik. */
  zadanie: null as Map<unknown, unknown> | null,
  WYNIK: Symbol('wynik'),
  BLAD: Symbol('blad'),
  ctx: null as unknown as { supabase: unknown; tenantId: string; user: { id: string; email: string | null }; role: 'owner' },
  proof: null as { verifiedAt: string | null; verifiedEnvironment: string | null } | null,
}));

type Wezel = Map<unknown, unknown>;

vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        if (!h.zadanie) return fn(...args);
        let wezel = h.zadanie as Wezel;
        for (const klucz of [fn, ...args]) {
          let dalej = wezel.get(klucz) as Wezel | undefined;
          if (!dalej) {
            dalej = new Map();
            wezel.set(klucz, dalej);
          }
          wezel = dalej;
        }
        if (wezel.has(h.BLAD)) throw wezel.get(h.BLAD);
        if (!wezel.has(h.WYNIK)) {
          try {
            wezel.set(h.WYNIK, fn(...args));
          } catch (e) {
            wezel.set(h.BLAD, e);
            throw e;
          }
        }
        return wezel.get(h.WYNIK) as R;
      },
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect ${to}`); },
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => h.ctx }));
vi.mock('@/lib/dashboard-shell-data', () => ({ getTenantKsefProof: async () => h.proof }));

const { default: DashboardHomePage } = await import('@/app/(dashboard)/dashboard/page');
const { danePrzykladowe, DEMO_TENANT } = await import('@/lib/demo/dane-przykladowe');
const { fakePostgrest } = await import('@/lib/demo/fake-postgrest');
/** Ikony po nazwie eksportu — paczka `@remixicon/react` jest zminifikowana, więc `name` komponentu zmienia się między wydaniami. */
const IKONY = new Map<unknown, string>(Object.entries(await import('@remixicon/react')).map(([nazwa, ikona]) => [ikona, nazwa]));

const WZORZEC = join(process.cwd(), 'tests/fixtures/pulpit-karty-przed-sesja-19.json');
const NOW = new Date('2026-10-23T08:00:00Z');
const ZWERYFIKOWANA = { verifiedAt: '2026-10-12T08:00:00Z', verifiedEnvironment: 'test' };

// ─── Atrapa licząca zapytania (z wstrzykiwaniem awarii) ───────────────────

/** Jedno zapytanie do atrapy: tabela, opcje `select` i wywołane filtry. */
interface Zapytanie {
  table: string;
  head: boolean;
  count: boolean;
  calls: Array<[string, unknown[]]>;
  /** Wiersze w odpowiedzi (bez `head`). */
  wiersze: number;
}

interface Zaklocenia {
  /** Treść błędu PostgREST-a dla zapytania; `null` = bez błędu. */
  awaria?: (z: Zapytanie) => string | null;
  /** Ucina odpowiedź do tylu wierszy (licznik zostaje) — jak cichy limit serwera. */
  uciecie?: (z: Zapytanie) => number | null;
  /** Zmienia tabele tuż przed odpowiedzią na zapytanie (zapis w trakcie odczytu). */
  przed?: (z: Zapytanie, tables: Tables) => void;
}

function ma(z: Zapytanie, metoda: string, ...args: unknown[]): boolean {
  return z.calls.some(([m, a]) => m === metoda && args.every((v, i) => a[i] === v));
}

function liczacyKlient(tables: Tables, log: Zapytanie[], zaklocenia: Zaklocenia = {}) {
  const inner = fakePostgrest(tables) as unknown as { from(table: string): Record<string, unknown> };
  return {
    from(table: string) {
      const z: Zapytanie = { table, head: false, count: false, calls: [], wiersze: 0 };
      log.push(z);
      const builder = inner.from(table) as Record<string, (...args: unknown[]) => unknown>;
      for (const metoda of Object.keys(builder)) {
        const oryginal = builder[metoda]!;
        if (metoda === 'then' || metoda === 'maybeSingle') continue;
        builder[metoda] = (...args: unknown[]) => {
          if (metoda === 'select') {
            const opcje = args[1] as { count?: string; head?: boolean } | undefined;
            z.head = opcje?.head === true;
            z.count = opcje?.count === 'exact';
          }
          z.calls.push([metoda, args]);
          return oryginal(...args);
        };
      }
      const then = builder.then!;
      builder.then = ((resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        zaklocenia.przed?.(z, tables);
        const blad = zaklocenia.awaria?.(z) ?? null;
        if (blad !== null) {
          return Promise.resolve({ data: null, count: null, error: { message: blad } }).then(resolve, reject);
        }
        const limit = zaklocenia.uciecie?.(z) ?? null;
        return (then as (r: (v: unknown) => unknown) => Promise<unknown>)((wynik) => {
          const w = wynik as { data: Row[] | null };
          const dane = limit !== null && w.data ? { ...w, data: w.data.slice(0, limit) } : w;
          z.wiersze = Array.isArray(dane.data) ? dane.data.length : 0;
          return resolve(dane);
        });
      }) as never;
      return builder;
    },
  };
}

// ─── Propsy kart z drzewa strony ──────────────────────────────────────────

function nazwaTypu(type: unknown): string {
  if (typeof type === 'string') return type;
  if (IKONY.has(type)) return IKONY.get(type)!;
  if (typeof type === 'function') return (type as { displayName?: string }).displayName ?? type.name ?? 'anonim';
  if (type && typeof type === 'object' && 'displayName' in type) return String((type as { displayName: unknown }).displayName);
  return String(type);
}

/** Wartość do porównania: liczby z −0 i NaN, `undefined` osobno od `null`, elementy Reacta jako typ i propsy, funkcje po nazwie. */
function zapis(value: unknown): unknown {
  if (value === undefined) return '(undefined)';
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '−0';
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === 'function') return `[funkcja ${value.name}]`;
  if (isValidElement(value)) {
    const el = value as { type: unknown; props: Record<string, unknown> };
    return { element: nazwaTypu(el.type), props: zapis(el.props) };
  }
  if (Array.isArray(value)) return value.map(zapis);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, zapis(v)]));
  }
  return value ?? null;
}

/** Karta slotu: dziecko `SectionErrorBoundary` (dane albo karta błędu). */
function karty(node: ReactNode): unknown[] {
  const out: unknown[] = [];
  const odwiedz = (n: ReactNode) => {
    if (Array.isArray(n)) { n.forEach(odwiedz); return; }
    if (!isValidElement(n)) return;
    const el = n as { type: unknown; props: { children?: ReactNode; fallback?: unknown } };
    if (el.props.fallback !== undefined) {
      out.push(zapis(el.props.children));
      return;
    }
    odwiedz(el.props.children);
  };
  odwiedz(node);
  return out;
}

// ─── Scenariusze ──────────────────────────────────────────────────────────

/** Data RRRR-MM-15 sprzed `miesiecy` miesięcy względem `now`. */
function miesiacTemu(now: Date, miesiecy: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - miesiecy, 15));
  return d.toISOString().slice(0, 10);
}

function sprzedaz(tables: Tables): Row[] {
  return tables.invoices!.filter((f) => f.direction === 'outgoing' && f.ksef_status === 'accepted');
}

/** Kopia przyjętej faktury sprzedaży z danego miesiąca (rodzaj `regular`) z nadpisanymi polami. */
function dopiszFakture(tables: Tables, now: Date, miesiecy: number, pola: Row): void {
  const data = miesiacTemu(now, miesiecy);
  const wzor = sprzedaz(tables).find((f) => f.invoice_kind === 'regular' && String(f.issue_date).slice(0, 7) === data.slice(0, 7))
    ?? sprzedaz(tables).find((f) => f.invoice_kind === 'regular')!;
  tables.invoices!.push({ ...wzor, issue_date: data, sale_date: data, ...pola });
}

/** Kopia przyjętej faktury sprzedaży `regular` z datą wystawienia i sprzedaży `iso`. */
function dopiszNaDzien(tables: Tables, iso: string, pola: Row): void {
  const wzor = sprzedaz(tables).find((f) => f.invoice_kind === 'regular')!;
  tables.invoices!.push({ ...wzor, issue_date: iso, sale_date: iso, ...pola });
}

/** 1. dzień miesiąca za `miesiecy` miesięcy (RRRR-MM-DD). */
function zaMiesiecy(now: Date, miesiecy: number, dzien = 5): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + miesiecy, dzien)).toISOString().slice(0, 10);
}

/** ROZ rozliczająca dwie zaliczki: zaliczki 2 i 4 miesiące temu, ROZ 1 miesiąc temu. */
function dopiszRoz(tables: Tables, now: Date): void {
  const baza = sprzedaz(tables).find((f) => f.invoice_kind === 'regular')!;
  const zal = (id: string, m: number, net: number) => ({
    ...baza, id, invoice_kind: 'advance', advance_invoice_ids: [], issue_date: miesiacTemu(now, m), sale_date: miesiacTemu(now, m),
    net_total: net, vat_total: net * 0.23, gross_total: net * 1.23,
  });
  tables.invoices!.push(zal('zal-a', 4, 1000), zal('zal-b', 2, 2500.55));
  tables.invoices!.push({
    ...baza, id: 'roz-1', invoice_kind: 'final', advance_invoice_ids: ['zal-a', 'zal-b', 'zal-a'],
    issue_date: miesiacTemu(now, 1), sale_date: miesiacTemu(now, 1),
    net_total: 10000, vat_total: 2300, gross_total: 12300,
  });
  tables.invoice_line_items!.push(
    { id: 'roz-1-poz-1', invoice_id: 'roz-1', name: 'Wdrożenie systemu', unit: 'usł', net_amount: 10000 },
  );
}

/** Duża firma: `n` faktur sprzedaży w 24 miesiącach, po 3 pozycje, id w innej kolejności niż daty. */
function duzaFirma(now: Date, env: string, n: number): Tables {
  const tables = danePrzykladowe(now, env as 'test');
  const hex = (i: number) => i.toString(16).padStart(12, '0');
  for (let i = 0; i < n; i++) {
    const p = (i * 7919) % n;
    const id = `00000000-0000-4000-8000-${hex(p + 1)}`;
    const data = miesiacTemu(now, i % 24).slice(0, 8) + String(1 + (i % 27)).padStart(2, '0');
    const net = 100 + ((i * 37) % 900) + 0.1 * (i % 10);
    tables.invoices!.push({
      id, tenant_id: DEMO_TENANT, direction: 'outgoing', ksef_status: 'accepted', ksef_environment: env,
      invoice_kind: i % 50 === 0 ? 'correction' : 'regular', advance_invoice_ids: [], currency: 'PLN',
      issue_date: data, sale_date: data, internal_number: `FV/${i}`, net_total: net, vat_total: Math.round(net * 23) / 100,
      gross_total: Math.round(net * 123) / 100, buyer_nip: `52${String(1000000 + (i % 40)).padStart(8, '0')}`,
      buyer_data: { name: `Klient ${i % 40} sp. z o.o.` }, is_b2c: i % 13 === 0, origin: 'app', invoice_type: 'VAT',
      payment_due_date: null, paid_at: null, fa3_data: null,
    });
    for (let j = 0; j < 3; j++) {
      tables.invoice_line_items!.push({
        id: `${id.slice(0, 24)}${hex(p * 3 + j + 1)}`.slice(0, 36) + `-${j}`,
        invoice_id: id, name: `Produkt ${(i + j) % 17} – październik 2026`, unit: j === 2 ? ' szt ' : 'szt', net_amount: net / 3,
      });
    }
  }
  return tables;
}

interface Scenariusz {
  nazwa: string;
  now?: Date;
  /** Dowód KSeF; bez — firma zweryfikowana w środowisku testowym. */
  proof?: { verifiedAt: string | null; verifiedEnvironment: string | null };
  tabele: (now: Date) => Tables;
  zaklocenia?: Zaklocenia;
}

const czyOdczytSprzedazy = (z: Zapytanie) =>
  z.table === 'invoices' && !z.head && ma(z, 'eq', 'direction', 'outgoing') && ma(z, 'eq', 'ksef_status', 'accepted')
  && ma(z, 'eq', 'ksef_environment', 'test');
const czyStraznikSrodowiska = (z: Zapytanie) =>
  z.table === 'invoices' && ma(z, 'eq', 'ksef_status', 'accepted') && ma(z, 'is', 'ksef_environment', null);
const czyOdczytZaliczek = (z: Zapytanie) => z.table === 'invoices' && ma(z, 'eq', 'invoice_kind', 'advance');
/** Licznik kontrolny po kilku stronach wspólnego odczytu (`head`, te same filtry co strony). */
const czyLicznikSprzedazy = (z: Zapytanie) =>
  z.table === 'invoices' && z.head && ma(z, 'eq', 'direction', 'outgoing') && ma(z, 'eq', 'ksef_status', 'accepted')
  && ma(z, 'eq', 'ksef_environment', 'test');

const SCENARIUSZE: Scenariusz[] = [
  { nazwa: 'tryb przykład (firma bez weryfikacji)', proof: { verifiedAt: null, verifiedEnvironment: null }, tabele: () => ({}) },
  { nazwa: 'dane przykładowe jako prawdziwe', tabele: (now) => danePrzykladowe(now, 'test') },
  { nazwa: 'dane przykładowe, firma zwolniona z VAT', tabele: (now) => danePrzykladowe(now, 'test', { zwolnionyZVat: true }) },
  { nazwa: 'pusta firma', tabele: () => ({ tenants: [{ id: DEMO_TENANT, vat_exemption_basis: null, business_started_on: null }] }) },
  {
    nazwa: 'faktura EUR sprzed 10 miesięcy',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszFakture(t, now, 10, { id: 'eur-10', currency: 'EUR' }); return t; },
  },
  {
    nazwa: 'faktura EUR sprzed 20 miesięcy',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszFakture(t, now, 20, { id: 'eur-20', currency: 'EUR' }); return t; },
  },
  {
    nazwa: 'faktura EUR sprzed 4 miesięcy, zaliczka (poza rankingiem produktów)',
    tabele: (now) => {
      const t = danePrzykladowe(now, 'test');
      dopiszFakture(t, now, 4, { id: 'eur-zal', currency: 'EUR', invoice_kind: 'advance' });
      return t;
    },
  },
  {
    nazwa: 'faktura bez waluty w bieżącym miesiącu',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszFakture(t, now, 0, { id: 'bez-waluty', currency: null }); return t; },
  },
  {
    nazwa: 'przyjęta faktura bez środowiska sprzed 20 miesięcy',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszFakture(t, now, 20, { id: 'bez-env-20', ksef_environment: null }); return t; },
  },
  {
    nazwa: 'przyjęta faktura bez środowiska sprzed 3 miesięcy',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszFakture(t, now, 3, { id: 'bez-env-3', ksef_environment: null }); return t; },
  },
  {
    nazwa: 'przyjęta faktura bez środowiska rok i 2 miesiące temu (tylko rok wcześniej Przychodu i klienci)',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszFakture(t, now, 14, { id: 'bez-env-14', ksef_environment: null }); return t; },
  },
  {
    nazwa: 'faktura EUR 5 miesięcy temu i bez środowiska 20 miesięcy temu',
    tabele: (now) => {
      const t = danePrzykladowe(now, 'test');
      dopiszFakture(t, now, 5, { id: 'eur-5', currency: 'EUR' });
      dopiszFakture(t, now, 20, { id: 'bez-env-20', ksef_environment: null });
      return t;
    },
  },
  {
    nazwa: 'faktura z innego środowiska (produkcja) nie liczy się nigdzie',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszFakture(t, now, 1, { id: 'prod-1', ksef_environment: 'production', currency: 'EUR' }); return t; },
  },
  {
    nazwa: 'ROZ z dwiema zaliczkami',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszRoz(t, now); return t; },
  },
  {
    nazwa: 'ROZ: awaria odczytu zaliczek',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszRoz(t, now); return t; },
    zaklocenia: { awaria: (z) => (czyOdczytZaliczek(z) ? 'connection reset' : null) },
  },
  {
    nazwa: 'awaria strażnika środowiska',
    tabele: (now) => danePrzykladowe(now, 'test'),
    zaklocenia: { awaria: (z) => (czyStraznikSrodowiska(z) ? 'statement timeout' : null) },
  },
  {
    nazwa: 'awaria odczytu sprzedaży',
    tabele: (now) => danePrzykladowe(now, 'test'),
    zaklocenia: { awaria: (z) => (czyOdczytSprzedazy(z) ? 'statement timeout' : null) },
  },
  {
    nazwa: 'serwer ucina odczyt sprzedaży (niepełna strona)',
    tabele: (now) => danePrzykladowe(now, 'test'),
    zaklocenia: { uciecie: (z) => (czyOdczytSprzedazy(z) ? 3 : null) },
  },
  {
    nazwa: 'awaria odczytu pozycji faktur',
    tabele: (now) => danePrzykladowe(now, 'test'),
    zaklocenia: { awaria: (z) => (z.table === 'invoice_line_items' ? 'statement timeout' : null) },
  },
  {
    nazwa: 'awaria odczytu szkiców',
    tabele: (now) => danePrzykladowe(now, 'test'),
    zaklocenia: { awaria: (z) => (z.table === 'invoices' && ma(z, 'eq', 'ksef_status', 'draft') ? 'statement timeout' : null) },
  },
  {
    nazwa: 'firma VAT: przyjęta faktura bez środowiska z datą w przyszłym miesiącu',
    tabele: (now) => { const t = danePrzykladowe(now, 'test'); dopiszNaDzien(t, zaMiesiecy(now, 1), { id: 'bez-env-przyszly', ksef_environment: null }); return t; },
  },
  {
    nazwa: 'zwolniona: faktura z datą w przyszłym miesiącu (limit VAT do końca roku)',
    tabele: (now) => {
      const t = danePrzykladowe(now, 'test', { zwolnionyZVat: true });
      dopiszNaDzien(t, zaMiesiecy(now, 1), { id: 'przyszla', net_total: 1234.56, vat_total: 0, gross_total: 1234.56 });
      return t;
    },
  },
  {
    nazwa: 'zwolniona: przyjęta faktura bez środowiska z datą w przyszłym miesiącu',
    tabele: (now) => {
      const t = danePrzykladowe(now, 'test', { zwolnionyZVat: true });
      dopiszNaDzien(t, zaMiesiecy(now, 1), { id: 'bez-env-przyszly', ksef_environment: null });
      return t;
    },
  },
  {
    nazwa: 'zwolniona: faktura wystawiona w grudniu za sprzedaż ze stycznia',
    now: new Date('2027-01-04T07:00:00Z'),
    tabele: () => {
      const t = danePrzykladowe(new Date('2027-01-04T07:00:00Z'), 'test', { zwolnionyZVat: true });
      dopiszNaDzien(t, '2026-12-20', { id: 'gru-sty', sale_date: '2027-01-10', net_total: 999.99, vat_total: 0, gross_total: 999.99 });
      return t;
    },
  },
  {
    nazwa: 'zwolniona, styczeń: faktura EUR z 20 listopada (okno odczytu limitu VAT)',
    now: new Date('2027-01-04T07:00:00Z'),
    tabele: () => {
      const t = danePrzykladowe(new Date('2027-01-04T07:00:00Z'), 'test', { zwolnionyZVat: true });
      dopiszNaDzien(t, '2026-11-20', { id: 'eur-lis', currency: 'EUR' });
      return t;
    },
  },
  {
    nazwa: 'zwolniona: awaria odczytu sprzedaży',
    tabele: (now) => danePrzykladowe(now, 'test', { zwolnionyZVat: true }),
    zaklocenia: { awaria: (z) => (czyOdczytSprzedazy(z) ? 'statement timeout' : null) },
  },
  { nazwa: 'mikrofirma: 40 faktur miesięcznie przez 24 miesiące', tabele: (now) => duzaFirma(now, 'test', 960) },
  { nazwa: 'duża firma: 3600 faktur w 24 miesiącach', tabele: (now) => duzaFirma(now, 'test', 3600) },
  {
    nazwa: 'duża firma: serwer ucina drugą stronę odczytu sprzedaży',
    tabele: (now) => duzaFirma(now, 'test', 3600),
    zaklocenia: {
      uciecie: (z) => (czyOdczytSprzedazy(z)
        && z.calls.some(([m, a]) => (m === 'range' && Number(a[0]) >= 500) || m === 'gt') ? 7 : null),
    },
  },
  {
    nazwa: 'duża firma zwolniona z VAT, ROZ i faktura bez środowiska sprzed 18 miesięcy',
    tabele: (now) => {
      const t = duzaFirma(now, 'test', 3600);
      t.tenants![0] = { ...t.tenants![0], vat_exemption_basis: 'art. 113 ust. 1 ustawy o VAT' };
      dopiszRoz(t, now);
      dopiszFakture(t, now, 18, { id: 'bez-env-18', ksef_environment: null });
      return t;
    },
  },
  {
    nazwa: 'styczeń: początek roku (YTD, limit VAT od grudnia)',
    now: new Date('2027-01-04T07:00:00Z'),
    tabele: (now) => danePrzykladowe(now, 'test', { zwolnionyZVat: true }),
  },
  {
    nazwa: '1. dzień miesiąca o 00:30 w Polsce (w UTC jeszcze poprzedni)',
    now: new Date('2026-11-30T23:30:00Z'),
    tabele: (now) => danePrzykladowe(now, 'test'),
  },
];

interface Wynik {
  karty: unknown[];
  zapytania: Zapytanie[];
}

async function renderuj(s: Scenariusz): Promise<Wynik> {
  const now = s.now ?? NOW;
  vi.setSystemTime(now);
  h.proof = s.proof ?? ZWERYFIKOWANA;
  const zapytania: Zapytanie[] = [];
  h.ctx = {
    supabase: liczacyKlient(s.tabele(now), zapytania, s.zaklocenia),
    tenantId: DEMO_TENANT,
    user: { id: 'uzytkownik-1', email: null },
    role: 'owner',
  };
  h.zadanie = new Map();
  try {
    return { karty: karty(await DashboardHomePage()), zapytania };
  } finally {
    h.zadanie = null;
  }
}

/** Rodzaj zapytania wejścia na Pulpit (do opisu PR i progów niżej). */
function rodzaj(z: Zapytanie): string {
  if (z.table === 'invoice_line_items') return 'pozycje';
  if (z.table === 'ksef_history_sync') return 'historia KSeF';
  if (z.table === 'tenants') return 'firma';
  if (z.table === 'expenses' || ma(z, 'eq', 'direction', 'incoming') || (z.table === 'invoices' && !ma(z, 'eq', 'direction', 'outgoing'))) {
    return 'koszty';
  }
  if (ma(z, 'eq', 'ksef_status', 'draft')) return 'szkice';
  if (czyOdczytZaliczek(z)) return 'zaliczki ROZ';
  if (z.calls.some(([m]) => m === 'or') || ma(z, 'not', 'parent_invoice_id', 'is', null)) return 'należności';
  if (czyStraznikSrodowiska(z)) return z.head ? 'strażnik środowiska (COUNT)' : 'strażnik środowiska (wiersze)';
  if (czyLicznikSprzedazy(z)) return 'sprzedaż: licznik kontrolny';
  if (czyOdczytSprzedazy(z)) return 'sprzedaż: strony';
  return 'inne';
}

function licznik(zapytania: readonly Zapytanie[]) {
  const rodzaje: Record<string, number> = {};
  for (const z of zapytania) rodzaje[rodzaj(z)] = (rodzaje[rodzaj(z)] ?? 0) + 1;
  return {
    razem: zapytania.length,
    faktury: zapytania.filter((z) => z.table === 'invoices').length,
    liczniki: zapytania.filter((z) => z.head).length,
    pozycje: zapytania.filter((z) => z.table === 'invoice_line_items').length,
    zLicznikiem: zapytania.filter((z) => z.count).length,
    wiersze: zapytania.reduce((suma, z) => suma + z.wiersze, 0),
    wierszeFaktur: zapytania.filter((z) => z.table === 'invoices').reduce((suma, z) => suma + z.wiersze, 0),
    rodzaje,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Wzorzec z dysku; `null`, gdy go jeszcze nie ma (pierwszy zapis). Bez osobnego sprawdzania istnienia pliku. */
function wczytajWzorzec(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(WZORZEC, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

describe('złoty wzorzec: propsy kart identyczne jak przed sesją 19', () => {
  it.each(SCENARIUSZE.map((s) => [s.nazwa, s] as const))('%s', async (_nazwa, s) => {
    const { karty: wynik } = await renderuj(s);
    expect(wynik).toHaveLength(7);
    if (process.env.PULPIT_WZORZEC === 'zapisz') {
      const wzorzec = wczytajWzorzec() ?? {};
      wzorzec[s.nazwa] = wynik;
      writeFileSync(WZORZEC, `${JSON.stringify(wzorzec, null, 1)}\n`);
      return;
    }
    const wzorzec = JSON.parse(readFileSync(WZORZEC, 'utf8')) as Record<string, unknown>;
    expect(wzorzec[s.nazwa], `brak scenariusza „${s.nazwa}” we wzorcu`).toBeDefined();
    expect(wynik).toEqual(wzorzec[s.nazwa]);
  });
});

const scenariusz = (nazwa: string) => SCENARIUSZE.find((s) => s.nazwa === nazwa)!;

/** Tytuły kart błędu w kolejności slotów. */
function kartyBledu(wynik: unknown[]): string[] {
  return (wynik as Array<{ element: string; props: { title: string } }>)
    .filter((k) => k.element === 'PulpitCardError')
    .map((k) => k.props.title);
}

describe('izolacja błędów: strażnik zabiera tylko kartę, której okno obejmuje fakturę', () => {
  it('faktura EUR sprzed 20 miesięcy — tylko karta rankingów (Najwięksi klienci: 24 miesiące)', async () => {
    const { karty: wynik } = await renderuj(scenariusz('faktura EUR sprzed 20 miesięcy'));
    expect(kartyBledu(wynik)).toEqual(['Najlepiej sprzedające się']);
  });

  it('przyjęta faktura bez środowiska sprzed 20 miesięcy — tylko karta rankingów', async () => {
    const { karty: wynik } = await renderuj(scenariusz('przyjęta faktura bez środowiska sprzed 20 miesięcy'));
    expect(kartyBledu(wynik)).toEqual(['Najlepiej sprzedające się']);
  });

  it('bez środowiska rok i 2 miesiące temu — tylko Przychód (rok wcześniej) i rankingi; luka okna Przychodu nie liczy się', async () => {
    const { karty: wynik } = await renderuj(scenariusz('przyjęta faktura bez środowiska rok i 2 miesiące temu (tylko rok wcześniej Przychodu i klienci)'));
    expect(kartyBledu(wynik)).toEqual(['Przychód netto', 'Najlepiej sprzedające się']);
  });

  it('zaliczka w EUR sprzed 4 miesięcy — Średnia (2 miesiące) zostaje', async () => {
    const { karty: wynik } = await renderuj(scenariusz('faktura EUR sprzed 4 miesięcy, zaliczka (poza rankingiem produktów)'));
    expect(kartyBledu(wynik)).toEqual(['Finanse', 'Faktury w KSeF', 'Przychód netto', 'VAT należny', 'Najlepiej sprzedające się']);
  });

  it('firma VAT: faktura bez środowiska z datą w przyszłym miesiącu nie zabiera żadnej karty (czyta ją tylko limit VAT)', async () => {
    const { karty: wynik } = await renderuj(scenariusz('firma VAT: przyjęta faktura bez środowiska z datą w przyszłym miesiącu'));
    expect(kartyBledu(wynik)).toEqual([]);
  });

  it('firma zwolniona: ta sama faktura zabiera tylko Limit VAT', async () => {
    const { karty: wynik } = await renderuj(scenariusz('zwolniona: przyjęta faktura bez środowiska z datą w przyszłym miesiącu'));
    expect(kartyBledu(wynik)).toEqual(['Limit VAT']);
  });

  it('zapis w trakcie odczytu kilku stron: wspólny odczyt pada, karty czytają swoje okna jak dawniej i działają', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let dopisana = false;
    const { karty: wynik, zapytania } = await renderuj({
      nazwa: 'zapis w trakcie odczytu',
      tabele: (now) => duzaFirma(now, 'test', 960),
      zaklocenia: {
        // Historia KSeF dopisuje przyjętą fakturę po pierwszej stronie wspólnego odczytu
        // (id przed już przeczytanymi), więc licznik kontrolny się nie zgadza.
        przed: (z, tables) => {
          if (dopisana || !czyOdczytSprzedazy(z) || !z.calls.some(([m]) => m === 'gt')) return;
          dopisana = true;
          const wzor = sprzedaz(tables).find((f) => f.ksef_environment === 'test' && f.invoice_kind === 'regular')!;
          tables.invoices!.push({ ...wzor, id: '0-dopisana', issue_date: miesiacTemu(NOW, 1), sale_date: miesiacTemu(NOW, 1) });
        },
      },
    });
    expect(dopisana).toBe(true);
    expect(kartyBledu(wynik)).toEqual([]);
    expect(warn.mock.calls.map(([tekst]) => String(tekst)))
      .toEqual(['[pulpit] wspólny odczyt sprzedaży nie przeszedł — karty czytają osobno:']);
    // Karty czytały wtedy po staremu: stronami z `range` i własnymi etykietami.
    expect(zapytania.filter((z) => czyOdczytSprzedazy(z) && z.calls.some(([m]) => m === 'range')).length).toBeGreaterThan(0);
  });

  it('awaria samego wspólnego odczytu przy ROZ w oknach kart: karty jak we wzorcu, jeden wpis w logu', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roz = scenariusz('ROZ z dwiema zaliczkami');
    const { karty: wynik } = await renderuj({
      ...roz,
      // Pada tylko wspólny odczyt (strony po kluczu, `limit`); dawne odczyty kart (`range`) przechodzą.
      zaklocenia: { awaria: (z) => (czyOdczytSprzedazy(z) && ma(z, 'limit', 500) ? 'statement timeout' : null) },
    });
    const wzorzec = JSON.parse(readFileSync(WZORZEC, 'utf8')) as Record<string, unknown>;
    expect(wynik).toEqual(wzorzec[roz.nazwa]);
    expect(warn.mock.calls.map(([tekst]) => String(tekst)))
      .toEqual(['[pulpit] wspólny odczyt sprzedaży nie przeszedł — karty czytają osobno:']);
  });
});

describe('zapytania na wejście (QRY-02, QAL-05, QRY-05, QRY-07)', () => {
  it('dane przykładowe: sprzedaż jednym odczytem — 14 zapytań zamiast 26 (wzrost wymaga świadomej zmiany)', async () => {
    const { zapytania } = await renderuj(scenariusz('dane przykładowe jako prawdziwe'));
    expect(licznik(zapytania).rodzaje).toEqual({
      // Wspólny odczyt sprzedaży: jedna strona i jeden odczyt faktur bez środowiska (dawniej 7 stron i 7 COUNT).
      'sprzedaż: strony': 1,
      'strażnik środowiska (wiersze)': 1,
      szkice: 1,
      pozycje: 1,
      // Poza sesją 19: koszty (E10), należności (E11), ustawienia firmy (VAT w karcie i w kosztach), tryb danych.
      koszty: 5,
      należności: 2,
      firma: 2,
      'historia KSeF': 1,
    });
    expect(zapytania).toHaveLength(14);
  });

  it('mikrofirma 40 FV/mies.: 35 → 22 zapytań; licznik COUNT tylko na pierwszej stronie i raz na końcu', async () => {
    const { zapytania } = await renderuj(scenariusz('mikrofirma: 40 faktur miesięcznie przez 24 miesiące'));
    const { rodzaje } = licznik(zapytania);
    expect(rodzaje['sprzedaż: strony']).toBe(3);
    expect(rodzaje['sprzedaż: licznik kontrolny']).toBe(1);
    expect(rodzaje['strażnik środowiska (wiersze)']).toBe(1);
    expect(rodzaje['strażnik środowiska (COUNT)']).toBeUndefined();
    // Pozycje: paczki po 100 faktur (długość adresu), do czterech naraz — liczba bez zmian, czas krótszy.
    expect(rodzaje.pozycje).toBe(6);
    expect(zapytania).toHaveLength(22);
    // Strony 2 i 3 wspólnego odczytu idą po kluczu, bez COUNT.
    const strony = zapytania.filter(czyOdczytSprzedazy);
    expect(strony.map((z) => [z.count, z.calls.some(([m]) => m === 'gt'), z.calls.some(([m]) => m === 'range')]))
      .toEqual([[true, false, false], [false, true, false], [false, true, false]]);
  });

  it('paczki pozycji idą naraz (najwyżej 4), w kolejności faktur', async () => {
    const tables = duzaFirma(NOW, 'test', 960);
    const zapytania: Zapytanie[] = [];
    let wToku = 0;
    let najwiecej = 0;
    const klient = liczacyKlient(tables, zapytania) as unknown as { from(t: string): Record<string, unknown> };
    const from = klient.from.bind(klient);
    klient.from = (table: string) => {
      const builder = from(table);
      if (table !== 'invoice_line_items') return builder;
      const then = builder.then as (r: (v: unknown) => unknown) => Promise<unknown>;
      builder.then = ((resolve: (v: unknown) => unknown) => {
        wToku += 1;
        najwiecej = Math.max(najwiecej, wToku);
        return new Promise((r) => setTimeout(r, 5)).then(() => then((v) => { wToku -= 1; return resolve(v); }));
      }) as never;
      return builder;
    };
    vi.setSystemTime(NOW);
    h.proof = ZWERYFIKOWANA;
    h.ctx = { supabase: klient, tenantId: DEMO_TENANT, user: { id: 'uzytkownik-1', email: null }, role: 'owner' };
    h.zadanie = new Map();
    try {
      const wynik = karty(await DashboardHomePage());
      expect(kartyBledu(wynik)).toEqual([]);
    } finally {
      h.zadanie = null;
    }
    expect(najwiecej).toBe(4);
    // Każda paczka to inne faktury, w kolejności `id` faktur.
    const paczki = zapytania.filter((z) => z.table === 'invoice_line_items')
      .map((z) => z.calls.find(([m]) => m === 'in')![1][1] as string[]);
    expect(paczki.flat()).toEqual([...paczki.flat()].sort());
    expect(new Set(paczki.flat()).size).toBe(paczki.flat().length);
  });
});

describe('pomiar zapytań na wejście', () => {
  // Tylko na żądanie: renderuje wszystkie scenariusze drugi raz.
  it.runIf(Boolean(process.env.PULPIT_POMIAR))('liczniki do opisu PR (PULPIT_POMIAR=ścieżka zapisuje je do pliku)', async () => {
    const tabela: Record<string, ReturnType<typeof licznik>> = {};
    for (const s of SCENARIUSZE.filter((x) => !x.zaklocenia && x.proof === undefined)) {
      tabela[s.nazwa] = licznik((await renderuj(s)).zapytania);
    }
    if (process.env.PULPIT_POMIAR) writeFileSync(process.env.PULPIT_POMIAR, `${JSON.stringify(tabela, null, 1)}\n`);
    expect(Object.keys(tabela).length).toBeGreaterThan(3);
  });
});

