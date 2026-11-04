'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import { PASSKEY_OFFER_COOKIE } from '@/lib/auth/device-cookies';

const PasskeyEnrollOffer = dynamic(
  () => import('./passkey-enroll-offer').then((m) => ({ default: m.PasskeyEnrollOffer })),
  { ssr: false, loading: () => null },
);

/** Klient najpierw widzi panel; propozycja nie ma wskakiwać razem z pierwszym widokiem. */
const OFFER_DELAY_MS = 800;

/**
 * Bramka propozycji biometrii: ciasteczko ustawia logowanie hasłem na telefonie
 * (`loginWithEmail`), a tu kasujemy je przy pokazaniu, żeby propozycja pojawiła się raz.
 * Biblioteka WebAuthn i sama propozycja ładują się tylko wtedy: reszta klientów
 * nie płaci za nie w paczce panelu (jak `InstallPrompt`).
 */
export function PasskeyEnrollOfferGate() {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const present = document.cookie.split('; ').some((cookie) => cookie.startsWith(`${PASSKEY_OFFER_COOKIE}=`));
    if (!present) return undefined;
    const timer = window.setTimeout(() => {
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${PASSKEY_OFFER_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
      setArmed(true);
    }, OFFER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return armed ? <PasskeyEnrollOffer /> : null;
}
