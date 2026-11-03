// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recenzja #359, pkt 2: po resecie hasła klucze biometrii są usunięte, więc ekran
 * potwierdzenia mówi, że trzeba je dodać ponownie w ustawieniach. Gdy usunięcie
 * się nie udało, mówi o tym wprost i wskazuje, co zrobić po zalogowaniu.
 */

const mocks = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children: React.ReactNode }) => <a {...p}>{children}</a>,
}));
vi.mock('@/app/(auth)/reset-password/actions', () => ({ resetPasswordAction: mocks.action }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ResetPasswordForm } = await import('@/app/(auth)/reset-password/reset-password-form');

const BASE = { ok: true, localSessionCleared: true, globalSignOutConfirmed: true };

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function submitReset(result: unknown) {
  mocks.action.mockResolvedValue(result);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ResetPasswordForm />));
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return document.body.textContent ?? '';
}

describe('ekran po zmianie hasła', () => {
  it('usunięte klucze: trzeba dodać logowanie biometrią ponownie w ustawieniach', async () => {
    const text = await submitReset({ ...BASE, passkeys: 'removed' });

    expect(text).toContain('Hasło zostało zmienione.');
    expect(text).toContain('Usunęliśmy zapisane urządzenia do logowania biometrią.');
    expect(text).toContain('dodaj je ponownie w Ustawieniach, w zakładce Bezpieczeństwo');
  });

  it('nieudane usunięcie: komunikat o błędzie z drogą wyjścia po zalogowaniu', async () => {
    const text = await submitReset({ ...BASE, passkeys: 'failed' });

    expect(text).toContain('Hasło zostało zmienione.');
    expect(text).toContain('Nie udało się usunąć zapisanych urządzeń do logowania biometrią.');
    expect(text).toContain('usuń te, których nie rozpoznajesz');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('logowania biometrią');
  });

  it('konto bez kluczy: ani słowa o biometrii', async () => {
    const text = await submitReset(BASE);

    expect(text).toContain('Hasło zostało zmienione.');
    expect(text.toLowerCase()).not.toContain('biometri');
  });
});
