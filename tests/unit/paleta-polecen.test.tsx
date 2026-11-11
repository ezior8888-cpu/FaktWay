import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { table: string; eqs: Array<[string, unknown]>; or: string | null; limit: number | null };
const st = vi.hoisted(() => ({
  auth: vi.fn(),
  calls: [] as Array<{ table: string; eqs: Array<[string, unknown]>; or: string | null; limit: number | null }>,
  error: false,
  data: {} as Record<string, unknown[]>,
}));

function fakeSupabase() {
  return {
    from: (table: string) => {
      const call: Call = { table, eqs: [], or: null, limit: null };
      st.calls.push(call);
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (call.eqs.push([k, v]), q),
        or: (f: string) => ((call.or = f), q),
        order: () => q,
        limit: async (n: number) => {
          call.limit = n;
          return st.error
            ? { data: null, error: { message: 'x' } }
            : { data: st.data[table] ?? [], error: null };
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireUserAndActiveOrg: st.auth };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { searchCommandPaletteAction } from '@/app/actions/command-search';
import { CommandMenu, CommandMenuPhoneTrigger } from '@/components/dashboard/command-menu';
import { buildPaletteNavEntries, normalizeSearchQuery } from '@/lib/command-palette';
import { dashboardNavItems, dashboardSettingsNavItem } from '@/lib/dashboard-nav-config';
import { ActionAuthError } from '@/lib/supabase/auth-context';

beforeEach(() => {
  vi.clearAllMocks();
  st.calls = [];
  st.error = false;
  st.data = {};
  st.auth.mockResolvedValue({ supabase: fakeSupabase(), tenantId: 'ten-1', user: { id: 'u' }, role: 'member' });
});

describe('buildPaletteNavEntries', () => {
  it('zawiera każdą pozycję menu, ustawienia i obie akcje', () => {
    const hrefs = buildPaletteNavEntries().map((e) => e.href);
    for (const item of dashboardNavItems) expect(hrefs).toContain(item.href);
    expect(hrefs).toContain(dashboardSettingsNavItem.href);
    const actions = buildPaletteNavEntries().filter((e) => e.group === 'Akcje');
    expect(actions.map((a) => [a.label, a.href])).toEqual([
      ['Wystaw fakturę', '/invoices/new'],
      ['Dodaj wydatek', '/expenses'],
      // Świadoma zmiana (plan Finora N4, krok 3.2): akcja „Importuj wyciąg” z ekranem Bank.
      ['Importuj wyciąg', '/bank'],
    ]);
  });
});

describe('buildPaletteNavEntries — zakładki Faktur (poprawka 21.10.2026)', () => {
  // Cykliczne i przypomnienia wyszły z menu (są zakładkami ekranu „Faktury”),
  // ale ⌘K dalej prowadzi do nich wprost — także po starej nazwie „Przypomnienia”.
  it('„Faktury cykliczne” są w ⌘K, z nazwą sekcji w słowach kluczowych', () => {
    const entry = buildPaletteNavEntries().find((e) => e.href === '/invoices/recurring');
    expect(entry).toMatchObject({ group: 'Przejdź do', label: 'Faktury cykliczne' });
    expect(entry?.keywords).toContain('Sprzedaż');
  });

  it('„Faktury po terminie” są w ⌘K i dają się znaleźć po słowie „Przypomnienia”', () => {
    const entry = buildPaletteNavEntries().find((e) => e.href === '/payments/overdue');
    expect(entry).toMatchObject({ group: 'Przejdź do', label: 'Faktury po terminie' });
    expect(entry?.keywords).toEqual(expect.arrayContaining(['Sprzedaż', 'Przypomnienia']));
  });
});

describe('buildPaletteNavEntries — zakładki Kosztów (poprawka 21.10.2026)', () => {
  // Wydatki i Skrzynka KSeF wyszły z menu (są zakładkami ekranu „Koszty”),
  // ale ⌘K dalej prowadzi do każdej wprost — także po słowie „Koszty”.
  it('„Koszty” są w menu, a „Wydatki” i „Skrzynka KSeF” w ⌘K ze starymi nazwami', () => {
    const entries = buildPaletteNavEntries().filter((e) => e.group === 'Przejdź do');
    expect(entries.find((e) => e.label === 'Koszty')?.href).toBe('/expenses');
    const wydatki = entries.find((e) => e.label === 'Wydatki');
    expect(wydatki?.href).toBe('/expenses');
    expect(wydatki?.keywords).toEqual(expect.arrayContaining(['Koszty', 'paragon']));
    const skrzynka = entries.find((e) => e.href === '/inbox');
    expect(skrzynka?.label).toBe('Skrzynka KSeF');
    expect(skrzynka?.keywords).toEqual(expect.arrayContaining(['Koszty', 'KSeF', 'faktury zakupowe']));
  });
});

describe('buildPaletteNavEntries — zakładki Księgowości (poprawka 21.10.2026)', () => {
  // KPiR i Eksport wyszły z menu (są zakładkami ekranu „Księgowość”), ale ⌘K
  // dalej prowadzi do każdej wprost — także po słowie „Księgowość” i „JPK”.
  it('„Księgowość” jest w menu, a „KPiR” i „Eksport” w ⌘K ze starymi nazwami', () => {
    const entries = buildPaletteNavEntries().filter((e) => e.group === 'Przejdź do');
    expect(entries.find((e) => e.label === 'Księgowość')?.href).toBe('/reports/kpir');
    const kpir = entries.find((e) => e.label === 'KPiR');
    expect(kpir?.href).toBe('/reports/kpir');
    expect(kpir?.keywords).toEqual(expect.arrayContaining(['Księgowość', 'książka przychodów i rozchodów', 'PIT']));
    const eksport = entries.find((e) => e.href === '/reports/exports');
    expect(eksport?.label).toBe('Eksport');
    expect(eksport?.keywords).toEqual(expect.arrayContaining(['Księgowość', 'JPK', 'CSV', 'plik dla księgowej']));
    // Ten sam adres co pozycja menu „Księgowość”, ale inna etykieta — inna wartość cmdk.
    expect(kpir?.value).not.toBe(entries.find((e) => e.label === 'Księgowość')?.value);
  });
});

describe('buildPaletteNavEntries — obie analizy (Analizy 1:1 z Finory, 21.10.2026)', () => {
  // Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — w menu jedna pozycja
  // „Analizy” (/analizy/sprzedaz), analiza kosztów jest za przełącznikiem
  // w nagłówku; ⌘K dalej prowadzi do każdej analizy wprost.
  it('„Analizy” są w menu, a „Analiza sprzedaży” i „Analiza kosztów” w ⌘K', () => {
    const entries = buildPaletteNavEntries().filter((e) => e.group === 'Przejdź do');
    const menu = entries.find((e) => e.label === 'Analizy');
    expect(menu?.href).toBe('/analizy/sprzedaz');
    const sprzedaz = entries.find((e) => e.label === 'Analiza sprzedaży');
    expect(sprzedaz?.href).toBe('/analizy/sprzedaz');
    expect(sprzedaz?.keywords).toEqual(
      expect.arrayContaining(['Analizy', 'Sprzedaż', 'przychody', 'produkty', 'należności', 'stali klienci', 'wykresy']),
    );
    const koszty = entries.find((e) => e.href === '/analizy/koszty');
    expect(koszty?.label).toBe('Analiza kosztów');
    expect(koszty?.keywords).toEqual(
      expect.arrayContaining(['Analizy', 'Koszty', 'wydatki', 'kategorie', 'VAT', 'stałe koszty', 'wykresy']),
    );
    // Ten sam adres co pozycja menu „Analizy”, ale inna etykieta — inna wartość cmdk.
    expect(sprzedaz?.value).not.toBe(menu?.value);
  });
});

describe('buildPaletteNavEntries — unikalne wartości cmdk', () => {
  it('„Wystaw fakturę” jest i w menu, i w akcjach, a wartości (value) się nie powtarzają', () => {
    const entries = buildPaletteNavEntries();
    expect(entries.filter((e) => e.label === 'Wystaw fakturę').length).toBeGreaterThan(1);
    const values = entries.map((e) => e.value);
    expect(new Set(values).size).toBe(values.length);
    // Etykieta zostaje w słowach kluczowych, by dopasowanie po nazwie działało.
    for (const e of entries) expect(e.keywords).toContain(e.label);
  });
});

describe('normalizeSearchQuery', () => {
  it('przycina, obcina do 80 znaków i odrzuca frazy krótsze niż 2', () => {
    expect(normalizeSearchQuery('  ab  ')).toBe('ab');
    expect(normalizeSearchQuery(' a ')).toBeNull();
    expect(normalizeSearchQuery('')).toBeNull();
    expect(normalizeSearchQuery('x'.repeat(200))).toHaveLength(80);
  });
});

describe('searchCommandPaletteAction', () => {
  it('faktura w walucie obcej ma kod waluty, nie „zł” (plan §2.4 pkt 6)', async () => {
    st.data = {
      invoices: [{ id: 'i2', internal_number: 'FV/2', buyer_data: { name: 'GmbH' }, gross_total: '100', currency: 'EUR' }],
      contractors: [],
    };
    const res = await searchCommandPaletteAction('gmbh');
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.invoices[0].grossLabel).toMatch(/EUR$/);
    expect(res.invoices[0].grossLabel).not.toContain('zł');
  });

  it('krótka fraza nie dotyka bazy ani sesji', async () => {
    const res = await searchCommandPaletteAction('a');
    expect(res).toEqual({ success: true, invoices: [], contractors: [] });
    expect(st.auth).not.toHaveBeenCalled();
    expect(st.calls).toHaveLength(0);
  });

  it('filtruje po tenant_id, limituje do 5 i mapuje wyniki', async () => {
    st.data = {
      invoices: [{ id: 'i1', internal_number: 'FV/1', buyer_data: { name: 'ACME' }, gross_total: '123.40' }],
      contractors: [{ id: 'c1', name: 'ACME', nip: '1234567890' }],
    };
    const res = await searchCommandPaletteAction('acme');
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.invoices[0]).toMatchObject({ id: 'i1', number: 'FV/1', buyer: 'ACME' });
    expect(res.invoices[0].grossLabel).toContain('123,40');
    expect(res.invoices[0].grossLabel).toMatch(/zł$/);
    expect(res.contractors).toEqual([{ id: 'c1', name: 'ACME', nip: '1234567890' }]);
    expect(st.calls).toHaveLength(2);
    for (const c of st.calls) {
      expect(c.eqs).toContainEqual(['tenant_id', 'ten-1']);
      expect(c.limit).toBe(5);
      expect(c.or).toBeTruthy();
    }
    expect(st.calls[0].eqs).toContainEqual(['direction', 'outgoing']);
  });

  it('błąd autoryzacji daje success false', async () => {
    st.auth.mockRejectedValue(new ActionAuthError('Niezalogowany'));
    expect(await searchCommandPaletteAction('acme')).toEqual({ success: false, error: 'Niezalogowany' });
  });

  it('błąd bazy daje polski komunikat', async () => {
    st.error = true;
    const res = await searchCommandPaletteAction('acme');
    expect(res.success).toBe(false);
  });
});

describe('CommandMenu', () => {
  it('renderuje przycisk z polskim tekstem i skrótem', () => {
    const html = renderToStaticMarkup(<CommandMenu />);
    expect(html).toContain('Szukaj lub przejdź…');
    expect(html).toContain('<kbd');
    expect(html).toContain('⌘K');
  });

  it('na telefonie lupa jest osobnym przyciskiem po prawej stronie paska (03.11.2026)', () => {
    const html = renderToStaticMarkup(<CommandMenuPhoneTrigger />);
    expect(html).toContain('aria-label="Szukaj"');
    expect(html).toMatch(/class="[^"]*\bsm:hidden/);
  });
});
