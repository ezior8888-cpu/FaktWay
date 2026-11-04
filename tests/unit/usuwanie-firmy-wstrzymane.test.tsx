import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Przegląd prawny 15.10.2026: „Usuń firmę” wołało `requestAccountDeletionAction`,
// które ustawiało `tenants.deleted_at`, `hard_delete_at` (+30 dni)
// i `is_active = false`, po czym wylogowywało właściciela. Tych kolumn nie
// sprawdza logowanie, RLS (`is_member_of`, `get_current_tenant_id`) ani żaden
// job, a subskrypcji Stripe nikt nie anulował — firma działała dalej,
// abonament się pobierał, a ekran logowania obiecywał „konto zostanie trwale
// usunięte (30 dni)”. #271 zamienił akcję w odmowę z adresem pomocy, ale
// formularz dalej kazał wpisać NIP i kliknąć przycisk, który zawsze odmawiał.
// Od 22.10.2026 na `/settings/account` jest sama instrukcja i link `mailto:`
// do pomocy z NIP w temacie, bez formularza i bez akcji serwera.

const mocks = vi.hoisted(() => ({
  getPageContext: vi.fn(), getActiveGdprRequest: vi.fn(), from: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: mocks.getPageContext }));
vi.mock('@/lib/gdpr/deletion', () => ({ getActiveGdprRequest: mocks.getActiveGdprRequest }));
vi.mock('@/app/(dashboard)/settings/account/actions', () => ({
  requestGdprDeletionAction: vi.fn(), cancelOwnGdprDeletionAction: vi.fn(),
}));
vi.mock('@/app/(auth)/login/actions', () => ({ loginWithEmail: vi.fn(), loginWithGoogle: vi.fn() }));
vi.mock('@/components/auth/turnstile-widget', () => ({ TurnstileWidget: () => null }));

import LoginPage from '@/app/(auth)/login/page';
import AccountSettingsPage from '@/app/(dashboard)/settings/account/page';
import { settingsTabsForRole } from '@/components/settings/finora/settings-tabs';
import { SUPPORT_EMAIL } from '@/lib/site';

const TENANT_NIP = '1234567890';

/** Atrapa odczytu NIP firmy: `from('tenants').select('nip').eq(…).maybeSingle()`. */
function tenantsChain(nip: string | null) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: { nip }, error: null })),
  };
  return chain;
}

function setContext(role: 'owner' | 'admin' | 'member' | 'accountant', nip: string | null = TENANT_NIP) {
  mocks.from.mockImplementation(() => tenantsChain(nip));
  mocks.getPageContext.mockResolvedValue({
    supabase: { from: mocks.from },
    tenantId: '00000000-0000-4000-8000-000000000001',
    user: { id: '00000000-0000-4000-8000-000000000002' },
    role,
  });
}

async function renderAccountPage() {
  return renderToStaticMarkup(await AccountSettingsPage());
}

/** Atrybut `href` linku `mailto:` tak, jak trafia do HTML (`&` jako `&amp;`). */
function mailtoHref(subject: string) {
  return `href="mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}"`;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getActiveGdprRequest.mockResolvedValue(null);
});

describe('usuwanie firmy przez pomoc techniczną — instrukcja i link, bez formularza', () => {
  it('właściciel: instrukcja z adresem pomocy i link mailto z NIP w temacie', async () => {
    setContext('owner');
    const html = await renderAccountPage();

    expect(html).toContain('Usuń organizację (firmę)');
    expect(html).toContain('przez pomoc techniczną');
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain(mailtoHref(`Usunięcie firmy, NIP ${TENANT_NIP}`));
    expect(html).toContain('Napisz do pomocy');
  });

  it('właściciel: bez pola NIP i przycisku, który tylko odmawiał', async () => {
    setContext('owner');
    const html = await renderAccountPage();

    // Kontrola, że strona się wyrenderowała (strażnik nie przechodzi na pustym HTML).
    expect(html).toContain('Twoje dane (RODO)');
    expect(html).not.toContain('nipConfirm');
    expect(html).not.toContain('Wpisz NIP firmy');
    expect(html).not.toContain('Usuń firmę');
    expect(html).not.toContain('Przetwarzanie');
  });

  it('NIP z separatorami trafia do tematu jako same cyfry; firma bez NIP — temat bez numeru', async () => {
    setContext('owner', '123-456-78-90');
    expect(await renderAccountPage()).toContain(mailtoHref(`Usunięcie firmy, NIP ${TENANT_NIP}`));

    setContext('owner', null);
    const html = await renderAccountPage();
    expect(html).toContain(mailtoHref('Usunięcie firmy'));
    expect(html).not.toContain('NIP%20');
  });

  it.each(['admin', 'member', 'accountant'] as const)(
    '%s: „Tylko właściciel…”, bez linku do zlecenia usunięcia',
    async (role) => {
      setContext(role);
      const html = await renderAccountPage();

      expect(html).toContain('Usuń organizację (firmę)');
      expect(html).toContain('Tylko właściciel konta może zlecić usunięcie firmy.');
      expect(html).not.toContain('mailto:');
      expect(html).not.toContain('Napisz do pomocy');
    },
  );

  it('ekran logowania nie obiecuje usunięcia konta ani firmy po „okresie retencji”', async () => {
    const html = renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({ success: 'account_deleted' }) }),
    );

    // Kontrola, że strona się wyrenderowała (strażnik nie przechodzi na pustym HTML).
    expect(html).toContain('Zaloguj się');
    expect(html).not.toContain('trwale usunięte');
    expect(html).not.toContain('okresu retencji');
    expect(html).not.toContain('żądanie usunięcia firmy');
  });

  // Regulamin (§ 14), pomoc i ta instrukcja odsyłają do „Ustawienia → Konto
  // i dane (RODO)”: tam jest usunięcie konta i informacja o usunięciu firmy.
  // Od planu Finora (P14) nawigacja ustawień to zakładki liczone z roli
  // w layoucie — zakładka musi być w każdej roli.
  it.each(['member', 'admin', 'owner', 'accountant'] as const)(
    'zakładki ustawień (%s) prowadzą do „Konto i dane (RODO)”',
    (role) => {
      const tab = settingsTabsForRole(role).find((t) => t.href === '/settings/account');
      expect(tab?.label).toBe('Konto i dane (RODO)');
    },
  );
});
