import { describe, expect, it, vi } from 'vitest';

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

import { emptySweep, runSweep } from '@/lib/flo/sweep';
import {
  ruleRun,
  runFloTick,
  summarizeTick,
  type FloTickResult,
  type FloTickSources,
} from '@/lib/flo/tick';

import { createFakeDb } from './flo-fake-db';

/**
 * Wspólny szkielet przebiegu i kształt wyniku pulsu (plan FLO 2, K1.3).
 *
 * Do tego zadania każda reguła miała własną pętlę po kontach, własny blok
 * `catch` i własne słownictwo w wyniku. Testy pilnują trzech rzeczy:
 * izolacja awarii jest JEDNA dla wszystkich reguł, wynik ma jedną pozycję
 * na regułę, a liczby trafiają wreszcie do logów operatora.
 */

const NOW = new Date('2026-09-17T05:30:00.000Z');
/** Pierwszy dzień roboczy miesiąca — wtedy i tylko wtedy chodzi audyt. */
const AUDIT_DAY = new Date('2026-10-01T05:30:00.000Z');

function silentSources(): FloTickSources {
  return {
    listTenantIds: async () => [],
    readGlobalKill: async () => false,
    paymentConfirm: {
      readOverdueInvoices: async () => [],
      readInvoiceState: async () => ({ facts: {}, context: {} }),
      readGlobalKill: async () => false,
    },
    expenseMissing: {
      readRecentExpenses: async () => [],
      readGlobalKill: async () => false,
    },
    invoiceMissing: {
      readIssuedInvoices: async () => [],
      readGlobalKill: async () => false,
    },
    onboarding: { readAccount: async () => null, readGlobalKill: async () => false },
  };
}

function tickResult(overrides: Partial<FloTickResult> = {}): FloTickResult {
  return {
    expired: 0,
    released: 0,
    failedCleanup: [],
    rules: [],
    withheld: 0,
    failedTenants: 0,
    ...overrides,
  };
}

describe('Wspólny przebieg — izolacja awarii', () => {
  it('konto, które padło, nie zabiera kart pozostałym', async () => {
    // To jest wymaganie bezpieczeństwa, nie wygoda. Wcześniej stało
    // w pięciu kopiach; teraz w jednym miejscu, więc i test jest jeden.
    captureException.mockClear();
    const widziane: string[] = [];
    const errors: string[] = [];

    const result = await runSweep(
      'payment.confirm',
      ['ten-1', 'ten-zly', 'ten-3'],
      async (tenantId) => {
        widziane.push(tenantId);
        if (tenantId === 'ten-zly') throw new Error('timeout zapytania');
        return { asked: 1 };
      },
      { error: (message: string) => errors.push(message) },
    );

    expect(widziane).toEqual(['ten-1', 'ten-zly', 'ten-3']);
    expect(result).toEqual({ asked: 2, closed: 0, failed: 1 });
    expect(errors[0]).toContain('ten-zly');
    expect(captureException.mock.calls[0]![1]).toMatchObject({
      tags: { job: 'flo-tick', kind: 'payment.confirm', tenant_id: 'ten-zly' },
    });
  });

  it('do Sentry i do logów idzie konto i rodzaj, nie treść błędu klienta', async () => {
    captureException.mockClear();
    const errors: string[] = [];

    await runSweep(
      'expense.missing',
      ['ten-1'],
      async () => {
        throw new Error('Nowak Sp. z o.o. — faktura FV/2026/09/1');
      },
      { error: (message: string) => errors.push(message) },
    );

    // Treść wyjątku bywa jedynym tropem, więc w logu workera zostaje —
    // ale identyfikacja idzie po koncie i rodzaju, nie po danych klienta.
    expect(captureException.mock.calls[0]![1]).toMatchObject({
      tags: { kind: 'expense.missing', tenant_id: 'ten-1' },
    });
    expect(errors[0]).toContain('ten-1');
    expect(errors[0]).toContain('expense.missing');
  });

  it('brak pola w wyniku konta znaczy zero, nie „nie wiem"', async () => {
    const result = await runSweep('invoice.draft', ['a', 'b'], async () => ({}));

    expect(result).toEqual({ asked: 0, closed: 0, failed: 0 });
    expect(emptySweep()).toEqual({ asked: 0, closed: 0, failed: 0 });
  });

  it('pusty przebieg nie jest współdzielonym obiektem', () => {
    // Gdyby `emptySweep` zwracał stałą, dwie reguły liczyłyby się nawzajem.
    const a = emptySweep();
    a.asked = 7;

    expect(emptySweep().asked).toBe(0);
  });
});

describe('Wynik pulsu — jedna pozycja na regułę', () => {
  it('każda reguła ma swoją pozycję, w kolejności przebiegu', async () => {
    const db = createFakeDb({});

    const result = await runFloTick(undefined, NOW, db.client, silentSources());

    expect(result.rules.map((rule) => rule.kind)).toEqual([
      'ksef.audit',
      'payment.confirm',
      'expense.missing',
      'invoice.draft',
      'onboarding.step',
    ]);
  });

  it('reguła, która dziś nie startowała, ma zera — a nie znika z wyniku', async () => {
    // 17 września to nie pierwszy dzień roboczy miesiąca, więc audyt nie
    // chodzi. „Nie ma pozycji" znaczyłoby „nie ma takiej reguły" — co innego
    // niż „przeszła i nie miała nic do powiedzenia".
    const db = createFakeDb({});

    const result = await runFloTick(undefined, NOW, db.client, silentSources());

    expect(ruleRun(result, 'ksef.audit')).toEqual({
      kind: 'ksef.audit',
      asked: 0,
      closed: 0,
      failed: 0,
    });
  });

  it('pierwszego dnia roboczego miesiąca audyt startuje', async () => {
    const db = createFakeDb({});
    const widziane: string[] = [];

    await runFloTick(undefined, AUDIT_DAY, db.client, {
      ...silentSources(),
      listTenantIds: async () => {
        widziane.push('lista');
        return [];
      },
    });

    // Bez kont nie ma czego audytować, ale reguła przeszła — zera z pozycją.
    expect(widziane).toEqual(['lista']);
  });

  it('odczyt reguły spoza wyniku daje zera, a nie wyjątek', () => {
    const result = tickResult({
      rules: [{ kind: 'payment.confirm', asked: 2, closed: 1, failed: 0 }],
    });

    expect(ruleRun(result, 'payment.confirm').asked).toBe(2);
    expect(ruleRun(result, 'ksef.audit')).toEqual({
      kind: 'ksef.audit',
      asked: 0,
      closed: 0,
      failed: 0,
    });
  });

  it('awarie kont sumują się ze wszystkich reguł', async () => {
    // Obie reguły wpuszczone jawnym wpisem operatora — bramka kanarka
    // stoi PRZED odczytami, więc bez tego nic by nawet nie padło.
    const db = createFakeDb({
      flo_kind_flags: [
        { tenant_id: 'ten-1', kind: 'payment.confirm', enabled: true, reason: 'alfa' },
        { tenant_id: 'ten-1', kind: 'onboarding.step', enabled: true, reason: 'alfa' },
      ],
    });

    const result = await runFloTick(undefined, NOW, db.client, {
      ...silentSources(),
      listTenantIds: async () => ['ten-1'],
      paymentConfirm: {
        readOverdueInvoices: async () => {
          throw new Error('baza nie odpowiada');
        },
        readInvoiceState: async () => ({ facts: {}, context: {} }),
        readGlobalKill: async () => false,
      },
      onboarding: {
        readAccount: async () => {
          throw new Error('baza nie odpowiada');
        },
        readGlobalKill: async () => false,
      },
    });

    // To samo konto padło w dwóch regułach i liczy się dwa razy — puls
    // za każdym razem poszedł dalej.
    expect(result.failedTenants).toBe(2);
    expect(ruleRun(result, 'payment.confirm').failed).toBe(1);
    expect(ruleRun(result, 'onboarding.step').failed).toBe(1);
  });
});

describe('Linia do logów operatora', () => {
  it('sprzątanie zostaje zawsze — jest dowodem, że puls się odbył', () => {
    expect(summarizeTick(tickResult({ expired: 3, released: 1 }))).toBe(
      'wygasłe 3 · podniesione 1',
    );
  });

  it('reguły, które nic nie zrobiły, nie zaśmiecają linii', () => {
    const line = summarizeTick(
      tickResult({
        rules: [
          { kind: 'ksef.audit', asked: 0, closed: 0, failed: 0 },
          { kind: 'payment.confirm', asked: 2, closed: 1, failed: 0 },
        ],
      }),
    );

    expect(line).toBe('wygasłe 0 · podniesione 0 · payment.confirm +2/-1');
    expect(line).not.toContain('ksef.audit');
  });

  it('awarie i zatrzymane karty są widoczne w linii', () => {
    const line = summarizeTick(
      tickResult({
        rules: [{ kind: 'expense.missing', asked: 1, closed: 0, failed: 2 }],
        withheld: 4,
      }),
    );

    expect(line).toContain('expense.missing +1/-0 (awarie 2)');
    expect(line).toContain('limit zatrzymał 4');
  });

  it('reguła z samymi awariami nie znika z linii', () => {
    // Zero kart i dwie awarie to NAJWAŻNIEJSZY przypadek do zobaczenia —
    // wygląda jak cisza, a jest zepsutą regułą.
    const line = summarizeTick(
      tickResult({
        rules: [{ kind: 'invoice.draft', asked: 0, closed: 0, failed: 2 }],
      }),
    );

    expect(line).toContain('invoice.draft +0/-0 (awarie 2)');
  });

  it('puls naprawdę zapisuje tę linię do logów workera', async () => {
    // Bez tego wynik pulsu nie trafia NIGDZIE: worker ignoruje zwrotkę
    // handlera, więc liczby czytałyby wyłącznie testy.
    const db = createFakeDb({});
    const lines: string[] = [];
    const logger = {
      info: (message: string) => lines.push(message),
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    await runFloTick(
      { logger, step: undefined as never, attempt: 0 },
      NOW,
      db.client,
      silentSources(),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[flo.tick]');
    expect(lines[0]).toContain('wygasłe 0');
  });
});
