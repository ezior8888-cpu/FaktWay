import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00199 (serie numeracji faktur, krok 2.5) czytana jako tekst.
 * Zachowanie na prawdziwym Postgresie (blokada serii przy dwóch wystawieniach
 * naraz, RLS, role, wzór bez licznika, numer zajęty w KSeF, istniejące
 * numery) sprawdza tests/rls-numeracja.test.ts w jobie CI „RLS isolation”;
 * ten test pilnuje lokalnie, żeby żadna z granic nie zniknęła po cichu
 * z tekstu migracji.
 */

const FILE = join(process.cwd(), 'supabase/migrations/00199_invoice_number_series.sql');
const sql = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const registry = readFileSync(join(process.cwd(), 'docs/koordynacja/CLAUDE-DO-CODEXA.md'), 'utf8');

/** Ciało funkcji `public.<nazwa>(` do zamykającego `$$;`. */
function body(name: string): string {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  if (start < 0) return '';
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$;', open + 2);
  return open > 0 && close > open ? sql.slice(open, close) : '';
}

const withoutComments = (text: string) => text.replace(/--[^\n]*/g, '');
const outsideBodies = (text: string) => withoutComments(text).replace(/\$\$[\s\S]*?\$\$/g, '');

describe('00199: plik, nagłówek i rejestr', () => {
  it('plik istnieje, nagłówek mówi PRZED wdrożeniem i opisuje wypełnienie danych', () => {
    expect(existsSync(FILE)).toBe(true);
    const header = sql.split('\n').filter((line) => line.startsWith('--')).join('\n');
    expect(header).toMatch(/PRZED wdrożeniem/);
    expect(header).toMatch(/DROP\/DML:/);
  });

  it('bez DROP tabel i kolumn, TRUNCATE i DELETE przy wgraniu; istniejących faktur nie zmienia (bez UPDATE invoices)', () => {
    expect(outsideBodies(sql)).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
    expect(outsideBodies(sql)).not.toMatch(/\bUPDATE\s+public\.invoices\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\.invoices\b/i);
  });

  it('rejestr: wiersz 00199, „następny wolny” za nim (numer nie wpisany na sztywno)', () => {
    expect(registry).toMatch(/^\| 00199 \| Claude \(plan kompletnej aplikacji, krok 2\.5/m);
    const next = /^\| \*\*(\d{5})\*\* \| — \| następny wolny/m.exec(registry)?.[1];
    expect(Number(next)).toBeGreaterThan(199);
  });
});

describe('00199: dostęp (RLS, granty)', () => {
  it.each(['invoice_number_series', 'invoice_number_counters'])('%s: RLS, odczyt tylko własnej firmy, zapis wyłącznie przez funkcje', (table) => {
    expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).toContain(`GRANT SELECT ON public.${table} TO authenticated;`);
    expect(sql).toContain(`GRANT SELECT, DELETE ON public.${table} TO service_role;`);
    const policies = [...sql.matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}\\s+FOR (\\w+)`, 'g'))].map((m) => m[1]);
    expect(policies).toEqual(['SELECT']);
    expect(sql).not.toMatch(new RegExp(`GRANT [^;]*(INSERT|UPDATE)[^;]* ON public\\.${table} TO authenticated`));
  });

  it.each([
    'invoice_number_series_overview(date)',
    'invoice_number_next(uuid, date)',
    'invoice_number_series_create(text, text, integer, text[])',
    'invoice_number_series_update(uuid, text, text[])',
    'invoice_number_series_set_active(uuid, boolean)',
    'invoice_number_series_delete(uuid)',
  ])('%s: tylko dla zalogowanych (bez anon i PUBLIC)', (fn) => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
  });

  it.each([
    'invoice_number_next_counter(uuid, uuid, text, text)',
    'invoice_number_preview_of(uuid, uuid, text, date)',
    'invoice_number_series_ensure_default(uuid, uuid)',
  ])('%s: funkcja pomocnicza z firmą w argumencie, bez EXECUTE dla klientów', (fn) => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn.replace(/[()[\]]/g, '\\$&')}`));
  });

  it.each([
    'invoice_number_series_create',
    'invoice_number_series_update',
    'invoice_number_series_set_active',
    'invoice_number_series_delete',
  ])('%s: firma z sesji, rola właściciel albo administrator, audyt w tej samej funkcji', (fn) => {
    const b = withoutComments(body(fn));
    expect(b).toContain('public.get_current_tenant_id()');
    expect(b).toMatch(/has_org_role\(v_tenant_id, 'owner'\)/);
    expect(b).toMatch(/has_org_role\(v_tenant_id, 'admin'\)/);
    expect(b).not.toMatch(/has_org_role\(v_tenant_id, 'member'\)/);
    expect(b).toMatch(/INSERT INTO public\.audit_logs/);
    expect(b).toMatch(/'invoice_number_series\.\w+'/);
  });

  it.each(['invoice_number_series_overview', 'invoice_number_next'])('%s: firma z sesji, nie z argumentu', (fn) => {
    const b = withoutComments(body(fn));
    expect(b).toContain('public.get_current_tenant_id()');
    expect(b).not.toMatch(/p_tenant_id/);
  });
});

describe('00199: numer z licznika serii pod blokadą', () => {
  it('wyzwalacz przed zapisem faktury: blokada serii, kolejny wolny licznik, licznik zapisany w tej samej transakcji', () => {
    const b = withoutComments(body('invoice_number_assign'));
    expect(b).toMatch(/pg_advisory_xact_lock\(\s*hashtextextended\('invoice_number_series:'/);
    expect(b).toContain('public.invoice_number_next_counter(');
    expect(b).toContain("'invoice_number_moved'");
    expect(b).toContain("'invoice_number_mismatch'");
    expect(b).toMatch(/INSERT INTO public\.invoice_number_counters[\s\S]*ON CONFLICT \(series_id, period\) DO UPDATE/);
    // Obca firma: sesja nie zapisze faktury innej firmy z jej serią (ani nie podejrzy jej licznika).
    expect(b).toMatch(/NEW\.tenant_id IS DISTINCT FROM public\.get_current_tenant_id\(\)/);
    // Seria tej samej firmy co faktura.
    expect(b).toMatch(/s\.id = NEW\.number_series_id AND s\.tenant_id = NEW\.tenant_id/);
    expect(sql).toMatch(/CREATE TRIGGER zzz_invoice_number_assign\s+BEFORE INSERT ON public\.invoices/);
  });

  it('kolejny wolny licznik pomija numery zajęte przez każdą fakturę sprzedaży firmy (także wycofany szkic po 440)', () => {
    const b = withoutComments(body('invoice_number_next_counter'));
    expect(b).toMatch(/FROM public\.invoices AS inv/);
    expect(b).toMatch(/inv\.tenant_id = p_tenant_id/);
    expect(b).toMatch(/inv\.direction = 'outgoing'/);
    expect(b).not.toMatch(/ksef_status/);
  });

  it('zwrot numeru tylko przy usunięciu ostatniego szkicu bez kontaktu z KSeF', () => {
    const b = withoutComments(body('invoice_number_release'));
    expect(b).toMatch(/OLD\.ksef_status IS DISTINCT FROM 'draft'/);
    expect(b).toMatch(/FROM public\.ksef_submissions/);
    expect(b).toMatch(/FROM public\.ksef_offline_queue/);
    expect(b).toMatch(/last_value = c\.last_value - 1/);
    expect(b).toMatch(/c\.last_value = OLD\.number_counter/);
    expect(sql).toMatch(/CREATE TRIGGER zzz_invoice_number_release\s+BEFORE DELETE ON public\.invoices/);
  });

  it('seria, okres, licznik i klucz zapisu: sesja klienta ich nie zmienia po zapisie', () => {
    expect(sql).toMatch(/BEFORE UPDATE OF number_series_id, number_period, number_counter, number_request_key ON public\.invoices/);
    const b = withoutComments(body('guard_invoice_number_series_update'));
    expect(b).toMatch(/current_user IN \('authenticated', 'anon'\)/);
  });

  it('wzór w bazie: te same problemy co w aplikacji (każdy kod z lib/numeracja/wzor.ts ma swoją gałąź)', () => {
    const b = withoutComments(body('invoice_number_pattern_problem'));
    for (const problem of ['empty', 'too_long', 'bad_char', 'unknown_token', 'no_counter', 'duplicate_token', 'month_without_year', 'ambiguous']) {
      expect(b).toContain(`RETURN '${problem}'`);
    }
    expect(b).toMatch(/IF v_counters = 0 THEN\s+RETURN 'no_counter'/);
    expect(b).toMatch(/IF v_months = 1 AND v_years = 0 THEN\s+RETURN 'month_without_year'/);
  });

  it('jednoznaczność: UNIQUE licznika w serii i okresie, UNIQUE klucza zapisu, wzór sprawdzany CHECK-iem, układ serii unikalny w firmie', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_invoices_number_series_counter\s+ON public\.invoices \(number_series_id, number_period, number_counter\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_invoices_number_request_key\s+ON public\.invoices \(tenant_id, number_request_key\)/);
    expect(sql).toMatch(/pattern IS NULL OR public\.invoice_number_pattern_problem\(pattern\) IS NULL/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_invoice_number_series_skeleton[\s\S]*invoice_number_pattern_skeleton\(pattern\)/);
  });

  it('seria domyślna firmy: bez wzoru (numeracja jak dotąd), domyślna dla wszystkich rodzajów', () => {
    const b = withoutComments(body('invoice_number_series_ensure_default'));
    expect(b).toMatch(/INSERT INTO public\.invoice_number_series/);
    expect(b).toMatch(/NULL/);
    expect(b).toMatch(/ARRAY\['regular', 'advance', 'final', 'correction'\]/);
  });
});
