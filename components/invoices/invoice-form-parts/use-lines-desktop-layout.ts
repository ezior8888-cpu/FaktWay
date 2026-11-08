'use client';

import { useEffect, useState } from 'react';

import { LINES_LAYOUT_MEDIA } from './constants';

/**
 * Nie montuj jednocześnie tabeli desktop i kart mobile z tym samym
 * `register('lines.*')` — oba bloki były w DOM (tylko `display:none`), przez co
 * React Hook Form wiązał ref z „drugim” inputem i widoczne pole Nazwa nie
 * aktualizowało stanu.
 */
export function useLinesDesktopLayout(): boolean {
  const [linesDesktopLayout, setLinesDesktopLayout] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(LINES_LAYOUT_MEDIA);
    const sync = () => setLinesDesktopLayout(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);
  return linesDesktopLayout;
}
