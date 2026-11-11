// @vitest-environment jsdom
// Krok 8.4 planu kompletnej aplikacji, część 2b: poprawki dostępności, które
// są wyłącznie atrybutami i strukturą (A-13, A-14, A-15, A-16, A-19 z
// docs/dostepnosc/AUDYT-2026-11.md; testy T-2, T-7 z sekcji 5 audytu).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const czytaj = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('A-13 / T-2: wiersz wyboru faktury korygowanej', () => {
  const src = czytaj('components/invoices/correction-form.tsx');
  it('<tr> nie ma role=button ani tabIndex, a numer faktury jest prawdziwym przyciskiem', () => {
    expect(src).not.toMatch(/<tr\b[^>]*\brole=/);
    const i = src.indexOf('parentInvoices.map');
    const tr = src.slice(i, src.indexOf('<td', i));
    expect(tr).not.toMatch(/tabIndex|onKeyDown|role=/);
    expect(src.slice(i, i + 1800)).toMatch(/<button\b[^>]*type="button"/);
  });
});

describe('A-14 / T-7: link „Przejdź do treści”', () => {
  const src = czytaj('app/(dashboard)/layout.tsx');
  it('pierwszy w układzie panelu, cel to <main id="tresc">', () => {
    expect(src).toMatch(/<a\s+href="#tresc"[^>]*sr-only[^>]*focus:not-sr-only/);
    expect(src).toMatch(/<SidebarInset[^>]*\bid="tresc"/);
    expect(src.indexOf('href="#tresc"')).toBeLessThan(src.indexOf('<AppSidebar'));
  });
});

describe('A-15 / T-2: nagłówek sortowania', () => {
  const src = czytaj('components/lists/finora-data-table.tsx');
  it('nie używa div z role=button', () => {
    expect(src).not.toMatch(/<div[^>]*role=.button./);
    expect(src).toMatch(/<button\b/);
  });
});

describe('A-16: warstwa pod kartą przesuwanego wiersza', () => {
  it('napis „Pobierz XML” jest ukryty przed czytnikiem', () => {
    const src = czytaj('components/invoices/swipeable-invoice-row.tsx');
    const i = src.indexOf('pointer-events-none absolute inset-0');
    expect(src.slice(i - 40, i + 120)).toContain('aria-hidden');
  });
});

describe('A-19: komunikat błędu logowania', () => {
  it('błąd ma tabIndex -1 i dostaje fokus po wyrenderowaniu', async () => {
    const { AuthMessage } = await import('@/components/auth/finora/auth-message');
    expect(renderToStaticMarkup(<AuthMessage tone='error'>Błąd</AuthMessage>)).toMatch(/tabindex="-1"/);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<AuthMessage tone='error'>Błąd</AuthMessage>));
    expect(document.activeElement?.getAttribute('role')).toBe('alert');
    act(() => root.unmount());
    host.remove();
  });

  it('potwierdzenie nie kradnie fokusu', async () => {
    const { AuthMessage } = await import('@/components/auth/finora/auth-message');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<AuthMessage tone='success'>OK</AuthMessage>));
    expect(document.activeElement?.getAttribute('role')).not.toBe('status');
    act(() => root.unmount());
    host.remove();
  });
});
