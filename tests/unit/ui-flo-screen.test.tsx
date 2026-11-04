import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateProposalInput } from '@/lib/flo/proposals';
import type { FloProposalView } from '@/types/flo';

/**
 * Ekran agenta w całości (kroki 4, 15–20 toru B).
 *
 * Ekran woła teraz prawdziwe akcje serwerowe, więc w teście podstawiamy dwie
 * rzeczy: router Next (poza aplikacją nie istnieje) i moduł akcji (jest
 * `'use server'` i ciągnie za sobą pół backendu). Podstawiamy JE, a nie
 * komponenty — sprawdzamy prawdziwy ekran, nie jego atrapę.
 */

let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => search,
}));

vi.mock('@/app/actions/flo', () => ({
  approveProposal: async () => ({ ok: true }),
  dismissProposal: async () => {},
  undoAction: async () => ({ ok: true }),
  cancelScheduled: async () => {},
}));

const { FloScreen, photoBannerSignals } = await import(
  '@/components/flo/flo-screen'
);
const { FLO_FIXTURES, FLO_SCHEDULED_FIXTURES } = await import(
  '@/lib/flo/fixtures'
);
const { buildExpenseReviewProposal, buildOcrFailedProposal } = await import(
  '@/lib/flo/functions/expense-review'
);
const { toProposalView } = await import('@/lib/flo/proposals');

function render() {
  return renderToStaticMarkup(
    <FloScreen
      proposals={[...FLO_FIXTURES]}
      scheduled={[...FLO_SCHEDULED_FIXTURES]}
      usingFixtures
    />,
  );
}

describe('FloScreen — ekran agenta', () => {
  it('rysuje wszystkie propozycje', () => {
    const html = render();

    for (const proposal of FLO_FIXTURES) {
      expect(html).toContain(proposal.title.slice(0, 40));
    }
  });

  it('panel zatwierdzonych nazywa się tym, czym jest, i pokazuje ślad zgody', () => {
    const html = render();

    expect(html).toContain('ZATWIERDZONE — CZEKA NA WYKONANIE');
    for (const item of FLO_SCHEDULED_FIXTURES) {
      expect(html).toContain(item.label);
      // Bez tego przy reklamacji „ja tego nie wysyłałem” nie ma czego pokazać.
      expect(html).toContain(item.approvedAtLabel);
    }
  });

  it('odznaka zadań jest odmieniona przez liczebnik', () => {
    expect(render()).toMatch(/\d+ (zadanie|zadania|zadań) dziś/);
  });

  it('nigdzie nie ma trybu ani poziomu samodzielności agenta', () => {
    expect(render()).not.toMatch(/TRYB|Tryb \d|poziom \d/i);
  });

  it('pole rozmowy jest wyłączone, a nie udaje działającego', () => {
    const html = render();

    expect(html).toContain('id="flo-composer"');
    expect(html).toMatch(/id="flo-composer"[^>]*disabled/);
  });

  it('pas rozmowy ma mikrofon i aparat z makiety — oba nieczynne', () => {
    const html = render();

    expect(html).toContain('Nagraj wiadomość (jeszcze nieczynne)');
    expect(html).toContain('Zrób zdjęcie paragonu (jeszcze nieczynne)');
  });

  it('każda karta ma rozwijane „dlaczego to widzę”, gdy są dowody', () => {
    const html = render();
    const withEvidence = FLO_FIXTURES.filter((f) => f.evidence.length > 0);

    const found = html.match(/Dlaczego to widzę/g) ?? [];
    expect(found).toHaveLength(withEvidence.length);
  });

  it('karta z czynnością zrobioną samodzielnie zapowiada cofnięcie', () => {
    // Pasek cofnięcia liczy czas, więc rysuje się dopiero po zamontowaniu —
    // w renderze serwerowym ma go NIE być. Inaczej byłby rozjazd hydratacji.
    const undoable = FLO_FIXTURES.filter((f) => f.undoableUntil);
    expect(undoable.length).toBeGreaterThan(0);
    expect(render()).not.toContain('Zrobiłem to za Ciebie');
  });
});

describe('FloScreen — sygnały dla paska zdjęcia (E16)', () => {
  afterEach(() => {
    search = new URLSearchParams();
  });

  function card(
    overrides: Partial<FloProposalView> & Pick<FloProposalView, 'id' | 'kind'>,
  ): FloProposalView {
    return {
      variant: 'single',
      title: 'Karta',
      body: 'Treść',
      evidence: [],
      primary: { label: 'Zgadza się', intent: 'approve' },
      secondary: [],
      expiresAt: '2026-09-30T12:00:00.000Z',
      priority: 50,
      createdAt: '2026-08-26T12:00:00.000Z',
      ...overrides,
    };
  }

  const failedCard = card({
    id: 'ocr-failed',
    kind: 'expense.review',
    title: 'Nie odczytałem tego zdjęcia',
    createdAt: '2026-08-26T12:05:00.000Z',
    ocrCard: { failed: true, ocrJobId: 'job-1' },
  });

  it('karty reguły, skrzynki KSeF, brakującego dokumentu i porażki nie znaczą „odczytany”', () => {
    // Każda z nich jest młodsza niż wejście na ekran — dawniej to wystarczało,
    // żeby pasek ogłosił sukces odczytu.
    const signals = photoBannerSignals([
      card({ id: 'rule', kind: 'expense.rule', createdAt: '2026-08-26T12:01:00.000Z' }),
      card({ id: 'inbox', kind: 'expense.review', createdAt: '2026-08-26T12:02:00.000Z' }),
      card({ id: 'missing', kind: 'expense.missing', createdAt: '2026-08-26T12:03:00.000Z' }),
      failedCard,
    ]);

    expect(signals.readOcrJobIds).toEqual([]);
    expect(signals.failedOcrJobIds).toEqual(['job-1']);
  });

  it('sukcesem są tylko karty kosztu z numerem zadania, wszystkie w wątku', () => {
    const signals = photoBannerSignals([
      // Karta sprzed E17: koszt ze zdjęcia, ale nie wiadomo którego.
      card({ id: 'read-old', kind: 'expense.review', ocrCard: { failed: false } }),
      card({ id: 'read-1', kind: 'expense.review', ocrCard: { failed: false, ocrJobId: 'job-9' } }),
      card({ id: 'read-2', kind: 'expense.review', ocrCard: { failed: false, ocrJobId: 'job-8' } }),
      card({ id: 'inbox', kind: 'expense.review' }),
      failedCard,
    ]);

    expect(signals.readOcrJobIds).toEqual(['job-9', 'job-8']);
    expect(signals.failedOcrJobIds).toEqual(['job-1']);
  });

  it('pasek nad kartą porażki mówi o porażce, nie o odczycie', () => {
    search = new URLSearchParams('paragon=job-1');
    const html = renderToStaticMarkup(
      <FloScreen proposals={[failedCard]} scheduled={[]} />,
    );

    expect(html).toContain('Nie odczytałem tego paragonu');
    expect(html).not.toContain('Paragon odczytany');
  });

  /** Karta z tego samego buildera, którego używa job OCR, przez ten sam odczyt co wątek. */
  function viewOf(input: CreateProposalInput): FloProposalView {
    const view = toProposalView({
      id: input.topicKey,
      tenant_id: input.tenantId,
      kind: input.kind,
      topic_key: input.topicKey,
      status: 'open',
      priority: input.priority ?? 50,
      title: input.title,
      body: input.body,
      payload: JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>,
      evidence: input.evidence ?? [],
      fingerprint: input.fingerprint,
      expires_at: input.expiresAt.toISOString(),
      created_at: '2026-08-26T12:00:00.000Z',
      approved_at: null,
      approved_by: null,
      executed_at: null,
      dismissed_reason: null,
    });
    if (!view) throw new Error('Karta bez widoku');
    return view;
  }

  function expenseCard(ocrJobId?: string): FloProposalView {
    return viewOf(buildExpenseReviewProposal({
      tenantId: 'ten-1',
      expenseId: 'exp-1',
      ...(ocrJobId ? { ocrJobId } : {}),
      facts: {
        sellerName: 'Figma Inc.', sellerNip: null, netAmount: 100, vatAmount: 0, grossAmount: 100,
        issueDate: '2026-09-28', confidence: 0.95, categoryLabel: 'Pozostałe wydatki', amountCurrency: 'EUR',
      },
      history: { count: 0, medianGross: 0 },
      applied: { kpirColumn: 'col_13', categoryLabel: 'Pozostałe wydatki' },
    }));
  }

  function bannerOver(proposal: FloProposalView): string {
    search = new URLSearchParams('paragon=job-1');
    return renderToStaticMarkup(<FloScreen proposals={[proposal]} scheduled={[]} />);
  }

  it('prawdziwa karta kosztu tego zadania: „odczytany”, a przycisk prowadzi do formularza', () => {
    const html = bannerOver(expenseCard('job-1'));

    expect(html).toContain('Paragon odczytany');
    expect(html).toContain('Uzupełnij kwotę w złotych');
    expect(html).not.toContain('Zgadza się');
  });

  it('prawdziwa karta kosztu innego zadania albo bez numeru: pasek czyta dalej', () => {
    for (const other of [expenseCard('job-2'), expenseCard()]) {
      const html = bannerOver(other);
      expect(html).not.toContain('Paragon odczytany');
      expect(html).toContain('Mam Twoje zdjęcie');
    }
  });

  it('prawdziwa karta porażki z joba: pasek mówi o porażce', () => {
    expect(bannerOver(viewOf(buildOcrFailedProposal('ten-1', 'job-1')))).toContain('Nie odczytałem tego paragonu');
  });
});
