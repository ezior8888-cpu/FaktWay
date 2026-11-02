import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 25.10.2026: Księgowość (KPiR, Eksport) to jedna strona.
 * Rząd zakładek stoi u góry sekcji w `reports/layout.tsx` i nie zmienia się
 * przy przełączaniu; dawniej siedział w karcie każdej zakładki i skakał
 * w pionie. Strona zakładki rozjaśnia się sama (`.ff-tab-panel`), bez ruchu.
 */

const nav = vi.hoisted(() => ({ pathname: '/reports/kpir' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const { default: KsiegowoscLayout } = await import('@/app/(dashboard)/reports/layout');
const { SectionTabsNav } = await import('@/components/lists/section-tabs-nav');
const { KSIEGOWOSC_TABS } = await import('@/components/reports/ksiegowosc-tabs');

const ROOT = join(__dirname, '..', '..');

function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((child) => elements(child, out));
  else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

describe('Księgowość — jedna strona', () => {
  it('layout: rząd zakładek Księgowości u góry, pod nim strona zakładki', () => {
    const tree = KsiegowoscLayout({ children: <p id="zakladka">treść</p> });
    expect((tree.props as { className: string }).className).toContain('ff-page-fill');
    const all = elements(tree);
    const tabs = all.find((el) => el.type === SectionTabsNav)!;
    expect((tabs.props as { tabs: unknown }).tabs).toBe(KSIEGOWOSC_TABS);
    expect(all.indexOf(tabs)).toBeLessThan(all.findIndex((el) => (el.props as { id?: string }).id === 'zakladka'));
  });

  it('aktywna zakładka z adresu', () => {
    for (const [pathname, label] of [['/reports/kpir', 'KPiR'], ['/reports/exports', 'Eksport']] as const) {
      nav.pathname = pathname;
      const html = renderToStaticMarkup(<SectionTabsNav label="Księgowość" tabs={KSIEGOWOSC_TABS} />);
      expect(html, pathname).toMatch(new RegExp(`<a[^>]*aria-current="page"[^>]*>${label}<`));
    }
  });

  it('panel zakładki rozjaśnia się sam, bez `transform` (pływające przyciski zostają przypięte do okna)', () => {
    const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
    const rule = /\.ff-tab-panel \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('animation: ff-tab-panel-in');
    const keyframes = /@keyframes ff-tab-panel-in \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(keyframes).toContain('opacity');
    expect(keyframes).not.toContain('transform');
  });
});
