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

const subscribeToNothing = () => () => {};

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

  const armAutofill = useCallback(async () => {
    if (!(await browserSupportsWebAuthnAutofill()) || !mounted.current) return;
    setSuggestionReady(true);
    const result = await signInWithPasskey({
      redirectTo,
      conditional: true,
      // Kliknięcie w trakcie pobierania wyzwania: podpowiedź nie może przerwać okna systemowego.
      isCancelled: () => explicitAttempt.current || !mounted.current,
    });
    if (!mounted.current) return;
    if (result.ok) {
      window.location.assign(result.redirectTo);
      return;
    }
    // W tle milczymy, dopóki klient niczego nie wybrał: limit albo brak sieci nie są jego sprawą.
    if (result.stage === 'verify' && result.message) setError(result.message);
  }, [redirectTo]);

  useEffect(() => {
    if (!supported) return undefined;
    mounted.current = true;
    void armAutofill();
    return () => {
      mounted.current = false;
      WebAuthnAbortService.cancelCeremony();
    };
  }, [supported, armAutofill]);

  const onClick = async () => {
    if (!knowsDeviceKey) {
      // Podpowiedź jest już uzbrojona i pokazuje tylko klucze z tego telefonu. Fokus w tym
      // samym dotknięciu otwiera klawiaturę także na iPhonie.
      document.getElementById(emailFieldId)?.focus();
      setShowHint(true);
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
      {showHint && !error && <p role="status" className="text-muted-foreground text-sm">{PASSKEY_SUGGESTION_HINT}</p>}
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
