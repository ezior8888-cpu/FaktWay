'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void> | void;
  /**
   * Element w treści strony. Gest liczy się względem jego najbliższego
   * przewijanego przodka — w panelu to `.ff-shell-scroll`, nie okno.
   */
  targetRef: RefObject<HTMLElement | null>;
  /** Jak daleko trzeba pociągnąć (px). */
  threshold?: number;
  /** 0–1 — im mniejsze, tym „cięższy” pull (mniejszy dystans przy tym samym ruchu). */
  resistance?: number;
}

/**
 * Najbliższy przodek przewijany w pionie, a bez niego dokument.
 *
 * DLACZEGO NIE `window.scrollY`. Szkielet panelu ma stałą wysokość ekranu
 * i przewija wyłącznie `.ff-shell-scroll`, więc `window.scrollY` jest tam
 * zawsze 0. Hak, który pytał okno, brał każdy ruch palca w dół za
 * pociągnięcie na górze strony: blokował przewijanie listy Faktur do góry
 * i odświeżał ją po puszczeniu (zgłoszenie Bartosza 23.10.2026).
 */
export function findScrollParent(el: HTMLElement | null): HTMLElement {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return node;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * Stan jednego gestu. Kierunek rozstrzygamy na pierwszym ruchu palca i nie
 * zmieniamy go do końca gestu: ruch, który zaczął przewijać listę (albo
 * przesuwać kartę w bok), nie może w połowie stać się odświeżeniem.
 */
type Gesture = 'idle' | 'undecided' | 'pull' | 'native';

export function usePullToRefresh({
  onRefresh,
  targetRef,
  threshold = 80,
  resistance = 0.5,
}: UsePullToRefreshOptions) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const scroller = findScrollParent(targetRef.current);
    // Słuchamy na obszarze przewijania, nie na dokumencie: dotyk dolnego
    // paska, arkusza „Więcej” czy okna dialogowego nie jest gestem listy.
    const surface: HTMLElement | Document =
      scroller === document.scrollingElement ? document : scroller;

    let gesture: Gesture = 'idle';
    let startX = 0;
    let startY = 0;
    let distance = 0;

    const reset = () => {
      gesture = 'idle';
      distance = 0;
      setPullDistance(0);
    };

    const handleTouchStart = (e: TouchEvent) => {
      const point = e.touches[0];
      if (e.touches.length !== 1 || !point || scroller.scrollTop > 0) {
        gesture = 'idle';
        return;
      }
      startX = point.clientX;
      startY = point.clientY;
      gesture = 'undecided';
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (gesture === 'idle' || gesture === 'native') return;
      const point = e.touches[0];
      if (!point) return;

      const dx = point.clientX - startX;
      const dy = point.clientY - startY;

      if (gesture === 'undecided') {
        if (dx === 0 && dy === 0) return;
        // Pociągnięcie = palec w dół, bardziej pionowo niż w bok, panel na górze.
        gesture = dy > 0 && dy >= Math.abs(dx) && scroller.scrollTop <= 0 ? 'pull' : 'native';
        if (gesture === 'native') return;
      }

      if (dy <= 0) {
        // Palec wrócił ponad punkt startu — wskaźnik znika, ruch należy do listy.
        if (distance !== 0) {
          distance = 0;
          setPullDistance(0);
        }
        return;
      }

      distance = Math.min(dy * resistance, threshold * 1.5);
      setPullDistance(distance);
      if (e.cancelable) e.preventDefault();
    };

    const handleTouchEnd = async () => {
      const pulled = gesture === 'pull' ? distance : 0;
      reset();
      if (pulled < threshold) return;

      setIsRefreshing(true);
      try {
        await onRefreshRef.current();
      } finally {
        setIsRefreshing(false);
      }
    };

    surface.addEventListener('touchstart', handleTouchStart as EventListener, {
      passive: true,
    });
    // `passive: false` — tylko tak `preventDefault` wstrzyma natywne
    // przeciągnięcie strony w trakcie pociągnięcia.
    surface.addEventListener('touchmove', handleTouchMove as EventListener, {
      passive: false,
    });
    surface.addEventListener('touchend', handleTouchEnd as EventListener);
    surface.addEventListener('touchcancel', reset);

    return () => {
      surface.removeEventListener('touchstart', handleTouchStart as EventListener);
      surface.removeEventListener('touchmove', handleTouchMove as EventListener);
      surface.removeEventListener('touchend', handleTouchEnd as EventListener);
      surface.removeEventListener('touchcancel', reset);
    };
  }, [targetRef, threshold, resistance]);

  return {
    pullDistance,
    isRefreshing,
    progress: Math.min(pullDistance / threshold, 1),
  };
}
