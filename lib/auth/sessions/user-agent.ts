import { userAgentParts } from '@/lib/auth/passkey/device-label';
import { isPhoneUserAgent } from '@/lib/auth/phone-user-agent';

/**
 * Opis urządzenia na liście zalogowanych urządzeń i w historii logowań
 * (krok 8.5). Nazwy systemów i przeglądarek są te same co przy urządzeniach
 * biometrii („iPhone (Safari)”, „Mac (Chrome)”).
 *
 * `fromServer`: zapytanie wysłał serwer FaktWay, nie przeglądarka klienta.
 * Node (fetch z undici) przedstawia się jako „node”. Tak GoTrue zapisuje
 * w `auth.sessions` sesje, które aplikacja loguje i odświeża po stronie
 * serwera, a adres IP takiej sesji to adres serwera aplikacji. Ekran nie
 * pokazuje wtedy ani urządzenia, ani adresu.
 */

export type SessionDeviceKind = 'phone' | 'tablet' | 'computer' | 'unknown';

export interface SessionDevice {
  kind: SessionDeviceKind;
  /** `null`: nie wiemy, jakie to urządzenie. */
  label: string | null;
  fromServer: boolean;
}

const SERVER_USER_AGENT = /^(node|undici)(\/\S*)?$/i;
const TABLET_USER_AGENT = /iPad|Tablet|Android(?!.*\bMobile\b)/i;
const DESKTOP_PLATFORMS: ReadonlySet<string> = new Set(['Mac', 'Windows', 'Chromebook', 'Linux']);
const MAX_TOOL_LABEL_LENGTH = 40;

function printable(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join('');
}

/** Pierwsze słowo nagłówka spoza przeglądarki, np. „curl” z „curl/8.4.0”. */
function toolLabel(userAgent: string): string | null {
  const name = printable(userAgent.split(/[\s/;()]/)[0] ?? '').trim();
  return name ? Array.from(name).slice(0, MAX_TOOL_LABEL_LENGTH).join('') : null;
}

export function describeUserAgent(userAgent: string | null | undefined): SessionDevice {
  const value = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (!value) return { kind: 'unknown', label: null, fromServer: false };
  if (SERVER_USER_AGENT.test(value)) return { kind: 'unknown', label: null, fromServer: true };

  const { platform, browser } = userAgentParts(value);
  if (!platform && !browser) return { kind: 'unknown', label: toolLabel(value), fromServer: false };

  const label = platform && browser ? `${platform} (${browser})` : (platform ?? browser);
  let kind: SessionDeviceKind = 'unknown';
  if (isPhoneUserAgent(value)) kind = 'phone';
  else if (TABLET_USER_AGENT.test(value)) kind = 'tablet';
  else if (platform && DESKTOP_PLATFORMS.has(platform)) kind = 'computer';
  return { kind, label, fromServer: false };
}
