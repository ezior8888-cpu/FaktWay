import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_NOTIFICATION_KINDS } from '@/lib/app-notifications/types';

/**
 * Migracja 00192 (plan kompletnej aplikacji, krok 6.2, część 3): komentarze
 * i prośby o dokument przy koszcie z wpisem w dzwonku. Tekst migracji
 * (uprawnienia, search_path, klucze idempotencji); zachowanie na prawdziwej
 * bazie sprawdza `tests/rls-komentarze-kosztow.test.ts` w jobie „RLS isolation”.
 */

const DIR = join(process.cwd(), 'supabase/migrations');
const sql = () => readFileSync(join(DIR, '00192_expense_comments.sql'), 'utf8');
/** Kod wykonywany przy wgraniu: bez komentarzy i bez ciał funkcji. */
const outsideBodies = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '');

/** Rodzaje z OSTATNIEJ definicji CHECK-a `app_notifications_kind_check` w migracjach (kolejność plików). */
function kindsFromMigrations(): string[] {
  let last: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const text = readFileSync(join(DIR, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of text.matchAll(/app_notifications_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi)) {
      last = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((k) => k[1]!);
    }
  }
  return last;
}

describe('migracja 00192 (tekst; zachowanie na bazie w tests/rls-komentarze-kosztow.test.ts)', () => {
  it('nagłówek: PRZED wdrożeniem, po 00188; opis zmiany CHECK; bez DROP tabel i kolumn, bez DML przy wgraniu', () => {
    const tekst = sql();
    expect(tekst).toMatch(/KIEDY WGRAĆ: PRZED wdrożeniem, po 00188/);
    expect(tekst).toMatch(/ZMIANA CHECK: app_notifications_kind_check/);
    expect(outsideBodies(tekst)).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
  });

  it('dzwonek: CHECK rodzajów to lista z 00188 i dwa nowe rodzaje, z tą samą nazwą ograniczenia', () => {
    const tekst = outsideBodies(sql());
    expect(tekst).toContain('DROP CONSTRAINT IF EXISTS app_notifications_kind_check');
    expect(tekst).toMatch(
      /ADD CONSTRAINT app_notifications_kind_check CHECK \(kind IN \('inbox_new', 'invoice_accepted', 'invoice_rejected', 'tax_deadline', 'expense_comment', 'expense_document_request'\)\)/,
    );
  });

  it('tabela: RLS, odczyt tylko przy koszcie widocznym dla czytającego, bez zapisu kluczem użytkownika', () => {
    const tekst = sql();
    expect(tekst).toContain('ALTER TABLE public.expense_comments ENABLE ROW LEVEL SECURITY;');
    expect(tekst).toMatch(/FOR SELECT TO authenticated\s+USING \(\s*tenant_id = public\.get_current_tenant_id\(\)\s+AND EXISTS \(/);
    expect(tekst).toMatch(/FROM public\.expenses AS e\s+WHERE e\.id = expense_comments\.expense_id\s+AND e\.tenant_id = expense_comments\.tenant_id/);
    expect(tekst).toContain('REVOKE ALL ON public.expense_comments FROM PUBLIC, anon, authenticated, service_role;');
    expect(tekst).toContain('GRANT SELECT ON public.expense_comments TO authenticated;');
    expect(tekst).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO authenticated/);
    expect(tekst).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/);
    // Po usunięciu konta wpis zostaje bez autora (bez blokady usunięcia konta, AUD-41).
    expect(tekst).toContain('author_id UUID REFERENCES public.users(id) ON DELETE SET NULL');
    expect(tekst).toContain('resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL');
    expect(tekst).toContain('expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE');
  });

  it('funkcje: SECURITY DEFINER z pustym search_path, EXECUTE tylko authenticated, firma i rola z sesji', () => {
    const tekst = sql();
    expect(tekst.match(/SECURITY DEFINER\s+SET search_path = ''/g)?.length).toBe(2);
    for (const fn of ['expense_comment_add(UUID, TEXT, TEXT, UUID)', 'expense_document_request_resolve(UUID)']) {
      expect(tekst).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(tekst).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    }
    expect(tekst.match(/v_tenant := public\.get_current_tenant_id\(\);/g)?.length).toBe(2);
    // Rola autora: aktywne członkostwo aktywnej firmy z rolą z listy, w obu funkcjach; brak = 42501.
    const roleCheck =
      /WHERE m\.organization_id = v_tenant\s+AND m\.user_id = v_user\s+AND m\.status = 'active'\s+AND m\.role IN \('owner', 'admin', 'member', 'accountant'\);\s+IF v_role IS NULL THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = '42501';/g;
    expect(tekst.match(roleCheck)?.length).toBe(2);
    // Koszt tylko z aktywnej firmy (koszt innej firmy wygląda jak brak kosztu).
    expect(tekst).toMatch(/FROM public\.expenses AS e\s+WHERE e\.id = p_expense_id\s+AND e\.tenant_id = v_tenant;\s+IF NOT FOUND THEN\s+RETURN jsonb_build_object\('status', 'refused', 'code', 'not_found'\);/);
  });

  it('dzwonek: pozostali aktywni członkowie bez autora, klucz z identyfikatora komentarza, link do kosztu', () => {
    const tekst = sql();
    expect(tekst).toMatch(
      /FROM public\.memberships AS m\s+WHERE m\.organization_id = v_tenant\s+AND m\.status = 'active'\s+AND m\.role IN \('owner', 'admin', 'member', 'accountant'\)\s+AND m\.user_id <> v_user\s+ON CONFLICT ON CONSTRAINT app_notifications_klucz_unikalny DO NOTHING/,
    );
    expect(tekst).toContain("'/expenses/' || p_expense_id::text || '#komentarze'");
    expect(tekst).toMatch(/v_id::text,/);
  });

  it('ponowienie: ten sam identyfikator nie dubluje wpisu; audyt prośby i załatwienia w tej samej transakcji', () => {
    const tekst = sql();
    expect(tekst).toContain('ON CONFLICT (id) DO NOTHING');
    expect(tekst).toContain("'expense.document_requested'");
    expect(tekst).toContain("'expense.document_request_resolved'");
    expect(tekst).toMatch(/AND c\.tenant_id = v_tenant\s+FOR UPDATE OF c;/);
    expect(tekst).toContain('SET resolved_at = v_resolved_at');
  });
});

describe('rodzaje dzwonka: lista w kodzie i CHECK z ostatniej migracji', () => {
  it('APP_NOTIFICATION_KINDS to dokładnie rodzaje z ostatniej definicji app_notifications_kind_check', () => {
    // Kto dopisuje kolejny rodzaj, bierze pełną listę z ostatniej migracji: inaczej ADD CONSTRAINT zgubi rodzaje innego PR.
    expect([...APP_NOTIFICATION_KINDS].sort()).toEqual(kindsFromMigrations().sort());
    expect(APP_NOTIFICATION_KINDS).toEqual(expect.arrayContaining(['expense_comment', 'expense_document_request']));
  });
});
