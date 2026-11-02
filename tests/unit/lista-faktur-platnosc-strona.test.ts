import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C1 (rewizja E3, PLAN-FINORA §5 P3): filtr `platnosc` na stronie /invoices
 * liczony na PRAWDZIWEJ ścieżce strony — zapytanie wykonuje klient w pamięci,
 * który stosuje filtry PostgREST (także `or()`) do wierszy. Filtr płatności
 * pokazuje tylko faktury z §2.4 pkt 11, te same, które kolumny „Płatność”
 * i „Do zapłaty” oraz kafel „Do zapłaty” traktują jako należności. Importy,
 * szkice, korekty, waluta obca i inne środowisko KSeF nie mają stanu
 * płatności („—”), więc nie mogą wypaść jako „po terminie”.
 *
 * Znane ograniczenie (opisane przy `receivableBaseFilterOps`): oryginał
 * z dzieckiem (korekta, ROZ) zostaje w wyniku filtra — PostgREST nie wyrazi
 * NOT EXISTS na wierszu rodzica; jego wiersz pokazuje „—”.
 */

const state = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, envBroken: false, role: 'owner' }));

vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => {
    if (state.envBroken) throw new Error('KSeF environment is not safely configured');
    return 'production';
  },
}));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: memoryClient(state.rows), tenantId: TENANT, role: state.role }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import InvoicesPage from '@/app/(dashboard)/invoices/page';

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-17T10:00:00Z');

/** Dzieli listę warunków po przecinkach najwyższego poziomu (poza nawiasami). */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** Warunek z `or()` PostgREST: `and(...)`, `or(...)` albo `kolumna.op.wartość`. */
function parseCondition(text: string): Pred {
  const logic = /^(and|or)\((.*)\)$/.exec(text);
  if (logic) {
    const inner = splitTopLevel(logic[2]!).map(parseCondition);
    return logic[1] === 'and' ? (r) => inner.every((p) => p(r)) : (r) => inner.some((p) => p(r));
  }
  const firstDot = text.indexOf('.');
  const secondDot = text.indexOf('.', firstDot + 1);
  const column = text.slice(0, firstDot);
  const op = text.slice(firstDot + 1, secondDot);
  const value = text.slice(secondDot + 1);
  switch (op) {
    case 'eq':
      return (r) => r[column] !== null && r[column] !== undefined && String(r[column]) === value;
    case 'in': {
      const list = splitTopLevel(value.replace(/^\((.*)\)$/, '$1'));
      return (r) => r[column] !== null && r[column] !== undefined && list.includes(String(r[column]));
    }
    case 'ilike': {
      // Wyszukiwanie strony (`searchOrFilter`): `%fraza%` bez rozróżniania wielkości liter.
      const needle = value.replace(/^%|%$/g, '').toLowerCase();
      return (r) => r[column] !== null && r[column] !== undefined && String(r[column]).toLowerCase().includes(needle);
    }
    case 'is':
      if (value !== 'null') throw new Error(`nieobsługiwane is.${value}`);
      return (r) => r[column] === null || r[column] === undefined;
    case 'not': {
      // `fa3_data->parsed->>paidDate.not.is.null`: ścieżka JSON z filtra „Opłacone”.
      if (value !== 'is.null') throw new Error(`nieobsługiwane not.${value}`);
      const path = column.split(/->>?/);
      const read = (r: Row): unknown =>
        path.reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Row)[key] : undefined), r);
      return (r) => read(r) !== null && read(r) !== undefined;
    }
    default:
      throw new Error(`nieobsługiwany operator w or(): ${op}`);
  }
}

/** Klient w pamięci: filtry PostgREST strony listy i faktów wiersza, `count: exact`, strony. */
function memoryClient(rows: Row[]) {
  return {
    from() {
      const predicates: Pred[] = [];
      const ordering: Array<{ column: string; ascending: boolean }> = [];
      let range: [number, number] | null = null;
      let countRequested = false;
      const present = (r: Row, c: string) => r[c] !== null && r[c] !== undefined;
      const builder = {
        select: (_cols: string, opts?: { count?: string }) => {
          countRequested = opts?.count === 'exact';
          return builder;
        },
        eq: (c: string, v: unknown) => { predicates.push((r) => r[c] === v); return builder; },
        neq: (c: string, v: unknown) => { predicates.push((r) => present(r, c) && r[c] !== v); return builder; },
        in: (c: string, v: unknown[]) => { predicates.push((r) => v.includes(r[c])); return builder; },
        gt: (c: string, v: number) => { predicates.push((r) => present(r, c) && Number(r[c]) > v); return builder; },
        gte: (c: string, v: number | string) => {
          predicates.push((r) => present(r, c) && (typeof v === 'number' ? Number(r[c]) >= v : String(r[c]) >= v));
          return builder;
        },
        lt: (c: string, v: string) => { predicates.push((r) => present(r, c) && String(r[c]) < v); return builder; },
        lte: (c: string, v: string) => { predicates.push((r) => present(r, c) && String(r[c]) <= v); return builder; },
        or: (filters: string) => {
          const any = splitTopLevel(filters).map(parseCondition);
          predicates.push((r) => any.some((p) => p(r)));
          return builder;
        },
        overlaps: (c: string, v: string[]) => {
          predicates.push((r) => Array.isArray(r[c]) && (r[c] as string[]).some((x) => v.includes(x)));
          return builder;
        },
        order: (column: string, opts?: { ascending?: boolean }) => {
          ordering.push({ column, ascending: opts?.ascending !== false });
          return builder;
        },
        range: (from: number, to: number) => { range = [from, to]; return builder; },
        then<T, E = never>(
          resolve?: ((value: { data: Row[]; count: number | null; error: null }) => T | PromiseLike<T>) | null,
          reject?: ((reason: unknown) => E | PromiseLike<E>) | null,
        ) {
          const matching = rows.filter((r) => predicates.every((p) => p(r)));
          matching.sort((a, b) => {
            for (const { column, ascending } of ordering) {
              const cmp = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
              if (cmp !== 0) return ascending ? cmp : -cmp;
            }
            return 0;
          });
          const data = range ? matching.slice(range[0], range[1] + 1) : matching;
          return Promise.resolve({ data, count: countRequested ? matching.length : null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

let seq = 0;
function invoice(label: string, overrides: Row = {}): Row {
  seq += 1;
  return {
    id: `inv-${String(seq).padStart(5, '0')}`,
    label,
    tenant_id: TENANT,
    internal_number: `FV/${seq}/10/2026`,
    issue_date: '2026-09-15',
    buyer_data: { name: `Nabywca ${seq}` },
    created_at: `2026-09-${String(10 + seq).padStart(2, '0')}T10:00:00Z`,
    xml_storage_path: null,
    last_error_code: null,
    ksef_number: `KSEF-${seq}`,
    direction: 'outgoing',
    origin: 'app',
    ksef_status: 'accepted',
    ksef_environment: 'production',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    currency: 'PLN',
    gross_total: 1230,
    paid_amount: 0,
    payment_data: null,
    payment_due_date: '2026-10-01', // po terminie względem 17.10
    payment_status: 'unpaid',
    parent_invoice_id: null,
    advance_invoice_ids: [],
    ...overrides,
  };
}

/** `initialInvoices` z drzewa strony (lista przekazana do komponentu klienta). */
function listedLabels(tree: ReactNode): string[] {
  const found: Row[][] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object' || !('props' in node)) return;
    const props = (node as ReactElement<Record<string, unknown>>).props;
    if (Array.isArray(props.initialInvoices)) found.push(props.initialInvoices as Row[]);
    walk(props.children as ReactNode);
  };
  walk(tree);
  if (found.length !== 1) throw new Error(`oczekiwano jednej listy faktur, jest ${found.length}`);
  return found[0]!.map((r) => String(r.label)).sort();
}

async function listFor(platnosc?: string, naStronie?: string): Promise<string[]> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const searchParams: Record<string, string> = {};
    if (platnosc) searchParams.platnosc = platnosc;
    if (naStronie) searchParams.na_stronie = naStronie;
    const tree = await InvoicesPage({ searchParams: Promise.resolve(searchParams) });
    return listedLabels(tree);
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  seq = 0;
  state.rows = [];
  state.envBroken = false;
  state.role = 'owner';
});

describe('„Zapłacone” (00158): strona listy przekazuje prawo roli', () => {
  /** Props komponentu z listą (`initialInvoices`) z drzewa strony. */
  function listProps(tree: ReactNode): Row | null {
    let found: Row | null = null;
    const walk = (node: ReactNode): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object' || !('props' in node)) return;
      const props = (node as ReactElement<Record<string, unknown>>).props;
      if (Array.isArray(props.initialInvoices)) found = props;
      walk(props.children as ReactNode);
    };
    walk(tree);
    return found;
  }

  it.each([
    ['owner', true],
    ['admin', true],
    ['member', true],
    ['accountant', false],
  ])('rola %s: canMarkPaid = %s', async (role, expected) => {
    state.role = role;
    state.rows = [invoice('vat')];
    const props = listProps(await InvoicesPage({ searchParams: Promise.resolve({}) }));
    expect(props?.canMarkPaid).toBe(expected);
  });
});

describe('C1: filtr płatności na stronie /invoices obejmuje tylko należności (§2.4 pkt 11)', () => {
  function overdueMix(): Row[] {
    return [
      invoice('vat'),
      invoice('import-ksef', { origin: 'ksef_import' }),
      invoice('import-plik', { origin: 'file_import' }),
      invoice('szkic', { ksef_status: 'draft', ksef_environment: null, ksef_number: null }),
      invoice('korekta', { invoice_kind: 'correction', invoice_type: 'KOR', gross_total: -123 }),
      invoice('eur', { currency: 'EUR' }),
      invoice('inne-srodowisko', { ksef_environment: 'test' }),
      invoice('para-niezgodna', { invoice_kind: 'advance', invoice_type: 'VAT' }),
      invoice('zero', { gross_total: 0 }),
      invoice('bez-waluty', { currency: null }),
      invoice('zaliczka', { invoice_kind: 'advance', invoice_type: 'ZAL' }),
      invoice('rozliczenie', { invoice_kind: 'final', invoice_type: 'ROZ', payment_data: { amountDue: 500 } }),
      invoice('zakup', { direction: 'incoming' }),
    ];
  }

  it('po terminie: tylko faktury z pkt 11 (bez importów, szkiców, korekt, EUR, innego środowiska)', async () => {
    state.rows = overdueMix();
    expect(await listFor('po_terminie')).toEqual(['bez-waluty', 'rozliczenie', 'vat', 'zaliczka']);
  });

  it('nieopłacone: ten sam zbiór bazowy', async () => {
    state.rows = overdueMix();
    expect(await listFor('nieoplacone')).toEqual(['bez-waluty', 'rozliczenie', 'vat', 'zaliczka']);
  });

  // Zapłata to fakt bez względu na pochodzenie: „Zapłacone” działa też na imporcie (00158), a wiersz
  // takiej faktury mówi „Opłacona”. Filtr ma pokazać te same faktury. Świadomie zastępuje dawne
  // „opłacony import ani opłacona korekta nie są opłaconą fakturą listy”.
  it('opłacone: każda zapłacona faktura sprzedaży, także import i z datą zapłaty z FA(3)', async () => {
    const paid = { payment_status: 'paid', paid_amount: 1230, paid_at: '2026-10-05T10:00:00Z' };
    state.rows = [
      invoice('vat-oplacona', paid),
      invoice('import-oplacony', { ...paid, origin: 'ksef_import' }),
      invoice('korekta-oplacona', { ...paid, invoice_kind: 'correction', invoice_type: 'KOR' }),
      invoice('plik-z-data-z-fa3', { origin: 'file_import', fa3_data: { parsed: { paidDate: '2026-09-20' } } }),
      invoice('vat-nieoplacona'),
      invoice('szkic-oplacony', { ...paid, ksef_status: 'draft', ksef_environment: null, ksef_number: null }),
      invoice('zakup-oplacony', { ...paid, direction: 'incoming' }),
      invoice('inne-srodowisko', { ...paid, ksef_environment: 'test' }),
    ];
    expect(await listFor('oplacone')).toEqual(['import-oplacony', 'korekta-oplacona', 'plik-z-data-z-fa3', 'vat-oplacona']);
  });

  it('bez filtra płatności lista pokazuje wszystkie faktury sprzedaży (jak dotąd)', async () => {
    state.rows = overdueMix();
    // Lista 1:1 z Finory (21.10.2026): domyślna strona ma 10 pozycji (było 50), a ten zbiór to 12 faktur
    // sprzedaży — „Pokaż 25” mieści je wszystkie, więc nadal sprawdzamy brak zawężenia filtrem płatności.
    expect(await listFor(undefined, '25')).toHaveLength(12); // wszystko poza zakupem
  });
});

describe('filtr płatności bez skonfigurowanego środowiska KSeF (AGENTS.md pkt 4: blokada z wyjściem)', () => {
  /** Teksty i adresy linków z drzewa strony (bez renderowania komponentów serwerowych). */
  function collect(tree: ReactNode): { text: string; hrefs: string[]; lists: number } {
    const out = { text: '', hrefs: [] as string[], lists: 0 };
    const walk = (node: ReactNode): void => {
      if (typeof node === 'string' || typeof node === 'number') {
        out.text += `${node} `;
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object' || !('props' in node)) return;
      const props = (node as ReactElement<Record<string, unknown>>).props;
      if (typeof props.href === 'string') out.hrefs.push(props.href);
      if (Array.isArray(props.initialInvoices)) out.lists += 1;
      walk(props.children as ReactNode);
    };
    walk(tree);
    return out;
  }

  it('strona nie wywraca się: komunikat i link do listy bez filtra płatności, bez listy niefiltrowanej', async () => {
    state.envBroken = true;
    state.rows = [invoice('vat')];
    const tree = await InvoicesPage({ searchParams: Promise.resolve({ platnosc: 'po_terminie', q: 'Acme' }) });
    const { text, hrefs, lists } = collect(tree);
    expect(text).toContain('Filtr płatności jest chwilowo niedostępny');
    expect(hrefs).toContain('/invoices?q=Acme');
    expect(lists).toBe(0);
  });

  it('bez filtra płatności środowisko nie jest potrzebne — lista działa', async () => {
    state.envBroken = true;
    state.rows = [invoice('vat')];
    expect(await listFor()).toEqual(['vat']);
  });
});
