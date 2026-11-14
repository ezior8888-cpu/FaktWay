import { describe, expect, it } from 'vitest';

import type { NaleznoscTelefonu } from '../../mobile/src/lib/api/kontrakt';
import { nazwaPlikuPdf, podpisPrzypomnien, powodBezPodgladu } from '../../mobile/src/lib/naleznosci';

/**
 * Plan aplikacji mobilnej, M10a: należności na telefonie. Reguła „można
 * przygotować przypomnienie” musi być ta sama co na stronie „Po terminie”
 * (`canPrepareReminder` w `components/reminders/overdue-dashboard.tsx`): tylko
 * bez wstrzymania i bez przypomnienia w kolejce; nieznany odczyt kolejki blokuje.
 */

const n = (extra: Partial<NaleznoscTelefonu> = {}): NaleznoscTelefonu => ({
  id: '11111111-1111-4111-8111-111111111111',
  numer: 'FV/1/10/2026',
  kontrahent: 'Klient',
  nip: null,
  email: 'klient@example.test',
  termin: '2026-10-20',
  brutto: 1230,
  doZaplaty: 1230,
  dniPoTerminie: 24,
  wstrzymane: false,
  wyslane: 0,
  kolejka: 'brak',
  ostatnie: null,
  ...extra,
});

describe('powodBezPodgladu: ta sama reguła co strona', () => {
  it('przygotować można tylko bez wstrzymania i bez przypomnienia w kolejce', () => {
    expect(powodBezPodgladu(n())).toBeUndefined();
    expect(powodBezPodgladu(n({ ostatnie: { status: 'sent', etap: 1, kiedy: '2026-10-28T08:00:00Z' } }))).toBeUndefined();
  });

  it.each([
    [{ wstrzymane: true }, 'Przypomnienia wstrzymane'],
    [{ kolejka: 'zaplanowane' as const }, 'Przypomnienie już zlecone'],
    [{ kolejka: 'do_sprawdzenia' as const }, 'Wysyłka wymaga weryfikacji'],
    [{ kolejka: 'nieznany' as const }, 'Stan wysyłki niedostępny'],
  ])('%j blokuje: %s', (extra, powod) => {
    expect(powodBezPodgladu(n(extra))).toBe(powod);
  });
});

describe('podpisPrzypomnien', () => {
  it.each([
    [{}, 'Bez przypomnień'],
    [{ wstrzymane: true, kolejka: 'zaplanowane' as const }, 'Wstrzymane'],
    [{ kolejka: 'zaplanowane' as const }, 'Zaplanowane'],
    [{ kolejka: 'do_sprawdzenia' as const }, 'Do sprawdzenia'],
    [{ ostatnie: 'nieznany' as const }, 'Stan niedostępny'],
    [{ ostatnie: { status: 'sent' as const, etap: 2, kiedy: 'x' } }, 'Etap 2 · wysłane'],
    [{ ostatnie: { status: 'failed' as const, etap: 1, kiedy: 'x' } }, 'Etap 1 · nieudane'],
  ])('%j: %s', (extra, tekst) => {
    expect(podpisPrzypomnien(n(extra)).tekst).toBe(tekst);
  });

  it('„Bez przypomnień” nigdy, gdy odczytu nie było (nie mówimy na wyrost)', () => {
    expect(podpisPrzypomnien(n({ kolejka: 'nieznany', ostatnie: null })).tekst).toBe('Stan niedostępny');
  });
});

describe('nazwaPlikuPdf', () => {
  it.each([
    ['FV_1_11_2026.pdf', 'FV_1_11_2026.pdf'],
    ['FV/1/11/2026', 'FV_1_11_2026.pdf'],
    ['../../etc/passwd', '.._.._etc_passwd.pdf'],
    ['wezwanie.PDF', 'wezwanie.PDF'],
    ['   ', 'faktura.pdf'],
  ])('%j → %j', (wejscie, wynik) => {
    expect(nazwaPlikuPdf(wejscie)).toBe(wynik);
  });
});
