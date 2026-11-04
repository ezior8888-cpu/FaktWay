// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Okno „Sesja wygasa” (E1): ma NIE dać się zamknąć klawiszem Escape ani
 * kliknięciem poza oknem — klient musi świadomie wybrać „Pozostań zalogowany”
 * albo „Wyloguj teraz”. Prawdziwe: `IdleWatcher`, `Dialog` (Base UI),
 * `useInactivityTimeout`. Zastąpiona: akcja wylogowania.
 */
const mocks = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('@/lib/auth/inactivity-logout', () => ({ forceSignOutInactive: mocks.logout }));
import { IdleWatcher } from '@/components/auth/idle-watcher';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openWarning() {
  await act(async () => { root.render(<IdleWatcher />); });
  await act(async () => { vi.advanceTimersByTime(59 * 60 * 1000); });
}

it('shows the warning dialog and keeps it open after Escape', async () => {
  await openWarning();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await act(async () => { vi.advanceTimersByTime(500); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).toContain('Sesja wygasa');
});

it('keeps the dialog open after a click outside of it', async () => {
  await openWarning();
  const backdrop = document.querySelector('[data-slot="dialog-overlay"]');
  await act(async () => {
    (backdrop ?? document.body).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    (backdrop ?? document.body).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    (backdrop ?? document.body).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { vi.advanceTimersByTime(500); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
