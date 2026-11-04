import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/analizy/koszty',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const { default: AssetAllocationCard } = await import('@/components/analizy/finora/chart-asset-allocation');
const { ANALIZY_EMPTY, CONCENTRATION_WARNING } = await import('@/components/analizy/finora/empty');
const { default: MoverListCard, formatMoverPercent } = await import('@/components/analizy/finora/mover-list-card');

/**
 * Karty `/analizy/*` spoza siatki Monthly Analytics (plan Finora P11): każda
 * jako komponent prezentacyjny — stan z danymi i pusty (§7.3). Bez danych
 * przykładowych Finory (`$`, awatary), bez szkła (§9 pkt 5).
 *
 * Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — dziewięć kart siatki
 * to teraz kopie z `components/analizy/finora-1do1/` (testy:
 * `analizy-finora-1do1.test.tsx`, dane: `analizy-adaptery.test.ts`), a nagłówek
 * z przełącznikiem „Sprzedaż | Koszty” sprawdza `analizy-naglowek.test.tsx`.
 * Tu zostają „Udział klientów” i „Klienci: rośnie / spada” — poza siatką
 * (decyzja Bartosza: „na razie wszystko 1:1”), ale w kodzie, bo do nich wrócimy.
 */

/** SSR wstawia <!-- --> między sąsiednie węzły tekstowe — usuwamy je. */
function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node).replace(/<!-- -->/g, '');
}

function noFinoraLeftovers(out: string) {
  expect(out).not.toMatch(/\$\s?\d/);
  expect(out).not.toContain('images/avatars');
  expect(out).not.toContain('backdrop-blur');
  expect(out).not.toContain('ff-glass-pane');
}

const slices = [
  { key: 'a', label: 'Paliwo', amount: 600, percentage: 60, other: false },
  { key: 'pozostale', label: 'Pozostałe', amount: 400, percentage: 40, other: true },
];

describe('Klienci', () => {
  it('udział: wykres i ostrzeżenie przy > 50%; pusto → komunikat', () => {
    const out = html(<AssetAllocationCard data={slices} concentrated empty={ANALIZY_EMPTY.noSalesThisMonth} />);
    expect(out).toContain('Udział klientów w przychodach');
    expect(out).toContain(CONCENTRATION_WARNING);
    // Odpowiednik tekstowy wykresu (WCAG 1.1.1): kwota i udział każdego wycinka.
    expect(out).toMatch(/<ul[^>]*class="sr-only"[^>]*>.*Paliwo: 600,00 zł \(60%\).*Pozostałe: 400,00 zł \(40%\)/);
    expect(html(<AssetAllocationCard data={slices} concentrated={false} empty={ANALIZY_EMPTY.noSalesThisMonth} />))
      .not.toContain(CONCENTRATION_WARNING);
    expect(html(<AssetAllocationCard data={[]} concentrated={false} empty={ANALIZY_EMPTY.noInvoices} />))
      .toContain(ANALIZY_EMPTY.noInvoices.message);
  });

  it('rośnie / spada: nazwa, NIP, procent po polsku; pusto → komunikat', () => {
    const out = html(<MoverListCard mode="losers" empty={ANALIZY_EMPTY.noLosers}
      items={[{ key: 'k', name: 'Klient Spada', subtitle: 'NIP 1234567890', percent: -25.5, net: 1, prevNet: 2 }]} />);
    expect(out).toContain('Klienci: spada');
    expect(out).toContain('Klient Spada');
    expect(out).toContain('NIP 1234567890');
    expect(out).toContain('−25,5%');
    expect(out).toContain('KS');
    noFinoraLeftovers(out);
    expect(html(<MoverListCard mode="gainers" items={[]} empty={ANALIZY_EMPTY.noGainers} />)).toContain(ANALIZY_EMPTY.noGainers.message);
    expect(formatMoverPercent(12)).toBe('+12,0%');
  });
});
