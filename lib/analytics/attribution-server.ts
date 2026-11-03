import 'server-only';

import { cookies } from 'next/headers';

import { ATTRIBUTION_COOKIE } from './attribution';

/**
 * Wylogowanie kasuje ciasteczko źródła wejścia: przy wspólnym komputerze (biuro
 * księgowe) nie przejdzie na kolejną osobę, która założy konto. Wylogowanie nie
 * zależy od analityki, więc błąd zapisu ciasteczka go nie przerywa.
 */
export async function forgetFirstTouchCookie(): Promise<void> {
  try {
    (await cookies()).set(ATTRIBUTION_COOKIE, '', { path: '/', maxAge: 0 });
  } catch {
    // Brak kontekstu żądania albo nieudany zapis: nic do sprzątania.
  }
}
