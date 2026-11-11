// @vitest-environment jsdom
// Krok 8.4 planu kompletnej aplikacji, część 2: poprawki dostępności, które
// są wyłącznie atrybutami i strukturą (A-02, A-07, A-10, A-11 z
// docs/dostepnosc/AUDYT-2026-11.md; testy T-2, T-7, T-9 z sekcji 5 audytu).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next/link', () => ({ default: ({ children, ...p }: { children: React.ReactNode }) => <a {...p}>{children}</a> }));
vi.mock('@/lib/support/support-actions', () => ({
  escalateConversationAction: async () => ({}),
  submitCsatAction: async () => ({}),
}));
vi.mock('@/lib/analytics/client', () => ({
  ANALYTICS_EVENTS: { supportChatStarted: 'x' },
  track: () => {},
}));
vi.mock('@/components/site/motion', () => ({
  Reveal: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
}));
vi.mock('@/components/auth/finora/auth-showcase', () => ({ AuthShowcase: () => null }));
vi.mock('@/components/auth/finora/auth-logo', () => ({ AuthLogo: () => null }));
vi.mock('@/components/site/ui', () => ({ BandGlow: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const czytaj = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('A-02 / T-2: formularz korekty', () => {
  const src = czytaj('components/invoices/correction-form.tsx');

  it('każdy <Label> ma htmlFor, a jego id istnieje w pliku', () => {
    const etykiety = [...src.matchAll(/<Label\b([^>]*)>/g)].map((m) => m[1]);
    expect(etykiety.length).toBeGreaterThan(0);
    for (const attrs of etykiety) {
      const m = /htmlFor="([^"]+)"/.exec(attrs);
      expect(m, `<Label${attrs}> bez htmlFor`).not.toBeNull();
      expect(src.includes(`id="${m![1]}"`), `brak id="${m![1]}"`).toBe(true);
    }
  });

  it('pola tabeli pozycji mają nazwy dostępne z numerem pozycji', () => {
    for (const pole of ['name', 'unit', 'quantity', 'unitPriceNet']) {
      const i = src.indexOf('`${name}.${index}.' + pole + '`');
      expect(i, pole).toBeGreaterThan(0);
      const poczatek = src.lastIndexOf('<Input', i);
      expect(src.slice(poczatek, i), pole).toMatch(/aria-label=\{`[^`]*\$\{index \+ 1\}/);
    }
  });

  it('przycisk usuwania pozycji ma nazwę', () => {
    const i = src.indexOf('onClick={() => remove(index)}');
    expect(src.slice(src.lastIndexOf('<Button', i), i)).toMatch(/aria-label=\{`Usuń pozycję/);
  });
});

describe('A-07 / T-7: logowanie, rejestracja i pokrewne', () => {
  it('AuthSplitLayout ma <main> i nie ma <h2> w panelu dekoracyjnym', async () => {
    const { AuthSplitLayout } = await import('@/components/auth/finora/auth-split-layout');
    const html = renderToStaticMarkup(
      <AuthSplitLayout panelTitle='Witaj ponownie!' panelText='Tekst'>
        <h1>Zaloguj się</h1>
      </AuthSplitLayout>,
    );
    expect(html.match(/<main[\s>]/g)).toHaveLength(1);
    expect(html).not.toMatch(/<h2/);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('strony (auth) mają <h1> zamiast <h2>', () => {
    const pliki = [
      'login/page.tsx', 'register/page.tsx', 'forgot-password/page.tsx',
      'reset-password/page.tsx', 'login/two-factor/page.tsx',
      'login/two-factor/setup/page.tsx', 'gdpr/cancel/page.tsx',
    ];
    for (const p of pliki) {
      const src = czytaj(`app/(auth)/${p}`);
      expect(src, p).toMatch(/<h1\b/);
      expect(src, p).not.toMatch(/<h2\b/);
    }
  });
});

describe('A-10 / A-11 / T-9: panel „Pomoc FaktWay”', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  async function otworz() {
    const { SupportWidget } = await import('@/components/support/support-widget');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<SupportWidget articleTitles={{}} />));
    const bubble = document.querySelector<HTMLButtonElement>('button[aria-label="Otwórz pomoc"]')!;
    expect(bubble.getAttribute('aria-expanded')).toBe('false');
    act(() => bubble.click());
  }

  it('okno ma role=dialog, nazwę z nagłówka i niemodalność', async () => {
    await otworz();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    const id = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(id)?.textContent).toBe('Pomoc FaktWay');
  });

  it('lista wiadomości jest regionem aria-live, a pole ma nazwę', async () => {
    await otworz();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(dialog.querySelector('textarea')?.getAttribute('aria-label')).toBe('Wiadomość do pomocy');
  });

  it('po otwarciu fokus ląduje na polu, Escape zamyka', async () => {
    await otworz();
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
