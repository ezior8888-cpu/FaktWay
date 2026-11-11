import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00198 (proforma i oferta, krok 2.4 planu kompletnej aplikacji)
 * jako tekst. Zachowanie na bazie sprawdza tests/rls-proformy.test.ts (job CI
 * „RLS isolation”); tu to, co da się sprawdzić bez bazy: kolejność wgrania,
 * brak operacji niszczących, RLS na tabelach z `tenant_id`, granty, funkcje
 * SECURITY DEFINER ze stałą ścieżką, powiązanie z fakturą wpisywane tylko
 * przy jej utworzeniu, brak zapisu do faktur i ksiąg, wiersz w rejestrze.
 */

const PATH = 'supabase/migrations/00198_sales_quotes.sql';
// Checkout na Windowsie (core.autocrlf) zapisuje migrację z CRLF.
const sql = existsSync(PATH) ? readFileSync(PATH, 'utf8').replace(/\r\n/g, '\n') : '';
const outsideBodies = sql.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');

function body(fn: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  if (start < 0) return '';
  const rest = sql.slice(start);
  const open = /AS \$(\w*)\$/.exec(rest);
  if (!open) return '';
  const from = open.index + open[0].length;
  return rest.slice(from, rest.indexOf(`$${open[1]}$`, from));
}

describe('migracja 00198: proforma i oferta', () => {
  it('plik istnieje; nagłówek: PRZED wdrożeniem, addytywna', () => {
    expect(sql).not.toBe('');
    expect(sql).toMatch(/PRZED wdrożeniem/);
  });

  it('bez DROP tabel i kolumn, bez TRUNCATE i bez zmian danych poza ciałami funkcji', () => {
    expect(outsideBodies).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)/i);
  });

  it('RLS włączony na obu tabelach z tenant_id; polityki przez get_current_tenant_id()', () => {
    for (const table of ['sales_quotes', 'sales_quote_emails']) {
      expect(outsideBodies).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(outsideBodies).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
    }
    const policies = outsideBodies.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(5);
    for (const policy of policies) expect(policy).toMatch(/tenant_id = public\.get_current_tenant_id\(\)/);
  });

  it('zapis, zmiana i usunięcie przez klienta tylko dla szkicu; historia wysyłek bez zapisu z sesji', () => {
    const write = outsideBodies.match(/CREATE POLICY "sales_quotes_(insert|update|delete)_draft"[\s\S]*?;/g) ?? [];
    expect(write).toHaveLength(3);
    for (const policy of write) expect(policy).toMatch(/status = 'draft'/);
    // UPDATE: szkic już w USING (wystawiony dokument to zero wierszy, nie błąd) i w WITH CHECK.
    const update = write.find((policy) => policy.includes('_update_draft'))!;
    const using = /USING \(([\s\S]*?)\)\s*WITH CHECK \(([\s\S]*)\)/.exec(update);
    expect(using?.[1]).toMatch(/status = 'draft'/);
    expect(using?.[2]).toMatch(/status = 'draft'/);
    expect(outsideBodies).toContain('GRANT SELECT ON public.sales_quote_emails TO authenticated;');
    expect(outsideBodies).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.sales_quote_emails TO authenticated/);
  });

  it('stan, numer, wystawca i autor poza grantami kolumnowymi klienta', () => {
    const grants = outsideBodies.match(/GRANT (INSERT|UPDATE) \(([^)]*)\)\s+ON public\.sales_quotes TO authenticated;/g) ?? [];
    expect(grants).toHaveLength(2);
    for (const grant of grants) {
      for (const column of ['status', 'number', 'number_year', 'number_seq', 'issuer', 'issued_at', 'issued_by', 'created_by']) {
        expect(grant, column).not.toMatch(new RegExp(`\\b${column}\\b`));
      }
    }
  });

  it('waluta tylko PLN, kwoty i pozycje sprawdzane w bazie', () => {
    expect(outsideBodies).toMatch(/CONSTRAINT sales_quotes_currency_check CHECK \(currency = 'PLN'\)/);
    expect(outsideBodies).toMatch(/sales_quotes_items_check CHECK \(public\.sales_quote_items_valid\(items\)\)/);
    for (const total of ['net_total', 'vat_total', 'gross_total']) {
      expect(outsideBodies, total).toMatch(new RegExp(`sales_quotes_${total}_check`));
    }
  });

  it.each([
    ['issue_sales_quote', 'issue_sales_quote(uuid)'],
    ['record_sales_quote_email', 'record_sales_quote_email(uuid, text, text, text)'],
  ])('%s: SECURITY DEFINER, stała ścieżka, sesja, firma i rola z sesji, EXECUTE bez anon', (fn, signature) => {
    const text = body(fn);
    expect(text).not.toBe('');
    expect(sql).toMatch(new RegExp(`FUNCTION public\\.${fn}\\([\\s\\S]*?SECURITY DEFINER\\s+SET search_path = ''`));
    expect(text).toMatch(/auth\.uid\(\) IS NULL/);
    expect(text).toContain('public.get_current_tenant_id()');
    expect(text).toMatch(/has_org_role\(v_tenant_id, 'accountant'\)/);
    expect(outsideBodies).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon;`);
    expect(outsideBodies).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated;`);
  });

  it('numer: blokada serii i kolejny numer w jednej transakcji; drugie wystawienie oddaje numer', () => {
    const text = body('issue_sales_quote');
    expect(text).toMatch(/FOR UPDATE/);
    expect(text).toMatch(/pg_advisory_xact_lock/);
    expect(text).toMatch(/'already_issued'/);
    expect(text).toMatch(/'PRO'/);
    expect(text).toMatch(/'OF'/);
    expect(text).toMatch(/INSERT INTO public\.audit_logs/);
  });

  it('historia: raz na klucz (ON CONFLICT), audyt tylko przy nowym wpisie', () => {
    const text = body('record_sales_quote_email');
    expect(text).toMatch(/ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/);
    expect(text).toMatch(/'already_recorded'/);
    expect(text).toMatch(/INSERT INTO public\.audit_logs/);
  });

  it('wyzwalacz: wystawionego dokumentu nie zmienia nikt (bez wyjątku dla roli)', () => {
    const text = body('guard_sales_quote_update');
    expect(text).toMatch(/OLD\.status = 'issued'/);
    expect(text).not.toMatch(/current_user/);
    expect(outsideBodies).toMatch(/CREATE TRIGGER \w+\s+BEFORE UPDATE ON public\.sales_quotes/);
  });

  it('faktura z dokumentu: powiązanie w invoices przez klucz złożony, kolejna zamiana pod indeksem unikalnym', () => {
    expect(outsideBodies).toMatch(/ADD COLUMN IF NOT EXISTS sales_quote_id uuid/);
    expect(outsideBodies).toMatch(/ADD COLUMN IF NOT EXISTS sales_quote_seq integer/);
    expect(outsideBodies).toMatch(
      /FOREIGN KEY \(tenant_id, sales_quote_id\)\s+REFERENCES public\.sales_quotes \(tenant_id, id\)\s+ON DELETE SET NULL \(sales_quote_id\)/,
    );
    expect(outsideBodies).toMatch(
      /CREATE UNIQUE INDEX uq_invoices_sales_quote_seq\s+ON public\.invoices \(tenant_id, sales_quote_id, sales_quote_seq\)\s+WHERE sales_quote_id IS NOT NULL/,
    );
  });

  it('faktura z dokumentu: tylko z wystawionego dokumentu, tylko zwykła albo zaliczkowa; klient nie przepina powiązania', () => {
    const insert = body('guard_invoice_sales_quote_insert');
    expect(insert).toMatch(/'issued'/);
    expect(insert).toMatch(/'regular'/);
    expect(insert).toMatch(/'advance'/);
    expect(outsideBodies).toMatch(/BEFORE INSERT ON public\.invoices\s+FOR EACH ROW\s+WHEN \(NEW\.sales_quote_id IS NOT NULL\)/);
    const update = body('guard_invoice_sales_quote_update');
    expect(update).toMatch(/current_user IN \('authenticated', 'anon'\)/);
    expect(outsideBodies).toMatch(/BEFORE UPDATE OF sales_quote_id, sales_quote_seq ON public\.invoices/);
  });

  it('poza KSeF i przychodem: migracja nie pisze do faktur, pozycji, wpłat, ksiąg ani KSeF', () => {
    expect(sql).not.toMatch(
      /INSERT\s+INTO\s+public\.(invoices|invoice_line_items|payments|ledger_\w+|tax_\w+|ksef_\w+|jpk_\w+|payment_reminders|xml_documents)\b/i,
    );
    expect(sql).not.toMatch(/UPDATE\s+public\.(invoices|payments|ledger_\w+|tax_\w+|ksef_\w+)\b/i);
  });

  it('rejestr numerów: 00198 zajęte w tym PR, „następny wolny” za nim', () => {
    const registry = readFileSync('docs/koordynacja/CLAUDE-DO-CODEXA.md', 'utf8');
    expect(registry).toMatch(/^\| 00198 \| Claude \(plan kompletnej aplikacji, krok 2\.4/m);
    // Bez numeru na sztywno: po kolejnych migracjach (gałąź zbiorcza, main) „następny wolny” rośnie.
    expect(Number(/^\| \*\*(\d{5})\*\* \| — \| następny wolny/m.exec(registry)?.[1])).toBeGreaterThan(198);
  });
});
