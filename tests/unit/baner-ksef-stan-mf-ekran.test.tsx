// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { KsefHealthBannerClient } from '@/app/(dashboard)/_components/ksef-health-banner-client';
import type { KsefHealthPublic } from '@/lib/ksef/health-status';

/** Plan „zero zgubionych faktur”, sesja B3: baner na ekranie według stanu ogłoszonego przez MF. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const healthy: KsefHealthPublic = {
  level: 'operational',
  lastCheckedAt: '2026-11-05T10:00:00.000Z',
  responseTimeMs: 120,
  consecutiveFailures: 0,
  isMfOutage: false,
  env: 'production',
  officialStatus: 'AVAILABLE',
  officialEnd: null,
};

let root: Root | null = null;
let host: HTMLDivElement;
let health: KsefHealthPublic;

function mount(initial: KsefHealthPublic) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<KsefHealthBannerClient initial={initial} />));
}

const nextPoll = () => act(async () => { await vi.advanceTimersByTimeAsync(3 * 60_000); });

beforeEach(() => {
  vi.useFakeTimers();
  health = healthy;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...health, stale: false })));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

it('awaria ogłoszona przez MF pokazuje baner mimo działającej sondy', async () => {
  mount(healthy);
  expect(host.textContent).toBe('');
  health = { ...healthy, officialStatus: 'FAILURE' };
  await nextPoll();
  expect(host.textContent).toContain('Ministerstwo Finansów ogłosiło awarię KSeF');
});

it('schowany baner wraca, gdy MF ogłosi awarię', async () => {
  const down: KsefHealthPublic = { ...healthy, level: 'down', officialStatus: null };
  health = down;
  mount(down);
  expect(host.textContent).toContain('KSeF jest niedostępny');

  act(() => host.querySelector('button')!.click());
  expect(host.textContent).toBe('');

  health = { ...down, officialStatus: 'TOTAL_FAILURE' };
  await nextPoll();
  expect(host.textContent).toContain('awarię całkowitą');
});
