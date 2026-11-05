/** Nazwa urządzenia na liście w ustawieniach. Ograniczenie: CHECK w 00159. */

export const MAX_DEVICE_LABEL_LENGTH = 60;
const FALLBACK = 'Urządzenie';

const PLATFORMS: Array<[RegExp, string]> = [
  [/iPhone|iPod/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'Chromebook'],
  [/Linux/, 'Linux'],
];
// Kolejność ma znaczenie: Edge i Opera też mają w nazwie „Chrome”, a Chrome „Safari”.
const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

function match(table: Array<[RegExp, string]>, userAgent: string): string | null {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
}

export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return FALLBACK;
  const platform = match(PLATFORMS, userAgent);
  const browser = match(BROWSERS, userAgent);
  if (platform && browser) return `${platform} (${browser})`;
  return platform ?? browser ?? FALLBACK;
}

/** Bez znaków sterujących i nadmiaru; nazwa z aplikacji natywnej pochodzi od klienta. */
export function sanitizeDeviceLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const printable = Array.from(raw)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return printable ? Array.from(printable).slice(0, MAX_DEVICE_LABEL_LENGTH).join('').trim() : null;
}
