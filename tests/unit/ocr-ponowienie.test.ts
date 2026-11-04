import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * pg-boss ponawia job OCR OD POCZĄTKU (bez pamięci kroków). Do 01.10.2026
 * błąd po zapisie wydatku — oznaczenie zadania, karta agenta, powiadomienie —
 * kończył się drugim (i trzecim) wydatkiem z tego samego paragonu, czyli
 * podwójnym kosztem w KPiR (#109). B4: wyścig dwóch równoczesnych przebiegów
 * (23505 z indeksu UNIQUE) i „nie rozpoznano” po zapisie. E15: ponowienie po
 * zapisie nie płaci drugi raz za OCR, a karta i powiadomienie pochodzą
 * z zapisanego wydatku, nie z nowego odczytu modelu.
 */

type Row = Record<string, unknown>;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const OTHER_JOB = '99999999-9999-4999-8999-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';

const state = vi.hoisted(() => ({
  expenses: [] as Record<string, unknown>[],
  cards: [] as Record<string, unknown>[],
  jobUpdates: [] as Record<string, unknown>[],
  // Odczyty `expenses` od tego numeru (1 = pierwszy) zwracają błąd bazy.
  readErrorFrom: null as number | null,
  // Konkurencyjny przebieg zapisuje wydatek po odczycie nr `raceAfterRead`.
  raceRow: null as Record<string, unknown> | null,
  raceAfterRead: 1,
  // B4: indeks UNIQUE (tenant_id, ocr_job_id) — insert dubla dostaje 23505.
  uniqueIndex: false,
  insertError: null as { code: string; message: string } | null,
  cardReadError: false,
  jobUpdateError: false,
  ocrFails: false,
  aiBudgetExhausted: false,
  // Pola odczytu modelu nadpisujące domyślny paragon (np. waluta).
  extractData: {} as Record<string, unknown>,
  // Wiersz ocr_jobs widziany przez load-job (`null` — brak zadania).
  jobRow: null as Record<string, unknown> | null,
  expenseReads: 0,
  inserts: 0,
  cardSeq: 0,
  nbp: vi.fn(),
  extract: vi.fn(),
  budget: vi.fn(),
  download: vi.fn(),
  categorize: vi.fn(),
  review: vi.fn(),
  proposal: vi.fn(),
  failedCard: vi.fn(),
  push: vi.fn(),
  sentry: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: state.sentry }));

vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: (...args: unknown[]) => state.budget(...args),
  recordTenantAiUsage: async () => undefined,
}));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: (...args: unknown[]) => state.categorize(...args),
}));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: (...args: unknown[]) => state.extract(...args),
}));
vi.mock('@/lib/nbp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/nbp/client')>()),
  nbpRateForCost: (...args: unknown[]) => state.nbp(...args),
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: (...args: unknown[]) => state.download(...args),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: state.push }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: state.proposal }));
vi.mock('@/lib/flo/functions/expense-review', () => ({
  buildExpenseReviewProposal: (input: unknown) => state.review(input),
  buildOcrFailedProposal: state.failedCard,
  readSellerHistory: async () => null,
}));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireTenantMember: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let insertRow: Row | null = null;
      let limited = false;
      let orderBy: { column: string; ascending: boolean } | null = null;
      const q: Record<string, unknown> = {};
      const rowsOf = (rows: Row[]) => rows.filter((r) => filters.every(([k, v]) => r[k] === v));
      Object.assign(q, {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        order: (column: string, opts?: { ascending?: boolean }) => {
          orderBy = { column, ascending: opts?.ascending !== false };
          return q;
        },
        limit: () => { limited = true; return q; },
        update: (v: Row) => { if (table === 'ocr_jobs') state.jobUpdates.push(v); return q; },
        insert: (r: Row) => { insertRow = r; return q; },
        single: async () => {
          if (table === 'ocr_jobs') {
            const [job] = rowsOf(state.jobRow ? [state.jobRow] : []);
            return job
              ? { data: job, error: null }
              : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
          }
          if (table === 'expenses' && insertRow) {
            state.inserts += 1;
            if (state.insertError) return { data: null, error: state.insertError };
            const row: Row = { id: `exp-${state.expenses.length + 1}`, ...insertRow };
            if (state.uniqueIndex && state.expenses.some(
              (e) => e.tenant_id === row.tenant_id && e.ocr_job_id === row.ocr_job_id,
            )) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_expenses_tenant_ocr_job"' },
              };
            }
            state.expenses.push(row);
            return { data: { id: row.id }, error: null };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'tenants') return { data: { vat_exemption_basis: null }, error: null };
          if (table === 'flo_proposals') {
            if (state.cardReadError) return { data: null, error: { message: 'database unavailable' } };
            const rows = rowsOf(state.cards);
            if (orderBy) {
              const { column, ascending } = orderBy;
              rows.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
            }
            if (rows.length > 1 && !limited) {
              return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
            }
            return { data: rows[0] ?? null, error: null };
          }
          if (table === 'expenses') {
            state.expenseReads += 1;
            if (state.readErrorFrom !== null && state.expenseReads >= state.readErrorFrom) {
              return { data: null, error: { message: 'database unavailable' } };
            }
            const rows = rowsOf(state.expenses);
            // Jak postgrest-js: maybeSingle przy kilku wierszach bez limit(1) to PGRST116.
            if (rows.length > 1 && !limited) {
              return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
            }
            if (state.raceRow && state.expenseReads >= state.raceAfterRead) {
              state.expenses.push(state.raceRow);
              state.raceRow = null;
            }
            return { data: rows[0] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        then: (ok: (v: { error: { message: string } | null }) => unknown) =>
          Promise.resolve({
            error: table === 'ocr_jobs' && state.jobUpdateError ? { message: 'zapis odrzucony' } : null,
          }).then(ok),
      });
      return q;
    },
  }),
}));

import { onProcessOcrExhausted, runProcessOcr } from '@/lib/jobs/runners/process-ocr';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const event = { ocrJobId: OCR_JOB, tenantId: TENANT };

/** Wydatek zapisany przez (wcześniejszy albo równoległy) przebieg OCR. */
function savedRow(id: string, over: Row = {}): Row {
  return {
    id, tenant_id: TENANT, ocr_job_id: OCR_JOB,
    seller_name: 'Stacja Paliw', seller_nip: '5260001246',
    net_amount: 100, vat_amount: 23, gross_amount: 123, issue_date: '2026-09-28',
    kpir_column: 'col_13', category_label: 'Paliwo', is_reviewed: false,
    ocr_extracted_data: { currency: 'PLN', ocr_confidence: 0.95 },
    ...over,
  };
}

/** Karta Flo zapisana przez wcześniejszy przebieg. */
function card(topicKey: string, status: string, over: Row = {}): Row {
  state.cardSeq += 1;
  return { tenant_id: TENANT, topic_key: topicKey, status, created_at: `2026-10-03T10:00:${String(state.cardSeq).padStart(2, '0')}Z`, ...over };
}

/** Pierwszy przebieg pada na karcie agenta (wydatek już zapisany), liczniki od nowa. */
async function firstRunFailsAfterSave() {
  state.proposal.mockRejectedValueOnce(new Error('chwilowy błąd bazy'));
  await expect(runProcessOcr(event, ctx)).rejects.toThrow('chwilowy błąd bazy');
  expect(state.expenses).toHaveLength(1);
  // Karta przed powiadomieniem — na tym opiera się „karta otwarta ⇒ push nie wyszedł”.
  expect(state.push).not.toHaveBeenCalled();
  state.jobUpdates = [];
  state.expenseReads = 0;
  for (const spy of [state.extract, state.budget, state.download, state.categorize, state.review, state.proposal, state.push]) {
    spy.mockClear();
  }
}

const pushBodies = (kind: string) =>
  state.push.mock.calls.filter((c) => c[1] === kind).map((c) => (c[2] as { body: string }).body);

beforeEach(() => {
  state.expenses = [];
  state.cards = [];
  state.jobUpdates = [];
  state.readErrorFrom = null;
  state.raceRow = null;
  state.raceAfterRead = 1;
  state.uniqueIndex = false;
  state.insertError = null;
  state.cardReadError = false;
  state.jobUpdateError = false;
  state.ocrFails = false;
  state.aiBudgetExhausted = false;
  state.extractData = {};
  state.jobRow = { id: OCR_JOB, tenant_id: TENANT, created_by: USER, source_file_path: 'r2/x.jpg', source_file_mime: 'image/jpeg' };
  state.expenseReads = 0;
  state.inserts = 0;
  state.cardSeq = 0;
  state.nbp.mockReset().mockResolvedValue({
    found: true, rate: { currency: 'EUR', mid: 4.2567, tableNo: '188/A/NBP/2026', effectiveDate: '2026-09-25' }, gapDays: 3,
  });
  state.budget.mockReset().mockImplementation(async () => state.aiBudgetExhausted
    ? { allowed: false, message: 'Limit AI firmy na ten miesiąc wyczerpany' }
    : { allowed: true });
  state.categorize.mockReset().mockResolvedValue({
    kpir_column: 'col_13', category_label: 'Paliwo', method: 'rule', confidence: 0.9,
  });
  state.extract.mockReset().mockImplementation(async () => state.ocrFails ? {
    success: false, error: 'Nie da się odczytać zdjęcia', inputTokens: 0, outputTokens: 0, processingTimeMs: 1,
  } : {
    success: true,
    data: {
      seller_name: 'Stacja Paliw', seller_nip: '5260001246', seller_address: null,
      document_number: 'PAR/1', document_type: 'receipt', issue_date: '2026-09-28',
      net_amount: 100, vat_amount: 23, gross_amount: 123, vat_rate: '23',
      line_items: null, ocr_confidence: 0.95, notes: null, currency: 'PLN',
      ...state.extractData,
    },
    modelUsed: 'claude-test', inputTokens: 1, outputTokens: 1, processingTimeMs: 1,
  });
  state.download.mockReset().mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' });
  state.review.mockReset().mockImplementation((input: { expenseId: string }) => ({
    topicKey: `expense.review:${input.expenseId}`,
    expenseId: input.expenseId,
  }));
  // Jak createProposal: zapisuje otwartą kartę tematu.
  state.proposal.mockReset().mockImplementation(async (proposal: { topicKey?: string }) => {
    if (proposal.topicKey) state.cards.push(card(proposal.topicKey, 'open'));
    return { status: 'created' };
  });
  state.failedCard.mockReset().mockReturnValue({});
  state.push.mockReset();
  state.sentry.mockReset();
  vi.mocked(ctx.logger.warn).mockClear();
});

describe('OCR — ponowienie joba nie dubluje wydatku', () => {
  it('błąd po zapisie, ponowienie — w KPiR dalej jeden wydatek', async () => {
    await firstRunFailsAfterSave();

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });
    expect(state.expenses).toHaveLength(1);
    expect(state.inserts).toBe(1);
  });

  it.each([
    ['innego zadania OCR', savedRow('exp-inne', { ocr_job_id: OTHER_JOB })],
    ['innej firmy', savedRow('exp-inne', { tenant_id: OTHER_TENANT })],
  ])('wydatek %s nie zatrzymuje zapisu', async (_label, other) => {
    state.expenses.push(other);
    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-2' });
    expect(state.expenses.filter((e) => e.ocr_job_id === OCR_JOB && e.tenant_id === TENANT)).toHaveLength(1);
  });

  it('nie da się sprawdzić, czy wydatek już jest — job rzuca przed zdjęciem, AI i „przetwarzaniem”', async () => {
    state.readErrorFrom = 1;

    const err = await runProcessOcr(event, ctx).catch((e: unknown) => e);
    expect((err as Error).message).toContain('Nie można sprawdzić, czy wydatek już istnieje');
    expect((err as Error).name).not.toBe('NonRetriableError');
    expect(state.expenses).toHaveLength(0);
    expect(state.download).not.toHaveBeenCalled();
    expect(state.budget).not.toHaveBeenCalled();
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.jobUpdates).toEqual([]);
  });

  it('dawne duble (sprzed indeksu B4) — job kończy się jednym z nich, bez trzeciego zapisu i bez OCR', async () => {
    state.expenses.push(savedRow('exp-stary-1'), savedRow('exp-stary-2'));

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-stary-1' });
    expect(state.inserts).toBe(0);
    expect(state.expenses).toHaveLength(2);
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.review).toHaveBeenCalledWith(expect.objectContaining({ expenseId: 'exp-stary-1' }));
  });
});

describe('pierwszy przebieg — karta, powiadomienie i ślad odczytu jak dotąd', () => {
  it('karta i powiadomienie z odczytu modelu; zadanie „przetwarzanie” → „zakończone” ze śladem odczytu', async () => {
    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });

    expect(state.review).toHaveBeenCalledTimes(1);
    expect(state.review).toHaveBeenCalledWith(expect.objectContaining({
      expenseId: 'exp-1',
      facts: {
        sellerName: 'Stacja Paliw', sellerNip: '5260001246',
        netAmount: 100, vatAmount: 23, grossAmount: 123,
        issueDate: '2026-09-28', confidence: 0.95, categoryLabel: 'Paliwo',
      },
      applied: { kpirColumn: 'col_13', categoryLabel: 'Paliwo' },
    }));
    expect(state.proposal).toHaveBeenCalledTimes(1);
    expect(pushBodies('invoice_accepted')).toEqual(['Stacja Paliw • 123.00 PLN']);
    expect(state.jobUpdates[0]).toEqual({ status: 'processing' });
    expect(state.jobUpdates.at(-1)).toEqual({
      status: 'completed', expense_id: 'exp-1', completed_at: expect.any(String),
      extracted_data: expect.objectContaining({ seller_name: 'Stacja Paliw', gross_amount: 123 }),
      ai_model_used: 'claude-test', ai_input_tokens: 1, ai_output_tokens: 1, processing_time_ms: 1,
    });
    expect(state.expenseReads).toBe(2);
  });

  it.each([
    ['waluta z kursem NBP', true, { netAmount: 425.67, vatAmount: 0, grossAmount: 425.67 }, 'Figma Inc. • 425.67 PLN'],
    ['waluta bez kursu NBP', false, { netAmount: 100, vatAmount: 0, grossAmount: 100 }, 'Figma Inc. • 100.00 EUR (bez kursu)'],
  ])('%s — karta i powiadomienie jak dotąd', async (_label, rateFound, amounts, body) => {
    state.extractData = { seller_name: 'Figma Inc.', currency: 'EUR', net_amount: 100, vat_amount: 0, gross_amount: 100 };
    if (!rateFound) state.nbp.mockResolvedValue({ found: false, reason: 'no_table_before' });

    await runProcessOcr(event, ctx);
    expect(state.review).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ sellerName: 'Figma Inc.', ...amounts }),
    }));
    expect(pushBodies('invoice_accepted')).toEqual([body]);
  });

  it.each([
    ['autor usunął konto', { created_by: null }, 'Autor zadania OCR usunął konto'],
    ['zdjęcie jeszcze nie wgrane', { source_file_path: 'pending' }, 'Brak pliku źródłowego'],
    ['zadanie innej firmy', { tenant_id: OTHER_TENANT }, 'Job nie istnieje lub niewłaściwy tenant'],
  ])('%s — błąd ostateczny przed odczytem wydatku, „przetwarzaniem” i zdjęciem', async (_label, over, message) => {
    state.jobRow = { ...state.jobRow, ...over };

    const err = await runProcessOcr(event, ctx).catch((e: unknown) => e);
    expect((err as Error).name).toBe('NonRetriableError');
    expect((err as Error).message).toContain(message);
    expect(state.expenseReads).toBe(0);
    expect(state.jobUpdates).toEqual([]);
    expect(state.download).not.toHaveBeenCalled();
  });
});

describe('E15 — ponowienie po zapisie: bez płatnego OCR, karta i powiadomienie z zapisanego wydatku', () => {
  it('bez pobrania zdjęcia, budżetu AI, OCR i kategoryzacji; bez cofania zadania na „przetwarzanie”', async () => {
    await firstRunFailsAfterSave();

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });
    expect(state.download).not.toHaveBeenCalled();
    expect(state.budget).not.toHaveBeenCalled();
    expect(state.extract).not.toHaveBeenCalled();
    expect(state.categorize).not.toHaveBeenCalled();
    expect(state.expenseReads).toBe(1);
    expect(state.jobUpdates).toEqual([{ status: 'completed', expense_id: 'exp-1', completed_at: expect.any(String) }]);
    expect(state.proposal).toHaveBeenCalledTimes(1);
    expect(pushBodies('invoice_accepted')).toEqual(['Stacja Paliw • 123.00 PLN']);
  });

  it('karta i powiadomienie z danych wiersza, nie z ponownego odczytu', async () => {
    await firstRunFailsAfterSave();
    Object.assign(state.expenses[0], { gross_amount: 150, net_amount: 121.95, kpir_column: 'col_10', category_label: 'Usługi' });

    await runProcessOcr(event, ctx);
    expect(state.review).toHaveBeenCalledWith(expect.objectContaining({
      expenseId: 'exp-1',
      facts: expect.objectContaining({ grossAmount: 150, netAmount: 121.95, categoryLabel: 'Usługi', confidence: 0.95 }),
      applied: { kpirColumn: 'col_10', categoryLabel: 'Usługi' },
    }));
    expect(pushBodies('invoice_accepted')).toEqual(['Stacja Paliw • 150.00 PLN']);
  });

  it('budżet AI firmy wyczerpany (pierwszy przebieg zużył resztę) — dalej karta i powiadomienie, nie „nie rozpoznano”', async () => {
    await firstRunFailsAfterSave();
    state.aiBudgetExhausted = true;
    state.ocrFails = true;

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });
    expect(state.jobUpdates).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(state.failedCard).not.toHaveBeenCalled();
    expect(pushBodies('invoice_rejected')).toEqual([]);
    expect(pushBodies('invoice_accepted')).toHaveLength(1);
  });

  it('klient już przejrzał wydatek — zadanie „zakończone”, bez karty i bez powiadomienia', async () => {
    state.expenses.push(savedRow('exp-1', { is_reviewed: true }));

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });
    expect(state.jobUpdates).toContainEqual(expect.objectContaining({ status: 'completed', expense_id: 'exp-1' }));
    expect(state.proposal).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('klient już przejrzał wydatek, karta wciąż otwarta — bez karty i bez powiadomienia', async () => {
    state.expenses.push(savedRow('exp-1', { is_reviewed: true }));
    state.cards.push(card('expense.review:exp-1', 'open'));

    await runProcessOcr(event, ctx);
    expect(state.proposal).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('karta otwarta (pierwszy przebieg do niej doszedł) — bez nowej karty, powiadomienie wychodzi', async () => {
    state.expenses.push(savedRow('exp-1'));
    state.cards.push(card('expense.review:exp-1', 'open'));

    await runProcessOcr(event, ctx);
    expect(state.proposal).not.toHaveBeenCalled();
    expect(pushBodies('invoice_accepted')).toHaveLength(1);
  });

  it('pierwszy przebieg padł na powiadomieniu — ponowienie: bez nowej karty, jedno powiadomienie', async () => {
    state.push.mockRejectedValueOnce(new Error('push niedostępny'));
    await expect(runProcessOcr(event, ctx)).rejects.toThrow('push niedostępny');
    expect(state.cards).toEqual([expect.objectContaining({ topic_key: 'expense.review:exp-1', status: 'open' })]);
    state.proposal.mockClear();
    state.push.mockClear();

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });
    expect(state.proposal).not.toHaveBeenCalled();
    expect(state.cards).toHaveLength(1);
    expect(pushBodies('invoice_accepted')).toHaveLength(1);
  });

  it('kilka kart tematu (starsza odrzucona, nowsza otwarta) — decyduje najnowsza: bez nowej karty, powiadomienie', async () => {
    state.expenses.push(savedRow('exp-1'));
    state.cards.push(card('expense.review:exp-1', 'dismissed'), card('expense.review:exp-1', 'open'));

    await runProcessOcr(event, ctx);
    expect(state.proposal).not.toHaveBeenCalled();
    expect(pushBodies('invoice_accepted')).toHaveLength(1);
  });

  it('karta innego tematu tej firmy nie zatrzymuje karty ani powiadomienia', async () => {
    state.expenses.push(savedRow('exp-1'));
    state.cards.push(card('expense.review:exp-inny', 'done'));

    await runProcessOcr(event, ctx);
    expect(state.proposal).toHaveBeenCalledTimes(1);
    expect(pushBodies('invoice_accepted')).toHaveLength(1);
  });

  it.each(['approved', 'executing', 'done', 'dismissed', 'expired', 'blocked'])(
    'karta w stanie „%s” (klient zareagował) — bez nowej karty i bez powiadomienia',
    async (status) => {
      state.expenses.push(savedRow('exp-1'));
      state.cards.push(card('expense.review:exp-1', status));

      expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });
      expect(state.proposal).not.toHaveBeenCalled();
      expect(state.push).not.toHaveBeenCalled();
    },
  );

  it('karta tego tematu w innej firmie nie zatrzymuje karty', async () => {
    state.expenses.push(savedRow('exp-1'));
    state.cards.push(card('expense.review:exp-1', 'done', { tenant_id: OTHER_TENANT }));

    await runProcessOcr(event, ctx);
    expect(state.proposal).toHaveBeenCalledTimes(1);
  });

  it('nie da się sprawdzić karty — błąd ponawialny, bez nowej karty', async () => {
    state.expenses.push(savedRow('exp-1'));
    state.cardReadError = true;

    await expect(runProcessOcr(event, ctx)).rejects.toThrow('Nie można sprawdzić karty przeglądu');
    expect(state.proposal).not.toHaveBeenCalled();
  });

  it.each([
    ['złotówki', { currency: 'PLN', ocr_confidence: 0.95 }, 123, 'Stacja Paliw • 123.00 PLN', 0.95],
    ['waluta z kursem NBP', { currency: 'EUR', ocr_confidence: 0.9, fx: { currency: 'EUR', mid: 4.3, tableNo: 'X', effectiveDate: '2026-09-26' } }, 430.5, 'Stacja Paliw • 430.50 PLN', 0.9],
    ['waluta bez kursu', { currency: 'EUR', ocr_confidence: 0.9 }, 100, 'Stacja Paliw • 100.00 EUR (bez kursu)', 0.9],
    ['dawny wpis bez waluty', { ocr_confidence: 0.8 }, 123, 'Stacja Paliw • 123.00 PLN', 0.8],
    ['ślad bez pewności odczytu', { currency: 'PLN' }, 123, 'Stacja Paliw • 123.00 PLN', null],
    ['nieczytelny ślad OCR — pewność 0 (karta-pytanie)', null, 123, 'Stacja Paliw • 123.00 PLN', 0],
  ])('kwota i pewność z zapisanego śladu: %s', async (_label, trace, gross, body, confidence) => {
    state.expenses.push(savedRow('exp-1', { ocr_extracted_data: trace, gross_amount: gross }));

    await runProcessOcr(event, ctx);
    expect(pushBodies('invoice_accepted')).toEqual([body]);
    expect(state.review).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ confidence, grossAmount: gross }),
    }));
  });
});

describe('B4 — indeks UNIQUE (tenant_id, ocr_job_id): wyścig dwóch przebiegów', () => {
  it.each(['exp-konkurent', 'exp-zwyciezca-2'])(
    'przegrany wyścig (23505) — wydatek zwycięzcy %s, karta i powiadomienie z jego wiersza, bez dubla',
    async (winnerId) => {
      state.uniqueIndex = true;
      state.raceAfterRead = 2;
      state.raceRow = savedRow(winnerId, { gross_amount: 200, kpir_column: 'col_10', category_label: 'Usługi' });

      expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: winnerId });
      expect(state.expenses.filter((e) => e.ocr_job_id === OCR_JOB && e.tenant_id === TENANT)).toHaveLength(1);
      expect(state.inserts).toBe(1);
      expect(state.expenseReads).toBe(3);
      expect(state.jobUpdates.at(-1)).toEqual({ status: 'completed', expense_id: winnerId, completed_at: expect.any(String) });
      expect(state.review).toHaveBeenCalledWith(expect.objectContaining({
        expenseId: winnerId,
        facts: expect.objectContaining({ grossAmount: 200, categoryLabel: 'Usługi' }),
        applied: { kpirColumn: 'col_10', categoryLabel: 'Usługi' },
      }));
      expect(pushBodies('invoice_accepted')).toEqual(['Stacja Paliw • 200.00 PLN']);
    },
  );

  it('wydatek równoległego przebiegu widoczny przed zapisem — bez zapisu, karta z jego wiersza', async () => {
    state.raceRow = savedRow('exp-konkurent', { gross_amount: 200 });

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-konkurent' });
    expect(state.inserts).toBe(0);
    expect(state.expenseReads).toBe(2);
    expect(state.jobUpdates.at(-1)).toEqual({ status: 'completed', expense_id: 'exp-konkurent', completed_at: expect.any(String) });
    expect(pushBodies('invoice_accepted')).toEqual(['Stacja Paliw • 200.00 PLN']);
  });

  it.each([
    ['odczyt przed zapisem', 1, false],
    ['23505', 2, true],
  ])('wydatek równoległego przebiegu już przejrzany (%s) — bez karty i bez powiadomienia', async (_label, raceAfterRead, uniqueIndex) => {
    state.uniqueIndex = uniqueIndex;
    state.raceAfterRead = raceAfterRead;
    state.raceRow = savedRow('exp-konkurent', { is_reviewed: true });

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-konkurent' });
    expect(state.proposal).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it.each([
    ['innego ograniczenia (brak wydatku)', []],
    ['wydatek innej firmy', [savedRow('exp-obcy', { tenant_id: OTHER_TENANT })]],
    ['wydatek innego zadania', [savedRow('exp-obcy', { ocr_job_id: OTHER_JOB })]],
  ])('23505, a ponowny odczyt nie znajduje wydatku tego zadania (%s) — błąd, nie cudze id', async (_label, rows) => {
    state.expenses.push(...rows);
    state.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "inny"' };

    await expect(runProcessOcr(event, ctx)).rejects.toThrow('Konflikt UNIQUE nie dotyczy wydatku z tego zadania OCR');
    expect(state.expenseReads).toBe(3);
    expect(state.jobUpdates).not.toContainEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('23505, a ponowny odczyt pada — błąd ponawialny, bez „zakończone”', async () => {
    state.uniqueIndex = true;
    state.raceAfterRead = 2;
    state.raceRow = savedRow('exp-konkurent');
    state.readErrorFrom = 3;

    const err = await runProcessOcr(event, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Nie można sprawdzić, czy wydatek już istnieje');
    expect((err as Error).name).not.toBe('NonRetriableError');
    expect(state.jobUpdates).not.toContainEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('inny błąd zapisu — bez ponownego odczytu, komunikat bazy', async () => {
    state.insertError = { code: '23502', message: 'null value in column "seller_name"' };

    await expect(runProcessOcr(event, ctx)).rejects.toThrow('null value in column "seller_name"');
    expect(state.expenseReads).toBe(2);
  });
});

describe('B4 — OCR zawodzi', () => {
  it('równoległy przebieg zapisał wydatek w trakcie — „zakończone” z jego wydatkiem, bez „nie rozpoznano”', async () => {
    state.ocrFails = true;
    state.raceRow = savedRow('exp-konkurent');

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-konkurent' });
    expect(state.jobUpdates).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(state.failedCard).not.toHaveBeenCalled();
    expect(pushBodies('invoice_rejected')).toEqual([]);
    expect(state.review).toHaveBeenCalledWith(expect.objectContaining({ expenseId: 'exp-konkurent' }));
  });

  it('wydatku nie ma — „nie rozpoznano” jak dotąd (karta i powiadomienie)', async () => {
    state.ocrFails = true;

    expect(await runProcessOcr(event, ctx)).toEqual({ success: false });
    expect(state.jobUpdates).toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(state.failedCard).toHaveBeenCalledTimes(1);
    expect(state.push).toHaveBeenCalledWith(USER, 'invoice_rejected', expect.anything());
  });

  it.each([
    ['innej firmy', savedRow('exp-obcy', { tenant_id: OTHER_TENANT })],
    ['innego zadania', savedRow('exp-obcy', { ocr_job_id: OTHER_JOB })],
  ])('jest tylko wydatek %s — „nie rozpoznano”', async (_label, other) => {
    state.expenses.push(other);
    state.ocrFails = true;

    expect(await runProcessOcr(event, ctx)).toEqual({ success: false });
    expect(state.jobUpdates).toContainEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('nie da się sprawdzić, czy wydatek jest — job rzuca zamiast ogłaszać porażkę w ciemno', async () => {
    state.ocrFails = true;
    state.readErrorFrom = 2;

    await expect(runProcessOcr(event, ctx)).rejects.toThrow('Nie można sprawdzić, czy wydatek już istnieje');
    expect(state.jobUpdates).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(state.push).not.toHaveBeenCalled();
  });

  // A5: push rzuca PushReadError przy awarii bazy. Tu „nieudane” jest już
  // zapisane, a ponowienie joba od zera zapłaciłoby drugi raz za OCR i mogło
  // nie dojść do karty — push jest dodatkiem do karty i statusu zadania.
  it('błąd odczytu przy pushu „nie rozpoznano” — karta powstaje, job bez wyjątku (bez drugiego płatnego OCR); log i Sentry', async () => {
    state.ocrFails = true;
    const readError = Object.assign(new Error('Nie można odczytać subskrypcji push: database unavailable'), { name: 'PushReadError' });
    state.push.mockRejectedValueOnce(readError);

    expect(await runProcessOcr(event, ctx)).toEqual({ success: false });
    expect(state.extract).toHaveBeenCalledTimes(1);
    expect(state.jobUpdates).toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(state.failedCard).toHaveBeenCalledTimes(1);
    expect(state.proposal).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('push'),
      expect.objectContaining({ ocrJobId: OCR_JOB, tenantId: TENANT, error: readError.message }),
    );
    expect(state.sentry).toHaveBeenCalledWith(readError, expect.objectContaining({
      tags: expect.objectContaining({ job: 'process-ocr' }),
      extra: expect.objectContaining({ ocrJobId: OCR_JOB, tenantId: TENANT }),
    }));
  });
});

describe('onProcessOcrExhausted — po wyczerpaniu prób', () => {
  it('krok po zapisie padł na stałe — zadanie wskazuje zapisany wydatek, nie „nieudane”', async () => {
    state.proposal.mockRejectedValue(new Error('karta agenta niedostępna'));
    await expect(runProcessOcr(event, ctx)).rejects.toThrow();
    state.jobUpdates = [];

    await onProcessOcrExhausted(new Error('karta agenta niedostępna'), event);
    expect(state.jobUpdates).toEqual([expect.objectContaining({ status: 'completed', expense_id: 'exp-1' })]);
    expect(state.expenses).toHaveLength(1);
  });

  it.each([
    ['innego zadania', savedRow('exp-inne', { ocr_job_id: OTHER_JOB })],
    ['innej firmy', savedRow('exp-inne', { tenant_id: OTHER_TENANT })],
  ])('wydatek nie powstał (jest tylko wydatek %s) — „nieudane”, jak dotąd', async (_label, other) => {
    state.expenses.push(other);
    await onProcessOcrExhausted(new Error('OCR niedostępny'), event);
    expect(state.jobUpdates).toEqual([expect.objectContaining({ status: 'failed', error_message: 'OCR niedostępny' })]);
  });

  it('nie da się sprawdzić, czy wydatek jest — rzuca, bez „nieudane” w ciemno', async () => {
    state.readErrorFrom = 1;

    await expect(onProcessOcrExhausted(new Error('OCR niedostępny'), event))
      .rejects.toThrow('Nie można sprawdzić, czy wydatek już istnieje');
    expect(state.jobUpdates).toEqual([]);
  });

  it.each([
    ['wydatek jest', [savedRow('exp-1')]],
    ['wydatku nie ma', []],
  ])('zapis statusu zadania odrzucony (%s) — rzuca zamiast milczeć', async (_label, rows) => {
    state.expenses.push(...rows);
    state.jobUpdateError = true;

    await expect(onProcessOcrExhausted(new Error('OCR niedostępny'), event))
      .rejects.toThrow('Nie można oznaczyć zadania OCR');
  });
});
