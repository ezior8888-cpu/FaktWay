import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lista wyciszeń w ustawieniach (plan FLO 2, K2.16 — druga połowa).
 *
 * Ekran czytał wcześniej `flo_prefs.muted_kinds` — tablicę, której NIC nigdy
 * nie zapisywało. Klient widział „nic nie jest wyciszone" nawet wtedy, gdy
 * agent milczał w pięciu sprawach, a „Przywróć" nie przywracało niczego.
 */

const fake = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => ({
    tenantId: 'ten-1',
    user: { id: 'user-1' },
  }),
}));

vi.mock('@/lib/flo/db-types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flo/db-types')>()),
  floDb: () => fake.client,
}));

import { listSilenced, restoreSilenced } from '@/app/actions/flo';
import { muteKind, recordSubjectDismissal } from '@/lib/flo/decisions';
import { buildSilencedList, kindOfKey } from '@/lib/flo/silenced';
import { createProposal, type CreateProposalInput } from '@/lib/flo/proposals';

import { createFakeDb } from './flo-fake-db';

const TENANT = 'ten-1';
const NOW = new Date('2026-09-23T10:00:00.000Z');
const SOON = '2026-12-21T10:00:00.000Z';
const noKill = async () => false;

let db: ReturnType<typeof createFakeDb>;

/** Rodzaj spoza kanarka — inaczej karta nie powstałaby z innego powodu. */
const KIND = 'onboarding.step';

function card(topicKey: string, title: string): CreateProposalInput {
  return {
    tenantId: TENANT,
    kind: KIND,
    topicKey,
    title,
    body: 'treść',
    fingerprint: 'fp',
    expiresAt: new Date(NOW.getTime() + 86_400_000),
  };
}

beforeEach(() => {
  // Zegar przypięty do NOW. Cisze zapisujemy tu z datą NOW i trwają 90 dni
  // (`MUTE_DAYS`), a `listSilenced`, `createProposal` i `restoreSilenced`
  // biorą „teraz” z `new Date()`. Bez przypięcia plik psuł się sam
  // 22.12.2026 o 10:00 UTC: część przypadków robiła się czerwona, a
  // sprawdzenia przywracania i cudzego konta przechodziły bez względu na kod,
  // bo cisza wygasała sama.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  db = createFakeDb({
    flo_kind_flags: [{ tenant_id: TENANT, kind: KIND, enabled: true, reason: 'test' }],
  });
  fake.client = db.client;
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════
// Funkcja czysta
// ═══════════════════════════════════════════════════════════════

describe('lista wyciszeń — reguła', () => {
  it('rodzaj z klucza tematu', () => {
    expect(kindOfKey('payment.confirm:inv-5')).toBe('payment.confirm');
    expect(kindOfKey('payment.confirm')).toBe('payment.confirm');
  });

  it('najpierw całe rodzaje, potem pojedyncze sprawy', () => {
    const list = buildSilencedList({
      rows: [
        { kind: 'payment.confirm:inv-5', accepted: 0, dismissed: 2, muted_until: SOON, last_at: SOON },
        { kind: 'payment.chase', accepted: 0, dismissed: 2, muted_until: SOON, last_at: SOON },
      ],
      titles: new Map([['payment.confirm:inv-5', 'Nowak zapłacił za fakturę 5/2026?']]),
      labelOfKind: (kind) => `etykieta ${kind}`,
      now: NOW,
    });

    expect(list.map((e) => e.wholeKind)).toEqual([true, false]);
    expect(list[1]!.label).toBe('Nowak zapłacił za fakturę 5/2026?');
  });

  it('sprawa bez tytułu nie pokazuje klucza z bazy', () => {
    // Karta zdążyła zniknąć — wtedy lepiej „jedna sprawa" niż surowy klucz.
    const list = buildSilencedList({
      rows: [
        { kind: 'payment.confirm:inv-9', accepted: 0, dismissed: 2, muted_until: SOON, last_at: SOON },
      ],
      titles: new Map(),
      labelOfKind: () => 'Pytania „czy zapłacił?”',
      now: NOW,
    });

    expect(list[0]!.label).toBe('Pytania „czy zapłacił?”: jedna sprawa');
    expect(list[0]!.label).not.toContain('inv-9');
  });

  it('wygasłe i nieuciszone wpisy nie trafiają na listę', () => {
    const list = buildSilencedList({
      rows: [
        { kind: 'payment.chase', accepted: 0, dismissed: 1, muted_until: null, last_at: SOON },
        {
          kind: 'ksef.audit',
          accepted: 0,
          dismissed: 2,
          muted_until: '2026-01-01T00:00:00.000Z',
          last_at: SOON,
        },
      ],
      titles: new Map(),
      labelOfKind: (kind) => kind,
      now: NOW,
    });

    expect(list).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Akcje serwerowe
// ═══════════════════════════════════════════════════════════════

describe('listSilenced i restoreSilenced', () => {
  it('pokazuje to, co NAPRAWDĘ zamyka agentowi usta', async () => {
    await muteKind(TENANT, 'payment.chase', NOW, db.client);
    // Najpierw karta, potem dwa „nie" — tak to idzie u klienta: tytuł
    // ostatniej karty jest jedynym miejscem, z którego wiadomo, o co pytaliśmy.
    await createProposal(
      card(`${KIND}:inv-5`, 'Nowak zapłacił za fakturę 5/2026?'),
      db.client,
      noKill,
    );
    await recordSubjectDismissal(TENANT, `${KIND}:inv-5`, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:inv-5`, NOW, db.client);

    const list = await listSilenced();

    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      key: 'payment.chase',
      wholeKind: true,
      label: 'Ponaglenia o płatność',
    });
    expect(list[1]).toMatchObject({
      key: `${KIND}:inv-5`,
      wholeKind: false,
      label: 'Nowak zapłacił za fakturę 5/2026?',
      kindLabel: 'Pierwsze kroki w aplikacji',
    });
  });

  it('przywrócenie sprawy sprawia, że agent znowu o nią pyta', async () => {
    await recordSubjectDismissal(TENANT, `${KIND}:inv-5`, NOW, db.client);
    await recordSubjectDismissal(TENANT, `${KIND}:inv-5`, NOW, db.client);
    expect(
      (await createProposal(card(`${KIND}:inv-5`, 'x'), db.client, noKill)).status,
    ).toBe('muted');

    await restoreSilenced(`${KIND}:inv-5`);

    expect(await listSilenced()).toEqual([]);
    expect(
      (await createProposal(card(`${KIND}:inv-5`, 'x'), db.client, noKill)).status,
    ).toBe('created');
  });

  it('przywrócenie rodzaju odblokowuje wszystkie jego sprawy', async () => {
    await muteKind(TENANT, KIND, NOW, db.client);

    await restoreSilenced(KIND);

    expect(
      (await createProposal(card(`${KIND}:inv-7`, 'x'), db.client, noKill)).status,
    ).toBe('created');
  });

  it('cisza innego konta nie wchodzi na listę', async () => {
    await muteKind('ten-2', 'payment.chase', NOW, db.client);

    expect(await listSilenced()).toEqual([]);
  });

  it('BEZPIECZEŃSTWO: tytuł sprawy nie może przyjść z cudzej karty', async () => {
    // Klucz tematu bywa WSPÓLNY między kontami — `expense.missing:2026-09`
    // wygląda tak samo u każdego. Bez filtra po koncie lista pokazałaby
    // klientowi tytuł karty innej firmy.
    const shared = 'expense.missing:2026-09';
    db.tables.flo_proposals.push({
      id: 'obca',
      tenant_id: 'ten-2',
      kind: 'expense.missing',
      topic_key: shared,
      status: 'open',
      title: 'Brakuje dokumentu: TAJNY KONTRAHENT',
      created_at: '2026-09-20T10:00:00.000Z',
    });
    await recordSubjectDismissal(TENANT, shared, NOW, db.client);
    await recordSubjectDismissal(TENANT, shared, NOW, db.client);

    const list = await listSilenced();

    expect(list).toHaveLength(1);
    expect(list[0]!.label).not.toContain('TAJNY KONTRAHENT');
    expect(list[0]!.label).toBe('Zgubione dokumenty kosztowe: jedna sprawa');
  });
});
