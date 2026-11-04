import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const { DemoBadge } = await import('@/components/dashboard/demo-badge');
const { default: CardHeaderWithMenu } = await import('@/components/dashboard/finora/card-header-with-menu');

/**
 * Recenzja 2 (E12, D-P): plakietka „Dane przykładowe” obok tytułu karty nie
 * może łamać nagłówka. Pomiar w Chromium (23.10.2026): „Przepływy pieniężne”
 * + plakietka mieszczą się przy 375 px na styk (0 px zapasu), a przy 360 px
 * (częsty Android) i 320 px tytuł łamał się w dwie linie — karta rosła
 * o 26 px. Tytuł nie może się zwężać, a plakietka na wąskim ekranie skraca
 * się wielokropkiem (pełny napis w dymku). Plakietka w Księgowości i Analizach
 * zostaje bez zmian.
 */

function klasyElementu(markup: string, tekst: string): string[] {
  const m = new RegExp(`<span class="([^"]*)"[^>]*>${tekst}</span>`).exec(markup);
  return m ? m[1]!.split(/\s+/) : [];
}

describe('nagłówek karty z plakietką „Dane przykładowe”', () => {
  const markup = renderToStaticMarkup(
    <CardHeaderWithMenu title="Przepływy pieniężne" subTitle="Podtytuł" badge={<DemoBadge skracana />} />,
  );

  it('tytuł się nie zwęża (nie łamie się w drugą linię)', () => {
    expect(klasyElementu(markup, 'Przepływy pieniężne')).toContain('shrink-0');
  });

  it('plakietka ustępuje miejsca: zwęża się i skraca napis wielokropkiem', () => {
    const badge = /<span data-slot="badge"[^>]*class="([^"]*)"/.exec(markup)?.[1]?.split(/\s+/) ?? [];
    expect(badge).toContain('min-w-0');
    expect(badge).toContain('shrink');
    expect(badge).not.toContain('shrink-0');
    expect(klasyElementu(markup, 'Dane przykładowe')).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  });

  it('plakietka w Księgowości i Analizach (bez `skracana`) — ten sam znacznik co dotąd', () => {
    const zwykla = renderToStaticMarkup(<DemoBadge />);
    expect(zwykla).toContain('shrink-0');
    expect(zwykla).not.toContain('truncate');
    expect(zwykla).toMatch(/>Dane przykładowe<\/span>$/);
  });
});
