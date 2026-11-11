import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Migracja 00193 (noty, krok 2.9 planu kompletnej aplikacji) jako tekst.
 * Zachowanie na bazie sprawdza tests/rls-noty.test.ts (job CI „RLS isolation”);
 * tu to, co da się sprawdzić bez bazy: kolejność wgrania, brak operacji
 * niszczących, RLS na obu tabelach z `tenant_id`, granty i funkcje
 * SECURITY DEFINER ze stałą ścieżką, wiersz w rejestrze numerów.
 */

const PATH = 'supabase/migrations/00193_accounting_notes.sql';
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

describe('migracja 00193: noty obciążeniowe i uznaniowe', () => {
  it('plik istnieje; nagłówek: PRZED wdrożeniem, addytywna', () => {
    expect(sql).not.toBe('');
    expect(sql).toMatch(/PRZED wdrożeniem/);
  });

  it('bez DROP tabel i kolumn, bez TRUNCATE i bez zmian danych poza ciałami funkcji', () => {
    expect(outsideBodies).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)/i);
  });

  it('RLS włączony na obu tabelach z tenant_id; polityki przez get_current_tenant_id()', () => {
    for (const table of ['accounting_notes', 'accounting_note_emails']) {
      expect(outsideBodies).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(outsideBodies).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
    }
    const policies = outsideBodies.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(5);
    for (const policy of policies) expect(policy).toMatch(/tenant_id = public\.get_current_tenant_id\(\)/);
  });

  it('zapis, zmiana i usunięcie przez klienta tylko dla szkicu; historia wysyłek bez zapisu z sesji', () => {
    const write = (outsideBodies.match(/CREATE POLICY "accounting_notes_(insert|update|delete)_draft"[\s\S]*?;/g) ?? []);
    expect(write).toHaveLength(3);
    for (const policy of write) expect(policy).toMatch(/status = 'draft'/);
    // UPDATE: szkic już w USING (wystawiona nota to zero wierszy, nie błąd) i w WITH CHECK.
    const update = write.find((policy) => policy.includes('_update_draft'))!;
    const using = /USING \(([\s\S]*?)\)\s*WITH CHECK \(([\s\S]*)\)/.exec(update);
    expect(using?.[1]).toMatch(/status = 'draft'/);
    expect(using?.[2]).toMatch(/status = 'draft'/);
    expect(outsideBodies).toContain('GRANT SELECT ON public.accounting_note_emails TO authenticated;');
    expect(outsideBodies).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.accounting_note_emails TO authenticated/);
  });

  it('stan, numer i wystawca poza grantami kolumnowymi klienta', () => {
    const grants = outsideBodies.match(/GRANT (INSERT|UPDATE) \(([^)]*)\)\s+ON public\.accounting_notes TO authenticated;/g) ?? [];
    expect(grants).toHaveLength(2);
    for (const grant of grants) {
      for (const column of ['status', 'number', 'number_year', 'number_seq', 'issuer', 'issued_at', 'issued_by', 'created_by']) {
        expect(grant, column).not.toMatch(new RegExp(`\\b${column}\\b`));
      }
    }
  });

  it.each([
    ['issue_accounting_note', 'issue_accounting_note(uuid)'],
    ['record_accounting_note_email', 'record_accounting_note_email(uuid, text, text, text)'],
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
    const text = body('issue_accounting_note');
    expect(text).toMatch(/FOR UPDATE/);
    expect(text).toMatch(/pg_advisory_xact_lock/);
    expect(text).toMatch(/'already_issued'/);
    expect(text).toMatch(/INSERT INTO public\.audit_logs/);
  });

  it('historia: raz na klucz (ON CONFLICT), audyt tylko przy nowym wpisie', () => {
    const text = body('record_accounting_note_email');
    expect(text).toMatch(/ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/);
    expect(text).toMatch(/'already_recorded'/);
    expect(text).toMatch(/INSERT INTO public\.audit_logs/);
  });

  it('wyzwalacz: wystawionej noty nie zmienia nikt (bez wyjątku dla roli)', () => {
    const text = body('guard_accounting_note_update');
    expect(text).toMatch(/OLD\.status = 'issued'/);
    expect(text).not.toMatch(/current_user/);
    expect(outsideBodies).toMatch(/CREATE TRIGGER \w+\s+BEFORE UPDATE ON public\.accounting_notes/);
  });

  it('rejestr numerów: 00193 zajęte w tym PR, „następny wolny” za nim', () => {
    const registry = readFileSync('docs/koordynacja/CLAUDE-DO-CODEXA.md', 'utf8');
    expect(registry).toMatch(/^\| 00193 \| Claude \(plan kompletnej aplikacji, krok 2\.9/m);
    // Bez numeru na sztywno: po kolejnych migracjach (gałąź zbiorcza, main) „następny wolny” rośnie.
    expect(Number(/^\| \*\*(\d{5})\*\* \| — \| następny wolny/m.exec(registry)?.[1])).toBeGreaterThan(193);
  });
});
