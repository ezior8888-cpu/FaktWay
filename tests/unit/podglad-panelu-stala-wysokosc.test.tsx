// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Podgląd panelu pod nagłówkiem strony głównej nie może zmieniać wysokości
 * (przegląd przed wdrożeniem 05.11.2026, PD-13). Nowa faktura wjeżdżała do
 * tabeli rozwijaniem wiersza od zera, a co 8,5 s znikała, więc wszystko pod
 * podglądem skakało o wysokość wiersza: na telefonie 56 px, CLS ok. 0,14-0,16
 * na produkcji, sekcja „Funkcje” pod palcem czytającego.
 *
 * Wysokość karty wynika z elementów tabeli w normalnym przepływie. Test
 * przechodzi całą pętlę animacji i sprawdza, że ich liczba się nie zmienia:
 * miejsce na nową fakturę ma być zarezerwowane od początku, a sam wiersz
 * tylko się w nim pojawia i znika. Przy okazji pilnuje, że pętla dalej
 * pokazuje kolejne stany wysyłki.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Pętla rusza tylko, gdy podgląd jest na ekranie.
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useInView: () => true,
}));

beforeAll(() => {
  // Bez „ogranicz ruch”: animacja ma działać.
  window.matchMedia = (query: string) =>
    ({
      media: query,
      matches: false,
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
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

/** Kontener tabeli: rodzic wiersza nagłówka z kolumną „Status KSeF”. */
function table(container: HTMLElement): HTMLElement {
  const header = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Status KSeF');
  if (!header?.parentElement?.parentElement) throw new Error('Brak tabeli w podglądzie');
  return header.parentElement.parentElement;
}

/** Elementy, które zajmują miejsce w tabeli (bez nakładek `absolute`). */
function inFlow(tableEl: HTMLElement): number {
  return [...tableEl.children].filter((child) => !child.classList.contains('absolute')).length;
}

/** Tekst widoczny dla oka: bez elementów `invisible`, które tylko trzymają miejsce. */
function visibleText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.invisible').forEach((node) => node.remove());
  return clone.textContent ?? '';
}

describe('podgląd panelu na stronie głównej', () => {
  it('ma stałą wysokość przez całą pętlę, a nowa faktura przechodzi przez stany wysyłki', async () => {
    const { HeroPreview } = await import('@/app/(home)/_components/hero-preview');
    host = document.createElement('div');
    document.body.append(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<HeroPreview />);
    });

    const tableEl = table(host);
    const counts: number[] = [inFlow(tableEl)];
    const texts: string[] = [];
    const pages: string[] = [];

    // Granice faz z komponentu: 0.9 s w kolejce, 2 s wysyłanie, 3.6 s przyjęta, 8.5 s od nowa.
    for (const ms of [900, 1100, 1600, 4900]) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
      counts.push(inFlow(tableEl));
      texts.push(visibleText(tableEl));
      pages.push(host.textContent ?? '');
    }

    expect(counts).toEqual(counts.map(() => counts[0]));
    // Liczba elementów nie wystarczy: wiersz wrócony do przepływu wewnątrz miejsca
    // albo miejsce bez niewidocznego wiersza znów zmieniałyby wysokość. Nowa faktura
    // ma być nakładką na całe miejsce, a miejsce ma trzymać wysokość wierszem `invisible`.
    const overlay = [...tableEl.querySelectorAll<HTMLElement>('.absolute')].find((element) =>
      element.textContent?.includes('FV/2026/11/004'),
    );
    expect(overlay?.classList.contains('inset-0')).toBe(true);
    const slot = overlay!.parentElement!;
    expect(slot.parentElement).toBe(tableEl);
    expect([...slot.children].filter((child) => child.classList.contains('invisible'))).toHaveLength(1);
    // Kolejne plakietki statusu podmienia animacja wyjścia, której jsdom nie
    // odtwarza, więc sprawdzamy wejście wiersza i potwierdzenie z UPO.
    expect(texts[0]).toContain('W kolejce');
    expect(pages[2]).toContain('FV/2026/11/004 przyjęta, UPO pobrane');
  });

  it('zanim przyjdzie nowa faktura, jej miejsce wypełnia szkielet wiersza, a nie pusty pasek', async () => {
    // Sprawdzenie produkcji 08.11.2026: przez ok. 1 s w każdej pętli u góry tabeli był
    // pusty pasek wysokości wiersza, który mógł wyglądać jak usterka.
    const { HeroPreview } = await import('@/app/(home)/_components/hero-preview');
    host = document.createElement('div');
    document.body.append(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<HeroPreview />);
    });

    const tableEl = table(host);
    const skeleton = tableEl.querySelector<HTMLElement>('[data-testid="podglad-szkielet"]');
    expect(skeleton).not.toBeNull();
    // Szkielet to nakładka w tym samym miejscu co nowa faktura: nie zmienia wysokości tabeli.
    expect(skeleton!.classList.contains('absolute')).toBe(true);
    expect(skeleton!.classList.contains('inset-0')).toBe(true);
    expect(skeleton!.parentElement!.querySelector(':scope > .invisible')).not.toBeNull();
    // Same kształty, bez tekstu, który czytelnik mógłby wziąć za dane.
    expect(skeleton!.textContent).toBe('');
  });
});
