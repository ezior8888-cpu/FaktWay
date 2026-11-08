'use client';

import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { RiFingerprintLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { PASSKEY_OFFER_DISMISSED_KEY } from '@/lib/auth/device-cookies';
import { addPasskeyDevice, fetchPasskeyDevices, isHandheldDevice, readDeviceKeys } from '@/lib/auth/passkey/client';
import { PASSKEY_ALREADY_ON_DEVICE_MESSAGE } from '@/lib/auth/passkey/messages';

const TITLE = 'Włącz logowanie biometrią';

function isDismissed(): boolean {
  try {
    return window.localStorage.getItem(PASSKEY_OFFER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    window.localStorage.setItem(PASSKEY_OFFER_DISMISSED_KEY, '1');
  } catch {
    // Tryb prywatny: propozycja wróci przy następnym logowaniu hasłem, nic więcej.
  }
}

/**
 * Jednorazowa propozycja po logowaniu hasłem na telefonie. Pojawia się tylko, gdy
 * urządzenie ma biometrię, konto nie ma jeszcze dodanych urządzeń (albo ten telefon nie ma
 * swojego klucza) i sesja może je dodać.
 * Odrzucenie zostaje na tym urządzeniu. Ładuje ją `PasskeyEnrollOfferGate`.
 */
export function PasskeyEnrollOffer() {
  const [stage, setStage] = useState<'hidden' | 'offer' | 'pending' | 'done' | 'already'>('hidden');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDismissed() || !browserSupportsWebAuthn()) return undefined;
    let active = true;
    void (async () => {
      if (!(await platformAuthenticatorIsAvailable())) return;
      const list = await fetchPasskeyDevices();
      // Telefon bez własnego klucza dostaje propozycję także wtedy, gdy konto ma klucz
      // z innego urządzenia: bez niego logowanie biometrią na telefonie prowadziłoby do kodu QR.
      const phoneWithoutKey = isHandheldDevice() && readDeviceKeys().length === 0;
      if (active && list.ok && list.canManage && (list.devices.length === 0 || phoneWithoutKey)) setStage('offer');
    })();
    return () => { active = false; };
  }, []);

  if (stage === 'hidden') return null;

  const accept = async () => {
    setStage('pending');
    setError(null);
    const result = await addPasskeyDevice();
    if (result.ok) {
      rememberDismissal();
      setStage(result.alreadyOnDevice ? 'already' : 'done');
      return;
    }
    setStage('offer');
    if (result.message) setError(result.message);
  };

  const dismiss = () => {
    rememberDismissal();
    setStage('hidden');
  };

  return (
    <section
      aria-label={TITLE}
      className="border-border bg-card fixed right-4 bottom-[calc(1rem+var(--ff-bottom-nav-h)+var(--ff-safe-b))] left-4 z-40 flex flex-col gap-3 border p-4 shadow-lg lg:right-6 lg:left-auto lg:w-96"
    >
      {stage === 'done' || stage === 'already' ? (
        <>
          <p role="status" className="text-sm">
            {stage === 'already'
              ? PASSKEY_ALREADY_ON_DEVICE_MESSAGE
              : 'Gotowe. Następnym razem zalogujesz się biometrią. Urządzenia znajdziesz w Ustawienia → Bezpieczeństwo.'}
          </p>
          <div>
            <Button type="button" variant="outline" onClick={() => setStage('hidden')}>Zamknij</Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <RiFingerprintLine className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{TITLE}</p>
              <p className="text-muted-foreground text-xs">
                Następnym razem zalogujesz się odciskiem palca albo twarzą, bez hasła. Dane biometryczne zostają na telefonie.
              </p>
            </div>
          </div>
          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" className="min-h-[44px] flex-1" disabled={stage === 'pending'} onClick={accept}>
              {stage === 'pending' ? 'Potwierdź na urządzeniu...' : 'Włącz'}
            </Button>
            <Button type="button" variant="outline" className="min-h-[44px]" disabled={stage === 'pending'} onClick={dismiss}>
              Nie teraz
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
