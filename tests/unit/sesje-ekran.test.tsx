import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountLoginView, AccountSessionView } from '@/lib/auth/sessions/view';

/**
 * Ekran kroku 8.5 w Ustawieniach → Bezpieczeństwo: zalogowane urządzenia
 * i historia logowań. Strona jest prawdziwa; atrapą są klient Supabase (RPC
 * z 00174), kontrola 2FA, użytkownik szkieletu i lista urządzeń biometrii.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  mfaState: vi.fn(),
  user: vi.fn(),
  passkeys: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc: h.rpc }) }));
vi.mock('@/lib/auth/verified-mfa', () => ({ getVerifiedMfaState: h.mfaState }));
vi.mock('@/lib/dashboard-shell-data', () => ({ getDashboardSessionUser: h.user }));
vi.mock('@/lib/auth/passkey/devices', () => ({ listPasskeyDevices: h.passkeys }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
// Karty hasła i 2FA bez zmian w tym kroku; ich akcje mają własne testy.
vi.mock('@/app/(dashboard)/settings/security/actions', () => ({
  enrollTotpAction: vi.fn(), unenrollTotpAction: vi.fn(), verifyTotpEnrollmentAction: vi.fn(),
  changePasswordAction: vi.fn(), requestPasswordChangeNonceAction: vi.fn(),
}));

const { SessionsCard } = await import('@/app/(dashboard)/settings/security/_components/sessions-card');
const { LoginHistoryCard } = await import('@/app/(dashboard)/settings/security/_components/login-history-card');
const { default: SecuritySettingsPage } = await import('@/app/(dashboard)/settings/security/page');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CURRENT = '5b7e2d1c-3f4a-4b6c-8d9e-0f1a2b3c4d5e';
const OTHER = '6c8f3e2d-4a5b-4c7d-9e0f-1a2b3c4d5e6f';

const current: AccountSessionView = {
  id: CURRENT, isCurrent: true, kind: 'computer', device: 'Mac (Chrome)', ip: '83.21.104.x',
  method: 'hasło', signedInAt: '08.11.2026, 14:05', lastActiveAt: '08.11.2026, 15:40',
};
const other: AccountSessionView = {
  id: OTHER, isCurrent: false, kind: 'phone', device: 'iPhone (Safari)', ip: null,
  method: null, signedInAt: '01.11.2026, 09:00', lastActiveAt: '07.11.2026, 20:15',
};
const login: AccountLoginView = {
  key: '0:2026-11-08T13:05:00+00:00', when: '08.11.2026, 14:05', kind: 'computer', device: 'Mac (Chrome)',
  ip: '83.21.104.x', method: 'hasło', status: 'current',
};

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  vi.resetAllMocks();
  h.user.mockResolvedValue({ id: '0d5c6a1e-6a8b-4c55-9e0e-2f4b1a7c3d10', factors: [] });
  h.passkeys.mockResolvedValue([]);
  h.mfaState.mockResolvedValue({ status: 'verified', user: { id: '0d5c6a1e-6a8b-4c55-9e0e-2f4b1a7c3d10' } });
});

describe('SessionsCard', () => {
  it('bieżące urządzenie oznaczone i bez „Wyloguj”; inne z „Wyloguj”; pod listą wylogowanie pozostałych', () => {
    const markup = renderToStaticMarkup(<SessionsCard initialSessions={[current, other]} state="ok" />);
    const plain = text(markup);
    expect(plain).toContain('Zalogowane urządzenia');
    expect(plain).toContain('To urządzenie · IP 83.21.104.x');
    expect(plain).toContain('Zalogowano: 08.11.2026, 14:05 (hasło) · Aktywne teraz');
    expect(plain).toContain('Adres nieznany');
    expect(plain).toContain('Ostatnia aktywność: 07.11.2026, 20:15');
    expect(markup).toContain('aria-label="Wyloguj iPhone (Safari)"');
    expect(markup).not.toContain('aria-label="Wyloguj Mac (Chrome)"');
    expect(markup.match(/data-testid="account-session"/g)).toHaveLength(2);
    expect(markup.indexOf('Wyloguj wszystkie inne urządzenia')).toBeGreaterThan(markup.lastIndexOf('data-testid="account-session"'));
    expect(plain).toContain('Wylogowane urządzenie traci dostęp przy następnym działaniu w FaktWay.');
  });

  it('tylko to urządzenie: bez wylogowania pozostałych', () => {
    const markup = renderToStaticMarkup(<SessionsCard initialSessions={[current]} state="ok" />);
    expect(markup).not.toContain('Wyloguj wszystkie inne urządzenia');
    expect(markup).not.toContain('>Wyloguj<');
  });

  it('wiersz działa w telefonie: kolumna, a obok siebie dopiero od sm', () => {
    const markup = renderToStaticMarkup(<SessionsCard initialSessions={[other]} state="ok" />);
    expect(markup).toContain('flex flex-col gap-3 border p-3 sm:flex-row sm:items-center sm:justify-between');
    expect(markup).toContain('min-h-[44px]');
  });

  it('bez kodu 2FA: przejście do kodu z powrotem na tę stronę', () => {
    const markup = renderToStaticMarkup(<SessionsCard initialSessions={[]} state="code_required" />);
    expect(markup).toContain('href="/login/two-factor?redirect=%2Fsettings%2Fsecurity&amp;potwierdzenie=1"');
    expect(text(markup)).toContain('Lista urządzeń i wylogowanie na odległość wymagają kodu');
  });

  it('bez kodu 2FA, gdy strona pokazuje przejście wyżej: samo zdanie, bez drugiego przycisku', () => {
    const markup = renderToStaticMarkup(<SessionsCard initialSessions={[]} state="code_required" stepUpShownAbove />);
    expect(markup).not.toContain('/login/two-factor');
    expect(text(markup)).toContain('Lista urządzeń pojawi się po potwierdzeniu kodem');
  });

  it('błąd odczytu: komunikat z tym, co zrobić', () => {
    const markup = renderToStaticMarkup(<SessionsCard initialSessions={[]} state="failed" />);
    expect(text(markup)).toContain('Nie udało się wczytać listy urządzeń. Odśwież stronę.');
  });
});

describe('LoginHistoryCard', () => {
  it('tabela od lg, wiersze w ramce poniżej: data, urządzenie, adres, sposób i stan', () => {
    const entries: AccountLoginView[] = [
      login,
      { ...login, key: '1:x', when: '01.11.2026, 09:00', device: 'iPhone (Safari)', ip: null, method: 'biometria', status: 'ended' },
    ];
    const markup = renderToStaticMarkup(<LoginHistoryCard entries={entries} state="ok" limit={20} />);
    expect(markup).toContain('class="hidden border lg:block"');
    expect(markup).toContain('class="flex flex-col gap-3 lg:hidden"');
    const plain = text(markup);
    expect(plain).toContain('Ostatnie logowania na to konto, najwyżej 20.');
    expect(plain).toContain('IP 83.21.104.x · To urządzenie');
    expect(plain).toContain('Adres nieznany · Zakończone');
    expect(plain).toContain('01.11.2026, 09:00 · biometria');
  });

  it('pusta historia: stan pusty Finory', () => {
    const markup = renderToStaticMarkup(<LoginHistoryCard entries={[]} state="ok" limit={20} />);
    expect(text(markup)).toContain('Brak zapisanych logowań.');
    expect(markup).not.toContain('<table');
  });

  it('bez kodu i po błędzie: zdanie zamiast tabeli', () => {
    expect(text(renderToStaticMarkup(<LoginHistoryCard entries={[]} state="code_required" limit={20} />)))
      .toContain('Historia logowań pojawi się po potwierdzeniu kodem');
    expect(text(renderToStaticMarkup(<LoginHistoryCard entries={[]} state="failed" limit={20} />)))
      .toContain('Nie udało się wczytać historii logowań. Odśwież stronę.');
  });
});

describe('strona Bezpieczeństwo', () => {
  const sessionRow = {
    session_id: CURRENT, is_current: true, signed_in_at: '2026-11-08T13:05:00+00:00',
    last_active_at: '2026-11-08T14:40:00+00:00', login_method: 'password', user_agent: IPHONE,
    ip_prefix: '83.21.104.0/24', device_source: 'login',
  };
  const loginRow = {
    signed_in_at: '2026-11-08T13:05:00+00:00', action: 'auth.login', login_method: 'password',
    user_agent: IPHONE, ip_prefix: '83.21.104.0/24', session_id: CURRENT, is_current: true, is_active: true,
  };

  it('czyta urządzenia i 20 ostatnich logowań funkcjami 00174 i pokazuje je pod biometrią', async () => {
    h.rpc.mockImplementation(async (fn: string) => ({
      data: fn === 'list_account_sessions' ? [sessionRow] : [loginRow],
      error: null,
    }));
    const markup = renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
    expect(h.rpc).toHaveBeenCalledWith('list_account_sessions');
    expect(h.rpc).toHaveBeenCalledWith('list_account_logins', { p_limit: 20 });
    const plain = text(markup);
    expect(plain).toContain('iPhone (Safari)');
    expect(plain).toContain('To urządzenie · IP 83.21.104.x');
    expect(markup).not.toContain('83.21.104.0');
    expect(markup.indexOf('Logowanie biometrią')).toBeLessThan(markup.indexOf('Zalogowane urządzenia'));
    expect(markup.indexOf('Zalogowane urządzenia')).toBeLessThan(markup.indexOf('Historia logowań'));
  });

  it('sesja po biometrii na koncie z 2FA: bez zapytań skazanych na odmowę, przejście do kodu u góry strony', async () => {
    h.mfaState.mockResolvedValue({ status: 'challenge_required', user: { id: 'u' } });
    const markup = renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
    expect(h.rpc).not.toHaveBeenCalled();
    expect(text(markup)).toContain('Lista urządzeń pojawi się po potwierdzeniu kodem');
    expect(text(markup)).toContain('Historia logowań pojawi się po potwierdzeniu kodem');
    expect(markup).toContain('/login/two-factor');
  });

  it('baza bez 00174 albo awaria: strona się renderuje z komunikatem', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const markup = renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
    expect(text(markup)).toContain('Nie udało się wczytać listy urządzeń. Odśwież stronę.');
    expect(text(markup)).toContain('Nie udało się wczytać historii logowań. Odśwież stronę.');
  });

  it('odmowa bazy code_step_required (np. sprawdzenie 2FA niedostępne): przejście do kodu w karcie', async () => {
    h.mfaState.mockRejectedValue(new Error('mfa_claims_invalid'));
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'code_step_required' } });
    const markup = renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
    expect(text(markup)).toContain('Lista urządzeń i wylogowanie na odległość wymagają kodu');
  });
});
