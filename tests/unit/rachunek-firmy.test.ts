import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 3.4, część 2: rachunek firmy w Ustawieniach (zakładka Firma,
 * `tenants.bank_account`, migracja 00183). Z niego plik przelewów zleca
 * przelewy (rachunek zleceniodawcy w rekordzie Elixir-0). Do tej zmiany
 * firma nie miała w ustawieniach żadnego rachunku.
 *
 * Prawdziwe: walidacja (ta sama w formularzu i akcji), akcja zapisu, odczyt.
 * Zastąpione: sesja, klient serwisowy, audyt, `revalidatePath`.
 */

const s = vi.hoisted(() => ({
  rola: 'owner',
  update: vi.fn(),
  bladZapisu: null as null | { code: string; message: string },
  przed: '45105010380000000000001234' as string | null,
  audit: vi.fn(async () => true),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: s.audit }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return {
    ActionAuthError,
    requireOrgRole: vi.fn(async (role: string[]) => {
      if (!role.includes(s.rola)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return { tenantId: 'org-a', user: { id: 'u-1' }, role: s.rola };
    }),
  };
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { bank_account: s.przed }, error: null }),
        update: (pola: unknown) => {
          s.update(pola);
          return { eq: async () => ({ error: s.bladZapisu }) };
        },
      };
      return b;
    },
  }),
}));

const RACHUNEK = '45105010380000000000001234';

beforeEach(() => {
  s.rola = 'owner';
  s.update.mockReset();
  s.bladZapisu = null;
  s.audit.mockReset();
});

describe('rachunek firmy: walidacja', () => {
  it('26 cyfr NRB z poprawną liczbą kontrolną; „PL”, spacje i kreski zdjęte; puste pole to brak rachunku', async () => {
    const { normalizujRachunekFirmy } = await import('@/lib/expenses/rachunek-firmy');
    expect(normalizujRachunekFirmy('PL 45 1050 1038 0000 0000 0000 1234')).toBe(RACHUNEK);
    expect(normalizujRachunekFirmy('45-1050-1038-0000-0000-0000-1234')).toBe(RACHUNEK);
    expect(normalizujRachunekFirmy('  ')).toBeNull();
    expect(() => normalizujRachunekFirmy(RACHUNEK.slice(1))).toThrow(/26 cyfr/);
    expect(() => normalizujRachunekFirmy(`${RACHUNEK.slice(0, 25)}5`)).toThrow(/cyfr kontrolnych/);
    expect(() => normalizujRachunekFirmy('DE89370400440532013000')).toThrow(/polski/);
  });
});

describe('rachunek firmy: zapis', () => {
  it('właściciel zapisuje 26 cyfr kluczem serwisowym po sprawdzeniu roli; zmiana trafia do audytu', async () => {
    s.przed = null;
    const { updateCompanyBankAccountAction } = await import('@/app/actions/company-bank-account');
    await expect(updateCompanyBankAccountAction('PL45 1050 1038 0000 0000 0000 1234')).resolves.toEqual({ success: true, rachunek: RACHUNEK });
    expect(s.update).toHaveBeenCalledWith({ bank_account: RACHUNEK });
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tenant.updated',
      metadata: { field: 'bank_account', from: null, to: RACHUNEK },
    }));
  });

  it('członek zespołu i księgowa nie zmieniają rachunku firmy', async () => {
    const { updateCompanyBankAccountAction } = await import('@/app/actions/company-bank-account');
    for (const rola of ['member', 'accountant']) {
      s.rola = rola;
      await expect(updateCompanyBankAccountAction(RACHUNEK)).resolves.toMatchObject({ success: false });
    }
    expect(s.update).not.toHaveBeenCalled();
  });

  it('zły numer: odmowa bez zapisu; przed migracją 00183: komunikat o aktualizacji bazy', async () => {
    const { updateCompanyBankAccountAction } = await import('@/app/actions/company-bank-account');
    await expect(updateCompanyBankAccountAction('123')).resolves.toMatchObject({ success: false, error: expect.stringMatching(/26 cyfr/) });
    expect(s.update).not.toHaveBeenCalled();
    s.bladZapisu = { code: 'PGRST204', message: 'Could not find the bank_account column' };
    await expect(updateCompanyBankAccountAction(RACHUNEK)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/aktualizację bazy/),
    });
  });
});

describe('rachunek firmy: odczyt i migracja', () => {
  const klient = (wynik: { data: unknown; error: unknown }) =>
    ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => wynik }) }) }) }) as never;

  it('brak kolumny (przed 00183) to brak rachunku; zapisany zły numer to brak rachunku; inny błąd rzuca', async () => {
    const { readTenantBankAccount } = await import('@/lib/expenses/rachunek-firmy');
    await expect(readTenantBankAccount(klient({ data: { bank_account: RACHUNEK }, error: null }), 'org-a')).resolves.toBe(RACHUNEK);
    await expect(readTenantBankAccount(klient({ data: null, error: { code: '42703', message: 'x' } }), 'org-a')).resolves.toBeNull();
    await expect(readTenantBankAccount(klient({ data: { bank_account: '123' }, error: null }), 'org-a')).resolves.toBeNull();
    await expect(readTenantBankAccount(klient({ data: null, error: { code: '57014', message: 'timeout' } }), 'org-a')).rejects.toThrow();
  });

  it('00183: kolumna NULL z CHECK na 26 cyfr, jawny GRANT SELECT, nagłówek „przed wdrożeniem”, bez DROP kolumn', () => {
    const sql = readFileSync('supabase/migrations/00183_tenant_bank_account.sql', 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS bank_account TEXT;/);
    expect(sql).toMatch(/CHECK \(bank_account IS NULL OR bank_account ~ '\^\[0-9\]\{26\}\$'\)/);
    expect(sql).toContain('GRANT SELECT (bank_account) ON public.tenants TO authenticated;');
    expect(sql).toMatch(/PRZED wdrożeniem/);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
