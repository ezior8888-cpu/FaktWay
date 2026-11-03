// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recenzja #357: wycofanie zgody bez sesji albo przy błędzie akcji nie dociera na konto,
 * a ekran mówił tylko „Analityka jest wyłączona”. Ustawienia mówią teraz prawdę:
 * gdzie wybór działa od razu, a gdzie dopiero po zalogowaniu albo ponowieniu.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('@/app/actions/analytics-consent', () => ({ syncAnalyticsConsentAction: mocks.action }));

let root: Root | null = null;
let container: HTMLDivElement;

async function mount() {
  vi.resetModules();
  const { CookieSettings } = await import('@/components/legal/cookie-settings');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CookieSettings />);
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (!button) throw new Error(`Brak przycisku: ${label}`);
  await act(async () => { button.click(); });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_unit_test');
  mocks.action.mockReset();
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
});

describe('ustawienia zgody pokazują, co się stało z wyborem', () => {
  it('wylogowany wycofuje zgodę: działa w tej przeglądarce, a konto dostanie to po zalogowaniu', async () => {
    mocks.action.mockResolvedValue({ status: 'anonymous' });
    await mount();
    await click('Wyłącz analitykę');
    expect(container.textContent).toContain('Wyłączono w tej przeglądarce');
    expect(container.textContent).toContain('zapiszemy to na koncie po zalogowaniu');
  });

  it('wylogowany włącza zgodę: informacja o zapisie na koncie po zalogowaniu', async () => {
    mocks.action.mockResolvedValue({ status: 'anonymous' });
    await mount();
    await click('Włącz analitykę');
    expect(container.textContent).toContain('Włączono w tej przeglądarce');
  });

  it('błąd zapisu na koncie: komunikat i ponowienie, po którym komunikat znika', async () => {
    mocks.action.mockResolvedValue({ status: 'unavailable' });
    await mount();
    await click('Wyłącz analitykę');
    expect(container.textContent).toContain('Nie udało się zapisać wyboru na koncie');

    mocks.action.mockResolvedValue({ status: 'ok', consent: 'denied', consentAt: '2026-11-02T10:00:00.000Z' });
    await click('Spróbuj ponownie');
    expect(container.textContent).not.toContain('Nie udało się zapisać wyboru na koncie');
  });

  it('błąd sieci też pokazuje komunikat', async () => {
    mocks.action.mockRejectedValue(new Error('network'));
    await mount();
    await click('Wyłącz analitykę');
    expect(container.textContent).toContain('Nie udało się zapisać wyboru na koncie');
  });

  it('zalogowany: konto potwierdziło, bez dodatkowych komunikatów', async () => {
    mocks.action.mockResolvedValue({ status: 'ok', consent: 'denied', consentAt: '2026-11-02T10:00:00.000Z' });
    await mount();
    await click('Wyłącz analitykę');
    expect(container.textContent).not.toContain('Nie udało się');
    expect(container.textContent).not.toContain('po zalogowaniu');
  });
});
