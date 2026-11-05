import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Cron Co-Pilota rezerwuje okres (żeby paczka nie wyszła dwa razy) i wysyła
 * zdarzenie „wyślij paczkę”. pg-boss ponawia job OD POCZĄTKU. Do 01.10.2026
 * rezerwacje szły osobnymi krokami, a zdarzenia jednym wysłaniem na końcu:
 * błąd po drodze zostawiał okres zarezerwowany bez zdarzenia, ponowienie
 * pomijało firmę i paczka za miesiąc nie wychodziła wcale.
 */

type Settings = {
  id: string;
  tenant_id: string;
  co_pilot_enabled: boolean;
  send_day_of_month: number;
  accountant_email: string;
  accountant_name: string | null;
  preferred_formats: string[];
  last_sent_period_start: string | null;
  last_sent_period_end: string | null;
};

const state = vi.hoisted(() => ({
  settings: [] as Settings[],
  sent: [] as Array<{ name: string; data: { tenantId: string } }>,
  failSendFor: new Set<string>(),
  failReserveFor: new Set<string>(),
  failReleaseFor: new Set<string>(),
}));

vi.mock('@/lib/jobs/enqueue', () => ({
  sendJobEvent: vi.fn(async (event: { name: string; data: { tenantId: string } }) => {
    if (state.failSendFor.has(event.data.tenantId)) throw new Error('kolejka niedostępna');
    state.sent.push(event);
    return { ids: ['id'] };
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const eqs: Array<[string, unknown]> = [];
      // Lista firm idzie stronami po kluczu (sesja 27): kursor, porządek i limit jak w bazie.
      let afterId: string | null = null;
      let limitN: number | null = null;
      let patch: Partial<Settings> | null = null;
      let casPeriod: { start: string; end: string } | null = null;
      const q: Record<string, unknown> = {};
      const run = () => {
        const tenant = eqs.find(([k]) => k === 'tenant_id')?.[1] as string | undefined;
        if (!patch) {
          // Kopie, jak z prawdziwej bazy — job nie może widzieć późniejszych zmian wiersza.
          const rows = state.settings
            .filter((s) => eqs.every(([k, v]) => s[k as keyof Settings] === v) && (afterId === null || s.id > afterId))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, limitN ?? undefined);
          return { data: structuredClone(rows), error: null };
        }
        if (casPeriod && tenant && state.failReserveFor.has(tenant)) return { data: null, error: { message: 'chwilowy błąd bazy' } };
        if (!casPeriod && tenant && state.failReleaseFor.has(tenant)) return { data: null, error: { message: 'chwilowy błąd bazy' } };
        const rows = state.settings.filter((s) =>
          eqs.every(([k, v]) => s[k as keyof Settings] === v) &&
          (!casPeriod ||
            s.last_sent_period_start !== casPeriod.start ||
            s.last_sent_period_end !== casPeriod.end ||
            s.last_sent_period_start === null ||
            s.last_sent_period_end === null),
        );
        for (const r of rows) Object.assign(r, patch);
        return { data: rows.map((r) => ({ tenant_id: r.tenant_id })), error: null };
      };
      Object.assign(q, {
        select: () => q,
        update: (v: Partial<Settings>) => { patch = v; return q; },
        eq: (k: string, v: unknown) => { eqs.push([k, v]); return q; },
        gt: (k: string, v: string) => { if (k === 'id') afterId = v; return q; },
        order: () => q,
        limit: (n: number) => { limitN = n; return q; },
        or: () => { casPeriod = { start: patch!.last_sent_period_start!, end: patch!.last_sent_period_end! }; return q; },
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, err),
      });
      return q;
    },
  }),
}));

import { runCoPilotMonthly } from '@/lib/jobs/runners/co-pilot-monthly';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const firma = (tenant_id: string, last: string | null = '2026-08-01'): Settings => ({
  id: `ustawienia-${tenant_id}`,
  tenant_id,
  co_pilot_enabled: true,
  send_day_of_month: 5,
  accountant_email: 'ksiegowa@example.test',
  accountant_name: 'Księgowa',
  preferred_formats: ['kpir_excel'],
  last_sent_period_start: last,
  last_sent_period_end: last ? '2026-08-31' : null,
});
const wyslane = (tenant: string) => state.sent.filter((e) => e.data.tenantId === tenant).length;

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T08:00:00+02:00'));
  state.settings = [firma('firma-a'), firma('firma-b', null)];
  state.sent = [];
  state.failSendFor.clear();
  state.failReserveFor.clear();
  state.failReleaseFor.clear();
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  log.mockRestore();
});

describe('Co-Pilot: rezerwacja okresu a ponowienie crona', () => {
  it('każda firma dostaje jedno zdarzenie za wrzesień', async () => {
    expect(await runCoPilotMonthly(ctx)).toMatchObject({ triggered: 2, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(wyslane('firma-a')).toBe(1);
    expect(wyslane('firma-b')).toBe(1);
  });

  it('błąd bazy przy drugiej firmie — po ponowieniu obie mają paczkę, żadna podwójnie', async () => {
    state.failReserveFor.add('firma-b');
    await expect(runCoPilotMonthly(ctx)).rejects.toThrow('chwilowy błąd bazy');
    expect(wyslane('firma-a')).toBe(1);

    state.failReserveFor.clear();
    expect(await runCoPilotMonthly(ctx)).toMatchObject({ triggered: 1 });
    expect(wyslane('firma-a')).toBe(1);
    expect(wyslane('firma-b')).toBe(1);
  });

  it('zdarzenie nie wyszło — rezerwacja wraca, ponowienie wysyła paczkę', async () => {
    state.failSendFor.add('firma-b');
    await expect(runCoPilotMonthly(ctx)).rejects.toThrow('kolejka niedostępna');
    expect(state.settings[1]).toMatchObject({ last_sent_period_start: null, last_sent_period_end: null });

    state.failSendFor.clear();
    await runCoPilotMonthly(ctx);
    expect(wyslane('firma-a')).toBe(1);
    expect(wyslane('firma-b')).toBe(1);
    expect(state.settings[1]).toMatchObject({ last_sent_period_start: '2026-09-01', last_sent_period_end: '2026-09-30' });
  });

  it('zwolnienie rezerwacji się nie udało — błąd wysłania dalej przerywa job, a log mówi o utraconej paczce', async () => {
    state.failSendFor.add('firma-a');
    state.failReleaseFor.add('firma-a');
    await expect(runCoPilotMonthly(ctx)).rejects.toThrow('kolejka niedostępna');
    expect(String(log.mock.calls[0]?.[0])).toContain('nie udało się zwolnić rezerwacji');
  });

  it('okres już wysłany w tym miesiącu — bez drugiej paczki', async () => {
    state.settings = [{ ...firma('firma-a'), last_sent_period_start: '2026-09-01', last_sent_period_end: '2026-09-30' }];
    expect(await runCoPilotMonthly(ctx)).toMatchObject({ triggered: 0 });
    expect(state.sent).toHaveLength(0);
  });
});
