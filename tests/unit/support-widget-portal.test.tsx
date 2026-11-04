// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora E2: okna Base UI trafiają do kontenera portali wewnątrz
 * `.ff-dashboard` (isolation: isolate). Bąbelek pomocy portalowany do `body`
 * leżałby ponad oknami, arkuszami i paletą ⌘K — musi iść do tego samego
 * kontenera (a bez providera, np. poza panelem, do `body`).
 */

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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SupportWidget } = await import('@/components/support/support-widget');
const { PortalContainerProvider } = await import('@/components/ui/portal-container');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const BUBBLE = 'button[aria-label="Otwórz pomoc"]';

describe('SupportWidget — kontener portalu', () => {
  it('w PortalContainerProvider bąbelek ląduje w [data-slot="portal-root"]', () => {
    mount(
      <PortalContainerProvider>
        <SupportWidget articleTitles={{}} />
      </PortalContainerProvider>,
    );
    const portalRoot = document.querySelector('[data-slot="portal-root"]');
    expect(portalRoot).not.toBeNull();
    expect(portalRoot!.querySelector(BUBBLE)).not.toBeNull();
    expect(document.body.querySelectorAll(BUBBLE)).toHaveLength(1);
  });

  it('bez providera bąbelek ląduje bezpośrednio w body', () => {
    mount(<SupportWidget articleTitles={{}} />);
    const bubble = document.querySelector(BUBBLE);
    expect(bubble).not.toBeNull();
    expect(host!.contains(bubble)).toBe(false);
    expect(document.querySelector('[data-slot="portal-root"]')).toBeNull();
  });
});
