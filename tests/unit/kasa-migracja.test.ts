import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00194 (kasa, krok 3.7) czytana jako tekst. Zachowanie na
 * prawdziwym Postgresie (RLS, blokada serii przy wystawieniach naraz, stan
 * kasy, wyzwalacze, wpłata do faktury) sprawdza tests/rls-kasa.test.ts w jobie
 * CI „RLS isolation”; ten test pilnuje lokalnie, żeby żadna z granic nie
 * zniknęła po cichu z tekstu migracji.
 */

const FILE = join(process.cwd(), 'supabase/migrations/00194_cash_documents.sql');
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

describe('00194: plik, nagłówek i rejestr', () => {
  it('plik istnieje i nagłówek mówi: PRZED wdrożeniem, po 00176', () => {
    expect(existsSync(FILE)).toBe(true);
    const header = sql.split('\n').filter((line) => line.startsWith('--')).join('\n');
    expect(header).toMatch(/PRZED wdrożeniem/);
    expect(header).toMatch(/po 00176/);
  });

  it('bez DROP tabel i kolumn, TRUNCATE i DELETE przy wgraniu', () => {
    expect(outsideBodies(sql)).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
  });

  it('rejestr: wiersz 00194, „następny wolny” za nim (numer nie wpisany na sztywno)', () => {
    expect(registry).toMatch(/^\| 00194 \| Claude \(plan kompletnej aplikacji, krok 3\.7/m);
    const next = /^\| \*\*(\d{5})\*\* \| — \| następny wolny/m.exec(registry)?.[1];
    expect(Number(next)).toBeGreaterThan(194);
  });
});

describe('00194: dostęp (RLS, granty)', () => {
  it.each(['cash_registers', 'cash_documents'])('%s: RLS, odczyt tylko własnej firmy, zapis wyłącznie przez RPC', (table) => {
    expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).toContain(`GRANT SELECT ON public.${table} TO authenticated;`);
    expect(sql).toContain(`GRANT SELECT, DELETE ON public.${table} TO service_role;`);
    const policies = [...sql.matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}\\s+FOR (\\w+)`, 'g'))].map((m) => m[1]);
    expect(policies).toEqual(['SELECT']);
    expect(sql).not.toMatch(new RegExp(`GRANT [^;]*(INSERT|UPDATE)[^;]* ON public\\.${table} TO authenticated`));
  });

  it.each([
    'open_cash_register(date, numeric)',
    'issue_cash_document(text, uuid, date, numeric, text, jsonb, text, uuid, uuid)',
    'correct_cash_document(uuid, text, uuid)',
    'cash_report(date, date)',
    'cash_receipt_payments()',
  ])('%s: tylko dla zalogowanych (bez anon i PUBLIC)', (fn) => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
  });

  it('stan kasy innej firmy nie jest do odpytania: funkcja pomocnicza bez EXECUTE dla klientów', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.cash_lowest_balance(uuid, date) FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.cash_lowest_balance/);
  });

  it.each(['open_cash_register', 'issue_cash_document', 'correct_cash_document', 'cash_lowest_balance', 'cash_report', 'cash_receipt_payments'])(
    '%s: każde zapytanie o dane firmy filtruje firmę z sesji (dane obcej firmy to „nie znaleziono”)',
    (fn) => {
      const b = withoutComments(body(fn));
      const reads = [...b.matchAll(/FROM public\.(cash_documents|cash_registers|invoices|payments|tenants)\b/g)];
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        const statement = b.slice(read.index, b.indexOf(';', read.index));
        const tenantFilter = read[1] === 'tenants'
          ? /\bid = v_tenant_id\b/
          : /tenant_id = (v_tenant_id|p_tenant_id|public\.get_current_tenant_id\(\))|\.tenant_id = [a-z]\.tenant_id/;
        expect(statement, `${fn}: ${statement.slice(0, 80)}`).toMatch(tenantFilter);
      }
    },
  );

  it.each(['open_cash_register', 'issue_cash_document', 'correct_cash_document'])(
    '%s: firma i rola z sesji; właściciel, administrator, członek; księgowa tylko wgląd',
    (fn) => {
      const b = body(fn);
      expect(b).toContain('public.get_current_tenant_id()');
      expect(b).toContain('auth.uid() IS NULL');
      for (const role of ['owner', 'admin', 'member']) expect(b).toContain(`public.has_org_role(v_tenant_id, '${role}')`);
      expect(b).not.toContain("'accountant'");
      expect(sql).toMatch(new RegExp(`FUNCTION public\\.${fn}\\([\\s\\S]*?SECURITY DEFINER\\s+SET search_path = ''`));
    },
  );
});

describe('00194: numer z bazy pod blokadą serii', () => {
  it.each(['issue_cash_document', 'correct_cash_document'])('%s: blokada wiersza kasy przed kluczem, stanem kasy i numerem', (fn) => {
    const b = body(fn);
    const lock = b.indexOf('FROM public.cash_registers WHERE tenant_id = v_tenant_id FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(b.indexOf('idempotency_key = p_idempotency_key')).toBeGreaterThan(lock);
    expect(b.indexOf('max(c.number_seq)')).toBeGreaterThan(lock);
    expect(b.indexOf('INSERT INTO public.cash_documents')).toBeGreaterThan(b.indexOf('max(c.number_seq)'));
  });

  it('UNIQUE numeru serii i klucza idempotencji jako druga ochrona; CHECK zgodności numeru z serią i rokiem operacji', () => {
    expect(sql).toContain('CONSTRAINT cash_documents_number_unique UNIQUE (tenant_id, kind, number_year, number_seq)');
    expect(sql).toContain('CONSTRAINT cash_documents_key_unique UNIQUE (tenant_id, idempotency_key)');
    expect(sql).toMatch(/number_year = EXTRACT\(YEAR FROM operation_date\)::integer/);
    expect(sql).toMatch(/number = kind \|\| '\/' \|\| number_seq::text \|\| '\/' \|\| number_year::text/);
  });

  it('jedna korekta na dowód i jeden dowód KP na wpłatę (indeksy unikalne)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_cash_documents_corrects\s+ON public\.cash_documents \(tenant_id, corrects_id\) WHERE corrects_id IS NOT NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_cash_documents_payment\s+ON public\.cash_documents \(tenant_id, payment_id\) WHERE payment_id IS NOT NULL;/);
  });
});

describe('00194: wystawionego dowodu nie zmienia nikt', () => {
  it('wyzwalacz przed UPDATE bez wyjątku dla roli; wolne tylko zerowania kluczy obcych', () => {
    expect(sql).toMatch(/CREATE TRIGGER a_guard_cash_document_update\s+BEFORE UPDATE ON public\.cash_documents/);
    const b = body('guard_cash_document_update');
    expect(b).toContain("ARRAY['invoice_id', 'payment_id', 'issued_by']");
    expect(b).toContain('RAISE EXCEPTION');
    expect(b).not.toMatch(/current_user|session_user|auth\.role|service_role|current_setting/);
    for (const col of ['invoice_id', 'payment_id', 'issued_by']) {
      expect(b).toContain(`NEW.${col} IS NOT NULL AND NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
  });

  it('stan początkowy kasy zablokowany po pierwszym dowodzie (wyzwalacz i RPC)', () => {
    expect(sql).toMatch(/CREATE TRIGGER a_guard_cash_register_update\s+BEFORE UPDATE ON public\.cash_registers/);
    expect(body('guard_cash_register_update')).toContain('FROM public.cash_documents');
    expect(body('open_cash_register')).toContain("'documents_exist'");
  });

  it('wpłaty z aktywnym KP nie cofa się na fakturze: wyzwalacz na payments', () => {
    expect(sql).toMatch(/CREATE TRIGGER a_guard_payment_cash_document\s+BEFORE UPDATE OF voided_at ON public\.payments/);
    const b = body('guard_payment_cash_document');
    expect(b).toContain("RAISE EXCEPTION 'cash_document_active'");
    expect(b).toContain('k.corrects_id = c.id');
  });
});

describe('00194: stan kasy, korekta i wpłata do faktury', () => {
  it('wypłata i korekta wpłaty sprawdzają najniższy stan na koniec dnia od daty operacji', () => {
    const lowest = body('cash_lowest_balance');
    expect(lowest).toContain('OVER (ORDER BY d.on_day)');
    expect(lowest).toContain('WHERE t.on_day >= p_from');
    expect(body('issue_cash_document')).toMatch(
      /IF v_kind = 'KW' THEN[\s\S]*public\.cash_lowest_balance\(v_tenant_id, p_operation_date\)[\s\S]*IF v_lowest < p_amount THEN\s+RETURN jsonb_build_object\('status', 'refused', 'code', 'insufficient_cash'/,
    );
    expect(body('correct_cash_document')).toMatch(
      /IF v_original\.kind = 'KP' THEN[\s\S]*public\.cash_lowest_balance\(v_tenant_id, v_original\.operation_date\)[\s\S]*IF v_lowest < v_original\.amount THEN\s+RETURN jsonb_build_object\('status', 'refused', 'code', 'insufficient_cash'/,
    );
  });

  it('korekta: storno z kwotą ujemną, datą operacji dowodu korygowanego i przyczyną; cofnięcie wpłaty w podtransakcji', () => {
    const b = body('correct_cash_document');
    expect(b).toContain('-v_original.amount');
    expect(b).toContain('v_original.operation_date');
    expect(b).toContain("'already_corrected'");
    expect(b).toContain("'is_correction'");
    expect(b).toContain('public.void_invoice_payment(v_original.payment_id)');
    expect(b).toMatch(/EXCEPTION WHEN raise_exception THEN/);
  });

  it('KP do faktury zapisuje wpłatę przez record_invoice_payment (00176), forma płatności gotówka', () => {
    const b = body('issue_cash_document');
    expect(b).toContain('public.record_invoice_payment(p_invoice_id, p_amount, p_idempotency_key, p_operation_date');
    expect(b).toContain("SET payment_method = 'cash'");
    expect(b).toContain("'payment_linked'");
    expect(b).toContain("match_method IS DISTINCT FROM 'manual_entry'");
  });

  it('audyt w tej samej transakcji co zapis', () => {
    expect(body('issue_cash_document')).toContain("'cash_document.issued'");
    expect(body('correct_cash_document')).toContain("'cash_document.corrected'");
    expect(body('open_cash_register')).toContain("'cash_register.opened'");
    expect(body('open_cash_register')).toContain("'cash_register.opening_changed'");
  });
});
