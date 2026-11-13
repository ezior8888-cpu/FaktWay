import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CROWD_MUTE_SUBJECTS,
  isSilenced,
  muteKind,
  recordDecision,
  recordSubjectDismissal,
  silenceVerdict,
  listMutedKinds,
  listMutedSubjects,
  type DecisionRow,
} from '@/lib/flo/decisions';
import { createProposal, type CreateProposalInput } from '@/lib/flo/proposals';

import { createFakeDb } from './flo-fake-db';

/**
 * Cisza na poziomie SPRAWY (plan FLO 2, K2.16).
 *
 * Błąd, który to naprawia: „nie chcę reguły akurat u Adobe" kliknięte przy
 * dwóch RÓŻNYCH sprzedawcach wyciszało cały rodzaj na kwartał. Klient
 * odpowiadał o dwóch sprawach, agent rozumiał „nie pytaj mnie o nic takiego".
 * Ten sam błąd dotyczył „Jeszcze nie" przy dwóch różnych fakturach (K-01).
 */

const NOW = new Date('2026-09-23T10:00:00.000Z');
const TENANT = 'ten-1';
const KIND = 'onboarding.step';
const noKill = async () => false;

/**
 * Wpis operatora wpuszczający rodzaj na to konto.
 *
 * Testy ciszy nie mogą zależeć od tego, czy akurat ten rodzaj jest w kanarku —
 * raz już się o to potknęły, gdy O-01 doszło do listy kanarkowej.
 */
const ALLOW = [
  { tenant_id: TENANT, kind: KIND, enabled: true, reason: 'test ciszy' },
  { tenant_id: 'ten-2', kind: KIND, enabled: true, reason: 'test ciszy' },
];

function row(overrides: Partial<DecisionRow> & { kind: string }): DecisionRow {
  return {
    accepted: 0,
    dismissed: 0,
    muted_until: null,
    last_at: NOW.toISOString(),
    ...overrides,
  };
}

function card(topicKey: string): CreateProposalInput {
  return {
    tenantId: TENANT,
    kind: KIND,
    topicKey,
    title: 'Dokończ konfigurację',
    body: 'Zostały dwa kroki.',
    fingerprint: 'fp',
    expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
  };
}

beforeEach(() => {
  // Zegar przypięty do NOW. Cisze zapisujemy tu z datą NOW i trwają 90 dni
  // (`MUTE_DAYS`), a `createProposal` bierze „teraz” z `new Date()`. Bez
  // przypięcia plik psuł się sam 22.12.2026 o 10:00 UTC: dwa przypadki
  // robiły się czerwone, a „przyjęcie sprawy zdejmuje jej ciszę” i „REGRESJA”
  // przechodziły bez względu na kod, bo cisza wygasała sama.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════
// Reguła — funkcja czysta
// ═══════════════════════════════════════════════════════════════

describe('cisza — reguła', () => {
  it('AWARIA, KTÓRĄ TO NAPRAWIA: dwa „nie" o RÓŻNYCH sprawach nie uciszają rodzaju', () => {
    const verdict = silenceVerdict(
      [
        row({ kind: `${KIND}:adobe`, dismissed: 1 }),
        row({ kind: `${KIND}:ovh`, dismissed: 1 }),
      ],
      KIND,
      `${KIND}:inny`,
      NOW,
    );

    expect(verdict.silenced).toBe(false);
  });

  it('cisza w sprawie dotyczy TYLKO tej sprawy', () => {
    const rows = [
      row({
        kind: `${KIND}:adobe`,
        dismissed: 2,
        muted_until: '2026-12-01T00:00:00.000Z',
      }),
    ];

    expect(silenceVerdict(rows, KIND, `${KIND}:adobe`, NOW)).toEqual({
      silenced: true,
      reason: 'subject',
    });
    expect(silenceVerdict(rows, KIND, `${KIND}:ovh`, NOW).silenced).toBe(false);
  });

  it('„nigdy więcej takich" ucisza cały rodzaj', () => {
    const verdict = silenceVerdict(
      [row({ kind: KIND, dismissed: 2, muted_until: '2026-12-01T00:00:00.000Z' })],
      KIND,
      `${KIND}:cokolwiek`,
      NOW,
    );

    expect(verdict).toEqual({ silenced: true, reason: 'kind' });
  });

  it('tłum: odrzucenie wielu różnych spraw jednak ucisza rodzaj', () => {
    // Cztery różne sprawy w miesiąc to już nie „akurat ta faktura", tylko
    // zdanie o samym rodzaju — ale wnioskujemy je z zachowania, więc ta
    // cisza sama wygasa razem z oknem.
    const rows = Array.from({ length: CROWD_MUTE_SUBJECTS }, (_, i) =>
      row({ kind: `${KIND}:sprawa-${i}`, dismissed: 1 }),
    );

    expect(silenceVerdict(rows, KIND, `${KIND}:nowa`, NOW)).toEqual({
      silenced: true,
      reason: 'crowd',
    });
  });

  it('do tłumu nie liczą się sprawy stare ani przyjęte', () => {
    const rows = [
      ...Array.from({ length: CROWD_MUTE_SUBJECTS - 1 }, (_, i) =>
        row({ kind: `${KIND}:sprawa-${i}`, dismissed: 1 }),
      ),
      // Sprzed dwóch miesięcy.
      row({
        kind: `${KIND}:stara`,
        dismissed: 1,
        last_at: '2026-07-20T10:00:00.000Z',
      }),
      // Odrzucona, a potem przyjęta — licznik wyzerowany.
      row({ kind: `${KIND}:przyjeta`, accepted: 1, dismissed: 0 }),
    ];

    expect(silenceVerdict(rows, KIND, `${KIND}:nowa`, NOW).silenced).toBe(false);
  });

  it('sprawy innego rodzaju nie mieszają się do rachunku', () => {
    const rows = Array.from({ length: CROWD_MUTE_SUBJECTS }, (_, i) =>
      row({ kind: `payment.confirm:faktura-${i}`, dismissed: 1 }),
    );

    expect(silenceVerdict(rows, KIND, `${KIND}:nowa`, NOW).silenced).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Cała droga: odpowiedź klienta → kolejna karta
// ═══════════════════════════════════════════════════════════════

describe('cisza — od kliknięcia do następnej karty', () => {
  it('REGRESJA: dwa „nie" o różnych sprawach, a trzecia karta nadal powstaje', async () => {
    const db = createFakeDb({ flo_kind_flags: ALLOW });

    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:ovh`, NOW, db.client);

    const result = await createProposal(card(`${KIND}:google`), db.client, noKill);

    expect(result.status).toBe('created');
  });

  it('dwa „nie" o TEJ SAMEJ sprawie: ta sprawa milknie, inne nie', async () => {
    const db = createFakeDb({ flo_kind_flags: ALLOW });

    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);

    expect((await createProposal(card(`${KIND}:adobe`), db.client, noKill)).status).toBe(
      'muted',
    );
    expect((await createProposal(card(`${KIND}:ovh`), db.client, noKill)).status).toBe(
      'created',
    );
  });

  it('„nigdy więcej takich" zamyka wszystkie sprawy rodzaju', async () => {
    const db = createFakeDb({ flo_kind_flags: ALLOW });

    await muteKind(TENANT, KIND, NOW, db.client);

    expect((await createProposal(card(`${KIND}:cokolwiek`), db.client, noKill)).status).toBe(
      'muted',
    );
  });

  it('przyjęcie sprawy zdejmuje jej ciszę', async () => {
    const db = createFakeDb({ flo_kind_flags: ALLOW });
    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);

    await recordDecision(TENANT, `${KIND}:adobe`, 'accepted', NOW, db.client);

    expect((await createProposal(card(`${KIND}:adobe`), db.client, noKill)).status).toBe(
      'created',
    );
  });

  it('cisza jednego konta nie przenosi się na drugie', async () => {
    const db = createFakeDb({ flo_kind_flags: ALLOW });
    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);

    const other = { ...card(`${KIND}:adobe`), tenantId: 'ten-2' };
    expect((await createProposal(other, db.client, noKill)).status).toBe('created');
  });

  it('ustawienia widzą rodzaje osobno, a sprawy osobno', async () => {
    // Bez tego rozdzielenia ekran ustawień pokazałby klientowi
    // „onboarding.step:adobe" jako rodzaj sprawy.
    const db = createFakeDb({ flo_kind_flags: ALLOW });
    await muteKind(TENANT, KIND, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:adobe`, NOW, db.client);

    expect(await listMutedKinds(TENANT, NOW, db.client)).toEqual([KIND]);
    expect(await listMutedSubjects(TENANT, NOW, db.client)).toEqual([
      { topicKey: `${KIND}:adobe`, mutedUntil: expect.any(String) },
    ]);
  });

  it('bramka pyta o ciszę raz — jednym odczytem, nie po jednym na poziom', async () => {
    const db = createFakeDb({ flo_kind_flags: ALLOW });
    const verdict = await isSilenced(TENANT, KIND, `${KIND}:adobe`, NOW, db.client);

    expect(verdict.silenced).toBe(false);
  });
});
