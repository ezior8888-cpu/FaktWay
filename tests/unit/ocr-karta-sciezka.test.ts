import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FloProposalRow } from '@/lib/flo/db-types';
import { assertFresh } from '@/lib/flo/fingerprint';
import { toProposalView } from '@/lib/flo/proposals';
import type { JobContext } from '@/lib/jobs/registry';
import { onProcessOcrExhausted, runProcessOcr } from '@/lib/jobs/runners/process-ocr';

/**
 * E17: karta wydatku z PRAWDZIWEJ ścieżki joba OCR.
 *
 * Testy kwot w walucie (`flo-expense-review-waluta`) wołają builder wprost,
 * z polami, których job mu nie podawał, więc były zielone na ścieżce, której
 * produkcja nie przechodzi. Skutek: paragon w EUR bez kursu NBP dostawał
 * kartę „Zaksięgowałem”, choć koszt jest poza KPiR.
 *
 * Tu działa cały kod: runner, `costInPln`, klient NBP, kategoryzacja, builder
 * karty, `createProposal`, wyłączniki agenta, odcisk. Podstawione są tylko
 * granice: baza (`fakePostgrest` zwraca WYŁĄCZNIE wybrane kolumny, więc
 * brakująca kolumna w `select` jest widoczna), HTTP (NBP przez `fetch`,
 * Anthropic, magazyn plików, push) i budżet AI (baza + Redis).
 */

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null };

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  failures: {} as Record<string, { code?: string; message: string; times?: number } | undefined>,
  seq: 0,
  nbp: { status: 404, rates: [] as unknown[] },
  extract: vi.fn(),
  download: vi.fn(),
  push: vi.fn(),
  sentry: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: h.sentry,
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => ({ allowed: true }),
  recordTenantAiUsage: async () => undefined,
}));
vi.mock('@/lib/categorization/ai-classifier', () => ({ classifyByAI: async () => null }));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: (...args: unknown[]) => h.extract(...args),
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: (...args: unknown[]) => h.download(...args),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: h.push }));

vi.mock('@/lib/supabase/admin', async () => {
  const { fakePostgrest } = await import('@/lib/demo/fake-postgrest');

  const failure = (key: string): Result['error'] => {
    const hit = h.failures[key];
    if (!hit) return null;
    if (hit.times !== undefined && --hit.times <= 0) delete h.failures[key];
    return { code: hit.code, message: hit.message };
  };

  // Wartości domyślne bazy z migracji (00034, 00061) — atrapa nie może ich zmyślać.
  const defaults: Record<string, () => Row> = {
    expenses: () => ({ id: `exp-${++h.seq}`, is_deductible: true, is_reviewed: false }),
    flo_proposals: () => ({
      id: `karta-${++h.seq}`,
      status: 'open',
      created_at: `2026-10-03T12:00:${String(h.seq).padStart(2, '0')}Z`,
    }),
  };
  const LIVE = ['open', 'approved'];
  // uq_expenses_tenant_ocr_job (B4) i flo_proposals_topic_live (00061).
  const clashes: Record<string, (a: Row, b: Row) => boolean> = {
    expenses: (a, b) => a.tenant_id === b.tenant_id && a.ocr_job_id === b.ocr_job_id,
    flo_proposals: (a, b) =>
      a.tenant_id === b.tenant_id &&
      a.topic_key === b.topic_key &&
      LIVE.includes(String(a.status)) &&
      LIVE.includes(String(b.status)),
  };

  const projected = (table: string, row: Row, columns: string) =>
    (fakePostgrest({ [table]: [row] }).from(table as never) as unknown as {
      select(columns: string): { maybeSingle(): Promise<Result> };
    })
      .select(columns)
      .maybeSingle();

  const read = (table: string, columns: string, options: unknown) => {
    const query = (fakePostgrest(h.tables).from(table as never) as unknown as {
      select(columns: string, options: unknown): Record<string, unknown>;
    }).select(columns, options);
    const maybeSingle = query.maybeSingle as () => Promise<Result>;
    const then = query.then as (ok: (value: Result) => unknown) => Promise<unknown>;
    const broken = () => {
      const error = failure(`${table}:select`);
      return error ? { data: null, error } : null;
    };
    query.maybeSingle = async () => broken() ?? maybeSingle.call(query);
    query.single = async () => {
      const result = broken() ?? (await maybeSingle.call(query));
      return result.data || result.error
        ? result
        : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
    };
    query.then = (ok: (value: Result) => unknown) => {
      const error = broken();
      return error ? Promise.resolve(error).then(ok) : then.call(query, ok);
    };
    return query;
  };

  const insert = (table: string, values: Row) => {
    let columns = '*';
    const run = async (): Promise<Result> => {
      const error = failure(`${table}:insert`);
      if (error) return { data: null, error };
      const row = { ...defaults[table]?.(), ...values };
      const rows = (h.tables[table] ??= []);
      if (rows.some((other) => clashes[table]?.(other, row))) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      }
      rows.push(row);
      return projected(table, row, columns);
    };
    const query = {
      select(selection: string) {
        columns = selection;
        return query;
      },
      single: run,
      maybeSingle: run,
      then: (ok: (value: Result) => unknown) => run().then(ok),
    };
    return query;
  };

  const update = (table: string, patch: Row) => {
    const filters: Array<[string, unknown]> = [];
    let columns: string | null = null;
    const run = async (): Promise<Result> => {
      const error = failure(`${table}:update`);
      if (error) return { data: null, error };
      const hits = (h.tables[table] ?? []).filter((row) => filters.every(([k, v]) => row[k] === v));
      hits.forEach((row) => Object.assign(row, patch));
      return { data: hits, error: null };
    };
    const query = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return query;
      },
      select(selection: string) {
        columns = selection;
        return query;
      },
      maybeSingle: async (): Promise<Result> => {
        const result = await run();
        const [hit] = (result.data ?? []) as Row[];
        if (result.error || !hit) return { data: null, error: result.error };
        return projected(table, hit, columns ?? '*');
      },
      then: (ok: (value: Result) => unknown) => run().then(ok),
    };
    return query;
  };

  return {
    createAdminClient: () => ({
      from: (table: string) => ({
        select: (columns: string, options?: unknown) => read(table, columns, options),
        insert: (values: Row) => insert(table, values),
        update: (patch: Row) => update(table, patch),
      }),
    }),
  };
});

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-10-03T12:00:00.000Z';

const event = { ocrJobId: OCR_JOB, tenantId: TENANT };
const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_name, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

/** Odczyt modelu: netto = brutto, żeby sito arytmetyki milczało. */
function receipt(over: Row = {}) {
  return {
    success: true,
    data: {
      seller_name: 'Figma Inc.', seller_nip: null, seller_address: null,
      document_number: 'INV-1', document_type: 'invoice', issue_date: '2026-09-28',
      net_amount: 100, vat_amount: 0, gross_amount: 100, vat_rate: 'np',
      line_items: null, ocr_confidence: 0.95, notes: null, currency: 'PLN',
      ...over,
    },
    modelUsed: 'claude-test', inputTokens: 1, outputTokens: 1, processingTimeMs: 1,
  };
}

const NBP_RATE = { no: '188/A/NBP/2026', effectiveDate: '2026-09-25', mid: 4.2567 };

function resetDatabase() {
  h.seq = 0;
  h.failures = {};
  h.tables = {
    ocr_jobs: [{
      id: OCR_JOB, tenant_id: TENANT, created_by: USER, status: 'pending',
      source_file_path: 'tenants/x/expenses/2026/10/job.jpg', source_file_mime: 'image/jpeg',
    }],
    memberships: [{ user_id: USER, organization_id: TENANT, status: 'active' }],
    tenants: [{ id: TENANT, vat_exemption_basis: null }],
    expenses: [],
    // W-01 podlega kanarkowi — bez wiersza agent milczy (tryb cichy).
    flo_rollout: [{ kind: 'expense.review', stage: 100, stage_since: NOW, complaints: 0, halted: false, halt_reason: null }],
    flo_proposals: [],
    flo_shadow: [],
  };
}

/** Karta tak, jak leży w bazie i jak czyta ją interfejs. */
const cards = () => h.tables.flo_proposals as unknown as FloProposalRow[];
function onlyCard(): FloProposalRow {
  expect(cards()).toHaveLength(1);
  return cards()[0]!;
}
const pushBodies = () => h.push.mock.calls.map((call) => (call[2] as { body: string }).body);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetDatabase();
  h.nbp = { status: 404, rates: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (!String(url).startsWith('https://api.nbp.pl/')) {
      throw new Error(`Test poszedł do sieci: ${String(url)}`);
    }
    return h.nbp.status === 200
      ? new Response(JSON.stringify({ code: 'EUR', rates: h.nbp.rates }), { status: 200 })
      : new Response('Not Found', { status: h.nbp.status });
  }));
  h.extract.mockReset().mockImplementation(async () => receipt());
  h.download.mockReset().mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' });
  h.push.mockReset();
  h.sentry.mockReset();
  vi.mocked(ctx.logger.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('paragon w EUR bez kursu NBP — karta przez prawdziwy job', () => {
  beforeEach(() => {
    h.extract.mockImplementation(async () => receipt({ currency: 'EUR' }));
  });

  it('pyta zamiast meldować „Zaksięgowałem”: kwota w EUR, poza KPiR, przycisk do formularza', async () => {
    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });

    // Wydatek: poza KPiR, kwoty w walucie dokumentu.
    expect(h.tables.expenses[0]).toMatchObject({ is_deductible: false, gross_amount: 100, vat_deductible_amount: 0 });

    const card = onlyCard();
    expect(card.topic_key).toBe('expense.review:exp-1');
    expect(card.title).toContain('100,00 EUR');
    expect(card.title).not.toContain('zł');
    expect(card.body).not.toContain('Zaksięgowałem');
    expect(card.body).toContain('kursu NBP');
    expect(card.priority).toBe(40);
    expect(card.payload).toMatchObject({
      issues: ['missing_rate'],
      primaryIntent: 'open',
      primaryLabel: 'Uzupełnij kwotę w złotych',
      facts: { grossTotal: 100, deductible: 0 },
    });
    // Agent niczego nie zaksięgował, więc nie ma czego cofać.
    expect(card.payload.undo).toBeUndefined();

    // Powiadomienie i karta mówią to samo.
    expect(pushBodies()).toEqual(['Figma Inc. • 100.00 EUR (bez kursu)']);
  });

  it('kliknięcie nie trafia na „dane się zmieniły”: odcisk karty = stan wiersza w bazie', async () => {
    await runProcessOcr(event, ctx);
    await expect(assertFresh(onlyCard())).resolves.toBeUndefined();
  });

  it('interfejs dostaje przycisk prowadzący do tego wydatku, nie „Zgadza się”', async () => {
    await runProcessOcr(event, ctx);

    const view = toProposalView(onlyCard());
    expect(view?.primary).toMatchObject({ intent: 'open', label: 'Uzupełnij kwotę w złotych' });
    expect(view?.evidence[0]?.href).toBe('/expenses/exp-1');
  });

  it('kod waluty małymi literami to ta sama waluta', async () => {
    h.extract.mockImplementation(async () => receipt({ currency: 'eur' }));
    await runProcessOcr(event, ctx);

    expect(onlyCard().title).toContain('100,00 EUR');
    expect(onlyCard().payload).toMatchObject({ issues: ['missing_rate'], facts: { deductible: 0 } });
  });

  it('nieznana waluta bez tabeli NBP — też pytanie, nie meldunek', async () => {
    h.extract.mockImplementation(async () => receipt({ currency: 'XTS' }));
    await runProcessOcr(event, ctx);

    expect(onlyCard().title).toContain('100,00 XTS');
    expect(onlyCard().body).not.toContain('Zaksięgowałem');
  });
});

describe('złotówki i waluta z kursem — zachowują się jak dotąd', () => {
  it.each([
    {
      label: 'PLN',
      over: { net_amount: 100, vat_amount: 23, gross_amount: 123 },
      rate: false,
      amount: '123,00 zł',
      gross: 123,
      push: 'Figma Inc. • 123.00 PLN',
    },
    {
      label: 'EUR z kursem NBP',
      over: { currency: 'EUR' },
      rate: true,
      amount: '425,67 zł',
      gross: 425.67,
      push: 'Figma Inc. • 425.67 PLN',
    },
  ])('$label: meldunek „Zaksięgowałem” z kwotą w złotych, w KPiR', async ({ over, rate, amount, gross, push }) => {
    h.extract.mockImplementation(async () => receipt(over));
    if (rate) h.nbp = { status: 200, rates: [NBP_RATE] };

    await runProcessOcr(event, ctx);

    expect(h.tables.expenses[0]).toMatchObject({ is_deductible: true, gross_amount: gross });
    const card = onlyCard();
    expect(card.title).toContain(amount);
    expect(card.body).toContain('Zaksięgowałem');
    expect(card.priority).toBe(60);
    expect(card.payload).toMatchObject({ issues: [], facts: { grossTotal: gross, deductible: 1 } });
    expect(card.payload.undo).toBeDefined();
    expect(card.payload).not.toHaveProperty('primaryIntent');
    expect(toProposalView(card)?.primary).toMatchObject({ intent: 'approve', label: 'Zgadza się' });
    await expect(assertFresh(card)).resolves.toBeUndefined();
    expect(pushBodies()).toEqual([push]);
  });

  it('błąd sieci NBP (5xx) to ponowienie, nie koszt „bez kursu”', async () => {
    h.extract.mockImplementation(async () => receipt({ currency: 'EUR' }));
    h.nbp = { status: 503, rates: [] };

    await expect(runProcessOcr(event, ctx)).rejects.toThrow('NBP: HTTP 503');
    expect(h.tables.expenses).toEqual([]);
    expect(cards()).toEqual([]);
  });
});

describe('ponowienie po zapisie: ta sama karta co w pierwszym przebiegu (reviewSourceFromSaved)', () => {
  /** Karta bez pól, które nadaje baza — reszta ma być identyczna co do bajtu. */
  const content = (card: FloProposalRow) => {
    const rest: Partial<FloProposalRow> = { ...card };
    delete rest.id;
    delete rest.created_at;
    return rest;
  };

  const scenarios = [
    {
      label: 'EUR bez kursu',
      over: { currency: 'EUR' },
      rate: false,
      amount: '100,00 EUR',
      deductible: 0,
      issues: ['missing_rate'],
      asks: true,
    },
    {
      label: 'EUR z kursem NBP',
      over: { currency: 'EUR' },
      rate: true,
      amount: '425,67 zł',
      deductible: 1,
      issues: [],
      asks: false,
    },
    {
      label: 'PLN',
      over: {},
      rate: false,
      amount: '100,00 zł',
      deductible: 1,
      issues: [],
      asks: false,
    },
  ];

  it.each(scenarios)('$label', async ({ over, rate, amount, deductible, issues, asks }) => {
    h.extract.mockImplementation(async () => receipt(over));
    if (rate) h.nbp = { status: 200, rates: [NBP_RATE] };

    // Wzorzec: przebieg bez awarii.
    await runProcessOcr(event, ctx);
    const clean = content(onlyCard());
    const cleanPush = pushBodies();

    // Ten sam paragon, ale pierwszy przebieg pada na karcie, już po zapisie.
    resetDatabase();
    h.push.mockClear();
    h.extract.mockClear();
    h.failures['flo_proposals:insert'] = { message: 'chwilowy błąd bazy', times: 1 };
    await expect(runProcessOcr(event, ctx)).rejects.toThrow('chwilowy błąd bazy');
    expect(h.tables.expenses).toHaveLength(1);
    expect(cards()).toEqual([]);

    // Ponowienie od zera: bez płatnego OCR, karta z zapisanego wiersza.
    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-1' });
    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(h.tables.expenses).toHaveLength(1);

    const retried = onlyCard();
    expect(content(retried)).toEqual(clean);
    expect(pushBodies()).toEqual(cleanPush);

    // Równość z wzorcem nie wystarczy: obie karty mogłyby być błędne tak samo.
    expect(retried.title).toContain(amount);
    expect(retried.payload).toMatchObject({ issues, facts: { deductible }, ocrJobId: OCR_JOB });
    expect(retried.body.includes('Zaksięgowałem')).toBe(!asks);
    await expect(assertFresh(retried)).resolves.toBeUndefined();
  });

  it('`is_deductible` pochodzi z zapisanego wiersza, a nie z domysłu po walucie', async () => {
    // Złotówki wyłączone z KPiR: po samej walucie wyszłoby `deductible: 1`
    // i odcisk rozjechałby się z wierszem przy kliknięciu.
    h.tables.expenses!.push({
      id: 'exp-zapisany', tenant_id: TENANT, ocr_job_id: OCR_JOB, is_deductible: false, is_reviewed: false,
      seller_name: 'Figma Inc.', seller_nip: null, net_amount: 100, vat_amount: 0, gross_amount: 100,
      issue_date: '2026-09-28', kpir_column: 'col_13', category_label: 'Pozostałe wydatki',
      ocr_extracted_data: { currency: 'PLN', ocr_confidence: 0.95 },
    });

    await runProcessOcr(event, ctx);

    expect(h.extract).not.toHaveBeenCalled();
    const card = onlyCard();
    expect(card.payload).toMatchObject({ facts: { deductible: 0 } });
    await expect(assertFresh(card)).resolves.toBeUndefined();
  });
});

describe('karta sukcesu niesie numer zadania OCR (baner bez wniosku z czasu)', () => {
  it.each([
    { label: 'pierwszy przebieg', retried: false },
    { label: 'ponowienie po zapisie', retried: true },
  ])('$label', async ({ retried }) => {
    if (retried) {
      h.failures['flo_proposals:insert'] = { message: 'chwilowy błąd bazy', times: 1 };
      await expect(runProcessOcr(event, ctx)).rejects.toThrow();
    }
    await runProcessOcr(event, ctx);

    expect(onlyCard().payload.ocrJobId).toBe(OCR_JOB);
    expect(toProposalView(onlyCard())?.ocrCard).toEqual({ failed: false, ocrJobId: OCR_JOB });
  });
});

// Silnik OCR nie rzuca (błędy modelu wracają jako `success: false` i kończą się
// krokiem flo-failed-card), więc do wyczerpania prób prowadzą awarie dookoła:
// magazyn plików, NBP, baza. Tu: magazyn plików.
const ocrDown = new Error('R2: HTTP 503');
const jobRow = () => h.tables.ocr_jobs![0]!;

describe('onProcessOcrExhausted — karta porażki po wyczerpaniu prób', () => {
  it('po awarii magazynu klient dostaje kartę z drogą wyjścia, a baner poznaje ją po numerze zadania', async () => {
    h.download.mockRejectedValue(ocrDown);
    await expect(runProcessOcr(event, ctx)).rejects.toThrow('R2: HTTP 503');
    expect(cards()).toEqual([]);
    expect(h.extract).not.toHaveBeenCalled();

    await onProcessOcrExhausted(ocrDown, event, ctx);

    expect(jobRow()).toMatchObject({ status: 'failed', error_message: 'R2: HTTP 503' });
    const card = onlyCard();
    expect(card.topic_key).toBe(`expense.review:ocr:${OCR_JOB}`);
    expect(card.title).toBe('Nie odczytałem tego zdjęcia');
    expect(card.body).toContain('Zdjęcie zostało w archiwum');
    // Formularza kosztu bez zdjęcia nie ma (plan kompletnej aplikacji, 2.6), więc
    // karta nie każe wpisywać ręcznie: prowadzi do Wydatków, gdzie jest „+ Dodaj wydatek”.
    expect(card.body).toContain('Wgraj je jeszcze raz');
    expect(card.body).not.toMatch(/ręcznie/i);
    const view = toProposalView(card);
    expect(view?.ocrCard).toEqual({ failed: true, ocrJobId: OCR_JOB });
    expect(view?.primary).toMatchObject({ intent: 'open', label: 'Otwórz Wydatki' });
    expect(view?.evidence[0]?.href).toBe('/expenses');
  });

  it('bez komunikatu błędu zadanie dostaje opis, który nie obiecuje wpisu ręcznego', async () => {
    await onProcessOcrExhausted(new Error(''), event, ctx);

    expect(jobRow()).toMatchObject({ status: 'failed', error_message: 'Nie udało się rozpoznać paragonu. Spróbuj ponownie.' });
  });

  it('drugie wywołanie (pg-boss ponowił obsłużony job) nie robi drugiej karty', async () => {
    await onProcessOcrExhausted(ocrDown, event, ctx);
    await onProcessOcrExhausted(ocrDown, event, ctx);

    expect(onlyCard().status).toBe('open');
  });

  it('klient zamknął kartę, a job wraca — karta nie wstaje z martwych', async () => {
    await onProcessOcrExhausted(ocrDown, event, ctx);
    onlyCard().status = 'dismissed';

    await onProcessOcrExhausted(ocrDown, event, ctx);

    expect(onlyCard().status).toBe('dismissed');
  });

  it('odczyt karty chwilowo pada, a klient ją zamknął — bez wskrzeszania na ślepo', async () => {
    await onProcessOcrExhausted(ocrDown, event, ctx);
    onlyCard().status = 'dismissed';
    // Jednorazowo: odczyt w `createProposal` już by się udał i nowa karta by powstała.
    h.failures['flo_proposals:select'] = { message: 'baza niedostępna', times: 1 };

    await onProcessOcrExhausted(ocrDown, event, ctx);

    expect(onlyCard().status).toBe('dismissed');
    expect(h.sentry).toHaveBeenCalledTimes(1);
  });

  it('karta z wcześniejszego „nie rozpoznano” nie dubluje się', async () => {
    h.extract.mockResolvedValue({
      success: false, error: 'Nie da się odczytać zdjęcia', inputTokens: 0, outputTokens: 0, processingTimeMs: 1,
    });
    expect(await runProcessOcr(event, ctx)).toEqual({ success: false });
    const first = onlyCard();

    await onProcessOcrExhausted(ocrDown, event, ctx);

    expect(onlyCard()).toBe(first);
  });

  it.each([
    ['nie da się sprawdzić, czy karta już jest', 'flo_proposals:select'],
    ['zapis karty odrzucony', 'flo_proposals:insert'],
  ])('%s — status zadania zostaje, wyjątek nie wychodzi, log i Sentry', async (_label, key) => {
    h.failures[key] = { message: 'baza niedostępna' };

    await expect(onProcessOcrExhausted(ocrDown, event, ctx)).resolves.toBeUndefined();

    expect(jobRow()).toMatchObject({ status: 'failed' });
    expect(cards()).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('karta'),
      expect.objectContaining({ ocrJobId: OCR_JOB, tenantId: TENANT, error: expect.stringContaining('baza niedostępna') }),
    );
    expect(h.sentry).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('baza niedostępna') }),
      expect.objectContaining({
        tags: expect.objectContaining({ job: 'process-ocr', step: 'exhausted-failed-card' }),
        extra: { ocrJobId: OCR_JOB, tenantId: TENANT },
      }),
    );
  });

  it('wydatek jest zapisany — „zakończone” z jego numerem, karty porażki nie ma', async () => {
    h.tables.expenses!.push({
      id: 'exp-zapisany', tenant_id: TENANT, ocr_job_id: OCR_JOB, is_deductible: true, is_reviewed: false,
      seller_name: 'Figma Inc.', seller_nip: null, net_amount: 100, vat_amount: 0, gross_amount: 100,
      issue_date: '2026-09-28', kpir_column: 'col_13', category_label: 'Pozostałe wydatki',
      ocr_extracted_data: { currency: 'PLN', ocr_confidence: 0.95 },
    });

    await onProcessOcrExhausted(new Error('karta agenta niedostępna'), event, ctx);

    expect(jobRow()).toMatchObject({ status: 'completed', expense_id: 'exp-zapisany' });
    expect(cards()).toEqual([]);
  });

  it('zadanie innej firmy (zły ładunek) — żadnej karty w cudzym wątku, nic nie zmienione', async () => {
    await onProcessOcrExhausted(ocrDown, { ocrJobId: OCR_JOB, tenantId: OTHER_TENANT }, ctx);

    expect(cards()).toEqual([]);
    expect(jobRow().status).toBe('pending');
  });

  it.each([
    ['pending'],
    [null],
  ])('zdjęcie nie dotarło do magazynu (ścieżka %s) — bez karty „zostało w archiwum”', async (path) => {
    jobRow().source_file_path = path;

    await onProcessOcrExhausted(new Error('Brak pliku źródłowego dla joba OCR'), event, ctx);

    expect(jobRow()).toMatchObject({ status: 'failed' });
    expect(cards()).toEqual([]);
  });

  it('konto poza kanarkiem W-01: tryb cichy zamiast karty, bez błędu', async () => {
    h.tables.flo_rollout![0]!.stage = 0;

    await expect(onProcessOcrExhausted(ocrDown, event, ctx)).resolves.toBeUndefined();

    expect(cards()).toEqual([]);
    expect(h.tables.flo_shadow).toHaveLength(1);
    expect(h.sentry).not.toHaveBeenCalled();
  });
});

describe('karta porażki a ponowne doręczenie tego samego joba', () => {
  // pg-boss rozlicza paczkę jobów po całości: gdy worker zginie w jej trakcie,
  // job, który już przeszedł onExhausted, wraca i handler rusza od zera.
  const failedTopic = `expense.review:ocr:${OCR_JOB}`;
  const failedCards = () => cards().filter((card) => card.topic_key === failedTopic);
  const openCards = () => cards().filter((card) => card.status === 'open');

  async function exhaustedFirst() {
    h.download.mockRejectedValueOnce(ocrDown);
    await expect(runProcessOcr(event, ctx)).rejects.toThrow('R2: HTTP 503');
    await onProcessOcrExhausted(ocrDown, event, ctx);
    expect(failedCards()).toEqual([expect.objectContaining({ status: 'open' })]);
  }

  it('job wraca i zapisuje koszt — „nie odczytałem” zamknięte, w wątku zostaje karta kosztu', async () => {
    await exhaustedFirst();

    expect(await runProcessOcr(event, ctx)).toEqual({ success: true, expenseId: 'exp-2' });

    expect(failedCards()).toEqual([expect.objectContaining({ status: 'expired', dismissed_reason: 'stale' })]);
    expect(openCards().map((card) => toProposalView(card)?.ocrCard)).toEqual([{ failed: false, ocrJobId: OCR_JOB }]);
  });

  it('klient zamknął kartę porażki — zamknięcie przez job nie nadpisuje jego decyzji', async () => {
    await exhaustedFirst();
    failedCards()[0]!.status = 'dismissed';

    await runProcessOcr(event, ctx);

    expect(failedCards()).toEqual([expect.objectContaining({ status: 'dismissed' })]);
  });

  it('job wraca z „nie rozpoznano”, a klient już zamknął kartę — bez drugiej karty (krok flo-failed-card)', async () => {
    await exhaustedFirst();
    failedCards()[0]!.status = 'dismissed';
    h.extract.mockResolvedValue({
      success: false, error: 'Nie da się odczytać zdjęcia', inputTokens: 0, outputTokens: 0, processingTimeMs: 1,
    });

    expect(await runProcessOcr(event, ctx)).toEqual({ success: false });

    expect(failedCards()).toEqual([expect.objectContaining({ status: 'dismissed' })]);
  });

  it('zamknięcie karty porażki pada — job rzuca po zapisie, ponowienie bez OCR kończy sprawę', async () => {
    await exhaustedFirst();
    h.failures['flo_proposals:update'] = { message: 'chwilowy błąd bazy', times: 1 };

    await expect(runProcessOcr(event, ctx)).rejects.toThrow('Nie można zamknąć karty porażki');
    expect(h.tables.expenses).toHaveLength(1);
    expect(h.extract).toHaveBeenCalledTimes(1);

    await runProcessOcr(event, ctx);

    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(failedCards()).toEqual([expect.objectContaining({ status: 'expired' })]);
    expect(openCards()).toHaveLength(1);
  });

  it('onExhausted przy zapisanym wydatku też zamyka otwartą kartę porażki', async () => {
    await exhaustedFirst();
    h.tables.expenses!.push({ id: 'exp-z-innego-przebiegu', tenant_id: TENANT, ocr_job_id: OCR_JOB });

    await onProcessOcrExhausted(new Error('karta agenta niedostępna'), event, ctx);

    expect(jobRow()).toMatchObject({ status: 'completed', expense_id: 'exp-z-innego-przebiegu' });
    expect(failedCards()).toEqual([expect.objectContaining({ status: 'expired' })]);
  });

  it('onExhausted przy zapisanym wydatku: awaria zamknięcia karty to log i Sentry, nie wyjątek', async () => {
    await exhaustedFirst();
    h.tables.expenses!.push({ id: 'exp-z-innego-przebiegu', tenant_id: TENANT, ocr_job_id: OCR_JOB });
    h.failures['flo_proposals:update'] = { message: 'baza niedostępna' };

    await expect(onProcessOcrExhausted(new Error('x'), event, ctx)).resolves.toBeUndefined();

    expect(jobRow()).toMatchObject({ status: 'completed' });
    expect(h.sentry).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('baza niedostępna') }),
      expect.objectContaining({ tags: expect.objectContaining({ step: 'exhausted-close-failed-card' }) }),
    );
  });
});
