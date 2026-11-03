'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';

import {
  ANALYTICS_CONSENT_EVENT,
  CONSENT_KEY,
  getAnalyticsConsent,
  isAnalyticsConfigured,
} from '@/lib/analytics/consent';
import { chooseAnalyticsConsent } from '@/lib/analytics/consent-sync';
import { ANALYTICS_STATEMENT } from '@/lib/legal/versions';

function subscribeConsent(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONSENT_KEY || event.key === null) onChange();
  };
  window.addEventListener(ANALYTICS_CONSENT_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ANALYTICS_CONSENT_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function ConsentBanner() {
  const visible = useSyncExternalStore(
    subscribeConsent,
    () => isAnalyticsConfigured() && getAnalyticsConsent() === 'unset',
    () => false,
  );
  if (!visible) return null;

  const grant = () => {
    chooseAnalyticsConsent(true);
  };

  const deny = () => {
    chooseAnalyticsConsent(false);
  };

  return (
    <div className="fixed bottom-5 left-5 right-5 z-[60] mx-auto max-w-2xl rounded-2xl border border-glass-border bg-background/95 px-4 py-3 shadow-xl backdrop-blur-glass-lg sm:left-auto sm:right-5">
      <div className="flex items-start gap-3">
        <div className="flex-1 text-sm">
          <p className="font-medium">Analityka i pomoc w rozwoju produktu</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {ANALYTICS_STATEMENT.text} Szczegóły:{' '}
            <Link
              href="/legal/cookies"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Polityka cookies
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          aria-label="Zamknij: tylko niezbędne"
          onClick={deny}
          className="rounded-full p-1.5 transition-colors hover:bg-foreground/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={grant}
          className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Akceptuję
        </button>
        <button
          type="button"
          onClick={deny}
          className="rounded-xl border border-glass-border px-4 py-2 text-sm hover:bg-foreground/5"
        >
          Tylko niezbędne
        </button>
      </div>
    </div>
  );
}
