import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje „Adres kalendarza” (krok 7.3): tworzenie i wymiana adresu oraz
 * usunięcie. Tylko właściciel i administrator, kod z drugiego składnika
 * przy sesji po biometrii, w bazie wyłącznie skrót tokenu, wpis w audycie.
 */

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  audit: vi.fn(),
  stepUp: vi.fn(),
  upsert: vi.fn(),
  del: vi.fn(),
  istnieje: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/auth/access-grant-mfa', () => ({ requireCodeForAccessGrant: mocks.stepUp }));
vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireOrgRole: mocks.requireOrgRole,
}));

import { ActionAuthError } from '@/lib/supabase/auth-context';
import { createCalendarFeedAction, deleteCalendarFeedAction } from '@/components/settings/calendar-feed-actions';

const TENANT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

function kontekst() {
  const supabase = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.istnieje }) }),
      upsert: mocks.upsert,
      delete: () => ({ eq: mocks.del }),
    }),
  };
  return { supabase, tenantId: TENANT, user: { id: USER }, role: 'owner' };
}

describe('createCalendarFeedAction', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.requireOrgRole.mockResolvedValue(kontekst());
    mocks.stepUp.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.del.mockResolvedValue({ error: null });
    mocks.istnieje.mockResolvedValue({ data: null, error: null });
  });

  it('odmawia, gdy rola nie pozwala (członek, księgowa)', async () => {
    mocks.requireOrgRole.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));
    const wynik = await createCalendarFeedAction();
    expect(wynik).toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin']);
  });

  it('wymaga kodu przy sesji po biometrii i niczego wtedy nie zapisuje', async () => {
    mocks.stepUp.mockResolvedValue({ success: false, error: 'Potrzebny kod', mfaStepUp: true });
    const wynik = await createCalendarFeedAction();
    expect(wynik).toMatchObject({ success: false, mfaStepUp: true });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('zapisuje tylko skrót, a adres z tokenem zwraca raz', async () => {
    const wynik = await createCalendarFeedAction();
    expect(wynik.success).toBe(true);
    if (!wynik.success) return;
    const token = /\/api\/kalendarz\/([A-Za-z0-9_-]{43})\.ics$/.exec(wynik.url)?.[1];
    expect(token).toBeDefined();
    const [wiersz, opcje] = mocks.upsert.mock.calls[0] as [Record<string, unknown>, { onConflict: string }];
    expect(wiersz.token_hash).toBe(createHash('sha256').update(token!).digest('hex'));
    expect(JSON.stringify(wiersz)).not.toContain(token!);
    expect(wiersz).toMatchObject({ tenant_id: TENANT, created_by: USER });
    expect(opcje.onConflict).toBe('tenant_id');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'calendar_feed.created', tenantId: TENANT, userId: USER }),
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token!);
  });

  it('wymiana istniejącego adresu to osobny wpis audytu, a nowy token różni się od poprzedniego', async () => {
    mocks.istnieje.mockResolvedValue({ data: { tenant_id: TENANT }, error: null });
    const a = await createCalendarFeedAction();
    const b = await createCalendarFeedAction();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'calendar_feed.regenerated' }));
    expect(a.success && b.success && a.url !== b.url).toBe(true);
  });

  it('błąd zapisu: komunikat, bez audytu i bez adresu', async () => {
    mocks.upsert.mockResolvedValue({ error: { message: 'x' } });
    const wynik = await createCalendarFeedAction();
    expect(wynik.success).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('deleteCalendarFeedAction', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.requireOrgRole.mockResolvedValue(kontekst());
    mocks.del.mockResolvedValue({ error: null });
  });

  it('usuwa adres firmy i zapisuje audyt', async () => {
    expect(await deleteCalendarFeedAction()).toEqual({ success: true });
    expect(mocks.del).toHaveBeenCalledWith('tenant_id', TENANT);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'calendar_feed.deleted' }));
  });

  it('odmawia bez uprawnień', async () => {
    mocks.requireOrgRole.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await deleteCalendarFeedAction()).toMatchObject({ success: false });
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
