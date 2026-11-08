// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Hydratacja przy włączonym „ogranicz ruch” (sesja testów wizualnych,
 * plan usprawnień 3.2). Serwer nie zna `prefers-reduced-motion`, więc rysuje
 * wersję z animacją. `useReducedMotion` z framer-motion czyta `matchMedia`
 * już w pierwszym renderze klienta, komponent dawał wtedy inne drzewo niż
 * serwer i React zgłaszał „Hydration failed”, a potem budował stronę od zera.
 *
 * Test odtwarza to dokładnie: HTML z „serwera” powstaje przy braku
 * preferencji, potem system przełącza się na `reduce` i dopiero wtedy klient
 * hydratuje ten HTML. Hydratacja ma przejść bez błędu, a po niej komponent
 * ma pokazać ten sam stan końcowy co dotąd (bez animacji, od razu „gotowe”).
 *
 * Różnica samych atrybutów (np. `style`) nie przerywa hydratacji: React 19
 * pisze ją tylko w `console.error` i zostawia atrybut z serwera. Dlatego test
 * łapie też to ostrzeżenie — przy `ScrollReveal` zostawało `opacity: 0`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Jeden przełącznik dla wszystkich zapytań o ruch. framer-motion zapamiętuje
// odpowiedź w zmiennej modułu i odświeża ją tylko zdarzeniem `change`, więc
// przy przełączeniu wołamy zapisane nasłuchy jak przeglądarka.
const motion = { reduce: false, listeners: new Set<() => void>() };

function setReduce(reduce: boolean) {
  motion.reduce = reduce;
  for (const listener of motion.listeners) listener();
}

beforeAll(() => {
  window.matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return query.includes('prefers-reduced-motion') && motion.reduce;
      },
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => motion.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => motion.listeners.delete(listener),
      addListener: (listener: () => void) => motion.listeners.add(listener),
      removeListener: (listener: () => void) => motion.listeners.delete(listener),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList;

  // `useInView` i `whileInView`: w jsdom nic nie jest „w ekranie”.
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setReduce(false);
});

async function hydrateWithReducedMotion(element: ReactElement) {
  setReduce(false);
  const html = renderToString(element);

  setReduce(true);
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  container = host;

  const errors: string[] = [];
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const message = args.map(String).join(' ');
    if (/hydrat/i.test(message)) errors.push(message);
  });
  try {
    await act(async () => {
      root = hydrateRoot(host, element, {
        onRecoverableError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      });
    });
  } finally {
    consoleError.mockRestore();
  }
  return { errors, container: host };
}

describe('hydratacja przy prefers-reduced-motion: reduce', () => {
  it('strona główna: podgląd faktur w hero', async () => {
    const { HeroPreview } = await import('@/app/(home)/_components/hero-preview');
    const { errors, container } = await hydrateWithReducedMotion(<HeroPreview />);

    expect(errors).toEqual([]);
    // Stan końcowy jak dotąd: nowa faktura przyjęta, UPO pobrane.
    expect(container.textContent).toContain('FV/2026/11/004 przyjęta, UPO pobrane');
    // Szkielet z serwera znika od razu, a nie wygasa pod gotowym wierszem (#457).
    expect(container.querySelector('[data-testid="podglad-szkielet"]')).toBeNull();
  });

  it('strona główna: telefon', async () => {
    const { Phone } = await import('@/app/(home)/_components/phone-section');
    const { errors, container } = await hydrateWithReducedMotion(<Phone />);

    expect(errors).toEqual([]);
    // Stan końcowy jak dotąd: scena gotowa od razu, bez paska autoodtwarzania.
    expect(container.textContent).toContain('Przyjęta w KSeF');
    expect(container.querySelector('[role="tab"] .origin-left')).toBeNull();
  });

  it('logowanie: karta z krokami faktury', async () => {
    const { AuthShowcase } = await import('@/components/auth/finora/auth-showcase');
    const { errors, container } = await hydrateWithReducedMotion(<AuthShowcase />);

    expect(errors).toEqual([]);
    // Wszystkie trzy kroki zrobione od razu.
    expect(container.querySelectorAll('li .bg-primary')).toHaveLength(3);
  });

  it('marketing: ScrollReveal i FloatingOrbs', async () => {
    const { ScrollReveal } = await import('@/components/marketing/scroll-reveal');
    const { FloatingOrbs } = await import('@/components/marketing/floating-orbs');
    const { errors, container } = await hydrateWithReducedMotion(
      <div>
        <ScrollReveal>
          <p id="tresc">treść</p>
        </ScrollReveal>
        <FloatingOrbs />
      </div>,
    );

    expect(errors).toEqual([]);
    // Treść nie zostaje przezroczysta po stylu z serwera (pokazuje się w
    // najbliższej klatce, bez czekania na wejście w ekran).
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLElement>('#tresc')!.parentElement!.style.opacity).not.toBe('0'),
    );
  });
});
