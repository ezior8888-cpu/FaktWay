import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { suggestNextInvoiceNumberForTenant } from '@/lib/invoices/next-number';
import { loadInvoiceNumbering } from '@/lib/numeracja/baza';

/**
 * Krok 2.5: podpowiedź numeru dla każdego rodzaju dokumentu (zwykła,
 * zaliczkowa, końcowa, korekta) według serii.
 *
 * - Firma bez serii (każda istniejąca firma po wgraniu 00199) dostaje
 *   dokładnie dzisiejszą podpowiedź zwykłej faktury, a pozostałe rodzaje:
 *   kolejny numer po ostatnim dokumencie tego rodzaju.
 * - Seria ze wzorem podpowiada kolejny numer z licznika (z bazy).
 * - Seria „jak dotąd” (bez wzoru) liczy tylko faktury bez serii i swoje,
 *   więc numery innej serii jej nie przestawiają.
 * - Domyślna seria rodzaju jest wybrana; ukryte serie nie są proponowane.
 */

type Row = Record<string, unknown>;

const TENANT = 'ten-1';
const BASIC = '0c0b5a9e-1d2f-4e3a-8b4c-5d6e7f809102';
const FX = '5f4e3d2c-1b0a-4987-8654-3210fedcba98';
const KOR = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const OLD = '6e5d4c3b-2a19-4807-a6b5-c4d3e2f1a0b9';

function fakeSupabase(rows: Row[], overview: unknown | Error) {
  return {
    rpc: async (fn: string) => {
      if (fn !== 'invoice_number_series_overview') return { data: null, error: { code: 'PGRST202', message: fn } };
      if (overview instanceof Error) return { data: null, error: { code: 'PGRST202', message: overview.message } };
      return { data: overview, error: null };
    },
    from: () => {
      const filters: Array<(r: Row) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let countMode = false;
      const hit = () => {
        const out = rows.filter((r) => filters.every((f) => f(r)));
        for (const [k, asc] of [...orders].reverse()) {
          out.sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (asc ? 1 : -1));
        }
        return out;
      };
      const q = {
        select: (_c: string, opts?: { count?: string }) => { countMode = Boolean(opts?.count); return q; },
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
        not: (k: string) => { filters.push((r) => r[k] !== null && r[k] !== undefined); return q; },
        // Tylko postać używana przez podpowiedź serii bez wzoru: „kolumna.is.null,kolumna.eq.<id>”.
        or: (expr: string) => {
          const m = /^(\w+)\.is\.null,\1\.eq\.(.+)$/.exec(expr);
          if (!m) throw new Error(`nieobsługiwany filtr or: ${expr}`);
          const [, column, id] = m;
          filters.push((r) => r[column!] === null || r[column!] === undefined || r[column!] === id);
          return q;
        },
        order: (k: string, o: { ascending: boolean }) => { orders.push([k, o.ascending]); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: hit()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(countMode ? { count: hit().length, error: null } : { data: hit(), error: null }).then(ok),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const row = (over: Row): Row => ({
  tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', origin: 'app',
  internal_number: 'FV/2026/11/001', issue_date: '2026-11-02', created_at: '2026-11-02T08:00:00Z',
  number_series_id: null, ...over,
});

const series = (over: Row): Row => ({
  id: BASIC, name: 'Podstawowa', pattern: null, default_kinds: ['regular', 'advance', 'final', 'correction'],
  active: true, used: true, next: null, ...over,
});

const DZIS = '2026-11-11';

describe('firma bez serii: numeracja jak dotąd', () => {
  const rows = [
    row({ internal_number: 'FV/2026/11/006', issue_date: '2026-11-05' }),
    row({ internal_number: 'ZAL/2026/11/002', invoice_kind: 'advance', issue_date: '2026-11-04' }),
  ];

  it('zwykła faktura: ta sama podpowiedź co dziś (kolejny po ostatniej zwykłej)', async () => {
    const sb = fakeSupabase(rows, new Error('brak 00199'));
    const numbering = await loadInvoiceNumbering(sb, TENANT, 'regular', DZIS);
    const today = await suggestNextInvoiceNumberForTenant(sb, TENANT, DZIS);

    expect(today).toBe('FV/2026/11/007');
    expect(numbering).toEqual({
      kind: 'regular',
      selectedId: null,
      options: [{ id: null, name: 'Numeracja jak dotąd', pattern: null, preview: today }],
    });
  });

  it('pusta lista serii (firma po wgraniu 00199, nic nie zmieniała) też daje dzisiejszą podpowiedź', async () => {
    const sb = fakeSupabase(rows, { series: [] });
    const numbering = await loadInvoiceNumbering(sb, TENANT, 'regular', DZIS);
    expect(numbering.options).toEqual([{ id: null, name: 'Numeracja jak dotąd', pattern: null, preview: 'FV/2026/11/007' }]);
  });

  it('zaliczka: kolejny po ostatniej zaliczce; korekta bez wcześniejszych korekt: bez podpowiedzi', async () => {
    const sb = fakeSupabase(rows, { series: [] });
    expect((await loadInvoiceNumbering(sb, TENANT, 'advance', DZIS)).options[0]!.preview).toBe('ZAL/2026/11/003');
    expect((await loadInvoiceNumbering(sb, TENANT, 'correction', DZIS)).options[0]!.preview).toBeNull();
  });
});

describe('firma z seriami', () => {
  const rows = [
    row({ internal_number: 'FV/2026/11/006', issue_date: '2026-11-05' }),
    row({ internal_number: 'FV/2026/11/007', issue_date: '2026-11-06', number_series_id: BASIC }),
    // Faktura serii walutowej wystawiona później nie przestawia serii podstawowej.
    row({ internal_number: 'WAL/2026/004', issue_date: '2026-11-10', number_series_id: FX }),
  ];
  // Jedna seria domyślna na rodzaj (pilnują RPC 00199): korekty przejęła seria „Korekty”.
  const overview = {
    series: [
      series({ default_kinds: ['regular', 'advance', 'final'] }),
      series({ id: FX, name: 'Waluty', pattern: 'WAL/{RRRR}/{NNN}', default_kinds: [], next: { number: 'WAL/2026/005', counter: 5, period: '2026' } }),
      series({ id: KOR, name: 'Korekty', pattern: 'KOR/{N}/{RRRR}', default_kinds: ['correction'], next: { number: 'KOR/3/2026', counter: 3, period: '2026' } }),
      series({ id: OLD, name: 'Stara', pattern: 'S/{N}', default_kinds: [], active: false, next: null }),
    ],
  };

  it('zwykła faktura: seria domyślna wybrana, podpowiedź bez numerów innej serii; ukryta seria pominięta', async () => {
    const numbering = await loadInvoiceNumbering(fakeSupabase(rows, overview), TENANT, 'regular', DZIS);

    expect(numbering.selectedId).toBe(BASIC);
    expect(numbering.options).toEqual([
      { id: BASIC, name: 'Podstawowa', pattern: null, preview: 'FV/2026/11/008' },
      { id: FX, name: 'Waluty', pattern: 'WAL/{RRRR}/{NNN}', preview: 'WAL/2026/005' },
      { id: KOR, name: 'Korekty', pattern: 'KOR/{N}/{RRRR}', preview: 'KOR/3/2026' },
    ]);
  });

  it('korekta: domyślna seria korekt z kolejnym numerem z licznika', async () => {
    const numbering = await loadInvoiceNumbering(fakeSupabase(rows, overview), TENANT, 'correction', DZIS);

    expect(numbering.selectedId).toBe(KOR);
    expect(numbering.options.find((o) => o.id === KOR)?.preview).toBe('KOR/3/2026');
  });
});
