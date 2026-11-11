import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 00185 (krok 6.2, część 2, „Moi klienci”): tekst migracji. Zachowanie na
 * prawdziwej bazie sprawdza `tests/rls-moi-klienci.test.ts` (job CI „RLS
 * isolation”); tu to, czego test na bazie nie zobaczy: kształt funkcji,
 * uprawnienia i brak operacji niszczących.
 */

const PLIK = join(process.cwd(), 'supabase', 'migrations', '00185_my_organizations_summary.sql');
const sql = existsSync(PLIK) ? readFileSync(PLIK, 'utf8') : '';
/** Bez komentarzy: warunki liczą się w kodzie, nie w opisie. */
const kod = sql.replace(/--[^\n]*/g, '');

describe('00185: my_organizations_summary', () => {
  it('plik migracji istnieje', () => {
    expect(existsSync(PLIK)).toBe(true);
  });

  it('SECURITY DEFINER z pustym search_path, tylko odczyt', () => {
    expect(kod).toMatch(/CREATE OR REPLACE FUNCTION public\.my_organizations_summary\(p_ksef_environment text\)/);
    expect(kod).toMatch(/SECURITY DEFINER/);
    expect(kod).toMatch(/SET search_path = ''/);
    expect(kod).toMatch(/\bSTABLE\b/);
    expect(kod).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });

  it('firmy tylko z aktywnych członkostw auth.uid(), bez nagłówka aktywnej firmy', () => {
    expect(kod).toMatch(/m\.user_id = auth\.uid\(\)/);
    expect(kod).toMatch(/m\.status = 'active'/);
    expect(kod).not.toMatch(/get_current_tenant_id/);
    // Każda tabela z danymi firmy łączy się z listą firm użytkownika.
    for (const tabela of ['invoices', 'expenses']) {
      expect(kod).toMatch(new RegExp(`public\\.${tabela} AS \\w+\\s+JOIN firmy AS f ON f\\.org_id = \\w+\\.tenant_id`));
    }
  });

  it('zwraca tylko kolumny podsumowania', () => {
    const zwraca = /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/.exec(kod)?.[1] ?? '';
    const kolumny = zwraca
      .split(',')
      .map((c) => c.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(kolumny).toEqual([
      'organization_id',
      'name',
      'nip',
      'role',
      'expenses_to_review',
      'overdue_count',
      'overdue_grosze',
      'overdue_foreign_count',
      'unknown_environment_count',
      'has_ksef_credentials',
      'ksef_verified_at',
      'ksef_verified_environment',
      'ksef_certificate_expiry',
      'vat_exemption_basis',
      'ksiegowosc_enabled',
    ]);
    expect(zwraca).not.toMatch(/credentials_encrypted|buyer|email|token/i);
  });

  it('wykonanie tylko dla zalogowanego (AUD-30: odebrane też anon i service_role)', () => {
    expect(kod).toMatch(
      /REVOKE ALL ON FUNCTION public\.my_organizations_summary\(text\) FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(kod).toMatch(/GRANT EXECUTE ON FUNCTION public\.my_organizations_summary\(text\) TO authenticated;/);
  });

  it('należności po terminie z warunkami getReceivables i dniem w Polsce', () => {
    expect(kod).toMatch(/\(now\(\) AT TIME ZONE 'Europe\/Warsaw'\)::date/);
    expect(kod).toMatch(/i\.direction = 'outgoing'/);
    expect(kod).toMatch(/i\.origin = 'app'/);
    expect(kod).toMatch(/i\.ksef_status = 'accepted'/);
    expect(kod).toMatch(/i\.payment_status IN \('unpaid', 'partial', 'overdue'\)/);
    expect(kod).toMatch(/k\.ksef_environment = p_ksef_environment/);
    expect(kod).toMatch(/k\.invoice_kind = 'regular' AND k\.invoice_type IN \('VAT', 'UPR'\)/);
    expect(kod).toMatch(/k\.invoice_kind = 'advance' AND k\.invoice_type = 'ZAL'/);
    expect(kod).toMatch(/k\.invoice_kind = 'final' AND k\.invoice_type = 'ROZ'/);
    // ROZ: reszta po zaliczkach, ten sam wzór co wyzwalacz i widok 00145.
    expect(kod).toMatch(/\(k\.payment_data ->> 'amountDue'\) ~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'/);
    expect(kod).toMatch(/n\.payment_due_date < v_today/);
  });
});
