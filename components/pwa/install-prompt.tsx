// components/pwa/install-prompt.tsx
'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Plus, Share, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useInstallPrompt } from '@/hooks/use-install-prompt';

export function InstallPrompt() {
  const { canInstall, isIOS, promptInstall, dismiss } = useInstallPrompt();
  const [showDelayed, setShowDelayed] = useState(false);

  useEffect(() => {
    if (!canInstall) return;
    const t = setTimeout(() => setShowDelayed(true), 30_000);
    return () => clearTimeout(t);
  }, [canInstall]);

  useEffect(() => {
    if (!canInstall) setShowDelayed(false);
  }, [canInstall]);

  if (!canInstall || !showDelayed) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="fixed bottom-[calc(1rem+var(--ff-bottom-nav-h)+var(--ff-safe-b))] left-4 right-4 z-50 lg:left-auto lg:right-6 lg:w-96"
      >
        <div
          className="rounded-3xl border border-glass-border bg-glass-white-strong backdrop-blur-glass-lg shadow-glass-lg p-5"
        >
          <div className="flex items-start gap-3">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-foreground font-display text-lg font-bold text-background shadow-glass-sm"
            >
              K
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-display text-sm font-semibold tracking-tighter-text">
                Zainstaluj FaktWay
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {isIOS
                  ? 'Dodaj do ekranu głównego dla pełnego doświadczenia'
                  : 'Wystawiaj faktury z telefonu jak natywna aplikacja'}
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5"
              aria-label="Zamknij"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {isIOS ? (
            <IOSInstructions />
          ) : (
            <div className="mt-4 flex gap-2">
              <Button
                variant="glass-primary"
                size="sm"
                type="button"
                onClick={async () => {
                  const accepted = await promptInstall();
                  if (accepted) dismiss();
                }}
                className="flex-1"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Zainstaluj
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={dismiss}>
                Później
              </Button>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

/** Safari na iOS nie wspiera `beforeinstallprompt`. */
function IOSInstructions() {
  return (
    <div className="mt-4 rounded-2xl border border-glass-border/50 bg-foreground/5 p-3">
      <ol className="space-y-2 text-xs text-foreground">
        <li className="flex items-center gap-2">
          <span className="font-medium text-muted-foreground">1.</span>
          <span>Naciśnij</span>
          <Share className="inline h-3.5 w-3.5" aria-hidden />
          <span>w pasku Safari</span>
        </li>
        <li className="flex items-center gap-2">
          <span className="font-medium text-muted-foreground">2.</span>
          <span>Wybierz</span>
          <span className="font-medium">Do ekranu początkowego</span>
          <Plus className="inline h-3.5 w-3.5" aria-hidden />
        </li>
        <li className="flex items-center gap-2">
          <span className="font-medium text-muted-foreground">3.</span>
          <span>Naciśnij</span>
          <span className="font-medium">Dodaj</span>
        </li>
      </ol>
    </div>
  );
}
