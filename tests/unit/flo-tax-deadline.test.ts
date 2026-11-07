import { describe, expect, it } from 'vitest';

import {
  buildDeadlineProposal,
  decideDeadlineNotice,
  describeAmount,
  describeBasis,
  NOTICE_FROM_DAYS,
  URGENT_FROM_DAYS,
  type PeriodSnapshot,
} from '@/lib/flo/functions/tax-deadline';
import { formatPln } from '@/lib/flo/money';
import { generateJpkV7m, summarizeJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import type { ExportExpense } from '@/lib/exports/data-fetcher';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import type { JpkV7mInputData } from '@/lib/exports/jpk-v7m-generator';
import type { JpkV7mSummary } from '@/lib/exports/jpk-v7m-generator';

/**
 * T-01 — kalendarz obowiązków z kwotą (krok 36).
 *
 * Złoty zbiór: kwota dodatnia, zero, nadwyżka, dane niepełne, termin
 * przesunięty na dzień roboczy oraz oba końce okna powiadamiania.
 */

const d = (iso: string) => new Date(`${iso}T09:00:00.000Z`);

function jpkInvoice(overrides: Partial<JpkInvoice> = {}): JpkInvoice {
  return {
    invoiceNumber: 'FV/1',
    currency: 'PLN',
    invoiceType: 'regular',
    issueDate: '2026-08-10',
    buyerName: 'Klient',
    netTotal: 10_000,
    vatTotal: 2_300,
    grossTotal: 12_300,
    lines: [
      {
        position: 1,
        name: 'Usługa',
        unit: 'usł.',
        quantity: 1,
        unitPriceNet: 10_000,
        netAmount: 10_000,
        vatRate: '23',
      },
    ],
    ...overrides,
  };
}

/** Zakup = koszt z listy wydatków (od 26.09 źródło zakupów w JPK_V7M). */
function jpkPurchase(): ExportExpense {
  return {
    id: 'exp-1',
    issueDate: '2026-08-12',
    documentNumber: 'ZAK/1',
    documentType: 'invoice',
    sellerName: 'Dostawca',
    sellerNip: '5260001246',
    sellerAddress: null,
    netAmount: 1_000,
    vatAmount: 230,
    grossAmount: 1_230,
    vatDeductibleAmount: 230,
    kpirColumn: 'col_13',
    categoryLabel: 'Usługi',
  };
}

function jpkData(overrides: Partial<JpkV7mInputData> = {}): JpkV7mInputData {
  return {
    issuer: { nip: '1234567890', name: 'Test', taxOfficeCode: '1433', email: 'test@example.test' },
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    issuedInvoices: [jpkInvoice()],
    expenses: [jpkPurchase()],
    ...overrides,
  };
}

function summary(overrides: Partial<JpkV7mSummary> = {}): JpkV7mSummary {
  return {
    vatDue: 5_000,
    vatDeductible: 2_660,
    purchaseNet: 11_565,
    balance: 2_340,
    previousSurplus: 0,
    toPay: 2_340,
    carryForward: 0,
    salesCount: 28,
    purchaseCount: 6,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PeriodSnapshot> = {}): PeriodSnapshot {
  return {
    year: 2026,
    month: 8,
    summary: summary(),
    unreviewedExpenses: 0,
    asOf: '2026-09-18',
    fileReady: true,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Kwota z tego samego kodu, co plik
// ═══════════════════════════════════════════════════════════════

describe('kwota pochodzi z generatora JPK, nie z osobnego wzoru', () => {
  it('summarizeJpkV7m liczy to, co trafia do deklaracji', () => {
    // Gdyby agent liczył po swojemu, karta i złożony plik mogłyby pokazywać
    // dwie różne kwoty — a wtedy klient przestaje wierzyć obu naraz.
    const result = summarizeJpkV7m(jpkData());

    expect(result.vatDue).toBe(2_300);
    expect(result.vatDeductible).toBe(230);
    expect(result.balance).toBe(2_070);
    expect(result.salesCount).toBe(1);
    expect(result.purchaseCount).toBe(1);
  });

  it('to, co mówi agent, jest tym, co ląduje w deklaracji', () => {
    // Zabezpieczenie wyciągnięcia `summarizeJpkV7m` z generatora: kwota
    // z karty musi zgadzać się z pozycjami P_38, P_48 i P_51 złożonego pliku.
    const data = jpkData();
    const result = summarizeJpkV7m(data);
    const xml = generateJpkV7m(data);

    // JPK_V7M(3): deklaracja w pełnych złotych, zakupy w P_42 (P_44 to korekty).
    expect(xml).toContain(`<P_38>${result.vatDue}</P_38>`);
    expect(xml).toContain(`<P_48>${result.vatDeductible}</P_48>`);
    expect(xml).toContain(`<P_42>${result.purchaseNet}</P_42>`);
    expect(xml).toContain(`<P_51>${result.balance}</P_51>`);
  });

  it('nadwyżka idzie do P_53, nie do P_51', () => {
    const data = jpkData({ issuedInvoices: [] });

    expect(summarizeJpkV7m(data).balance).toBe(-230);
    const xml = generateJpkV7m(data);
    expect(xml).toContain('<P_51>0</P_51>');
    expect(xml).toContain('<P_53>230</P_53>');
  });
});

// ═══════════════════════════════════════════════════════════════
// Okno powiadamiania
// ═══════════════════════════════════════════════════════════════

describe('kiedy agent się odzywa', () => {
  // VAT za sierpień 2026 → termin 25.09.2026 (piątek, bez przesunięcia).
  it('poza oknem milczy', () => {
    expect(decideDeadlineNotice({ kind: 'vat', snapshot: snapshot(), today: d('2026-09-01') })).toEqual(
      { kind: 'silent', reason: 'too_early' },
    );
  });

  it('odzywa się na siedem dni przed terminem', () => {
    const verdict = decideDeadlineNotice({
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-18'),
    });
    expect(verdict.kind).toBe('notice');
    if (verdict.kind !== 'notice') return;
    expect(verdict.daysLeft).toBe(NOTICE_FROM_DAYS);
    expect(verdict.urgent).toBe(false);
  });

  it('na trzy dni przed terminem podnosi priorytet', () => {
    const verdict = decideDeadlineNotice({
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-22'),
    });
    expect(verdict.kind).toBe('notice');
    if (verdict.kind !== 'notice') return;
    expect(verdict.daysLeft).toBe(URGENT_FROM_DAYS);
    expect(verdict.urgent).toBe(true);
  });

  it('okno jest progiem, nie dwoma dniami — nieudany przebieg crona nie gubi ostrzeżenia', () => {
    // Gdyby agent odzywał się WYŁĄCZNIE siódmego i trzeciego dnia, jeden
    // nieudany przebieg zabrałby klientowi jedyne ostrzeżenie.
    for (const day of ['2026-09-19', '2026-09-20', '2026-09-21']) {
      expect(decideDeadlineNotice({ kind: 'vat', snapshot: snapshot(), today: d(day) }).kind).toBe(
        'notice',
      );
    }
  });

  it('po terminie milczy — przypominanie po fakcie to inna rozmowa', () => {
    expect(
      decideDeadlineNotice({ kind: 'vat', snapshot: snapshot(), today: d('2026-09-26') }),
    ).toEqual({ kind: 'silent', reason: 'passed' });
  });

  it('bez znanych parametrów nie zgaduje terminu', () => {
    expect(
      decideDeadlineNotice({
        kind: 'vat',
        snapshot: snapshot({ year: 2019, month: 3 }),
        today: d('2019-04-20'),
      }),
    ).toEqual({ kind: 'silent', reason: 'no_params' });
  });
});

// ═══════════════════════════════════════════════════════════════
// Liczba nigdy bez podstawy
// ═══════════════════════════════════════════════════════════════

describe('liczba nigdy bez podstawy', () => {
  it('podaje liczbę dokumentów i dzień, na który jest aktualna', () => {
    expect(describeBasis(snapshot())).toBe('na podstawie 34 dokumentów, stan na 18.09');
  });

  it('dopisuje nieprzejrzane koszty', () => {
    expect(describeBasis(snapshot({ unreviewedExpenses: 3 }))).toContain(
      '3 koszty czekają na Twoją decyzję',
    );
  });

  it('odmienia liczbę mnogą po polsku', () => {
    // „5 koszty czekają” w komunikacie o podatkach brzmi jak automat —
    // a to jest moment, w którym klient ma uwierzyć liczbie.
    expect(describeBasis(snapshot({ unreviewedExpenses: 1 }))).toContain('1 koszt czeka');
    expect(describeBasis(snapshot({ unreviewedExpenses: 5 }))).toContain('5 kosztów czeka');
    expect(describeBasis(snapshot({ unreviewedExpenses: 12 }))).toContain('12 kosztów czeka');
    expect(describeBasis(snapshot({ unreviewedExpenses: 22 }))).toContain('22 koszty czekają');
  });

  it('KAŻDA karta niesie podstawę razem z kwotą', () => {
    const proposal = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-18'),
    });
    expect(proposal?.body).toContain(formatPln(2_340));
    expect(proposal?.body).toContain('na podstawie 34 dokumentów');
    expect(proposal?.body).toContain('stan na 18.09');
  });
});

// ═══════════════════════════════════════════════════════════════
// Trzy zakończenia rozliczenia
// ═══════════════════════════════════════════════════════════════

describe('kwota — trzy możliwe zakończenia okresu', () => {
  it('do zapłaty', () => {
    expect(describeAmount(summary())).toContain(formatPln(2_340));
    expect(describeAmount(summary())).toContain('Wychodzi mi');
  });

  it('nadwyżka do przeniesienia, a nie „do zapłaty”', () => {
    // Powiedzenie klientowi z nadwyżką, że coś mu wychodzi do zapłaty,
    // jest po prostu nieprawdą.
    const text = describeAmount(summary({ balance: -1_200 }));
    expect(text).toContain('nadwyżki do przeniesienia');
    expect(text).not.toContain('do zapłaty');
    expect(text).not.toContain('-');
  });

  it('zero', () => {
    expect(describeAmount(summary({ balance: 0 }))).toContain('zero');
  });
});

// ═══════════════════════════════════════════════════════════════
// Ton
// ═══════════════════════════════════════════════════════════════

describe('ton — nigdy „zapłać”', () => {
  it('żadna wersja karty nie każe niczego zrobić', () => {
    const cases: PeriodSnapshot[] = [
      snapshot(),
      snapshot({ summary: summary({ balance: -900 }) }),
      snapshot({ summary: summary({ balance: 0 }) }),
      snapshot({ unreviewedExpenses: 4 }),
    ];

    for (const snap of cases) {
      const proposal = buildDeadlineProposal({
        tenantId: 't1',
        kind: 'vat',
        snapshot: snap,
        today: d('2026-09-20'),
      });
      const text = `${proposal?.title} ${proposal?.body}`;
      expect(text).not.toMatch(/zapłać/i);
      expect(text).not.toMatch(/musisz/i);
      expect(proposal?.body).toContain('Wychodzi mi');
    }
  });

  it('agent niczego nie wykonuje — prowadzi do pliku', () => {
    const proposal = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-20'),
    });
    expect(proposal?.payload?.primaryIntent).toBe('open');
    expect(proposal?.payload?.primaryLabel).toBe('Pobierz plik');
  });
});

// ═══════════════════════════════════════════════════════════════
// Dane niepełne
// ═══════════════════════════════════════════════════════════════

describe('nieprzejrzane dokumenty', () => {
  const proposal = buildDeadlineProposal({
    tenantId: 't1',
    kind: 'vat',
    snapshot: snapshot({ unreviewedExpenses: 3 }),
    today: d('2026-09-20'),
  });

  it('kwota jest oznaczona jako niepełna ZARAZ ZA LICZBĄ', () => {
    // Zastrzeżenie, które trzeba doczytać, nie jest zastrzeżeniem.
    // Zdanie z kwotą, kropka, zaraz potem zastrzeżenie — nic pomiędzy.
    expect(proposal!.body).toMatch(/Wychodzi mi [^.]+\. Kwota jest niepełna/);
  });

  it('agent proponuje NAJPIERW domknięcie kosztów', () => {
    expect(proposal?.payload?.primaryLabel).toBe('Przejrzyj koszty');
    expect(proposal?.payload?.complete).toBe(false);
    expect(proposal?.evidence?.[0]?.href).toBe('/expenses');
  });

  it('komplet danych nie straszy zastrzeżeniem', () => {
    const clean = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-20'),
    });
    expect(clean?.body).not.toContain('niepełna');
  });
});

// ═══════════════════════════════════════════════════════════════
// Termin przesunięty
// ═══════════════════════════════════════════════════════════════

describe('termin przesunięty na dzień roboczy', () => {
  // VAT za marzec 2026: ustawowo 25.04 (sobota), faktycznie 27.04.
  const proposal = buildDeadlineProposal({
    tenantId: 't1',
    kind: 'vat',
    snapshot: snapshot({ year: 2026, month: 3, asOf: '2026-04-22' }),
    today: d('2026-04-22'),
  });

  it('tytuł pokazuje termin faktyczny', () => {
    expect(proposal?.title).toBe('JPK_V7M do 27.04');
  });

  it('treść tłumaczy, skąd inna data niż ta z ustawy', () => {
    // Bez tego zdania klient nie wie, czy program się myli, czy on źle pamięta.
    expect(proposal?.body).toContain('Ustawowy termin to 25.04');
    expect(proposal?.body).toContain('liczy się 27.04');
  });

  it('karta wygasa z końcem dnia terminu', () => {
    expect(proposal?.expiresAt.toISOString().slice(0, 10)).toBe('2026-04-27');
  });
});

// ═══════════════════════════════════════════════════════════════
// Karta
// ═══════════════════════════════════════════════════════════════

describe('karta T-01', () => {
  it('jeden okres = jeden temat', () => {
    const proposal = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-18'),
    });
    expect(proposal?.topicKey).toBe('tax.deadline:vat:2026-08');
  });

  it('priorytet rośnie na trzy dni przed terminem', () => {
    const early = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-18'),
    });
    const late = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-23'),
    });
    expect(late!.priority!).toBeLessThan(early!.priority!);
  });

  it('zmiana kwoty zmienia odcisk danych', () => {
    const base = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot(),
      today: d('2026-09-18'),
    });
    const changed = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot({ summary: summary({ balance: 2_900 }) }),
      today: d('2026-09-18'),
    });
    expect(changed?.fingerprint).not.toBe(base?.fingerprint);
  });

  it('odświeżenie danych tego samego dnia nie przepisuje karty bez powodu', () => {
    // `asOf` zmienia się codziennie; gdyby wchodziło w odcisk, karta
    // udawałaby nową wiedzę przy każdym przebiegu.
    const a = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot({ asOf: '2026-09-18' }),
      today: d('2026-09-18'),
    });
    const b = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'vat',
      snapshot: snapshot({ asOf: '2026-09-19' }),
      today: d('2026-09-19'),
    });
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });

  it('poza oknem nie powstaje żadna karta', () => {
    expect(
      buildDeadlineProposal({
        tenantId: 't1',
        kind: 'vat',
        snapshot: snapshot(),
        today: d('2026-09-01'),
      }),
    ).toBeNull();
  });

  it('PIT ma własną nazwę i własny temat', () => {
    const proposal = buildDeadlineProposal({
      tenantId: 't1',
      kind: 'pit',
      snapshot: snapshot(),
      today: d('2026-09-16'),
    });
    expect(proposal?.title).toContain('Zaliczka na PIT');
    expect(proposal?.topicKey).toBe('tax.deadline:pit:2026-08');
  });
});
