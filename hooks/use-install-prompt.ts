// hooks/use-install-prompt.ts
'use client';

import { useEffect, useState } from 'react';

/** Chrome / Edge — `beforeinstallprompt`; pełnego typu nie ma w lib.dom */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface NavigatorStandalone extends Navigator {
  /** iOS Safari — aplikacja dodana do ekranu głównego */
  standalone?: boolean;
}

const DISMISS_STORAGE_KEY = 'install-prompt-dismissed-at';
const DISMISS_COOLDOWN_DAYS = 7;

export function useInstallPrompt() {
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    const nav = window.navigator as NavigatorStandalone;
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      nav.standalone === true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- odczyt API przeglądarki (matchMedia, userAgent, localStorage) po zamontowaniu; na serwerze ich nie ma
    setIsStandalone(standalone);

    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    setIsIOS(ios);

    const dismissedAt = localStorage.getItem(DISMISS_STORAGE_KEY);
    if (dismissedAt) {
      const parsed = Number(dismissedAt);
      if (!Number.isNaN(parsed)) {
        const daysSince =
          (Date.now() - parsed) / (1000 * 60 * 60 * 24);
        if (daysSince < DISMISS_COOLDOWN_DAYS) {
          setIsDismissed(true);
        }
      }
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const promptInstall = async () => {
    if (!installEvent) return false;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === 'accepted') {
      setInstallEvent(null);
    }
    return outcome === 'accepted';
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    setIsDismissed(true);
  };

  return {
    canInstall:
      !isStandalone &&
      !isDismissed &&
      (installEvent !== null || isIOS),
    isStandalone,
    isIOS,
    promptInstall,
    dismiss,
  };
}
