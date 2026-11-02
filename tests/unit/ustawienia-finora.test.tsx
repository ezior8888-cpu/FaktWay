import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ustawienia = strona Settings szablonu Finora (plan P14, etap E10a):
 * ramka z zakładkami-linkami liczonymi z roli, zakładki z sekcjami Finory.
 * Podstawiamy tylko router Next, kontekst strony (sesja + rola) i akcje
 * serwerowe (`'use server'` ciągną backend). Komponenty renderujemy prawdziwe.
 */

const nav = vi.hoisted(() => ({ pathname: '/settings' }));
const ctx = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'admin' | 'member' | 'accountant',
  tenant: {} as Record<string, unknown>,
  user: null as Record<string, unknown> | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

function fakeSupabase() {
  const row = async () => ({ data: ctx.tenant, error: null });
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: row, single: row }) }),
    }),
    auth: { getUser: async () => ({ data: { user: ctx.user }, error: null }) },
  };
}

// Pełny użytkownik (tożsamości, dostawcy logowania) — ten sam odczyt co w
// `getPageContext`, z `cache()` na żądanie (sesja 9 planu skalowania).
vi.mock('@/lib/dashboard-shell-data', async (original) => ({
  ...(await original<typeof import('@/lib/dashboard-shell-data')>()),
  getDashboardSessionUser: async () => ctx.user,
}));

vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({
    supabase: fakeSupabase(),
    user: { id: 'user-fixture', email: 'jan@example.test' },
    tenantId: 'tenant-fixture',
    role: ctx.role,
  }),
}));

vi.mock('@/app/actions/cash-method', () => ({ updateCashMethodAction: vi.fn() }));
vi.mock('@/app/actions/vat-exemption', () => ({ updateVatExemptionAction: vi.fn() }));
vi.mock('@/app/actions/company-profile', () => ({ updateCompanyProfileAction: vi.fn() }));
vi.mock('@/app/actions/business-start', () => ({ updateBusinessStartAction: vi.fn() }));
vi.mock('@/components/settings/actions', () => ({ uploadCertificateAction: vi.fn() }));
vi.mock('@/components/onboarding/actions', () => ({ lookupNipAction: vi.fn() }));
vi.mock('@/app/actions/organizations', () => ({
  completeCompanyNipAction: vi.fn(),
  approveJoinRequestAction: vi.fn(),
  changeMembershipRoleAction: vi.fn(),
  denyJoinRequestAction: vi.fn(),
  inviteMemberAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
  revokeMembershipAction: vi.fn(),
}));
vi.mock('@/components/settings/accountant-actions', () => ({
  createAccountantTokenAction: vi.fn(),
  revokeAccountantTokenAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/settings/notifications/email-actions', () => ({ toggleEmailCategoryAction: vi.fn() }));

const { settingsTabsForRole, isSettingsTabActive } = await import('@/components/settings/finora/settings-tabs');
const { default: SettingsView } = await import('@/components/settings/finora/settings-view');
const { default: SettingsLayout } = await import('@/app/(dashboard)/settings/layout');
const { default: SettingsPage } = await import('@/app/(dashboard)/settings/page');
const { default: KsefSettingsPage } = await import('@/app/(dashboard)/settings/ksef/page');
const { AuditLog } = await import('@/app/(dashboard)/settings/audit/_components/audit-log');
const { AccountantAccessList } = await import('@/components/settings/accountant-list');
const { TeamManagement } = await import('@/components/team/team-management');
const { EmailPreferences } = await import('@/app/(dashboard)/settings/notifications/_components/email-preferences');
const { formatSettingsDate } = await import('@/components/settings/finora/format-date');

const hrefs = (role: Parameters<typeof settingsTabsForRole>[0]) => settingsTabsForRole(role).map((t) => t.href);

beforeEach(() => {
  nav.pathname = '/settings';
  ctx.role = 'owner';
  ctx.tenant = {};
  ctx.user = null;
});

describe('zakładki ustawień liczone z roli (jak dawne settings/page.tsx)', () => {
  it('właściciel widzi wszystkie zakładki w kolejności Finory, adresy bez zmian', () => {
    expect(settingsTabsForRole('owner')).toEqual([
      { href: '/settings', label: 'Firma' },
      { href: '/settings/security', label: 'Bezpieczeństwo' },
      { href: '/settings/notifications', label: 'Powiadomienia' },
      { href: '/settings/ksef', label: 'KSeF' },
      { href: '/settings/reminders', label: 'Przypomnienia' },
      { href: '/settings/accountant', label: 'Księgowa' },
      { href: '/settings/team', label: 'Zespół' },
      { href: '/settings/billing', label: 'Abonament' },
      { href: '/settings/flo', label: 'FLO' },
      { href: '/settings/audit', label: 'Dziennik zdarzeń' },
      { href: '/settings/account', label: 'Konto i dane (RODO)' },
    ]);
  });

  it('administrator: bez Przypomnień, z Zespołem i Abonamentem', () => {
    const list = hrefs('admin');
    expect(list).not.toContain('/settings/reminders');
    expect(list).toContain('/settings/team');
    expect(list).toContain('/settings/billing');
  });

  it.each(['member', 'accountant'] as const)('%s: bez Przypomnień, Zespołu i Abonamentu', (role) => {
    const list = hrefs(role);
    for (const hidden of ['/settings/reminders', '/settings/team', '/settings/billing']) {
      expect(list).not.toContain(hidden);
    }
    for (const visible of ['/settings', '/settings/security', '/settings/ksef', '/settings/flo', '/settings/account']) {
      expect(list).toContain(visible);
    }
  });

  it('aktywna zakładka: Firma tylko dokładnie na /settings, podstrony po prefiksie', () => {
    expect(isSettingsTabActive('/settings', '/settings')).toBe(true);
    expect(isSettingsTabActive('/settings/ksef', '/settings')).toBe(false);
    expect(isSettingsTabActive('/settings/ksef', '/settings/ksef')).toBe(true);
    expect(isSettingsTabActive('/settings/team/x', '/settings/team')).toBe(true);
    expect(isSettingsTabActive('/settings/teamx', '/settings/team')).toBe(false);
  });
});

describe('ramka ustawień (Finora views/settings/index.tsx)', () => {
  it('nagłówek, zakładki jako linki z aria-current, treść trasy po prawej', () => {
    nav.pathname = '/settings/security';
    const html = renderToStaticMarkup(
      <SettingsView tabs={settingsTabsForRole('owner')}>
        <p>Treść zakładki</p>
      </SettingsView>,
    );
    expect(html).toContain('<h1 class="text-lg font-semibold">Ustawienia</h1>');
    expect(html).toContain('aria-label="Ustawienia"');
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/settings\/security"|<a[^>]*href="\/settings\/security"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/<a[^>]*href="\/settings"[^>]*aria-current="page"/);
    expect(html).toContain('Treść zakładki');
    // Linki, nie przyciski (czytnik ekranu nie może czytać zakładek jako przycisków).
    expect(html).not.toMatch(/<a[^>]*role="button"/);
    // Układ Finory: zakładki po lewej od sm, menu w Sheet na telefonie.
    expect(html).toContain('hidden w-64 shrink-0 overflow-y-auto border-r sm:block');
    expect(html).toContain('aria-label="Otwórz menu ustawień"');
  });

  it('layout liczy zakładki z roli na serwerze', async () => {
    ctx.role = 'member';
    const html = renderToStaticMarkup(await SettingsLayout({ children: <p>x</p> }));
    expect(html).toContain('href="/settings/ksef"');
    expect(html).not.toContain('href="/settings/team"');
    expect(html).not.toContain('href="/settings/billing"');
    expect(html).not.toContain('href="/settings/reminders"');
  });
});

describe('zakładka Firma (Finora General)', () => {
  it('profil firmy, VAT, metoda kasowa i data rozpoczęcia; bez usuwania firmy i opcji General Finory', async () => {
    ctx.role = 'owner';
    ctx.tenant = {
      name: 'Firma Testowa',
      nip: '1234567890',
      address_json: { addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
      vat_exemption_basis: null,
      vat_cash_method: true,
      business_started_on: '2024-03-01',
    };
    const html = renderToStaticMarkup(await SettingsPage());
    for (const text of ['Dane firmy', '1234567890', 'Podatek VAT', 'Czynny podatnik VAT — metoda kasowa',
      'Moja firma jest zwolniona z VAT', 'Rozliczam VAT metodą kasową', 'Data rozpoczęcia działalności']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('id="data-rozpoczecia"');
    expect(html).toContain('value="Firma Testowa"');
    // Usunięcie firmy tylko w „Konto i dane”; z General wylatują język, waluta, strefa, rok obrotowy.
    for (const text of ['Niebezpieczna strefa', 'Usuń konto', 'Język', 'Waluta', 'Strefa czasowa', 'Rok obrotowy', 'Language']) {
      expect(html).not.toContain(text);
    }
  });

  it('członek bez uprawnień widzi dane bez formularzy', async () => {
    ctx.role = 'member';
    ctx.tenant = { name: 'Firma Testowa', nip: '1234567890', address_json: null };
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain('Informacje o aktywnej organizacji');
    expect(html).toContain('Firma Testowa');
    expect(html).not.toContain('Zapisz dane firmy');
    expect(html).toContain('Zmienić to może właściciel albo administrator firmy.');
  });
});

/**
 * Decyzja Bartosza 22.10.2026 — świadoma zmiana oczekiwań: blok „Magiczny
 * Import historii” z przyciskiem startu zastępuje „Historia faktur z KSeF”
 * (FaktWay pobiera historię sam) z linkiem „Zobacz postęp” do Importu danych.
 */
describe('zakładka KSeF (Finora Connected Accounts)', () => {
  it('połączenie z certyfikatem, historia faktur z KSeF i logowanie Google', async () => {
    ctx.tenant = { name: 'Firma', nip: '1234567890', has_ksef_credentials: true, ksef_certificate_expiry: '2027-03-01T00:00:00Z' };
    ctx.user = { identities: [{ provider: 'google' }], app_metadata: { providers: ['email', 'google'] } };
    const html = renderToStaticMarkup(await KsefSettingsPage());
    expect(html).toContain('Skonfigurowano połączenie');
    expect(html).toContain('Certyfikat ważny do: 01.03.2027');
    expect(html).toContain('Historia faktur z KSeF');
    expect(html).toContain(
      'Po wgraniu certyfikatu FaktWay sam pobiera z KSeF całą historię sprzedaży i zakupów, a potem na bieżąco faktury wystawione poza FaktWay. Pobieranie możesz wstrzymać w Imporcie danych.',
    );
    expect(html).toMatch(/href="\/import-danych"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Zobacz postęp<\/a>/);
    expect(html).not.toContain('Magiczny');
    expect(html).not.toContain('/onboarding/magic-import');
    expect(html).toContain('Logowanie przez Google');
    expect(html).toContain('Połączone');
  });

  it('bez certyfikatu: ostrzeżenie zamiast linku do postępu, Google niepołączony', async () => {
    ctx.tenant = { name: 'Firma', nip: '1234567890', has_ksef_credentials: false };
    ctx.user = { identities: [{ provider: 'email' }], app_metadata: { providers: ['email'] } };
    const html = renderToStaticMarkup(await KsefSettingsPage());
    expect(html).toContain('Brak certyfikatu');
    expect(html).toContain('najpierw wgraj certyfikat');
    expect(html).toContain('Historia faktur z KSeF');
    expect(html).not.toContain('Zobacz postęp');
    expect(html).not.toContain('Magiczny');
    expect(html).toContain('Niepołączone');
  });

  it('firma bez NIP-u: uzupełnienie NIP zamiast certyfikatu', async () => {
    ctx.tenant = { name: 'Szkic', nip: '' };
    const html = renderToStaticMarkup(await KsefSettingsPage());
    expect(html).toContain('Organizacja bez NIP-u');
    expect(html).toContain('id="complete-nip"');
    expect(html).not.toContain('Wgraj i zweryfikuj certyfikat');
  });

  it('członek nie wgra certyfikatu', async () => {
    ctx.role = 'member';
    ctx.tenant = { name: 'Firma', nip: '1234567890', has_ksef_credentials: false };
    const html = renderToStaticMarkup(await KsefSettingsPage());
    expect(html).toContain('Certyfikat KSeF może zmienić wyłącznie właściciel organizacji.');
    expect(html).not.toContain('Wgraj i zweryfikuj certyfikat');
  });
});

describe('Dziennik zdarzeń: tabela od lg, karty poniżej (plan §7.2)', () => {
  const entries = [
    { id: '1', when: '20.10.2026, 08:15', action: 'Zalogowanie', resource: '—', ip: '127.0.0.1' },
    { id: '2', when: '19.10.2026, 22:01', action: 'Wysłano fakturę do KSeF', resource: 'invoice:abcd1234…', ip: '—' },
  ];

  it('z danymi: te same wpisy w tabeli (lg) i w kartach (telefon)', () => {
    const html = renderToStaticMarkup(<AuditLog entries={entries} />);
    expect(html).toContain('2 wpisy (max. 200)');
    expect(html).toMatch(/class="hidden border lg:block"[^>]*data-testid="audit-table"/);
    expect(html).toMatch(/class="flex flex-col gap-3 lg:hidden"[^>]*data-testid="audit-cards"/);
    // Tabela: odznaka; karta: odznaka + jej `title` (ucięcie wielokropkiem, §7.2).
    expect(html.match(/Wysłano fakturę do KSeF/g)).toHaveLength(3);
    expect(html).toContain('invoice:abcd1234…');
    expect(html).not.toContain('Brak wpisów.');
  });

  it('pusty: stan pusty Finory, bez tabeli', () => {
    const html = renderToStaticMarkup(<AuditLog entries={[]} />);
    expect(html).toContain('Brak wpisów.');
    expect(html).toContain('0 wpisów');
    expect(html).not.toContain('<table');
  });
});

describe('przeniesione ekrany bez wyglądu prototypu (plan §9 pkt 5)', () => {
  const files = [
    'app/(dashboard)/settings/layout.tsx',
    'app/(dashboard)/settings/page.tsx',
    'app/(dashboard)/settings/security/page.tsx',
    'app/(dashboard)/settings/security/_components/password-change-card.tsx',
    'app/(dashboard)/settings/security/_components/two-factor-card.tsx',
    'app/(dashboard)/settings/notifications/page.tsx',
    'app/(dashboard)/settings/notifications/_components/email-preferences.tsx',
    'app/(dashboard)/settings/ksef/page.tsx',
    'app/(dashboard)/settings/reminders/page.tsx',
    'app/(dashboard)/settings/accountant/page.tsx',
    'app/(dashboard)/settings/team/page.tsx',
    'app/(dashboard)/settings/billing/page.tsx',
    'app/(dashboard)/settings/billing/_components/plan-cards.tsx',
    'app/(dashboard)/settings/billing/_components/portal-button.tsx',
    'app/(dashboard)/settings/audit/page.tsx',
    'app/(dashboard)/settings/audit/_components/audit-log.tsx',
    'app/(dashboard)/settings/account/page.tsx',
    'app/(dashboard)/settings/account/_components/gdpr-section.tsx',
    'components/settings/accountant-list.tsx',
    'components/settings/business-start-form.tsx',
    'components/settings/cash-method-form.tsx',
    'components/settings/certificate-upload.tsx',
    'components/settings/company-deletion.tsx',
    'components/settings/company-profile-form.tsx',
    'components/settings/complete-nip-form.tsx',
    'components/settings/tax-office-form.tsx',
    'components/settings/vat-exemption-form.tsx',
    'components/pwa/notifications-settings.tsx',
    'components/reminders/reminder-settings-form.tsx',
    'components/exports/co-pilot-settings-form.tsx',
    'components/team/team-management.tsx',
  ];

  it.each(files)('%s: bez szkła, tokenów --ff-* i lucide', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).not.toMatch(/rgba\(15,10,30|white\/55|backdrop-blur|ff-glass-pane|variant="glass|var\(--ff-|lucide-react/);
    expect(src).not.toMatch(/\$\d|images\/avatars/);
  });
});

describe('daty w ustawieniach (plan §7.1)', () => {
  it('DD.MM.RRRR w strefie Europe/Warsaw, pusta i błędna wartość jako —', () => {
    expect(formatSettingsDate('2027-03-01T00:00:00Z')).toBe('01.03.2027');
    // 23:30 UTC 31.12 to już 1.01 w Polsce.
    expect(formatSettingsDate('2026-12-31T23:30:00Z')).toBe('01.01.2027');
    expect(formatSettingsDate(null)).toBe('—');
    expect(formatSettingsDate('nie-data')).toBe('—');
  });
});

describe('Księgowa: dostępy jako wiersze Finory', () => {
  const access = {
    id: 'a1',
    accountant_name: 'Anna Kowalska',
    accountant_email: 'anna@biuro.example',
    access_level: 'download',
    expires_at: '2999-01-01T00:00:00Z',
    revoked_at: null,
    last_used_at: '2026-10-01T10:00:00Z',
    use_count: 2,
    created_at: '2026-09-01T10:00:00Z',
  };

  it('z danymi: nazwa, stan, poziom, liczebnik użyć, akcja odebrania; bez tabeli', () => {
    const html = renderToStaticMarkup(
      <AccountantAccessList
        accesses={[access, { ...access, id: 'a2', revoked_at: '2026-10-02T00:00:00Z', use_count: 5 }]}
      />,
    );
    expect(html).toContain('Anna Kowalska');
    expect(html).toContain('Aktywny');
    expect(html).toContain('Odebrany');
    expect(html).toContain('Pobieranie');
    expect(html).toContain('2 użycia');
    expect(html).toContain('5 użyć');
    expect(html).toContain('ostatnio 01.10.2026');
    expect(html).toContain('Aktywne tokeny: <span class="text-foreground font-medium">1</span>');
    expect(html.match(/>Odbierz</g)).toHaveLength(1);
    expect(html).not.toContain('<table');
  });

  it('pusty: stan pusty Finory i przycisk nowego dostępu', () => {
    const html = renderToStaticMarkup(<AccountantAccessList accesses={[]} />);
    expect(html).toContain('Brak udostępnionych dostępów');
    expect(html).toContain('Nowy dostęp');
  });
});

describe('Zespół: wiersze Finory', () => {
  const member = {
    membershipId: 'm1',
    userId: 'u1',
    email: 'jan@example.test',
    name: 'Jan',
    role: 'owner' as const,
    status: 'active',
    joinedAt: '2026-01-15T10:00:00Z',
    isYou: true,
  };

  it('członkowie, zaproszenia i prośby z datami DD.MM.RRRR', () => {
    const html = renderToStaticMarkup(
      <TeamManagement
        members={[member, { ...member, membershipId: 'm2', userId: 'u2', name: 'Ola', role: 'member', isYou: false }]}
        invitations={[
          { id: 'i1', email: 'nowy@example.test', role: 'admin', invitedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z' },
        ]}
        joinRequests={[
          { id: 'j1', userId: 'u3', email: 'prosi@example.test', name: 'Piotr', message: 'Dzień dobry', createdAt: '2026-10-02T00:00:00Z' },
        ]}
        currentRole="owner"
      />,
    );
    expect(html).toContain('Członkowie (2)');
    expect(html).toContain('Zaproszenia oczekujące (1)');
    expect(html).toContain('Prośby o dostęp (1)');
    expect(html).toContain('dołączył(a) 15.01.2026');
    expect(html).toContain('rola admin · wygasa 08.10.2026');
    expect(html).toContain('Akceptuj');
    expect(html).toContain('Zaproś nowego członka');
  });

  it('bez zaproszeń i próśb: tylko zaproszenie i członkowie', () => {
    const html = renderToStaticMarkup(
      <TeamManagement members={[member]} invitations={[]} joinRequests={[]} currentRole="admin" />,
    );
    expect(html).toContain('Członkowie (1)');
    expect(html).not.toContain('Zaproszenia oczekujące');
    expect(html).not.toContain('Prośby o dostęp');
  });
});

describe('Powiadomienia e-mail: przełączniki Finory', () => {
  it('kategoria transakcyjna zablokowana i włączona, wypisana kategoria wyłączona', () => {
    const html = renderToStaticMarkup(<EmailPreferences unsubscribedCategories={['marketing']} />);
    expect(html).toContain('Wymagane');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*id="email-category-transactional"[^>]*checked=""/);
    expect(html).toMatch(/<input(?![^>]*checked)[^>]*id="email-category-marketing"[^>]*>/);
    expect(html).toMatch(/<input[^>]*id="email-category-product_updates"[^>]*checked=""/);
  });

  it('bez wypisań: wszystkie kategorie włączone', () => {
    const html = renderToStaticMarkup(<EmailPreferences unsubscribedCategories={[]} />);
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(3);
  });
});

describe('dostępność ustawień (WCAG AA)', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('jasny motyw: tekst odznak i alertów bez green-600/amber-600 (kontrast < 4,5:1)', () => {
    const files = [
      'app/(dashboard)/settings/ksef/page.tsx',
      'app/(dashboard)/settings/billing/page.tsx',
      'app/(dashboard)/settings/billing/_components/plan-cards.tsx',
      'app/(dashboard)/settings/security/_components/two-factor-card.tsx',
      'app/(dashboard)/settings/security/_components/password-change-card.tsx',
      'app/(dashboard)/settings/account/_components/gdpr-section.tsx',
      'components/settings/accountant-list.tsx',
      'components/settings/complete-nip-form.tsx',
      'components/onboarding/form.tsx',
    ];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/(?<!dark:)text-(green|amber)-600/);
    }
  });

  it('aktywna zakładka: w jasnym motywie text-chart-3 (primary/15 daje 4,13:1)', () => {
    const src = read('components/settings/finora/settings-nav.tsx');
    expect(src).toContain('text-chart-3');
    // Ciemny motyw: accent-foreground (primary na primary/20–/30 to 3,4–5,0:1 — finora-kontrast-przeoczone).
    expect(src).toContain('dark:text-accent-foreground');
    expect(src).not.toMatch(/(?<!dark:)(?<!dark:hover:)(?<!-)\btext-primary\b/);
  });

  it('okno importu z pliku: pole pliku daje widoczny fokus strefie upuszczania', () => {
    const src = read('components/onboarding/file-import-dialog.tsx');
    expect(src).toMatch(/className="sr-only peer"|className="peer sr-only"/);
    expect(src).toContain('peer-focus-visible:ring');
  });
});
