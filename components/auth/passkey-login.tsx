'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { RiFingerprintLine } from '@remixicon/react';

import { AuthMessage } from '@/components/auth/finora/auth-message';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { passkeyButtonAvailable, signInWithPasskey } from '@/lib/auth/passkey/client';
import { PASSKEY_SUGGESTION_HINT } from '@/lib/auth/passkey/messages';
import { cn } from '@/lib/utils';

const subscribeToNothing = () => () => {};

// Wyzwanie żyje na serwerze 5 minut (`lib/auth/passkey/challenges.ts`). Na telefonie bez
// zapamiętanego klucza przycisk działa tylko przez podpowiedź, więc odświeżamy ją wcześniej.
const SUGGESTION_MAX_AGE_MS = 4 * 60_000;
// Odmowa szybsza niż 2 s nie była decyzją klienta: wtedy nie uzbrajamy podpowiedzi sami,
// żeby nie pytać serwera w kółko. Następne dotknięcie przycisku i tak ją uzbroi.
const MIN_USER_ATTEMPT_MS = 2_000;

/**
 * Przycisk „Zaloguj biometrią” i podpowiedź w polu e-mail (`autocomplete="username webauthn"`).
 * Bez WebAuthn komponent nic nie pokazuje. Pole adresu i hasła działają niezależnie od niego.
 *
 * Podpowiedź przeglądarki prosi o wyzwanie przy każdym wejściu na stronę; kliknięcie
 * przycisku ją przerywa, a po nieudanej próbie uzbrajamy ją od nowa. Wyzwanie żyje
 * 5 minut, więc po dłuższym czekaniu serwer odmówi i klient dostanie zwykły komunikat.
 */
export function PasskeyLogin({
  redirectTo,
  withSeparator,
  emailFieldId = 'email',
}: {
  redirectTo?: string;
  withSeparator: boolean;
  /** Pole e-mail z `autocomplete="username webauthn"`, w którym przeglądarka pokazuje klucze. */
  emailFieldId?: string;
}) {
  // Serwer nie wie, co potrafi przeglądarka, więc na serwerze przycisku nie ma.
  const supported = useSyncExternalStore(subscribeToNothing, browserSupportsWebAuthn, () => false);
  // Telefon bez zapamiętanego klucza nie otwiera okna systemowego, bo to pokazałoby kod QR
  // (`lib/auth/passkey/client.ts`). Przycisk prowadzi wtedy do podpowiedzi w polu e-mail,
  // więc pokazujemy go dopiero, gdy przeglądarka ją obsługuje.
  const knowsDeviceKey = useSyncExternalStore(subscribeToNothing, passkeyButtonAvailable, () => false);
  const [suggestionReady, setSuggestionReady] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const explicitAttempt = useRef(false);
  // Kiedy bieżąca podpowiedź dostała wyzwanie; `null`, gdy żadna nie czeka.
  const armedAt = useRef<number | null>(null);
  // Nowa podpowiedź przerywa poprzednią; jej zakończenie nie może już nic zmieniać.
  const generation = useRef(0);
  const rearm = useRef<() => void>(() => {});

  const armAutofill = useCallback(async () => {
    if (!(await browserSupportsWebAuthnAutofill()) || !mounted.current) return;
    const current = ++generation.current;
    const attempt: { armedAt: number | null } = { armedAt: null };
    const result = await signInWithPasskey({
      redirectTo,
      conditional: true,
      // Kliknięcie w trakcie pobierania wyzwania: podpowiedź nie może przerwać okna systemowego.
      isCancelled: () => explicitAttempt.current || !mounted.current,
      onArmed: () => {
        attempt.armedAt = Date.now();
        if (current !== generation.current) return;
        armedAt.current = attempt.armedAt;
        setSuggestionReady(true);
      },
    });
    if (current !== generation.current) return;
    armedAt.current = null;
    if (!mounted.current) return;
    if (result.ok) {
      window.location.assign(result.redirectTo);
      return;
    }
    // W tle milczymy, dopóki klient niczego nie wybrał: limit albo brak sieci nie są jego sprawą.
    if (result.stage === 'verify' && result.message) setError(result.message);
    // Wyzwanie jest jednorazowe. Po anulowanym Face ID albo nieudanej weryfikacji telefon bez
    // zapamiętanego klucza dostaje od razu nową podpowiedź, bo tylko ona prowadzi do logowania.
    const decidedByUser = attempt.armedAt !== null && Date.now() - attempt.armedAt >= MIN_USER_ATTEMPT_MS;
    if (result.message !== null && decidedByUser && !passkeyButtonAvailable()) rearm.current();
  }, [redirectTo]);

  useEffect(() => {
    rearm.current = () => void armAutofill();
  }, [armAutofill]);

  useEffect(() => {
    if (!supported) return undefined;
    mounted.current = true;
    void armAutofill();
    return () => {
      mounted.current = false;
      WebAuthnAbortService.cancelCeremony();
    };
  }, [supported, armAutofill]);

  useEffect(() => {
    if (!supported) return undefined;
    // Telefon bez zapamiętanego klucza: po powrocie do karty albo po dłuższym czekaniu
    // podpowiedź dostaje świeże wyzwanie, zanim stare wygaśnie.
    const refreshIfStale = () => {
      if (document.visibilityState !== 'visible' || passkeyButtonAvailable() || armedAt.current === null) return;
      if (Date.now() - armedAt.current > SUGGESTION_MAX_AGE_MS) rearm.current();
    };
    const timer = window.setInterval(refreshIfStale, 30_000);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [supported]);

  const onClick = async () => {
    if (!knowsDeviceKey) {
      // Podpowiedź pokazuje tylko klucze z tego telefonu. Fokus w tym samym dotknięciu
      // otwiera klawiaturę także na iPhonie.
      document.getElementById(emailFieldId)?.focus();
      setError(null);
      setShowHint(true);
      // Zużyta (anulowane Face ID, błąd) albo z wyzwaniem bliskim wygaśnięcia: nowa podpowiedź.
      const stale = armedAt.current === null || Date.now() - armedAt.current > SUGGESTION_MAX_AGE_MS;
      if (stale) void armAutofill();
      return;
    }
    setPending(true);
    setError(null);
    explicitAttempt.current = true;
    const result = await signInWithPasskey({ redirectTo });
    explicitAttempt.current = false;
    if (result.ok) {
      // Pełne przeładowanie: proxy ustawia aktywną firmę, a panel czyta świeże ciasteczka.
      window.location.assign(result.redirectTo);
      return;
    }
    setPending(false);
    if (result.message) setError(result.message);
    void armAutofill();
  };

  if (!supported) return null;
  if (!knowsDeviceKey && !suggestionReady) return error ? <AuthMessage tone="error">{error}</AuthMessage> : null;

  return (
    <>
      <Button type="button" variant="outline" className="min-h-[44px] w-full" disabled={pending} onClick={onClick}>
        <RiFingerprintLine aria-hidden />
        {pending ? 'Potwierdź na urządzeniu...' : 'Zaloguj biometrią'}
      </Button>
      {!knowsDeviceKey && (
        // Obszar komunikatu istnieje od początku, żeby czytnik ekranu ogłosił wskazówkę.
        <p role="status" className={cn('text-muted-foreground text-sm', !(showHint && !error) && 'sr-only')}>
          {showHint && !error ? PASSKEY_SUGGESTION_HINT : ''}
        </p>
      )}
      {error && <AuthMessage tone="error">{error}</AuthMessage>}
      {withSeparator && (
        <div className="flex items-center gap-4">
          <Separator className="flex-1" />
          <p>lub e‑mailem</p>
          <Separator className="flex-1" />
        </div>
      )}
    </>
  );
}
