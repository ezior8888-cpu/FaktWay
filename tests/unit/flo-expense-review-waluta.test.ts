import { describe, expect, it, vi } from 'vitest';

import type { FloProposalRow } from '@/lib/flo/db-types';
import { describeChange, fingerprintOf } from '@/lib/flo/fingerprint';
import {
  assessExpense,
  buildExpenseReviewProposal,
  readSellerHistory,
  sellerHistoryFrom,
  type BuildExpenseProposalInput,
  type OcrFacts,
  type SellerHistory,
  type SellerHistoryEntry,
} from '@/lib/flo/functions/expense-review';
import { toProposalView } from '@/lib/flo/proposals';

/**
 * Karta przeglądu wydatku (E16): waluta bez kursu, odcisk zgodny z bazą
 * i historia sprzedawcy bez właśnie zapisanego wydatku.
 *
 * Trzy awarie, które ten plik zamyka:
 * - „Zgadza się” na wydatku bez kursu kończyło się „dane się zmieniły”, bo
 *   karta wpisywała na sztywno `deductible: 1`, a baza ma `is_deductible = false`;
 * - sto euro pokazywane jako „100,00 zł” i porównywane z medianą w złotych;
 * - historia liczona po zapisie wydatku, więc sprzedawca nigdy nie był nowy,
 *   a mediana zawierała samą sprawdzaną kwotę.
 */

const NOW = new Date('2026-10-03T12:00:00.000Z');

function facts(overrides: Partial<OcrFacts> = {}): OcrFacts {
  return {
    sellerName: 'Sklep Testowy',
    sellerNip: '1234567890',
    netAmount: null,
    vatAmount: null,
    grossAmount: 312.4,
    issueDate: '2026-09-30',
    confidence: 0.95,
    categoryLabel: 'paliwo',
    ...overrides,
  };
}

const KNOWN: SellerHistory = { count: 12, medianGross: 300 };

function build(overrides: Partial<BuildExpenseProposalInput> = {}) {
  return buildExpenseReviewProposal({
    tenantId: 'ten-1',
    expenseId: 'exp-cur',
    facts: facts(),
    history: KNOWN,
    applied: { kpirColumn: 'col_13', categoryLabel: 'paliwo' },
    now: NOW,
    ...overrides,
  });
}

function factsOf(proposal: ReturnType<typeof build>): Record<string, unknown> {
  return proposal.payload?.facts as Record<string, unknown>;
}

function entry(expenseId: string, grossPln: number | null): SellerHistoryEntry {
  return { expenseId, grossPln };
}

// ═══════════════════════════════════════════════════════════════
// (a) Odcisk
// ═══════════════════════════════════════════════════════════════

describe('odcisk karty — te same fakty, które przeczyta baza', () => {
  it('kwoty w walucie bez kursu: deductible 0, bo wydatek nie idzie do KPiR', () => {
    const proposal = build({ facts: facts({ grossAmount: 100, amountCurrency: 'EUR' }) });

    expect(factsOf(proposal).deductible).toBe(0);
    expect(proposal.fingerprint).toBe(
      fingerprintOf({ grossTotal: 100, kpirColumn: 'col_13', reviewedAt: 0, deductible: 0 }),
    );
  });

  it('jawne deductible wygrywa z domyślnym', () => {
    expect(
      factsOf(build({ facts: facts({ amountCurrency: 'EUR' }), deductible: true })).deductible,
    ).toBe(1);
    // Złotówki ręcznie wyłączone z KPiR — baza ma `is_deductible = false`.
    expect(factsOf(build({ deductible: false })).deductible).toBe(0);
  });

  it('waluta przeliczona kursem (kwoty w PLN) liczy się do KPiR', () => {
    expect(factsOf(build({ facts: facts({ amountCurrency: 'PLN' }) })).deductible).toBe(1);
    expect(factsOf(build({ facts: facts({ amountCurrency: null }) })).deductible).toBe(1);
  });

  it('kwota zaokrąglona do groszy tak, jak zapisze ją NUMERIC(14,2)', () => {
    // Postgres zaokrągla połówki od zera na zapisie dziesiętnym: „2.135” → 2,14.
    // Zaokrąglenie na przybliżeniu binarnym dałoby 2,13 — grosz różnicy
    // i karta „nieaktualna” przy pierwszym kliknięciu.
    expect(factsOf(build({ facts: facts({ grossAmount: 2.135 }) })).grossTotal).toBe(2.14);
    expect(factsOf(build({ facts: facts({ grossAmount: 1234.565 }) })).grossTotal).toBe(1234.57);
    expect(factsOf(build({ facts: facts({ grossAmount: 0.1 + 0.2 }) })).grossTotal).toBe(0.3);
    // Dwa miejsca po przecinku — bez zmian.
    expect(factsOf(build({ facts: facts({ grossAmount: 312.4 }) })).grossTotal).toBe(312.4);
    expect(factsOf(build({ facts: facts({ grossAmount: null }) })).grossTotal).toBe(0);
    // Połówka od zera także poniżej zera (Postgres: -2.135 → -2,14).
    expect(factsOf(build({ facts: facts({ grossAmount: -2.135 }) })).grossTotal).toBe(-2.14);
    // Ułamek grosza w zapisie wykładniczym i wartość bez sensu — zero, nie NaN.
    expect(factsOf(build({ facts: facts({ grossAmount: 1e-7 }) })).grossTotal).toBe(0);
    expect(factsOf(build({ facts: facts({ grossAmount: Number.NaN }) })).grossTotal).toBe(0);
  });

  it('kwota na karcie jest tą samą kwotą, co w odcisku', () => {
    const proposal = build({ facts: facts({ grossAmount: 2.135 }) });
    expect(proposal.title).toContain('2,14 zł');
  });
});

// ═══════════════════════════════════════════════════════════════
// (b) Waluta bez kursu
// ═══════════════════════════════════════════════════════════════

describe('karta wydatku bez kursu NBP', () => {
  const eur = () =>
    build({
      expenseId: 'exp-eur',
      facts: facts({ grossAmount: 100, amountCurrency: 'EUR' }),
    });

  it('pokazuje kwotę w walucie dokumentu, nie w złotych', () => {
    const proposal = eur();
    expect(proposal.title).toContain('100,00 EUR');
    expect(proposal.title).not.toContain('zł');
    expect(proposal.body).not.toContain('zł ');
  });

  it('pyta, nie melduje — i mówi, czego brakuje', () => {
    const proposal = eur();
    expect(proposal.payload?.issues).toEqual(['missing_rate']);
    expect(proposal.body).not.toContain('Zaksięgowałem');
    expect(proposal.body).toContain('kursu NBP');
    expect(proposal.priority).toBe(40);
    // Nie ma czego cofać — agent niczego nie zaksięgował.
    expect(proposal.payload?.undo).toBeUndefined();
  });

  it('przycisk otwiera formularz wydatku zamiast „Zgadza się”', () => {
    const proposal = eur();
    expect(proposal.payload?.primaryIntent).toBe('open');
    expect(proposal.payload?.primaryLabel).toBe('Uzupełnij kwotę w złotych');
    // Interfejs otwiera PIERWSZY dowód — musi to być ten wydatek.
    expect(proposal.evidence?.[0]?.href).toBe('/expenses/exp-eur');

    const row: FloProposalRow = {
      id: 'prop-1',
      tenant_id: proposal.tenantId,
      kind: proposal.kind,
      topic_key: proposal.topicKey,
      status: 'open',
      priority: proposal.priority ?? 50,
      title: proposal.title,
      body: proposal.body,
      // Tak, jak wraca z JSONB — bez pól `undefined`.
      payload: JSON.parse(JSON.stringify(proposal.payload)) as Record<string, unknown>,
      evidence: proposal.evidence ?? [],
      fingerprint: proposal.fingerprint,
      expires_at: NOW.toISOString(),
      created_at: NOW.toISOString(),
      approved_at: null,
      approved_by: null,
      executed_at: null,
      dismissed_reason: null,
    };
    const view = toProposalView(row);
    expect(view?.primary).toMatchObject({ intent: 'open', label: 'Uzupełnij kwotę w złotych' });
  });

  it('brak kursu jest PIERWSZYM powodem, także przy innych wątpliwościach', () => {
    const result = assessExpense(
      facts({ grossAmount: 100, amountCurrency: 'EUR', confidence: 0.3, categoryLabel: 'spozywcze' }),
      KNOWN,
    );
    expect(result.issues[0]).toBe('missing_rate');
    expect(result.issues).toEqual(['missing_rate', 'low_confidence', 'sensitive_category']);
    expect(result.reason).toContain('kursu NBP');
  });

  it('inne wątpliwości przy złotówkach nie zmieniają przycisku', () => {
    const proposal = build({ facts: facts({ confidence: 0.3 }) });
    expect(proposal.payload?.issues).toEqual(['low_confidence']);
    expect(proposal.payload).not.toHaveProperty('primaryIntent');
  });

  it('powód mówi spokojnie i bez liczb', () => {
    const { reason } = assessExpense(facts({ amountCurrency: 'EUR' }), KNOWN);
    expect(reason).not.toMatch(/\d/);
    expect(reason).not.toContain('!');
    expect(reason.toLowerCase()).not.toMatch(/błąd|awaria/);
  });

  it('kontrola rzędu wielkości nie porównuje euro z medianą w złotych', () => {
    // 31 240 EUR wobec mediany 300 zł — dla złotówek to klasyczny zgubiony
    // przecinek. W euro to porównanie nie ma sensu.
    const result = assessExpense(facts({ grossAmount: 31240, amountCurrency: 'EUR' }), KNOWN);
    expect(result.issues).not.toContain('magnitude');
    expect(result.issues).toEqual(['missing_rate']);

    // Kontrola: ta sama kwota w złotych odpala sito.
    expect(assessExpense(facts({ grossAmount: 31240 }), KNOWN).issues).toContain('magnitude');
  });

  it('próg nieznanego sprzedawcy jest w złotych, euro go nie odpala', () => {
    const fresh: SellerHistory = { count: 0, medianGross: 0 };
    const result = assessExpense(facts({ grossAmount: 4200, amountCurrency: 'EUR' }), fresh);
    expect(result.issues).not.toContain('unknown_seller');

    expect(assessExpense(facts({ grossAmount: 4200 }), fresh).issues).toContain('unknown_seller');
  });

  it('kod waluty małymi literami to ta sama waluta', () => {
    const proposal = build({ facts: facts({ grossAmount: 100, amountCurrency: 'eur' }) });
    expect(proposal.title).toContain('100,00 EUR');
    expect(factsOf(proposal).deductible).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// (c) Historia sprzedawcy bez bieżącego wydatku
// ═══════════════════════════════════════════════════════════════

describe('historia sprzedawcy — funkcja czysta', () => {
  it('liczy inne dokumenty, medianę tylko z kwot w złotych', () => {
    const history = sellerHistoryFrom(
      [entry('a', 100), entry('b', null), entry('c', 300), entry('cur', 999)],
      'cur',
    );
    expect(history.count).toBe(3);
    expect(history.medianGross).toBe(200);
    expect(history.medianBasis).toBe(2);
    expect(history.entries?.map((e) => e.expenseId)).toEqual(['a', 'b', 'c']);
  });

  it('bez wykluczenia liczy wszystko', () => {
    const history = sellerHistoryFrom([entry('a', 100), entry('cur', 900)]);
    expect(history.count).toBe(2);
    expect(history.medianGross).toBe(500);
  });

  it('pusta historia to nieznany sprzedawca', () => {
    expect(sellerHistoryFrom([])).toMatchObject({ count: 0, medianGross: 0, medianBasis: 0 });
  });

  it('kwoty zerowe i ujemne nie wchodzą do mediany, ale sprzedawca jest znany', () => {
    const history = sellerHistoryFrom([entry('a', 0), entry('b', -50), entry('c', 120)]);
    expect(history.count).toBe(3);
    expect(history.medianBasis).toBe(1);
    expect(history.medianGross).toBe(120);
  });
});

describe('historia sprzedawcy w karcie', () => {
  it('nieznany sprzedawca: jedyny wiersz to sam bieżący wydatek', () => {
    // Karta powstaje po INSERT, więc odczyt zawsze widzi bieżący wydatek.
    // Bez wykluczenia sito nieznanego sprzedawcy nie działało nigdy.
    const proposal = build({
      facts: facts({ grossAmount: 600 }),
      history: { count: 1, medianGross: 600, entries: [entry('exp-cur', 600)] },
    });
    expect(proposal.payload?.issues).toContain('unknown_seller');
  });

  it('nieznany sprzedawca przy drobnej kwocie nie zawraca głowy', () => {
    const proposal = build({
      facts: facts({ grossAmount: 450 }),
      history: { count: 1, medianGross: 450, entries: [entry('exp-cur', 450)] },
    });
    expect(proposal.payload?.issues).toEqual([]);
  });

  it('dokument w walucie bez kursu czyni sprzedawcę znanym', () => {
    const proposal = build({
      facts: facts({ grossAmount: 600 }),
      history: { count: 2, medianGross: 600, entries: [entry('exp-cur', 600), entry('old', null)] },
    });
    expect(proposal.payload?.issues).not.toContain('unknown_seller');
  });

  it('trzeci dokument u sprzedawcy: bieżąca kwota uzupełnia medianę, sito działa jak dotąd', () => {
    // Dwa wcześniejsze paragony po ~312 zł, trzeci odczytany jako 31 240 —
    // zgubiony przecinek. Mediana z dwóch to za mało, ale z trzech (z bieżącą)
    // wychodzi 315, więc 31 240 odstaje stukrotnie. Tak liczyła karta przed
    // wykluczeniem bieżącego wydatku.
    const comma = build({
      facts: facts({ grossAmount: 31240 }),
      history: {
        count: 3,
        medianGross: 315,
        entries: [entry('a', 312.4), entry('b', 315), entry('exp-cur', 31240)],
      },
    });
    expect(comma.payload?.issues).toContain('magnitude');

    // W drugą stronę: 3,12 zamiast 312,40.
    const lost = build({
      facts: facts({ grossAmount: 3.12 }),
      history: {
        count: 3,
        medianGross: 312.4,
        entries: [entry('a', 312.4), entry('b', 315), entry('exp-cur', 3.12)],
      },
    });
    expect(lost.payload?.issues).toContain('magnitude');

    // Zwykła kwota przy tych samych dwóch — cisza.
    const usual = build({
      facts: facts({ grossAmount: 320 }),
      history: {
        count: 3,
        medianGross: 315,
        entries: [entry('a', 312.4), entry('b', 315), entry('exp-cur', 320)],
      },
    });
    expect(usual.payload?.issues).toEqual([]);
  });

  it('jeden wcześniejszy dokument to za mało nawet z bieżącym', () => {
    const one = build({
      facts: facts({ grossAmount: 9000 }),
      history: { count: 2, medianGross: 4550, entries: [entry('a', 100), entry('exp-cur', 9000)] },
    });
    expect(one.payload?.issues).not.toContain('magnitude');

    // Dwa wcześniejsze, ale jeden bez kursu — do mediany weszłyby dwie kwoty.
    const noRate = build({
      facts: facts({ grossAmount: 9000 }),
      history: {
        count: 3,
        medianGross: 100,
        entries: [entry('a', 100), entry('b', null), entry('exp-cur', 9000)],
      },
    });
    expect(noRate.payload?.issues).not.toContain('magnitude');
  });

  it('kwota bez kursu przy dwóch wcześniejszych: tylko brak kursu', () => {
    // 9000 EUR nie jest kwotą w złotych: karta nie dokłada jej do mediany,
    // a sito rzędu wielkości i tak pomija waluty bez kursu.
    const proposal = build({
      facts: facts({ grossAmount: 9000, amountCurrency: 'EUR' }),
      history: {
        count: 3,
        medianGross: 100,
        entries: [entry('a', 100), entry('b', 100), entry('exp-cur', null)],
      },
    });
    expect(proposal.payload?.issues).toEqual(['missing_rate']);
  });

  it('trzy wcześniejsze dokumenty wystarczą bez bieżącego', () => {
    const three = build({
      facts: facts({ grossAmount: 9000 }),
      history: {
        count: 4,
        medianGross: 100,
        entries: [entry('a', 100), entry('b', 100), entry('c', 100), entry('exp-cur', 9000)],
      },
    });
    expect(three.payload?.issues).toContain('magnitude');
  });

  it('mediana bez bieżącego wydatku', () => {
    // Wcześniej: 100, 120, 3000 → mediana 120; 700 to prawie sześć razy tyle.
    // Z bieżącym w środku mediana skoczyłaby do 410 i sito by milczało.
    const proposal = build({
      facts: facts({ grossAmount: 700 }),
      history: {
        count: 4,
        medianGross: 410,
        entries: [entry('a', 100), entry('b', 120), entry('exp-cur', 700), entry('c', 3000)],
      },
    });
    expect(proposal.payload?.issues).toContain('magnitude');
  });

  it('próg mediany liczy tylko kwoty w złotych', () => {
    // Trzy wcześniejsze dokumenty, ale jeden bez kursu — do mediany weszły
    // dwa, więc rzędu wielkości nie oceniamy.
    const result = assessExpense(
      facts({ grossAmount: 9000 }),
      sellerHistoryFrom([entry('a', 100), entry('b', 100), entry('c', null)]),
    );
    expect(result.issues).not.toContain('magnitude');
  });

  it('historia podana wprost (bez wierszy) działa jak dotąd', () => {
    const proposal = build({ facts: facts({ grossAmount: 31240 }), history: KNOWN });
    expect(proposal.payload?.issues).toContain('magnitude');
    expect(
      build({ facts: facts({ grossAmount: 4200 }), history: { count: 0, medianGross: 0 } }).payload
        ?.issues,
    ).toContain('unknown_seller');
  });
});

// ═══════════════════════════════════════════════════════════════
// readSellerHistory — atrapa klienta
// ═══════════════════════════════════════════════════════════════

type HistoryClient = NonNullable<Parameters<typeof readSellerHistory>[2]>;

function fakeClient(result: {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
}) {
  const calls = {
    table: [] as string[],
    columns: [] as string[],
    eq: [] as Array<[string, string]>,
  };
  // Strony po `id` jak w bazie (sesja 29 planu skalowania): `gt` pomija już
  // przeczytane, `limit` ucina stronę; odczyt kończy pusta strona.
  const page = (afterId: string | null, limit: number) => {
    if (!result.data) return result;
    const data = [...result.data]
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
      .filter((row) => afterId === null || String(row.id) > afterId)
      .slice(0, limit);
    return { data, error: result.error };
  };
  const client = {
    from: (table: string) => {
      calls.table.push(table);
      let afterId: string | null = null;
      const query = {
        gt: (_column: string, value: string) => {
          afterId = value;
          return query;
        },
        order: () => ({ limit: async (limit: number) => page(afterId, limit) }),
      };
      return {
        select: (columns: string) => {
          calls.columns.push(columns);
          return {
            eq: (column: string, value: string) => {
              calls.eq.push([column, value]);
              return {
                eq: (column2: string, value2: string) => {
                  calls.eq.push([column2, value2]);
                  return query;
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as HistoryClient, calls };
}

describe('readSellerHistory', () => {
  it('pyta o wydatki tego konta i tego sprzedawcy, z walutą i kursem ze śladu OCR', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    await readSellerHistory('ten-1', 'Sklep Testowy', client);

    expect(calls.table).toEqual(['expenses']);
    const columns = calls.columns[0]!.split(',').map((c) => c.trim());
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'gross_amount',
        'is_deductible',
        'currency:ocr_extracted_data->>currency',
        'fx:ocr_extracted_data->fx',
      ]),
    );
    expect(calls.eq).toEqual([
      ['tenant_id', 'ten-1'],
      ['seller_name', 'Sklep Testowy'],
    ]);
  });

  it('kwoty w złotych: dawne wiersze, przeliczone kursem; bez kursu — poza medianą', async () => {
    const { client } = fakeClient({
      data: [
        // Dawny wiersz bez śladu waluty — złotówki.
        { id: 'a', gross_amount: 100, currency: null, fx: null },
        // Euro przeliczone kursem NBP — kwota w bazie jest w złotych.
        {
          id: 'b',
          gross_amount: 430.5,
          currency: 'EUR',
          fx: { currency: 'EUR', mid: 4.305, tableNo: '190/A/NBP/2026', effectiveDate: '2026-09-29' },
        },
        // Euro bez kursu — kwota w euro, nie do porównania ze złotymi.
        { id: 'c', gross_amount: 100, currency: 'EUR', fx: null },
        // Zapis małymi literami, bez kursu — też euro.
        { id: 'd', gross_amount: 50, currency: 'eur' },
        // Złotówki podane wprost.
        { id: 'e', gross_amount: '200.00', currency: 'PLN', fx: null },
      ],
      error: null,
    });
    const history = await readSellerHistory('ten-1', 'Sklep Testowy', client);

    expect(history.entries).toEqual([
      { expenseId: 'a', grossPln: 100 },
      { expenseId: 'b', grossPln: 430.5 },
      { expenseId: 'c', grossPln: null },
      { expenseId: 'd', grossPln: null },
      { expenseId: 'e', grossPln: 200 },
    ]);
    expect(history.count).toBe(5);
    expect(history.medianBasis).toBe(3);
    expect(history.medianGross).toBe(200);
  });

  it('koszt bez kursu poprawiony ręcznie na złotówki i włączony do KPiR wchodzi do mediany', async () => {
    const { client } = fakeClient({
      data: [
        // Ślad OCR dalej mówi „EUR” bez kursu, ale klient wpisał kwotę
        // w złotych i włączył koszt do KPiR.
        { id: 'a', gross_amount: 430.5, is_deductible: true, currency: 'EUR', fx: null },
        // Wciąż poza KPiR — kwota w euro.
        { id: 'b', gross_amount: 100, is_deductible: false, currency: 'EUR', fx: null },
        // Złotówki wyłączone z KPiR (np. wydatek prywatny) — dalej złotówki.
        { id: 'c', gross_amount: 80, is_deductible: false, currency: 'PLN', fx: null },
      ],
      error: null,
    });
    const history = await readSellerHistory('ten-1', 'Sklep Testowy', client);

    expect(history.entries).toEqual([
      { expenseId: 'a', grossPln: 430.5 },
      { expenseId: 'b', grossPln: null },
      { expenseId: 'c', grossPln: 80 },
    ]);
  });

  it('zwraca też bieżący wydatek — wyklucza go dopiero karta', async () => {
    const { client } = fakeClient({
      data: [{ id: 'exp-cur', gross_amount: 600, currency: null, fx: null }],
      error: null,
    });
    const history = await readSellerHistory('ten-1', 'Sklep Testowy', client);
    expect(history.count).toBe(1);

    const proposal = build({ facts: facts({ grossAmount: 600 }), history });
    expect(proposal.payload?.issues).toContain('unknown_seller');
  });

  it('błąd odczytu rzuca — nie udaje sprzedawcy bez historii', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'permission denied' } });
    await expect(readSellerHistory('ten-1', 'Sklep Testowy', client)).rejects.toThrow(
      'permission denied',
    );
  });

  it('bez nazwy sprzedawcy nie pyta bazy', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    const from = vi.spyOn(client, 'from');

    const history = await readSellerHistory('ten-1', null, client);
    expect(from).not.toHaveBeenCalled();
    expect(calls.table).toEqual([]);
    expect(history).toMatchObject({ count: 0, medianGross: 0 });

    await readSellerHistory('ten-1', '', client);
    expect(calls.table).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// (e) Komunikat o zmianie
// ═══════════════════════════════════════════════════════════════

describe('describeChange — koszt włączony do KPiR albo z niej wyłączony', () => {
  const base = { grossTotal: 100, kpirColumn: 'col_13', reviewedAt: 0 };

  it('koszt poza KPiR mówi po polsku, bez nazwy pola', () => {
    const message = describeChange(
      'expense.review',
      { ...base, deductible: 1 },
      { ...base, deductible: 0 },
      {},
      NOW,
    );
    expect(message).toBe(
      'Ten koszt jest poza KPiR, więc niczego nie potwierdziłem — sprawdź go w formularzu.',
    );
    expect(message).not.toContain('deductible');
  });

  it('nie twierdzi, że ktoś coś zmienił — karta mogła od początku zakładać KPiR', () => {
    // Wydatek bez kursu zapisujemy poza KPiR; karta zbudowana bez `deductible`
    // przez starszy kod ma w odcisku 1. Nikt niczego nie ruszał.
    for (const [before, after] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const message = describeChange(
        'expense.review',
        { ...base, deductible: before },
        { ...base, deductible: after },
        {},
        NOW,
      );
      expect(message).not.toMatch(/międzyczasie|został|zmienił/);
    }
  });

  it('włączenie do KPiR odsyła do formularza', () => {
    const message = describeChange(
      'expense.review',
      { ...base, deductible: 0 },
      { ...base, deductible: 1 },
      {},
      NOW,
    );
    expect(message).toBe(
      'Ten koszt jest w KPiR, a karta zakładała inaczej — sprawdź go w formularzu.',
    );
    expect(message).not.toContain('deductible');
  });

  it('zmiana kwoty wciąż ma pierwszeństwo', () => {
    const message = describeChange(
      'expense.review',
      { ...base, deductible: 1 },
      { ...base, grossTotal: 430.5, deductible: 0 },
      {},
      NOW,
    );
    expect(message).toContain('Kwota');
  });

  it('inne rodzaje kart zostają przy ogólnym komunikacie', () => {
    const message = describeChange(
      'wrapped.ready',
      { deductible: 1 },
      { deductible: 0 },
      {},
      NOW,
    );
    expect(message).toContain('Dane zmieniły się');
  });
});
