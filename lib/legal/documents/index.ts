import type { LegalDocument } from '@/lib/legal/doc-model';

import { POLITYKA_COOKIES } from './polityka-cookies';
import { POLITYKA_PRYWATNOSCI } from './polityka-prywatnosci';
import { REGULAMIN } from './regulamin';
import { UMOWA_POWIERZENIA } from './umowa-powierzenia';

export { POLITYKA_COOKIES, POLITYKA_PRYWATNOSCI, REGULAMIN, UMOWA_POWIERZENIA };

/** Kolejność = kolejność w nawigacji stron /legal. */
export const LEGAL_DOCUMENTS: ReadonlyArray<{ href: string; label: string; doc?: LegalDocument }> = [
  { href: '/legal/regulamin', label: 'Regulamin', doc: REGULAMIN },
  { href: '/legal/umowa-powierzenia', label: 'Umowa powierzenia danych', doc: UMOWA_POWIERZENIA },
  { href: '/legal/polityka-prywatnosci', label: 'Polityka prywatności', doc: POLITYKA_PRYWATNOSCI },
  { href: '/legal/cookies', label: 'Polityka cookies', doc: POLITYKA_COOKIES },
  { href: '/legal/podprocesorzy', label: 'Podmioty przetwarzające' },
  { href: '/legal/rodo', label: 'RODO i bezpieczeństwo' },
];

/** Dokumenty umowy — te idą do klienta mailem jako trwały nośnik. */
export const CONTRACT_DOCUMENTS: readonly LegalDocument[] = [REGULAMIN, UMOWA_POWIERZENIA];
