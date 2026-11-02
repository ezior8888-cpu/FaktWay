/**
 * Przełącznik wpuszczania telefonów do panelu (zdejmowanie BUG-008).
 *
 * DLACZEGO `NEXT_PUBLIC_*`, SKORO TO NIE JEST DANA PUBLICZNA.
 * Bramka siedzi w `proxy.ts`, a ten jest bundlowany pod Edge — Next.js
 * WSTAWIA tam wartości `process.env` w czasie budowania. Do tego Dockerfile
 * przekazuje do builda wyłącznie argumenty `NEXT_PUBLIC_*` (wiersze 43-52).
 * Zmienna nazwana `MOBILE_PANEL` byłaby więc w gotowym obrazie `undefined`,
 * czyli blokada nigdy by nie zeszła, a objaw („ustawiłem zmienną i nic")
 * nie wskazywałby na przyczynę.
 *
 * Cena: lista identyfikatorów trafia do paczki przeglądarki. To są nieprzezroczyste
 * UUID-y bez wartości poznawczej, a sama bramka NIE JEST granicą bezpieczeństwa —
 * to decyzja produktowa o tym, komu pokazujemy niedokończony interfejs. Dostęp do
 * danych pilnują dalej auth i RLS, dokładnie tak samo jak na komputerze.
 *
 * Zmiana listy wymaga przebudowania obrazu (12-18 minut). Przy jednym, dwóch
 * wpisach to nie jest problem; gdyby lista miała rosnąć, właściwym miejscem
 * jest `global_feature_flags` i odczyt poza proxy.
 *
 * FAIL-CLOSED: brak zmiennej = `off` = zachowanie sprzed zmiany.
 */

/**
 * Telefon, nie tablet: `Android` bez `Mobile` w UA to tablet, podobnie iPad.
 * Czytają to bramka w proxy i ekran logowania („Zapamiętaj mnie”, propozycja biometrii).
 */
const PHONE_UA_RE = /iPhone|iPod|Windows Phone|Android(?=.*\bMobile\b)/i;

export function isPhoneUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && PHONE_UA_RE.test(userAgent);
}

/** `off` — wszystkie telefony na `/mobile`. `allowlist` — tylko wskazane konta. `on` — każdy. */
export type MobilePanelMode = 'off' | 'allowlist' | 'on';

const MODES = new Set<MobilePanelMode>(['off', 'allowlist', 'on']);

export function mobilePanelMode(): MobilePanelMode {
  const raw = (process.env.NEXT_PUBLIC_MOBILE_PANEL ?? '').trim().toLowerCase();
  return MODES.has(raw as MobilePanelMode) ? (raw as MobilePanelMode) : 'off';
}

/** Identyfikatory `sub` z JWT, po przecinku. Puste wpisy pomijamy. */
function allowlist(): Set<string> {
  return new Set(
    (process.env.NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/**
 * Czy ten telefon ma wejść do panelu?
 *
 * `isDevEnv` wstrzykujemy zamiast wołać `isLocalDevEnv()` w środku, żeby moduł
 * dał się przetestować bez grzebania w `process.env` na trzy sposoby naraz —
 * i żeby wywołanie w proxy było jawne co do tego, że lokalnie wpuszczamy
 * wszystko (inaczej projekty `mobile-*` w Playwrighcie nie mają jak działać).
 */
export function isMobilePanelAllowed({
  userId,
  isDevEnv = false,
}: {
  userId: string | null;
  isDevEnv?: boolean;
}): boolean {
  if (isDevEnv) return true;

  switch (mobilePanelMode()) {
    case 'on':
      return true;
    case 'allowlist':
      return userId !== null && allowlist().has(userId);
    case 'off':
      return false;
  }
}
