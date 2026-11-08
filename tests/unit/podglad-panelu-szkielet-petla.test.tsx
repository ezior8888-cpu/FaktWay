// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Szkielet wiersza w podglądzie panelu przez całą pętlę (sprawdzenie produkcji
 * 08.11.2026, recenzja #457). jsdom nie odtwarza animacji wyjścia, więc
 * `AnimatePresence` jest tu zwykłym przejściem: element znika w tej samej chwili,
 * w której znika z drzewa. Dzięki temu widać, kiedy szkielet jest, a kiedy go nie ma.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  // Pętla rusza tylko, gdy podgląd jest na ekranie.
  useInView: () => true,
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

let reduce = false;

beforeAll(() => {
  window.matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return query.includes('prefers-reduced-motion') && reduce;
      },
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  reduce = false;
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

async function renderPreview(): Promise<HTMLElement> {
  const { HeroPreview } = await import('@/app/(home)/_components/hero-preview');
  host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<HeroPreview />);
  });
  return host;
}

const skeleton = (container: HTMLElement) => container.querySelector('[data-testid="podglad-szkielet"]');

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe('szkielet wiersza w podglądzie panelu', () => {
  it('jest przed fakturą, znika, gdy ona przychodzi, i wraca po resecie pętli', async () => {
    const container = await renderPreview();
    expect(skeleton(container)).not.toBeNull();

    await advance(900);
    expect(skeleton(container)).toBeNull();
    expect(container.textContent).toContain('W kolejce');

    // Reset pętli po 8,5 s: znów miejsce czeka na fakturę.
    await advance(7600);
    expect(skeleton(container)).not.toBeNull();

    await advance(900);
    expect(skeleton(container)).toBeNull();
  });

  it('przy „ogranicz ruch” go nie ma: od razu gotowa, przyjęta faktura', async () => {
    reduce = true;
    const container = await renderPreview();

    expect(skeleton(container)).toBeNull();
    expect(container.textContent).toContain('FV/2026/11/004 przyjęta, UPO pobrane');
  });
});
