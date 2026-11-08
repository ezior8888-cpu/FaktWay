// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  search: new URLSearchParams('month=9&year=2026'),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  useSearchParams: () => nav.search,
}));

import KpirError from '@/app/(dashboard)/reports/kpir/error';
import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * Ekran błędu KPiR (poprawka Bartosza 21.10.2026: przeprojektowanie
 * Księgowości). Strona celowo rzuca przy niepełnym środowisku KSeF albo
 * proweniencji — klient dostaje powłokę z zakładkami, ponowienie, kontakt
 * i przełącznik miesiąca. Granica błędu Next czyści się sama tylko przy
 * zmianie ścieżki, a KPiR zmienia miesiąc w `?month=&year=` — zmiana adresu
 * musi więc sama wywołać `reset()`, inaczej inny miesiąc (Wstecz, zakładka
 * „KPiR”) dalej pokazuje błąd.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  nav.push.mockReset();
  nav.refresh.mockReset();
  sentry.captureException.mockReset();
  nav.search = new URLSearchParams('month=9&year=2026');
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function blad(digest?: string): Error & { digest?: string } {
  return Object.assign(new Error('Brak środowiska KSeF'), digest ? { digest } : {});
}

async function mount(error: Error & { digest?: string }, reset: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<KpirError error={error} reset={reset} />);
  });
  return host;
}

describe('KPiR — ekran błędu', () => {
  it('powłoka, Sentry, kod błędu, ponowienie i kontakt', async () => {
    const reset = vi.fn();
    const error = blad('abc123');
    const el = await mount(error, reset);

    expect(sentry.captureException).toHaveBeenCalledWith(error);
    expect(el.querySelector('.ff-tab-panel')).not.toBeNull();
    expect(el.textContent).toContain('Nie udało się wczytać KPiR');
    expect(el.textContent).toContain('Kod błędu: abc123');
    // Rząd zakładek stoi nad granicą błędu, w `reports/layout.tsx` (od 25.10.2026),
    // więc z ekranu błędu nadal da się przejść do Eksportu — tu go nie dublujemy.
    expect(el.querySelector('nav[aria-label="Księgowość"]')).toBeNull();
    expect(el.querySelector('a[href^="mailto:"]')?.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}?subject=KPiR`);

    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Spróbuj ponownie'));
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('bez kodu błędu nie pokazuje pustego „Kod błędu”', async () => {
    const el = await mount(blad(), vi.fn());
    expect(el.textContent).not.toContain('Kod błędu');
  });

  it('przełącznik miesiąca z adresu i strzałki poza listę 24 miesięcy', async () => {
    const el = await mount(blad(), vi.fn());
    expect(el.querySelector('[aria-label="Miesiąc KPiR"]')).not.toBeNull();
    expect(el.textContent).toContain('Wrzesień 2026');
    expect(el.querySelector('a[aria-label="Poprzedni miesiąc"]')?.getAttribute('href')).toBe('/reports/kpir?month=8&year=2026');
    expect(el.querySelector('a[aria-label="Następny miesiąc"]')?.getAttribute('href')).toBe('/reports/kpir?month=10&year=2026');
    // Bez „Eksport KPiR” — miesiąc się nie wczytał.
    expect(el.textContent).not.toContain('Eksport KPiR');
  });

  it('zmiana miesiąca w adresie (wybór, Wstecz, zakładka „KPiR”) zdejmuje błąd', async () => {
    const reset = vi.fn();
    await mount(blad(), reset);
    expect(reset).not.toHaveBeenCalled();

    nav.search = new URLSearchParams('month=8&year=2026');
    await act(async () => {
      root!.render(<KpirError error={blad()} reset={reset} />);
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('ten sam adres nie resetuje w kółko', async () => {
    const reset = vi.fn();
    const error = blad();
    await mount(error, reset);
    await act(async () => {
      root!.render(<KpirError error={error} reset={reset} />);
    });
    expect(reset).not.toHaveBeenCalled();
  });
});
