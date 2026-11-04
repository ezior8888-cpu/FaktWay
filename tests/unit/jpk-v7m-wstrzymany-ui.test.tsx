import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/app/actions/exports', () => ({
  startExportAction: vi.fn(),
  downloadExportFileAction: vi.fn(),
}));

import { ExportsCenter } from '@/components/exports/exports-center';
import { SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';

/** Centrum eksportu: JPK_V7M nie do wyboru, a klient widzi dlaczego. */
describe('Centrum eksportu — JPK_V7M wstrzymany', () => {
  const html = renderToStaticMarkup(<ExportsCenter recentJobs={[]} />);

  it('nie ma przycisku JPK_V7M, reszta formatów jest', () => {
    expect(html).not.toContain('JPK_V7M (ewidencja + deklaracja VAT)');
    expect(html).toContain('JPK_FA(4)');
    expect(html).toContain('KPiR Excel');
  });

  it('notka wyjaśnia powód wyłączenia', () => {
    expect(html).toContain('JPK_V7M jest chwilowo wyłączony');
    expect(html).toContain('JPK_V7M(3)');
  });

  // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): `jpk_v7m` był na liście
  // dwa razy (ręcznie doklejony do enuma, który już go miał) — powód stał na ekranie podwójnie,
  // a React zgłaszał dwa elementy z tym samym kluczem.
  it('każdy powód wyłączenia dokładnie raz', () => {
    for (const reason of Object.values(SUSPENDED_EXPORT_FORMATS)) {
      expect(html.split(reason).length - 1).toBe(1);
    }
    expect(html.match(/JPK_V7M jest chwilowo wyłączony/g)).toHaveLength(1);
  });
});
