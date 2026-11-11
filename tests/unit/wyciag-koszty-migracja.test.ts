import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00196 (przelewy do dostawców z wyciągu jako zapłaty kosztów, krok
 * 3.2, część 3) czytana jako tekst. Zachowanie na prawdziwym Postgresie (zapis
 * raz, rola, obca firma, RODO przy „Pomiń”, cofnięcie, CHECK-i dla klucza
 * serwisowego) sprawdza tests/rls-wyciag-koszty.test.ts w jobie CI „RLS
 * isolation”; ten test pilnuje lokalnie, żeby granice nie zniknęły z tekstu
 * migracji, a zastąpione funkcje z 00189 zachowały całe dawne zachowanie.
 */

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = join(DIR, '00196_bank_expense_payments.sql');
const sql = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const m189 = readFileSync(join(DIR, '00189_bank_tax_payments.sql'), 'utf8');
const registry = readFileSync(join(process.cwd(), 'docs/koordynacja/CLAUDE-DO-CODEXA.md'), 'utf8');

/** Ciało funkcji `public.<nazwa>(` do zamykającego `$$;`. */
function body(text: string, name: string): string {
  const start = text.indexOf(`FUNCTION public.${name}(`);
  if (start < 0) return '';
  const open = text.indexOf('$$', start);
  const close = text.indexOf('$$;', open + 2);
  return open > 0 && close > open ? text.slice(open, close) : '';
}

const withoutComments = (text: string) => text.replace(/--[^\n]*/g, '');
const outsideBodies = (text: string) => withoutComments(text).replace(/\$\$[\s\S]*?\$\$/g, '');
/** Instrukcje ciała bez komentarzy i białych znaków na brzegach linii: do porównania z 00189. */
const statements = (text: string) =>
  withoutComments(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const RPC = [
  'bank_known_operations(text[])',
  'confirm_bank_expense_payment(text, jsonb, uuid[], text)',
  'skip_bank_expense_operation(text, jsonb)',
  'undo_bank_expense_payment(uuid)',
  'bank_expense_operations()',
  'skip_bank_operation(uuid)',
];

describe('00196: plik, nagłówek i rejestr', () => {
  it('plik istnieje, nagłówek mówi: PRZED wdrożeniem, po 00189 i 00177', () => {
    expect(existsSync(FILE)).toBe(true);
    const header = sql.split('\n').filter((line) => line.startsWith('--')).join('\n');
    expect(header).toMatch(/PRZED wdrożeniem/);
    expect(header).toMatch(/po 00189/);
    expect(header).toMatch(/00177/);
    expect(header).not.toMatch(/PO wdrożeniu/);
  });

  it('bez DROP tabel i kolumn, TRUNCATE i DELETE przy wgraniu (DELETE tylko w ciele cofnięcia)', () => {
    expect(outsideBodies(sql)).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|FUNCTION)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.)\b/i);
    expect(body(sql, 'undo_bank_expense_payment')).toMatch(/DELETE FROM public\.payment_imports/);
  });

  it('rejestr: wiersz 00196, „następny wolny” za nim (numer nie wpisany na sztywno)', () => {
    expect(registry).toMatch(/^\| 00196 \| Claude \(plan kompletnej aplikacji, krok 3\.2, część 3/m);
    const next = /^\| \*\*(\d{5})\*\* \| — \| następny wolny/m.exec(registry)?.[1];
    expect(Number(next)).toBeGreaterThan(196);
  });
});

describe('00196: RODO w CHECK-ach (także dla klucza serwisowego)', () => {
  it('wypływ bez rodzaju podatkowego tylko jako potwierdzona zapłata kosztów albo pominięty bez danych', () => {
    const check = /ADD CONSTRAINT payment_imports_bank_file_direction_check\s+CHECK \(([\s\S]*?)\);/.exec(sql)?.[1] ?? '';
    const flat = check.replace(/\s+/g, ' ');
    // Gałęzie z 00189 bez zmian w sensie: wpływ bez rodzaju, wypływ podatkowy.
    expect(flat).toContain("provider <> 'bank_file'");
    expect(flat).toContain('amount > 0 AND tax_kind IS NULL AND expense_ids IS NULL');
    expect(flat).toContain('amount < 0 AND tax_kind IS NOT NULL AND expense_ids IS NULL');
    // Nowe: wypływ do dostawcy rozstrzygnięty, połączony z kosztami albo pominięty i zamaskowany.
    expect(flat).toContain('amount < 0 AND tax_kind IS NULL AND decided_at IS NOT NULL');
    expect(flat).toContain('expense_ids IS NOT NULL AND is_matched AND NOT ignored');
    expect(flat).toContain('expense_ids IS NULL AND ignored AND NOT is_matched AND redacted_at IS NOT NULL');
  });

  it('połączenie z kosztami: 1-500 kosztów, bez wpłaty do faktury i zapłaty rozliczenia, bez maskowania', () => {
    const check = /ADD CONSTRAINT payment_imports_expense_link_check\s+CHECK \(([\s\S]*?)\);/.exec(sql)?.[1]?.replace(/\s+/g, ' ') ?? '';
    for (const part of ['cardinality(expense_ids) BETWEEN 1 AND 500', 'matched_payment_id IS NULL', 'tax_settlement_ids IS NULL', 'tax_kind IS NULL', 'redacted_at IS NULL']) {
      expect(check).toContain(part);
    }
  });
});

describe('00196: funkcje (firma i rola z sesji, uprawnienia)', () => {
  it.each(RPC)('%s: SECURITY DEFINER, pusta ścieżka, EXECUTE tylko dla zalogowanych', (signature) => {
    const name = signature.slice(0, signature.indexOf('('));
    const start = sql.indexOf(`FUNCTION public.${name}(`);
    expect(start).toBeGreaterThan(0);
    const head = sql.slice(start, sql.indexOf('$$', start));
    expect(head).toContain('SECURITY DEFINER');
    expect(head).toContain("SET search_path = ''");
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated;`);
  });

  it.each(['confirm_bank_expense_payment', 'skip_bank_expense_operation', 'undo_bank_expense_payment'])(
    '%s: rola owner, admin albo member jak przy „Oznacz jako zapłacone” (00177), firma z sesji',
    (name) => {
      const b = body(sql, name);
      expect(b).toContain('public.get_current_tenant_id()');
      expect(b).toContain("public.has_org_role(v_tenant_id, 'owner')");
      expect(b).toContain("public.has_org_role(v_tenant_id, 'admin')");
      expect(b).toContain("public.has_org_role(v_tenant_id, 'member')");
      expect(b).toMatch(/USING ERRCODE = '42501'/);
      expect(b).not.toContain("'accountant'");
    },
  );

  // Dopisane po kodzie: obca firma na bazie sprawdza test RLS w CI, a tu lokalnie, że żadne zapytanie nie gubi firmy z sesji.
  it.each(['confirm_bank_expense_payment', 'skip_bank_expense_operation', 'undo_bank_expense_payment', 'bank_known_operations', 'bank_expense_operations'])(
    '%s: każde zapytanie do payment_imports i expenses ma firmę z sesji',
    (name) => {
      const b = withoutComments(body(sql, name));
      const queries = [...b.matchAll(/(FROM|UPDATE|INTO|DELETE FROM) public\.(payment_imports|expenses)\b/g)].filter((m) => m[1] !== 'INTO');
      expect(queries.length).toBeGreaterThan(0);
      for (const m of queries) {
        // Do końca instrukcji (średnik) albo nagłówka pętli: firma musi być w tym samym zapytaniu.
        const rest = b.slice(m.index!);
        const end = rest.search(/;|\bLOOP\b/);
        const fragment = end >= 0 ? rest.slice(0, end) : rest;
        expect(fragment, fragment).toMatch(/tenant_id = v_tenant_id/);
      }
    },
  );

  it('potwierdzenie: zapłata tą samą drogą co „Oznacz jako zapłacone” (mark_expense_paid z dniem z wyciągu), blokady, granice', () => {
    const b = body(sql, 'confirm_bank_expense_payment');
    expect(b).toContain('public.mark_expense_paid(v_id, v_day)');
    expect(b).toContain('pg_advisory_xact_lock');
    expect(b).toMatch(/FROM public\.expenses[\s\S]*FOR UPDATE/);
    for (const code of ['invalid_request', 'invalid_operation', 'operation_confirmed', 'operation_skipped', 'not_expense_payment', 'payment_in_future',
      'expense_not_found', 'expense_paid', 'nothing_to_pay', 'expense_currency', 'account_mismatch', 'amount_mismatch', 'already_confirmed']) {
      expect(b).toContain(`'${code}'`);
    }
    // Kwota do zapłaty jak na liście „Do zapłaty”: brutto bez wpłat częściowych z faktury.
    expect(b).toContain("'zaplaconoCzesciowo'");
    // Same porównania granic (zachowanie na bazie: tests/rls-wyciag-koszty.test.ts).
    for (const warunek of [
      'IF v_sum <> -v_amount THEN',
      'public.bank_account_key(v_exp.payment_account) <> v_account',
      'IF v_exp.paid_at IS NOT NULL THEN',
      "IF v_currency IS DISTINCT FROM 'PLN' THEN",
      'IF v_day > v_today THEN',
      'IF v_existing.expense_ids = v_ids THEN',
      'IF v_amount >= 0 OR',
    ]) {
      expect(b).toContain(warunek);
    }
    expect(b).toContain("'bank.expense_payment_confirmed'");
    expect(b).toContain("COALESCE(p_operation ->> 'currency', '') <> 'PLN'");
  });

  it('pominięcie: wiersz od razu bez tytułu, nazwy, rachunku, NIP i referencji, tylko dla rachunku z kosztów firmy', () => {
    const b = body(sql, 'skip_bank_expense_operation');
    const insert = /INSERT INTO public\.payment_imports \(([\s\S]*?)\)/.exec(b)?.[1] ?? '';
    for (const column of ['title', 'counterparty_name', 'counterparty_account', 'counterparty_nip', 'reference']) {
      expect(insert).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(insert).toContain('redacted_at');
    expect(b).toContain("'not_expense_payment'");
    expect(b).toContain("'already_skipped'");
    expect(b).toContain("'bank.operation_skipped'");
    expect(b).toContain('public.bank_account_key(e.payment_account)');
  });

  it('cofnięcie: przez undo_expense_paid tylko koszty z dniem z wyciągu, operacja usunięta, audyt', () => {
    const b = body(sql, 'undo_bank_expense_payment');
    expect(b).toContain('public.undo_expense_paid(v_id)');
    expect(b).toContain('v_paid = v_paid_on');
    expect(b).toContain("'bank.expense_payment_undone'");
  });

  it('skip_bank_operation: całe zachowanie z 00189 i odmowa przy potwierdzonej zapłacie kosztów', () => {
    const before = statements(body(m189, 'skip_bank_operation'));
    const after = statements(body(sql, 'skip_bank_operation'));
    const added = after.filter((line) => !before.includes(line));
    const removed = before.filter((line) => !after.includes(line));
    expect(removed).toEqual([]);
    expect(added).toEqual([
      'IF v_op.expense_ids IS NOT NULL THEN',
      "RETURN jsonb_build_object('status', 'refused', 'code', 'expense_payment_confirmed');",
      'END IF;',
    ].filter((line) => !before.includes(line)));
  });

  it('wyzwalacz: niezmienne wszystko z 00189 i połączenie z kosztami', () => {
    const before = statements(body(m189, 'guard_payment_import_update'));
    const after = statements(body(sql, 'guard_payment_import_update'));
    expect(before.filter((line) => !after.includes(line))).toEqual(['OR NEW.tax_kind IS DISTINCT FROM OLD.tax_kind THEN']);
    expect(after.filter((line) => !before.includes(line))).toEqual([
      'OR NEW.tax_kind IS DISTINCT FROM OLD.tax_kind',
      'OR NEW.expense_ids IS DISTINCT FROM OLD.expense_ids THEN',
    ]);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.guard_payment_import_update() FROM PUBLIC, anon, authenticated;');
  });

  it('import_bank_operations bez zmian: wypływ bez rodzaju dalej jest tam odmową', () => {
    expect(sql).not.toContain('FUNCTION public.import_bank_operations(');
  });

  it('pomocnicza funkcja rachunku bez EXECUTE dla klientów', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.bank_account_key(text) FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).not.toContain('GRANT EXECUTE ON FUNCTION public.bank_account_key');
  });
});
