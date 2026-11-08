import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { suggestNextInvoiceNumber, suggestNextInvoiceNumberForTenant } from '@/lib/invoices/next-number';

/**
 * F-015 (audyt bloku 1): numer faktury wpisywało się ręcznie przy każdej
 * fakturze — ciągłość serii (art. 106e ust. 1 pkt 2) zależała wyłącznie od
 * użytkownika. Numeracja z seriami jest w podstawowym obiegu u Fakturowni,
 * inFaktu, wFirmy i iFirmy. Podpowiadamy kolejny numer na podstawie ostatniej
 * faktury: licznik +1, a po zmianie miesiąca lub roku w numerze — nowy okres
 * i licznik od 1. Pole zostaje edytowalne.
 */

const last = (number: string, issueDate: string) => ({ number, issueDate });

describe('podpowiedź kolejnego numeru faktury (F-015)', () => {
  it.each([
    ['FV/7/10/2026', '2026-10-05', '2026-10-06', 'FV/8/10/2026'],
    ['FV/2026/10/007', '2026-10-05', '2026-10-06', 'FV/2026/10/008'],
    ['FV 9/10/2026', '2026-10-05', '2026-10-06', 'FV 10/10/2026'],
    ['FV/10/10/2026', '2026-10-05', '2026-10-06', 'FV/11/10/2026'],
    ['FV/2026/0099', '2026-10-05', '2026-10-06', 'FV/2026/0100'],
    ['F-123', '2026-10-05', '2026-10-06', 'F-124'],
  ])('ten sam okres: %s → %s', (number, lastDate, today, expected) => {
    expect(suggestNextInvoiceNumber(last(number, lastDate), today)).toBe(expected);
  });

  it.each([
    ['FV/7/10/2026', '2026-10-31', '2026-11-02', 'FV/1/11/2026'],
    ['FV/2026/10/007', '2026-10-31', '2026-11-02', 'FV/2026/11/001'],
    ['FV/12/12/2026', '2026-12-30', '2027-01-04', 'FV/1/01/2027'],
    ['FV/2026/0099', '2026-12-30', '2027-01-04', 'FV/2027/0001'],
    ['FV/3/9/2026', '2026-09-30', '2026-10-01', 'FV/1/10/2026'],
  ])('nowy okres: %s (z %s) w dniu %s → %s', (number, lastDate, today, expected) => {
    expect(suggestNextInvoiceNumber(last(number, lastDate), today)).toBe(expected);
  });

  it('numeracja ciągła (bez okresu w numerze) rośnie dalej po zmianie miesiąca', () => {
    expect(suggestNextInvoiceNumber(last('F-123', '2026-10-31'), '2026-11-02')).toBe('F-124');
  });

  it('brak ostatniej faktury albo numer bez cyfr — bez podpowiedzi', () => {
    expect(suggestNextInvoiceNumber(null, '2026-10-02')).toBeNull();
    expect(suggestNextInvoiceNumber(last('FAKTURA-A', '2026-10-01'), '2026-10-02')).toBeNull();
  });

  it('numer z samym okresem (bez licznika) — bez podpowiedzi', () => {
    expect(suggestNextInvoiceNumber(last('FV/10/2026', '2026-10-01'), '2026-10-02')).toBeNull();
  });
});

type Row = {
  tenant_id: string; direction: string; invoice_kind: string; origin: string;
  internal_number: string | null; issue_date: string; created_at: string;
};

/** Minimalny klient: filtry eq/not is null, sortowanie, limit, count. */
function fakeSupabase(rows: Row[]) {
  return {
    from: () => {
      const filters: Array<(r: Row) => boolean> = [];
      const orders: Array<[keyof Row, boolean]> = [];
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
        eq: (k: keyof Row, v: unknown) => { filters.push((r) => r[k] === v); return q; },
        not: (k: keyof Row) => { filters.push((r) => r[k] !== null); return q; },
        order: (k: keyof Row, o: { ascending: boolean }) => { orders.push([k, o.ascending]); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: hit()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(countMode ? { count: hit().length, error: null } : { data: hit(), error: null }).then(ok),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const row = (o: Partial<Row>): Row => ({
  tenant_id: 'ten-1', direction: 'outgoing', invoice_kind: 'regular', origin: 'app',
  internal_number: 'FV/1/10/2026', issue_date: '2026-10-01', created_at: '2026-10-01T08:00:00Z', ...o,
});

describe('podpowiedź numeru dla firmy (F-015)', () => {
  it('bierze ostatnią zwykłą fakturę sprzedażową tej firmy', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/6/10/2026', issue_date: '2026-10-04', created_at: '2026-10-04T08:00:00Z' }),
      row({ internal_number: 'FV/7/10/2026', issue_date: '2026-10-05', created_at: '2026-10-05T08:00:00Z' }),
      row({ internal_number: 'KOR/3/10/2026', invoice_kind: 'correction', issue_date: '2026-10-06', created_at: '2026-10-06T08:00:00Z' }),
      row({ internal_number: 'ZAKUP/99', direction: 'incoming', issue_date: '2026-10-06', created_at: '2026-10-06T09:00:00Z' }),
      row({ tenant_id: 'ten-2', internal_number: 'FV/50/10/2026', issue_date: '2026-10-06', created_at: '2026-10-06T10:00:00Z' }),
    ]);
    expect(await suggestNextInvoiceNumberForTenant(sb, 'ten-1', '2026-10-06')).toBe('FV/8/10/2026');
  });

  it('numer już zajęty (np. szkic) — przeskakuje na kolejny wolny', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/7/10/2026', issue_date: '2026-10-05', created_at: '2026-10-05T08:00:00Z' }),
      row({ internal_number: 'FV/8/10/2026', issue_date: '2026-10-01', created_at: '2026-10-01T08:00:00Z' }),
    ]);
    expect(await suggestNextInvoiceNumberForTenant(sb, 'ten-1', '2026-10-06')).toBe('FV/9/10/2026');
  });

  it('pierwsza faktura firmy — bez podpowiedzi', async () => {
    expect(await suggestNextInvoiceNumberForTenant(fakeSupabase([]), 'ten-1', '2026-10-06')).toBeNull();
  });

  // Decyzja Bartosza 22.10.2026: sprzedaż wystawiona poza FaktWay przychodzi
  // z KSeF na bieżąco (`origin = ksef_import`) — nie może ustawiać serii FaktWay.
  it('woli ostatnią fakturę wystawioną w FaktWay niż późniejszą sprzedaż spoza FaktWay z KSeF', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/7/10/2026', issue_date: '2026-10-05', created_at: '2026-10-05T08:00:00Z' }),
      row({ internal_number: 'ZEW/123/2026', origin: 'ksef_import', issue_date: '2026-10-06', created_at: '2026-10-06T08:00:00Z' }),
    ]);
    expect(await suggestNextInvoiceNumberForTenant(sb, 'ten-1', '2026-10-06')).toBe('FV/8/10/2026');
  });

  it('bez faktur z FaktWay — kontynuacja serii z historii KSeF (klient przeniósł się tylko przez KSeF)', async () => {
    const sb = fakeSupabase([
      row({ internal_number: 'FV/20/10/2026', origin: 'ksef_import', issue_date: '2026-10-05', created_at: '2026-10-05T08:00:00Z' }),
    ]);
    expect(await suggestNextInvoiceNumberForTenant(sb, 'ten-1', '2026-10-06')).toBe('FV/21/10/2026');
  });
});
