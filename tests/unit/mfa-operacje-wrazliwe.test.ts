import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({
  flag: false,
  role: 'owner' as string | null,
  mfa: 'enrollment_required' as 'verified' | 'enrollment_required' | 'challenge_required',
  flagError: false,
}));

vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlagForExecution: async () => {
    if (s.flagError) throw new Error('baza');
    return s.flag;
  },
}));
vi.mock('@/lib/auth/verified-mfa', () => ({
  getVerifiedMfaState: async () => ({ status: s.mfa, user: { id: 'u-1' } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({}),
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: s.role ? { role: s.role } : null, error: null }),
      });
      return q;
    },
  }),
}));

import { assertSensitiveMfa, SensitiveMfaRequiredError } from '@/lib/auth/sensitive-mfa';

/**
 * AUD-65 (B10, B13): wysyłka do KSeF, certyfikat i płatności przez właściciela
 * albo admina wymagają drugiego kroku (AAL2) — za flagą globalną
 * `requireMfaForSensitive`, domyślnie wyłączoną, żeby włączenie nie odcięło
 * klientów bez MFA bez zapowiedzi.
 */

beforeEach(() => {
  s.flag = false;
  s.role = 'owner';
  s.mfa = 'enrollment_required';
  s.flagError = false;
});

const ctx = { tenantId: 't-1', userId: 'u-1' };

describe('MFA przy operacjach wrażliwych', () => {
  it('flaga wyłączona — bez zmian (właściciel bez MFA przechodzi)', async () => {
    await expect(assertSensitiveMfa(ctx, 'ksef_submit')).resolves.toBeUndefined();
  });

  it('flaga włączona — właściciel bez MFA zatrzymany z instrukcją', async () => {
    s.flag = true;
    await expect(assertSensitiveMfa(ctx, 'ksef_submit')).rejects.toBeInstanceOf(SensitiveMfaRequiredError);
    await expect(assertSensitiveMfa(ctx, 'ksef_submit')).rejects.toThrow(/dwuetapow/);
  });

  it('flaga włączona — admin po MFA przechodzi', async () => {
    s.flag = true;
    s.role = 'admin';
    s.mfa = 'verified';
    await expect(assertSensitiveMfa(ctx, 'certificate')).resolves.toBeUndefined();
  });

  it('flaga włączona — członek (nie owner/admin) bez MFA przechodzi (B10: pozostałe role opcjonalnie)', async () => {
    s.flag = true;
    s.role = 'member';
    await expect(assertSensitiveMfa(ctx, 'ksef_submit')).resolves.toBeUndefined();
  });

  it('błąd odczytu flagi — bez blokady (fail-open: to dodatkowa warstwa, nie wyłącznik)', async () => {
    s.flagError = true;
    await expect(assertSensitiveMfa(ctx, 'ksef_submit')).resolves.toBeUndefined();
  });

  // Logowanie biometrią (FW1): sesja AAL1 konta z 2FA wchodzi do panelu ze
  // znacznikiem. Do tej pory taka sesja nie docierała tu wcale, więc flaga
  // wyłączona nic nie ryzykowała. Teraz płatności i certyfikat muszą prosić
  // o prawdziwy kod także przy wyłączonej fladze.
  describe('sesja po logowaniu biometrią (challenge_required)', () => {
    beforeEach(() => { s.mfa = 'challenge_required'; });

    it.each(['billing', 'certificate'] as const)('%s: flaga wyłączona, a i tak prosi o kod', async (operation) => {
      await expect(assertSensitiveMfa(ctx, operation)).rejects.toMatchObject({
        name: 'SensitiveMfaRequiredError', reason: 'challenge',
      });
    });

    it('rola bez obowiązku MFA też podaje kod: konto ma 2FA, a sesja go nie potwierdziła', async () => {
      s.role = 'member';
      await expect(assertSensitiveMfa(ctx, 'billing')).rejects.toBeInstanceOf(SensitiveMfaRequiredError);
    });

    it('wysyłka do KSeF przy wyłączonej fladze przechodzi: biometria to dwa składniki', async () => {
      await expect(assertSensitiveMfa(ctx, 'ksef_submit')).resolves.toBeUndefined();
    });

    it('wysyłka do KSeF przy włączonej fladze prosi o kod, a komunikat mówi, gdzie go podać', async () => {
      s.flag = true;
      await expect(assertSensitiveMfa(ctx, 'ksef_submit')).rejects.toMatchObject({ reason: 'challenge' });
      await expect(assertSensitiveMfa(ctx, 'ksef_submit')).rejects.toThrow(/Bezpieczeństwo/);
      await expect(assertSensitiveMfa(ctx, 'ksef_submit')).rejects.not.toThrow(/Włącz ją/);
    });
  });

  it('flaga włączona, konto bez 2FA: powód to brak włączonego 2FA, nie kod', async () => {
    s.flag = true;
    await expect(assertSensitiveMfa(ctx, 'billing')).rejects.toMatchObject({ reason: 'enrollment' });
  });

  it('migracja: wiersz flagi wyłączony', () => {
    const sql = readFileSync('supabase/migrations/00108_flag_require_mfa_sensitive.sql', 'utf8');
    expect(sql).toMatch(/'requireMfaForSensitive',\s*false/);
    expect(sql).toContain('ON CONFLICT (flag) DO NOTHING');
  });
});
