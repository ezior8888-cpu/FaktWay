import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EVENT_QUEUE_MAP } from '@/lib/jobs/queues';

import { bezKomentarzyTs, plikiKodu, toPosix } from '../helpers/schema-z-migracji';

/**
 * Każde zadanie czekające na zdarzenie ma KOGOŚ, kto to zdarzenie wysyła.
 *
 * `jobs-foundation.test.ts` pilnuje, że mapa kolejek zgadza się z klientem
 * Inngest, a `jobs-registry.test.ts` — że kolejki i handlery się pokrywają
 * (od PR #47 w obu kierunkach). Nic nie pilnowało trzeciego ogniwa: czy ktokolwiek to zdarzenie publikuje. Job bez
 * nadawcy jest zarejestrowany, przetestowany i martwy — w przeglądzie
 * 24–25.09 był to najczęstszy wzorzec (X-05, wykonawca K-01, maile triala).
 *
 * Nadawca to wywołanie `<stała>.create(…)` (stała z `lib/jobs/events.ts`)
 * albo zdarzenie podane napisem: `{ name: '…' }` lub `send…('…')`.
 */

const ROOT = process.cwd();
const KLIENT = 'lib/jobs/events.ts';

/** Nazwa zdarzenia → nazwa stałej, którą się je tworzy. */
function staleZdarzen(): Map<string, string> {
  const kod = readFileSync(join(ROOT, KLIENT), 'utf8');
  return new Map(
    [...kod.matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*(?:zodEvent\(\s*|jobEvent<[\s\S]*?>\(\s*)'([^']+)'/g)].map(
      (m) => [m[2]!, m[1]!] as const,
    ),
  );
}

const PLIKI = ['lib', 'app']
  .flatMap((d) => plikiKodu(join(ROOT, d)))
  .map((f) => ({ plik: toPosix(f).replace(toPosix(ROOT) + '/', ''), sciezka: f }))
  .filter(({ plik }) => !/\.test\.tsx?$/.test(plik) && plik !== KLIENT && plik !== 'lib/jobs/queues.ts')
  .map(({ plik, sciezka }) => ({ plik, kod: bezKomentarzyTs(readFileSync(sciezka, 'utf8')) }));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function nadawcy(zdarzenie: string, stala: string | undefined): string[] {
  const wzorce = [
    ...(stala ? [new RegExp(`\\b${stala}\\.create\\(`)] : []),
    new RegExp(`name:\\s*'${escape(zdarzenie)}'`),
    new RegExp(`(?:send|emit|enqueue)[A-Za-z]*\\(\\s*'${escape(zdarzenie)}'`),
  ];
  return PLIKI.filter(({ kod }) => wzorce.some((w) => w.test(kod))).map(({ plik }) => plik);
}

/**
 * Znany dług — lista nie może rosnąć po cichu ani trzymać wpisów naprawionych.
 */
const ZNANE: Record<string, string> = {
  // Maile triala z dnia 12 i 14 wstrzymane 01.10.2026 (sprzeczne z regulaminem
  // i retencją — `email-sequence.ts`, `runEmailDay8`). Kolejki zostają, żeby
  // odebrać zdarzenia zaplanowane przed wdrożeniem; po ~14 dniach od wdrożenia
  // można usunąć kolejki, joby i te dwa wpisy.
  'email/trial-day-12': 'wstrzymany 01.10.2026 — tylko odbiór starych zdarzeń',
  'email/trial-day-14': 'wstrzymany 01.10.2026 — tylko odbiór starych zdarzeń',
};

describe('każde zdarzenie z kolejką ma nadawcę', () => {
  const STALE = staleZdarzen();
  const ZDARZENIA = Object.keys(EVENT_QUEUE_MAP);

  it('rozpoznaje stałe zdarzeń w kliencie (inaczej skan widziałby tylko napisy)', () => {
    expect(STALE.get('reminders/send.requested')).toBe('remindersSendRequested');
    expect(STALE.get('invoice/submit.requested')).toBe('invoiceSubmitRequested');
    expect(STALE.size).toBeGreaterThanOrEqual(ZDARZENIA.length - Object.keys(ZNANE).length);
  });

  it('widzi nadawców przez stałą i przez napis', () => {
    expect(nadawcy('reminders/send.requested', STALE.get('reminders/send.requested'))).toContain(
      'lib/flo/functions/payment-chase-handler.ts',
    );
    expect(nadawcy('invoice/submit.requested', STALE.get('invoice/submit.requested'))).toContain(
      'lib/invoices/ksef-submit-enqueue.ts',
    );
  });

  it('żaden job nie czeka na zdarzenie, którego nikt nie wysyła', () => {
    const bezNadawcy = ZDARZENIA.filter(
      (z) => !(z in ZNANE) && nadawcy(z, STALE.get(z)).length === 0,
    );
    expect(
      bezNadawcy,
      'Job zarejestrowany, ale nikt nie publikuje jego zdarzenia — nigdy się nie uruchomi.',
    ).toEqual([]);
  });

  it('lista znanego długu nie trzyma wpisów już naprawionych', () => {
    const naprawione = Object.keys(ZNANE).filter((z) => nadawcy(z, STALE.get(z)).length > 0);
    expect(naprawione, 'To zdarzenie ma już nadawcę — usuń je z ZNANE.').toEqual([]);
  });
});
