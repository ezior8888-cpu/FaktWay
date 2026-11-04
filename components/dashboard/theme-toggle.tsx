'use client';

import { RiMoonClearLine, RiSunLine } from '@remixicon/react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  type Theme,
  THEME_STORAGE_KEY,
} from '@/lib/theme/theme';

/**
 * WŁAŚCICIEL: Bartosz (tor silnika) — rama panelu.
 *
 * Wygląd `ModeToggle` z szablonu Finora (plan Finora P0, E2), logika nasza:
 * motywem rządzi `lib/theme/theme.ts`, nie `next-themes`.
 *
 * Od 30.08.2026 domyślny motyw to jasny, więc stan początkowy bierze
 * `DEFAULT_THEME` zamiast zaszytego `'dark'`. Renderowanie jest wstrzymane do
 * `mounted`, bo inaczej pierwszy render miałby etykietę drugiego motywu.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = readStoredTheme();
    applyTheme(stored);
    queueMicrotask(() => {
      setTheme(stored);
      setMounted(true);
    });
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  if (!mounted) {
    // Ten sam wymiar co przycisk niżej (`size='icon'` + cel dotykowy 44 px),
    // żeby nagłówek nie drgnął po montażu.
    return (
      <span
        className="size-8 shrink-0 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]"
        aria-hidden
      />
    );
  }

  const isDark = theme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      onClick={toggle}
      aria-label={isDark ? 'Włącz jasny motyw' : 'Włącz ciemny motyw'}
      title="Przełącz motyw"
    >
      {/* Ikony przełącza klasa `dark` na <html> (jak w Finorze) — ta sama,
          którą ustawia `applyTheme`, więc ikona nie rozjedzie się z motywem. */}
      <RiMoonClearLine aria-hidden className="scale-100 dark:scale-0" />
      <RiSunLine aria-hidden className="absolute scale-0 dark:scale-100" />
      <span className="sr-only">Przełącz motyw</span>
    </Button>
  );
}
