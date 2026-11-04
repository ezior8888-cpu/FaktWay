import { JSDOM } from 'jsdom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth/inactivity-logout', () => ({ forceSignOutInactive: mocks.logout }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock('@/app/(auth)/login/actions', () => ({ loginWithEmail: vi.fn(), loginWithGoogle: vi.fn() }));
vi.mock('@/components/auth/turnstile-widget', () => ({ TurnstileWidget: () => null }));
import { IdleWatcher } from '@/components/auth/idle-watcher';
import LoginPage from '@/app/(auth)/login/page';
let dom: JSDOM; let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  // Base UI Button (floating-ui isHTMLElement) wymaga konstruktorów DOM w globalach.
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement); vi.stubGlobal('Element', dom.window.Element); vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function stayButton() { return [...container.querySelectorAll('button')].find((button) => button.textContent === 'Pozostań zalogowany')!; }
async function mountAndExpire() {
  await act(async () => { root.render(<IdleWatcher />); });
  await act(async () => { vi.advanceTimersByTime(60 * 60 * 1000); });
}
it.each(['returned failure', 'transport exception'])('shows a retry after %s without claiming logout or extending an expired session', async (failure) => {
  if (failure === 'returned failure') mocks.logout.mockResolvedValue({ ok: false, error: 'local_logout_failed' });
  else mocks.logout.mockRejectedValue(new Error('synthetic-private-error'));
  await mountAndExpire();
  expect(mocks.logout).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Spróbuj ponownie');
  expect(container.textContent).not.toContain('synthetic-private-error');
  expect(container.textContent).not.toContain('zostaniesz automatycznie wylogowany');
  expect(stayButton().disabled).toBe(true);
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Spróbuj wylogować ponownie')!;
  expect(retry.disabled).toBe(false);
  await act(async () => retry.click());
  expect(mocks.logout).toHaveBeenCalledTimes(2);
});
it('keeps controls pending and avoids a second request if the deadline elapses during manual logout', async () => {
  let finish!: (value: { ok: false; error: 'local_logout_failed' }) => void;
  mocks.logout.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => { root.render(<IdleWatcher />); });
  await act(async () => { vi.advanceTimersByTime(59 * 60 * 1000); });
  await act(async () => container.querySelector('button')!.click());
  expect(stayButton().disabled).toBe(true);
  await act(async () => { vi.advanceTimersByTime(60 * 1000); });
  expect(mocks.logout).toHaveBeenCalledOnce();
  await act(async () => { finish({ ok: false, error: 'local_logout_failed' }); });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it('states the local-only result on the login page', async () => {
  const markup = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ notice: 'logout_local_only', success: 'session_expired' }) }));
  expect(markup).toContain('Wylogowaliśmy tę przeglądarkę');
  expect(markup).toContain('Nie udało się potwierdzić wylogowania na pozostałych urządzeniach');
});
it('does not invent a local-only failure on an ordinary login page', async () => {
  const markup = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
  expect(markup).not.toContain('pozostałych urządzeniach');
});
