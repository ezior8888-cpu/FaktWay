// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PullToRefresh } from '@/components/pwa/pull-to-refresh';

/**
 * „Pociągnij, by odświeżyć” na liście Faktur (zgłoszenie Bartosza 23.10.2026:
 * „na fakturach nie da się przewijać, bo się odświeża i nie da się z tego
 * wyjść”).
 *
 * Panel przewija `.ff-shell-scroll`, nie okno, więc `window.scrollY` jest
 * w nim zawsze 0. Hak, który pytał okno, brał KAŻDY ruch palca w dół za
 * pociągnięcie na górze strony: blokował przewijanie listy do góry
 * (`preventDefault`) i po puszczeniu odświeżał stronę. Gest ma się liczyć
 * tylko wtedy, gdy obszar przewijania panelu stoi na samej górze.
 */

let host: HTMLDivElement;
let scroller: HTMLDivElement;
let outside: HTMLElement;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // Odwzorowanie szkieletu: przewijany kontener z listą i dolny pasek poza nim.
  scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  host = document.createElement('div');
  scroller.appendChild(host);
  outside = document.createElement('nav');
  document.body.append(scroller, outside);
  setScrollTop(0);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  scroller.remove();
  outside.remove();
});

function setScrollTop(value: number) {
  // jsdom nie liczy układu, więc `scrollTop` ustawiamy wprost.
  Object.defineProperty(scroller, 'scrollTop', { value, writable: true, configurable: true });
}

function mount(onRefresh: () => void) {
  root = createRoot(host);
  act(() => {
    root?.render(
      <PullToRefresh onRefresh={onRefresh}>
        <p id="lista">Lista faktur</p>
      </PullToRefresh>,
    );
  });
  return host.querySelector<HTMLElement>('#lista')!;
}

function touch(target: Element, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : [point],
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Palec od (x, y) do (x + dx, y + dy) w kilku krokach, jak prawdziwy ruch. */
async function swipe(target: Element, dx: number, dy: number) {
  const startX = 100;
  const startY = 200;
  touch(target, 'touchstart', startX, startY);
  const moves: Event[] = [];
  for (let step = 1; step <= 5; step += 1) {
    moves.push(touch(target, 'touchmove', startX + (dx * step) / 5, startY + (dy * step) / 5));
  }
  touch(target, 'touchend', startX + dx, startY + dy);
  await act(async () => {});
  return moves;
}

describe('pociągnij, by odświeżyć — lista w przewijanym panelu', () => {
  it('lista przewinięta w dół: ruch palca w dół przewija ją do góry i nie odświeża', async () => {
    const onRefresh = vi.fn();
    const list = mount(onRefresh);
    setScrollTop(400);

    const moves = await swipe(list, 0, 300);

    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('panel na samej górze: pociągnięcie w dół odświeża i nie przepuszcza natywnego ruchu', async () => {
    const onRefresh = vi.fn();
    const list = mount(onRefresh);

    const moves = await swipe(list, 0, 300);

    expect(moves.at(-1)?.defaultPrevented).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('krótkie pociągnięcie poniżej progu nie odświeża', async () => {
    const onRefresh = vi.fn();
    const list = mount(onRefresh);

    await swipe(list, 0, 60);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('ruch w poziomie (przesunięcie karty faktury) nie jest pociągnięciem', async () => {
    const onRefresh = vi.fn();
    const list = mount(onRefresh);

    const moves = await swipe(list, -250, 40);

    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('dotyk poza obszarem przewijania (dolny pasek, arkusz) nie odświeża listy', async () => {
    const onRefresh = vi.fn();
    mount(onRefresh);

    const moves = await swipe(outside, 0, 300);

    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('gest, który zaczął przewijać listę, nie zamienia się w pociągnięcie po dojściu do góry', async () => {
    const onRefresh = vi.fn();
    const list = mount(onRefresh);
    setScrollTop(120);

    touch(list, 'touchstart', 100, 200);
    touch(list, 'touchmove', 100, 260);
    // Natywne przewijanie doprowadziło listę do góry w trakcie tego samego gestu.
    setScrollTop(0);
    const late = [touch(list, 'touchmove', 100, 400), touch(list, 'touchmove', 100, 500)];
    touch(list, 'touchend', 100, 500);
    await act(async () => {});

    expect(late.some((e) => e.defaultPrevented)).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
