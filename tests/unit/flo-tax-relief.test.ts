import { describe, expect, it } from 'vitest';

import {
  buildReliefProposal,
  decideReliefNotice,
  NOTICE_BEFORE_DAYS,
  reliefWindows,
  type ReliefParams,
  type ReliefProfileInput,
} from '@/lib/flo/functions/tax-relief';
import { formatPln } from '@/lib/flo/money';
import { paramsFor, type TaxParams } from '@/lib/flo/tax-params';

/**
 * T-03 — zegar ulg na starcie (krok 38).
 *
 * Trzy awarie: zła data w profilu, zawieszenie policzone jak praca,
 * zła wiadomość bez konkretu „ile odkładać”.
 */

/**
 * Kwoty składek TESTOWE, nie parametry: od kroku K1 planu księgowości
 * funkcja dostaje je od wywołującego (atrapy usunięte z tabeli FLO).
 * Liczy się tylko to, że każdy etap jest droższy od poprzedniego.
 */
const ZUS_TESTOWE = { startRelief: 400, preferential: 700, standard: 1_600 };
const PARAMS: ReliefParams = {
  ...(paramsFor(new Date('2026-06-01T00:00:00.000Z')) as TaxParams),
  zusMonthly: ZUS_TESTOWE,
};
const d = (iso: string) => new Date(`${iso}T09:00:00.000Z`);

function profile(overrides: Partial<ReliefProfileInput> = {}): ReliefProfileInput {
  return { startedOn: '2026-01-15', usesStartRelief: true, ...overrides };
}

// ═══════════════════════════════════════════════════════════════
// Oś czasu
// ═══════════════════════════════════════════════════════════════

describe('oś czasu ulg', () => {
  it('ulga na start biegnie 6 miesięcy, preferencyjny ZUS kolejne 24', () => {
    const [start, preferential] = reliefWindows(profile(), PARAMS);

    expect(start?.startsOn).toBe('2026-01-15');
    expect(start?.endsOn).toBe('2026-07-15');
    expect(preferential?.startsOn).toBe('2026-07-15');
    expect(preferential?.endsOn).toBe('2028-07-15');
  });

  it('bez ulgi na start preferencyjny ZUS zaczyna się od razu', () => {
    const windows = reliefWindows(profile({ usesStartRelief: false }), PARAMS);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.kind).toBe('preferential');
    expect(windows[0]?.startsOn).toBe('2026-01-15');
  });

  it('koniec miesiąca nie ucieka na kolejny', () => {
    // 31 sierpnia + 6 miesięcy to 28 lutego, a nie 3 marca. Kilka dni
    // wystarczy, żeby komunikat wypadł po pierwszym wyższym przelewie.
    const [start] = reliefWindows(profile({ startedOn: '2026-08-31' }), PARAMS);
    expect(start?.endsOn).toBe('2027-02-28');
  });

  it('składki: co teraz, co potem', () => {
    const [start, preferential] = reliefWindows(profile(), PARAMS);
    expect(start?.monthly).toBe(PARAMS.zusMonthly.startRelief);
    expect(start?.nextMonthly).toBe(PARAMS.zusMonthly.preferential);
    expect(preferential?.nextMonthly).toBe(PARAMS.zusMonthly.standard);
  });
});

// ═══════════════════════════════════════════════════════════════
// AWARIA 1 — zła data
// ═══════════════════════════════════════════════════════════════

describe('AWARIA 1 — data, na której stoi cała funkcja', () => {
  it('brak daty rozpoczęcia = MILCZENIE, nie oszacowanie', () => {
    expect(
      decideReliefNotice({ profile: profile({ startedOn: null }), params: PARAMS, today: d('2026-06-01') }),
    ).toEqual({ kind: 'silent', reason: 'no_start_date' });
  });

  it('data spoza kalendarza nie produkuje okien', () => {
    expect(reliefWindows(profile({ startedOn: 'wczoraj' }), PARAMS)).toEqual([]);
  });

  it('brak deklaracji o uldze na start = MILCZENIE', () => {
    // Nie każdy ma do niej prawo, a agent tego nie rozstrzyga.
    expect(
      decideReliefNotice({
        profile: profile({ usesStartRelief: null }),
        params: PARAMS,
        today: d('2026-06-01'),
      }),
    ).toEqual({ kind: 'silent', reason: 'relief_unknown' });
  });

  it('KAŻDY komunikat pokazuje datę, z której liczy, i link „to nie ta data”', () => {
    // Bez tego klient nie ma jak sprawdzić, czy agent liczy od właściwego dnia.
    const proposal = buildReliefProposal({
      tenantId: 't1',
      profile: profile(),
      params: PARAMS,
      today: d('2026-06-01'),
    });

    const first = proposal?.evidence?.[0];
    expect(first?.label).toContain('15.01.2026');
    expect(first?.label).toContain('to nie ta data');
    expect(first?.href).toContain('profil-podatkowy');
  });
});

// ═══════════════════════════════════════════════════════════════
// AWARIA 2 — zawieszenie
// ═══════════════════════════════════════════════════════════════

describe('AWARIA 2 — zawieszenie działalności', () => {
  it('zawieszenie PRZESUWA koniec ulgi — ulga nie biegnie, kiedy firma stoi', () => {
    const [start] = reliefWindows(profile({ suspendedDays: 92 }), PARAMS);
    expect(start?.endsOn).toBe('2026-10-15');
    expect(start?.shiftedByDays).toBe(92);
  });

  it('agent nie straszy wzrostem składki w miesiącu, w którym go nie będzie', () => {
    // Bez przesunięcia 1 czerwca wypadałoby w oknie 60 dni przed 15 lipca.
    const suspended = decideReliefNotice({
      profile: profile({ suspendedDays: 92 }),
      params: PARAMS,
      today: d('2026-06-01'),
    });
    expect(suspended).toEqual({ kind: 'silent', reason: 'too_early' });

    const active = decideReliefNotice({
      profile: profile(),
      params: PARAMS,
      today: d('2026-06-01'),
    });
    expect(active.kind).toBe('notice');
  });

  it('zawieszenie doliczamy raz do całego ciągu ulg, nie do każdej z osobna', () => {
    // Inaczej pół roku przerwy wydłużałoby ulgi o rok.
    const [, preferential] = reliefWindows(profile({ suspendedDays: 92 }), PARAMS);
    expect(preferential?.startsOn).toBe('2026-10-15');
    expect(preferential?.endsOn).toBe('2028-10-15');
  });

  it('przesunięcie jest widoczne w treści i w dowodach', () => {
    const proposal = buildReliefProposal({
      tenantId: 't1',
      profile: profile({ suspendedDays: 92 }),
      params: PARAMS,
      today: d('2026-09-01'),
    });
    expect(proposal?.body).toContain('Zawieszenie działalności przesunęło ten termin o 92 dni');
    expect(proposal?.evidence?.some((e) => e.label.includes('92 dni'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// AWARIA 3 — zła wiadomość bez konkretu
// ═══════════════════════════════════════════════════════════════

describe('AWARIA 3 — żaden komunikat nie kończy się na złej wiadomości', () => {
  const cases: ReliefProfileInput[] = [
    profile(),
    profile({ usesStartRelief: false }),
    profile({ suspendedDays: 30 }),
  ];

  it('każdy wariant mówi, ile odkładać', () => {
    for (const p of cases) {
      const windows = reliefWindows(p, PARAMS);
      const target = windows[0]!;
      const today = new Date(
        Date.parse(`${target.endsOn}T00:00:00.000Z`) - 30 * 86_400_000,
      );

      const proposal = buildReliefProposal({
        tenantId: 't1',
        profile: p,
        params: PARAMS,
        today,
      });

      expect(proposal?.body).toContain('Odkładaj po');
      expect(proposal?.payload?.monthlySetAside).toBeGreaterThan(0);
    }
  });

  it('kwota do odkładania to różnica między starą a nową składką', () => {
    const verdict = decideReliefNotice({
      profile: profile(),
      params: PARAMS,
      today: d('2026-06-01'),
    });
    expect(verdict.kind).toBe('notice');
    if (verdict.kind !== 'notice') return;
    expect(verdict.increase).toBe(
      PARAMS.zusMonthly.preferential - PARAMS.zusMonthly.startRelief,
    );
  });

  it('treść podaje obie składki i kwotę do odkładania', () => {
    const proposal = buildReliefProposal({
      tenantId: 't1',
      profile: profile(),
      params: PARAMS,
      today: d('2026-06-01'),
    });
    expect(proposal?.body).toContain(formatPln(PARAMS.zusMonthly.startRelief));
    expect(proposal?.body).toContain(formatPln(PARAMS.zusMonthly.preferential));
    expect(proposal?.body).toContain(formatPln(300));
  });
});

// ═══════════════════════════════════════════════════════════════
// Okno powiadamiania
// ═══════════════════════════════════════════════════════════════

describe('okno 60 dni', () => {
  it('wcześniej milczy', () => {
    expect(
      decideReliefNotice({ profile: profile(), params: PARAMS, today: d('2026-04-01') }),
    ).toEqual({ kind: 'silent', reason: 'too_early' });
  });

  it('dokładnie 60 dni przed końcem już mówi', () => {
    const target = reliefWindows(profile(), PARAMS)[0]!;
    const today = new Date(
      Date.parse(`${target.endsOn}T00:00:00.000Z`) - NOTICE_BEFORE_DAYS * 86_400_000,
    );
    expect(decideReliefNotice({ profile: profile(), params: PARAMS, today }).kind).toBe('notice');
  });

  it('po wyczerpaniu wszystkich ulg milczy na zawsze', () => {
    expect(
      decideReliefNotice({ profile: profile(), params: PARAMS, today: d('2029-01-01') }),
    ).toEqual({ kind: 'silent', reason: 'no_relief_left' });
  });

  it('po końcu ulgi na start przechodzi na preferencyjny ZUS', () => {
    const verdict = decideReliefNotice({
      profile: profile(),
      params: PARAMS,
      today: d('2028-06-01'),
    });
    expect(verdict.kind).toBe('notice');
    if (verdict.kind !== 'notice') return;
    expect(verdict.window.kind).toBe('preferential');
  });
});

// ═══════════════════════════════════════════════════════════════
// Karta
// ═══════════════════════════════════════════════════════════════

describe('karta T-03', () => {
  const proposal = buildReliefProposal({
    tenantId: 't1',
    profile: profile(),
    params: PARAMS,
    today: d('2026-06-01'),
  });

  it('jeden koniec ulgi = jedna karta w życiu konta', () => {
    expect(proposal?.topicKey).toBe('tax.relief:start:2026-07-15');
  });

  it('agent nie zmienia nikomu składek w ZUS-ie', () => {
    expect(proposal?.payload?.primaryIntent).toBe('open');
  });

  it('karta wygasa w dniu, w którym wyższa składka zaczyna obowiązywać', () => {
    expect(proposal?.expiresAt.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('poza oknem nie powstaje żadna karta', () => {
    expect(
      buildReliefProposal({
        tenantId: 't1',
        profile: profile(),
        params: PARAMS,
        today: d('2026-03-01'),
      }),
    ).toBeNull();
  });
});
