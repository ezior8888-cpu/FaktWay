import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { suggestNextInvoiceNumberForTenant } from '@/lib/invoices/next-number';

/**
 * D-A4-1b-3 PR C, INV-7 (spec v3, 7.2) — STRAŻNIK, ZIELONY NA `main` PRZED
 * I PO PR C (nie odtwarza błędu, który PR C naprawia).
 *
 * Po zapisie oryginału K numer dawnego dokumentu X (P_2) przechodzi na fakturę
 * K (`origin = 'ksef_import'`, `accepted`), a X zostaje szkicem bez numeru.
 * Podpowiedź kolejnego numeru faktury (`suggestNextInvoiceNumberForTenant`,
 * F-015) nie może więc podać numeru zajętego przez K — inaczej klient dostałby
 * w formularzu numer, który baza odrzuci (indeks unikalny numeru sprzedaży
 * `(tenant_id, internal_number)`, 00120) albo, gorzej, wystawiłby duplikat
 * numeru z KSeF. F17: podpowiedź pomija numer zajęty przez DOWOLNY wiersz firmy
 * — K jest takim wierszem, więc strażnik jest zielony już dziś; zostaje
 * pinem tej własności na czas, gdy nowy kod (zapis K) zacznie takie wiersze
 * produkować.
 *
 * Atrapa klienta: minimalny odpowiednik zapytań funkcji (filtry eq / not is
 * null, sortowanie wielokolumnowe, limit, count) — kopia wzorca z
 * `numeracja-podpowiedz.test.ts`, rozszerzona o kolumny wiersza K.
 */

type Row = Record<string, unknown>;

function fakeSupabase(rows: Row[]) {
  return {
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

const TENANT = 'ten-1';
const KSEF_K = '5260001246-20261005-0100A0B0C0D0-1A';

const row = (over: Row): Row => ({
  tenant_id: TENANT, direction: 'outgoing', invoice_kind: 'regular', origin: 'app',
  internal_number: 'FV/2026/10/001', issue_date: '2026-10-01', created_at: '2026-10-01T08:00:00Z', ...over,
});

/** Faktura K zapisana z oryginału: numer P_2 = dawny numer X, przyjęta w KSeF, pochodzenie `ksef_import`. */
const importedK = (over: Row = {}): Row => row({
  internal_number: 'FV/2026/10/007', origin: 'ksef_import', ksef_status: 'accepted', ksef_number: KSEF_K,
  issue_date: '2026-10-05', created_at: '2026-10-05T09:00:00Z', ...over,
});

describe('INV-7 (strażnik): podpowiedź numeru nie podaje numeru zajętego przez K', () => {
  it('K jest ostatnią fakturą (numer 007) → kolejny numer to 008, nie 007; szkic X bez numeru nie przeszkadza', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/2026/10/006', issue_date: '2026-10-04', created_at: '2026-10-04T08:00:00Z' }),
      importedK(),
      // X po zapisie K: szkic wycofany, bez numeru.
      row({ internal_number: null, issue_date: '2026-10-05', created_at: '2026-10-05T08:00:00Z', ksef_status: 'draft' }),
    ]);

    expect(await suggestNextInvoiceNumberForTenant(sb, TENANT, '2026-10-06')).toBe('FV/2026/10/008');
  });

  it('K starszy datą wystawienia niż ostatnia faktura (006 jest późniejsza) → kandydat 007 zajęty przez K, podpowiedź przeskakuje na 008', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/2026/10/006', issue_date: '2026-10-06', created_at: '2026-10-06T08:00:00Z' }),
      importedK({ issue_date: '2026-10-05' }),
    ]);

    expect(await suggestNextInvoiceNumberForTenant(sb, TENANT, '2026-10-06')).toBe('FV/2026/10/008');
  });

  it('inny wzór numeracji (FV/n/mm/rrrr): K zajmuje kolejny numer (008) → podpowiedź przeskakuje na 009', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/7/10/2026', issue_date: '2026-10-06', created_at: '2026-10-06T08:00:00Z' }),
      importedK({ internal_number: 'FV/8/10/2026', issue_date: '2026-10-02' }),
    ]);

    expect(await suggestNextInvoiceNumberForTenant(sb, TENANT, '2026-10-06')).toBe('FV/9/10/2026');
  });

  it('K innej firmy z tym samym numerem nie blokuje podpowiedzi (numer zajmuje się w obrębie firmy)', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/2026/10/006', issue_date: '2026-10-06', created_at: '2026-10-06T08:00:00Z' }),
      importedK({ tenant_id: 'ten-2', issue_date: '2026-10-05' }),
    ]);

    expect(await suggestNextInvoiceNumberForTenant(sb, TENANT, '2026-10-06')).toBe('FV/2026/10/007');
  });
});
