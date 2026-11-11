import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Tekst migracji 00195 (uprawnienia biura rachunkowego w KSeF, krok 6.2,
 * część 4). Zachowanie na prawdziwej bazie sprawdza
 * `tests/rls-uprawnienia-ksef.test.ts` w jobie CI „RLS isolation”; ten plik
 * pilnuje lokalnie, bez bazy, granic, których test na bazie nie zobaczy przy
 * zmianie kolejności w pliku: nagłówka, RLS, uprawnień i kontroli roli przed
 * każdym zapisem.
 */

const PLIK = join(process.cwd(), 'supabase/migrations/00195_ksef_permission_grants.sql');
const sql = existsSync(PLIK) ? readFileSync(PLIK, 'utf8') : '';
const bezKomentarzy = sql.replace(/--[^\n]*/g, '');
const pozaCialami = bezKomentarzy.replace(/\$\$[\s\S]*?\$\$/g, '');

/** Ciało funkcji `public.<nazwa>(…)` między `$$`. */
function cialo(nazwa: string): string {
  const start = bezKomentarzy.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${nazwa}\\(`));
  expect(start, nazwa).toBeGreaterThan(-1);
  const od = bezKomentarzy.indexOf('$$', start);
  const doKonca = bezKomentarzy.indexOf('$$', od + 2);
  return bezKomentarzy.slice(od + 2, doKonca);
}

const RPC = [
  'claim_ksef_permission_grant',
  'claim_ksef_permission_revoke',
  'finish_ksef_permission_attempt',
  'record_ksef_permission_check',
] as const;

describe('00195: nagłówek i operacje przy wgraniu', () => {
  it('plik istnieje i mówi, że wgrywa się go PRZED wdrożeniem', () => {
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.split('\n').slice(0, 40).join('\n')).toMatch(/PRZED wdrożeniem/);
  });

  it('bez DROP tabel i kolumn, bez TRUNCATE, DELETE i UPDATE poza ciałami funkcji', () => {
    expect(pozaCialami).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+public\./i);
  });

  it('PostgREST przeładowuje schemat na końcu', () => {
    expect(pozaCialami).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });
});

describe('00195: tabela, RLS i uprawnienia', () => {
  it('jeden wiersz na biuro w firmie i środowisku KSeF (UNIQUE)', () => {
    expect(pozaCialami).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON public\.ksef_permission_grants \(tenant_id, ksef_environment, subject_nip\)/);
  });

  it('RLS włączony; odczyt tylko właściciela aktywnej firmy', () => {
    expect(pozaCialami).toContain('ALTER TABLE public.ksef_permission_grants ENABLE ROW LEVEL SECURITY;');
    expect(pozaCialami).toMatch(/FOR SELECT\s+TO authenticated\s+USING \(\s*tenant_id = public\.get_current_tenant_id\(\)\s+AND public\.has_org_role\(tenant_id, 'owner'\)\s*\)/);
    expect(pozaCialami).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)\b/);
  });

  it('sesja bez INSERT, UPDATE i DELETE oraz bez kolumny żetonu próby; serwis pełny dostęp', () => {
    expect(pozaCialami).toContain('REVOKE ALL ON public.ksef_permission_grants FROM PUBLIC, anon, authenticated, service_role;');
    const grant = /GRANT SELECT \(([^)]+)\)\s+ON public\.ksef_permission_grants TO authenticated;/.exec(pozaCialami);
    expect(grant).not.toBeNull();
    const kolumny = grant![1]!.split(',').map((k) => k.trim());
    expect(kolumny).not.toContain('attempt');
    expect(kolumny).toEqual(expect.arrayContaining(['id', 'tenant_id', 'subject_nip', 'subject_name', 'scopes', 'status', 'operation_references']));
    expect(pozaCialami).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.ksef_permission_grants TO service_role;');
  });

  it('wyzwalacz przejść stanów działa także przy kluczu serwisowym (BEFORE UPDATE)', () => {
    expect(pozaCialami).toMatch(/CREATE TRIGGER \w+\s+BEFORE UPDATE ON public\.ksef_permission_grants\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.guard_ksef_permission_grant\(\);/);
    expect(pozaCialami).toContain('REVOKE ALL ON FUNCTION public.guard_ksef_permission_grant() FROM PUBLIC, anon, authenticated;');
  });

  it.each(RPC)('%s: SECURITY DEFINER, pusta ścieżka, EXECUTE tylko dla authenticated', (nazwa) => {
    const naglowek = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${nazwa}\\([\\s\\S]*?\\)\\s+RETURNS jsonb\\s+LANGUAGE plpgsql\\s+SECURITY DEFINER\\s+SET search_path = ''`);
    expect(bezKomentarzy).toMatch(naglowek);
    expect(pozaCialami).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${nazwa}\\([^)]*\\) FROM PUBLIC, anon, authenticated, service_role;`));
    expect(pozaCialami).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${nazwa}\\([^)]*\\) TO authenticated;`));
  });
});

describe('00195: kontrola roli przed każdym zapisem', () => {
  it.each(RPC)('%s: sesja, aktywna firma i rola właściciela (42501) przed dotknięciem tabeli', (nazwa) => {
    // Od BEGIN: deklaracje zmiennych nie są wykonaniem.
    const caleCialo = cialo(nazwa);
    const c = caleCialo.slice(caleCialo.search(/\bBEGIN\b/));
    const sesja = c.indexOf('auth.uid() IS NULL');
    const firma = c.indexOf('public.get_current_tenant_id()');
    const rola = c.search(/IF NOT public\.has_org_role\(v_tenant_id, 'owner'\) THEN\s+RAISE EXCEPTION [^;]+USING ERRCODE = '42501'/);
    const tabela = c.indexOf('public.ksef_permission_grants');
    expect(sesja, nazwa).toBeGreaterThan(-1);
    expect(firma, nazwa).toBeGreaterThan(sesja);
    expect(rola, nazwa).toBeGreaterThan(firma);
    expect(tabela, nazwa).toBeGreaterThan(rola);
    // Administrator nie nadaje uprawnień w KSeF: tylko właściciel.
    expect(c, nazwa).not.toMatch(/has_org_role\(v_tenant_id, 'admin'\)/);
  });

  it.each(RPC)('%s: każdy odczyt wiersza tylko w aktywnej firmie (tenant_id = v_tenant_id)', (nazwa) => {
    const c = cialo(nazwa);
    const odczyty = [...c.matchAll(/FROM public\.ksef_permission_grants\b([\s\S]*?)(?:FOR UPDATE|;)/g)];
    if (nazwa !== 'claim_ksef_permission_grant') expect(odczyty.length, nazwa).toBeGreaterThan(0);
    for (const [, warunek] of odczyty) expect(warunek, nazwa).toMatch(/tenant_id = v_tenant_id/);
  });

  it('nadanie wymaga kroku kodu (code_step_required), odebranie nie', () => {
    expect(cialo('claim_ksef_permission_grant')).toMatch(/IF NOT public\.session_may_grant_access\(\) THEN\s+RAISE EXCEPTION 'code_step_required' USING ERRCODE = '42501'/);
    expect(cialo('claim_ksef_permission_revoke')).not.toContain('session_may_grant_access');
  });

  it('nadanie sprawdza sumę kontrolną NIP-u biura i odmawia NIP-u własnej firmy', () => {
    const c = cialo('claim_ksef_permission_grant');
    expect(c).toMatch(/ARRAY\[6, 5, 7, 2, 3, 4, 5, 6, 7\]/);
    expect(c).toContain("'own_nip'");
    expect(c).toContain("'invalid_nip'");
  });

  it('nadanie bez drugiej próby: nadane, w toku w KSeF, odbieranie i świeża próba nie dostają żetonu', () => {
    const c = cialo('claim_ksef_permission_grant');
    const przejecie = c.indexOf("RETURN jsonb_build_object('status', 'claimed', 'id', v_row.id");
    const odmowy = [
      /IF v_row\.status IN \('granted', 'revoke_failed'\) THEN\s+RETURN jsonb_build_object\('status', 'already_granted'/,
      /IF v_row\.status = 'grant_in_progress' THEN\s+RETURN jsonb_build_object\('status', 'awaiting_ksef'/,
      /IF v_row\.status IN \('revoke_pending', 'revoke_in_progress'\) THEN\s+RETURN jsonb_build_object\('status', 'revoke_in_progress'/,
      /IF v_row\.status = 'grant_pending' AND v_row\.claimed_at > now\(\) - interval '5 minutes' THEN\s+RETURN jsonb_build_object\('status', 'in_progress'/,
    ];
    expect(przejecie).toBeGreaterThan(-1);
    for (const odmowa of odmowy) {
      const miejsce = c.search(odmowa);
      expect(miejsce, String(odmowa)).toBeGreaterThan(-1);
      // Każda odmowa stoi przed przejęciem wiersza nową próbą.
      expect(miejsce, String(odmowa)).toBeLessThan(przejecie);
    }
  });

  it('zapis wyniku tylko bieżącej próby (żeton) i sprawdzenie tylko tej samej operacji (numery)', () => {
    expect(cialo('finish_ksef_permission_attempt')).toMatch(/v_row\.attempt <> p_attempt/);
    expect(cialo('finish_ksef_permission_attempt')).toContain("'stale_attempt'");
    expect(cialo('record_ksef_permission_check')).toMatch(/p_references IS DISTINCT FROM v_row\.operation_references/);
    expect(cialo('record_ksef_permission_check')).toContain("'stale_check'");
  });

  it('audyt w tej samej transakcji co zmiana stanu', () => {
    for (const nazwa of ['finish_ksef_permission_attempt', 'record_ksef_permission_check'] as const) {
      expect(cialo(nazwa), nazwa).toMatch(/INSERT INTO public\.audit_logs/);
    }
    for (const akcja of [
      'accountant.ksef_permission_grant_sent',
      'accountant.ksef_permission_granted',
      'accountant.ksef_permission_grant_failed',
      'accountant.ksef_permission_revoke_sent',
      'accountant.ksef_permission_revoked',
      'accountant.ksef_permission_revoke_failed',
    ]) {
      expect(bezKomentarzy).toContain(`'${akcja}'`);
    }
  });
});
