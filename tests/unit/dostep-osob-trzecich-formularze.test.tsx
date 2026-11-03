// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mfaStepUpHref } from '@/lib/auth/mfa-step-up';

/**
 * Odmowa „potrzebny kod” nie może zostać samym tekstem błędu (recenzja #359, pkt 1):
 * formularze zespołu i księgowej pokazują komunikat z przejściem na ekran kodu
 * i powrotem na tę samą stronę. Zwykła porażka dalej jest powiadomieniem.
 */

const mocks = vi.hoisted(() => ({
  invite: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  changeRole: vi.fn(),
  revokeMembership: vi.fn(),
  revokeInvitation: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children: React.ReactNode }) => <a {...p}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock('@/app/actions/organizations', () => ({
  inviteMemberAction: mocks.invite,
  approveJoinRequestAction: mocks.approve,
  denyJoinRequestAction: mocks.deny,
  changeMembershipRoleAction: mocks.changeRole,
  revokeMembershipAction: mocks.revokeMembership,
  revokeInvitationAction: mocks.revokeInvitation,
}));
vi.mock('@/components/settings/accountant-actions', () => ({
  createAccountantTokenAction: mocks.createToken,
  revokeAccountantTokenAction: mocks.revokeToken,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TeamManagement } = await import('@/components/team/team-management');
const { AccountantAccessList } = await import('@/components/settings/accountant-list');

const STEP_UP = (message: string) => ({ success: false, error: message, mfaStepUp: true });
const TEAM_HREF = mfaStepUpHref('/settings/team');
const ACCOUNTANT_HREF = mfaStepUpHref('/settings/accountant');

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
const notice = () => document.querySelector<HTMLElement>('[data-slot="mfa-step-up"]');
const noticeLink = () => notice()?.querySelector<HTMLAnchorElement>('a') ?? null;

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => { el.click(); });
  await settle();
}

function team() {
  return (
    <TeamManagement
      currentRole="owner"
      members={[
        { membershipId: 'm-1', userId: 'u-1', email: 'wlasciciel@example.test', name: 'Właściciel', role: 'owner', status: 'active', joinedAt: '2026-01-01T00:00:00Z', isYou: true },
        { membershipId: 'm-2', userId: 'u-2', email: 'czlonek@example.test', name: 'Członek', role: 'member', status: 'active', joinedAt: '2026-02-01T00:00:00Z', isYou: false },
      ]}
      invitations={[]}
      joinRequests={[{ id: 'jr-1', userId: 'u-3', email: 'prosi@example.test', name: 'Prosi', message: null, createdAt: '2026-03-01T00:00:00Z' }]}
    />
  );
}

describe('zespół firmy', () => {
  it('zaproszenie po biometrii: komunikat z przejściem na ekran kodu i powrotem do Zespołu', async () => {
    mocks.invite.mockResolvedValue(STEP_UP('Zaproszenie do firmy wymaga potwierdzenia kodem z aplikacji.'));
    await render(team());
    await type('#invite-email', 'nowy@example.test');

    await click(button('Wyślij'));

    expect(noticeLink()?.getAttribute('href')).toBe(TEAM_HREF);
    expect(notice()?.textContent).toContain('Zaproszenie do firmy wymaga potwierdzenia kodem z aplikacji.');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('przyjęcie prośby o dostęp po biometrii: to samo przejście', async () => {
    mocks.approve.mockResolvedValue(STEP_UP('Przyjęcie prośby o dostęp wymaga potwierdzenia kodem z aplikacji.'));
    await render(team());

    await click(button('Akceptuj'));

    expect(noticeLink()?.getAttribute('href')).toBe(TEAM_HREF);
    expect(notice()?.textContent).toContain('Przyjęcie prośby o dostęp');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('awans na właściciela po biometrii: to samo przejście', async () => {
    mocks.changeRole.mockResolvedValue(STEP_UP('Zmiana roli w firmie wymaga potwierdzenia kodem z aplikacji.'));
    await render(team());
    const trigger = document.querySelectorAll<HTMLElement>('button[aria-label="Akcje członka"]')[1]!;
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      }
    });
    await settle();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === 'właściciel')!;

    await click(item);

    expect(mocks.changeRole).toHaveBeenCalledWith({ membershipId: 'm-2', newRole: 'owner' });
    expect(noticeLink()?.getAttribute('href')).toBe(TEAM_HREF);
    expect(notice()?.textContent).toContain('Zmiana roli w firmie');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('zwykła porażka zaproszenia zostaje powiadomieniem, bez przejścia na kod', async () => {
    mocks.invite.mockResolvedValue({ success: false, error: 'Ten użytkownik jest już członkiem' });
    await render(team());
    await type('#invite-email', 'czlonek@example.test');

    await click(button('Wyślij'));

    expect(mocks.toastError).toHaveBeenCalledWith('Ten użytkownik jest już członkiem');
    expect(notice()).toBeNull();
  });
});

describe('dostęp dla księgowej', () => {
  it('link po biometrii: komunikat z przejściem na ekran kodu i powrotem do Księgowej', async () => {
    mocks.createToken.mockResolvedValue(STEP_UP('Wystawienie linku dla księgowej wymaga potwierdzenia kodem z aplikacji.'));
    await render(<AccountantAccessList accesses={[]} />);
    await click(button('Nowy dostęp'));
    await type('#acc-name', 'Anna Kowalska');
    await type('#acc-email', 'anna@biuro.example');

    await click(button('Wygeneruj link'));

    expect(noticeLink()?.getAttribute('href')).toBe(ACCOUNTANT_HREF);
    expect(notice()?.textContent).toContain('Wystawienie linku dla księgowej');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('zwykła porażka zostaje powiadomieniem', async () => {
    mocks.createToken.mockResolvedValue({ success: false, error: 'Błąd tworzenia zaproszenia' });
    await render(<AccountantAccessList accesses={[]} />);
    await click(button('Nowy dostęp'));
    await type('#acc-name', 'Anna Kowalska');
    await type('#acc-email', 'anna@biuro.example');

    await click(button('Wygeneruj link'));

    expect(mocks.toastError).toHaveBeenCalledWith('Błąd tworzenia zaproszenia');
    expect(notice()).toBeNull();
  });
});
