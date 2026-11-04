import 'server-only';

import { getTrustedAppOrigin } from '@/lib/auth/trusted-origin';

/**
 * Jedyne miejsce z RP ID i listą dozwolonych originów.
 *
 * RP ID jest na stałe wpisany w poświadczenia: po zmianie domeny stare urządzenia
 * przestają logować, dlatego bierzemy go z konfiguracji (`NEXT_PUBLIC_APP_URL`),
 * nigdy z nagłówków żądania. Produkcja: `faktway.pl`, także z `www`. Adres IP
 * nie może być RP ID, więc lokalnie działa tylko `localhost`.
 *
 * Aplikacje natywne dopiszą tu swój origin (`android:apk-key-hash:...`), kiedy
 * znany będzie odcisk klucza.
 */

export interface PasskeyConfig {
  rpId: string;
  rpName: string;
  origins: string[];
}

const RP_NAME = 'FaktWay';
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

export function getPasskeyConfig(): PasskeyConfig | null {
  const origin = getTrustedAppOrigin();
  if (!origin) return null;
  const { hostname, protocol } = new URL(origin);
  if (IPV4_PATTERN.test(hostname) || hostname.startsWith('[')) return null;
  if (hostname === 'localhost') return { rpId: hostname, rpName: RP_NAME, origins: [origin] };
  const rpId = hostname.replace(/^www\./, '');
  return {
    rpId,
    rpName: RP_NAME,
    origins: [`${protocol}//${rpId}`, `${protocol}//www.${rpId}`],
  };
}

/**
 * Przeglądarka przy POST i DELETE zawsze wysyła `Origin`, także międzydomenowo
 * (ewentualnie `null`), więc obcy albo pusty adres odrzucamy. Brak nagłówka to klient
 * spoza przeglądarki (aplikacja natywna): nie niesie cudzych ciasteczek, a asercję
 * i tak weryfikuje WebAuthn po `clientDataJSON.origin`.
 */
export function isRequestOriginAllowed(request: Request, config: PasskeyConfig): boolean {
  const origin = request.headers.get('origin');
  return origin === null || config.origins.includes(origin);
}
