import { generateAccountantToken, hashToken } from '@/lib/accountant/tokens';

/**
 * Token adresu kalendarza (krok 7.3): 32 losowe bajty (256 bitów) w base64url,
 * czyli 43 znaki; w bazie tylko skrót SHA-256 (hex). Ta sama konstrukcja co
 * token linku dla księgowej.
 */

/** Nazwa pliku w adresie: dokładnie 43 znaki base64url i `.ics`. */
const NAZWA_PLIKU = /^([A-Za-z0-9_-]{43})\.ics$/;

export function generujTokenKalendarza(): { token: string; hash: string } {
  return generateAccountantToken();
}

export function skrotTokenuKalendarza(token: string): string {
  return hashToken(token);
}

/** Token z ostatniego segmentu adresu albo `null`, gdy kształt nie pasuje (wtedy nawet nie pytamy bazy). */
export function tokenZNazwyPliku(plik: string): string | null {
  return NAZWA_PLIKU.exec(plik)?.[1] ?? null;
}

export function adresKalendarza(token: string): string {
  const baza = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
  return `${baza}/api/kalendarz/${token}.ics`;
}
