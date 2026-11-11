import { describe, expect, it } from 'vitest';

import {
  assessExpense,
  buildExpenseReviewProposal,
  buildOcrFailedProposal,
  median,
  type OcrFacts,
  type SellerHistory,
} from '@/lib/flo/functions/expense-review';
import { fingerprintOf } from '@/lib/flo/fingerprint';
import { containsSensitive, redactForModel, redactText } from '@/lib/flo/redact';

/**
 * Minimalizacja danych (krok 17) i pierwsza prawdziwa funkcja agenta —
 * paragon z telefonu (krok 18).
 */

const NOW = new Date('2026-08-26T12:00:00.000Z');

// ═══════════════════════════════════════════════════════════════
// Krok 17
// ═══════════════════════════════════════════════════════════════

describe('minimalizacja danych przed wysłaniem do modelu', () => {
  it('usuwa numer konta w każdej postaci', () => {
    const withIban = 'Przelew na PL61 1090 1014 0000 0712 1981 2874 do jutra.';
    const withBare = 'Konto: 61 1090 1014 0000 0712 1981 2874';

    expect(redactText(withIban)).not.toContain('1090');
    expect(redactText(withIban)).toContain('[konto]');
    expect(redactText(withBare)).not.toContain('1090');
  });

  it('usuwa PESEL, e-mail i telefon', () => {
    const text = 'Kontakt: anna@biuro.pl, 512 345 678, PESEL 84052212345.';
    const clean = redactText(text);

    expect(clean).not.toContain('anna@biuro.pl');
    expect(clean).not.toContain('512 345 678');
    expect(clean).not.toContain('84052212345');
  });

  it('usuwa adres i kod pocztowy', () => {
    const clean = redactText('Siedziba: ul. Chemików 7, 09-411 Płock');
    expect(clean).not.toContain('Chemików');
    expect(clean).not.toContain('09-411');
  });

  it('zostawia to, co jest do zadania potrzebne', () => {
    // Nazwa firmy i słowa opisujące sprawę mają zostać — inaczej model nie
    // ma z czego napisać zdania.
    const clean = redactText('Nowak Sp. z o.o. spóźnia się trzeci raz z rzędu');
    expect(clean).toContain('Nowak Sp. z o.o.');
    expect(clean).toContain('trzeci raz');
  });

  it('NIP tylko wtedy, gdy jawnie dopuszczony', () => {
    const text = 'NIP 5252445767';
    expect(redactText(text)).not.toContain('5252445767');
    expect(redactText(text, { allowNip: true })).toContain('5252445767');
  });

  it('czyści całą strukturę, nie tylko napis', () => {
    const context = {
      seller: 'Orlen',
      note: 'zapłacone z konta PL61 1090 1014 0000 0712 1981 2874',
      nested: { contact: 'biuro@orlen.pl' },
      list: ['ul. Chemików 7', 'zwykły tekst'],
    };

    const clean = redactForModel(context);
    const serialized = JSON.stringify(clean);

    expect(serialized).toContain('Orlen');
    expect(containsSensitive(serialized)).toBe(false);
  });

  it('zestaw realnych kontekstów wychodzi czysty', () => {
    // Wymóg z planu: test na ZESTAWIE kontekstów, nie na jednym zdaniu.
    const contexts = [
      'Faktura opłacona przelewem na PL27 1140 2004 0000 3002 0135 5387',
      'Kontrahent: Jan Kowalski, ul. Długa 12/3, 00-238 Warszawa, tel. +48 601 234 567',
      'Wysłać na anna.kowalska@biuro-rachunkowe.pl przed końcem miesiąca',
      'Klient podał PESEL 90010112345 do umowy',
      'Zwykły kontekst bez danych: trzecie opóźnienie w tym roku',
    ];

    for (const context of contexts) {
      expect(containsSensitive(redactText(context)), context).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Krok 18
// ═══════════════════════════════════════════════════════════════

function facts(overrides: Partial<OcrFacts> = {}): OcrFacts {
  return {
    sellerName: 'Orlen',
    sellerNip: '7740001454',
    netAmount: 254.0,
    vatAmount: 58.4,
    grossAmount: 312.4,
    issueDate: '2026-08-22',
    confidence: 0.95,
    categoryLabel: 'paliwo',
    ...overrides,
  };
}

const history: SellerHistory = { count: 12, medianGross: 300 };

describe('W-01 — ocena odczytu', () => {
  it('czysty odczyt nie wymaga pytania', () => {
    const result = assessExpense(facts(), history);
    expect(result.needsQuestion).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it('AWARIA 1: przecinek zgubiony przez OCR', () => {
    // 312,40 odczytane jako 31 240. Kontrola rzędu wielkości to jedyne sito,
    // które to łapie — arytmetyka może się zgadzać, a pewność być wysoka.
    const result = assessExpense(
      facts({ grossAmount: 31240, netAmount: 25400, vatAmount: 5840 }),
      history,
    );
    expect(result.issues).toContain('magnitude');
    expect(result.needsQuestion).toBe(true);
  });

  it('AWARIA 1: kwoty, które się nie sumują', () => {
    const result = assessExpense(
      facts({ netAmount: 254.0, vatAmount: 58.4, grossAmount: 512.4 }),
      history,
    );
    expect(result.issues).toContain('arithmetic');
  });

  it('AWARIA 1: nieczytelne zdjęcie', () => {
    expect(assessExpense(facts({ confidence: 0.3 }), history).issues).toContain(
      'low_confidence',
    );
    expect(assessExpense(facts({ sellerName: null }), history).issues).toContain(
      'missing_field',
    );
  });

  it('tolerancja groszowa nie wywołuje fałszywego alarmu', () => {
    // Zaokrąglenia na paragonie potrafią dać grosz różnicy. Pytanie o każdy
    // taki przypadek byłoby udręką.
    const result = assessExpense(
      facts({ netAmount: 254.0, vatAmount: 58.41, grossAmount: 312.4 }),
      history,
    );
    expect(result.issues).not.toContain('arithmetic');
  });

  it('AWARIA 2: wydatek prywatny — kategoria wątpliwa pyta zawsze', () => {
    // Idealny odczyt, znany sprzedawca, a mimo to pytanie. O firmowości
    // decyduje wyłącznie człowiek.
    const result = assessExpense(
      facts({ sellerName: 'Biedronka', categoryLabel: 'spozywcze' }),
      { count: 20, medianGross: 300 },
    );
    expect(result.issues).toContain('sensitive_category');
    expect(result.needsQuestion).toBe(true);
  });

  it('AWARIA 2: nieznany sprzedawca przy większej kwocie', () => {
    const result = assessExpense(
      facts({ netAmount: 3414.63, vatAmount: 785.37, grossAmount: 4200 }),
      { count: 0, medianGross: 0 },
    );
    expect(result.issues).toContain('unknown_seller');
  });

  it('nieznany sprzedawca przy drobnej kwocie nie zawraca głowy', () => {
    const result = assessExpense(
      facts({ netAmount: 20.24, vatAmount: 4.66, grossAmount: 24.9 }),
      { count: 0, medianGross: 0 },
    );
    expect(result.needsQuestion).toBe(false);
  });

  it('krótka historia nie uruchamia kontroli rzędu wielkości', () => {
    // Dwa dokumenty to za mało, żeby cokolwiek nazywać typowym.
    const result = assessExpense(
      facts({ netAmount: 7317.07, vatAmount: 1682.93, grossAmount: 9000 }),
      { count: 2, medianGross: 100 },
    );
    expect(result.issues).not.toContain('magnitude');
  });

  it('mediana bierze środek, nie średnią', () => {
    // Jeden wybryk nie ma prawa przesunąć progu.
    expect(median([10, 12, 14, 16, 5000])).toBe(14);
  });
});

describe('W-01 — karta dla klienta', () => {
  it('przy pewnym odczycie melduje i daje cofnięcie', () => {
    const proposal = buildExpenseReviewProposal({
      tenantId: 'ten-1',
      expenseId: 'exp-1',
      facts: facts(),
      history,
      applied: { kpirColumn: 'col_13', categoryLabel: 'paliwo' },
      now: NOW,
    });

    expect(proposal.title).toBe('Orlen, 312,40 zł');
    expect(proposal.body).toContain('Zaksięgowałem');
    expect(proposal.payload?.undo).toBeTruthy();
    expect(proposal.topicKey).toBe('expense.review:exp-1');
  });

  it('wywołanie bez nowych pól daje ten sam odcisk co przed obsługą walut', () => {
    // Karty już leżące w bazie mają odcisk liczony z tych czterech faktów.
    // Zmiana odcisku dla złotówek = każda z nich „nieaktualna” przy kliknięciu.
    const proposal = buildExpenseReviewProposal({
      tenantId: 'ten-1',
      expenseId: 'exp-1',
      facts: facts(),
      history,
      applied: { kpirColumn: 'col_13', categoryLabel: 'paliwo' },
      now: NOW,
    });

    expect(proposal.payload?.facts).toEqual({
      grossTotal: 312.4,
      kpirColumn: 'col_13',
      reviewedAt: 0,
      deductible: 1,
    });
    expect(proposal.fingerprint).toBe(
      fingerprintOf({ grossTotal: 312.4, kpirColumn: 'col_13', reviewedAt: 0, deductible: 1 }),
    );
    // Wartość z wersji sprzed zmiany (ef9bb43) — pilnuje też samego skrótu.
    expect(proposal.fingerprint).toBe('d3b4c560f53a65272a8d7a8eccb9617a');
    // Złotówki nie dostają przycisku „otwórz” — zostaje „Zgadza się”.
    expect(proposal.payload).not.toHaveProperty('primaryIntent');
    expect(proposal.payload).not.toHaveProperty('primaryLabel');
  });

  it('przy wątpliwościach PYTA i nie twierdzi, że zaksięgował', () => {
    // To jest różnica, która decyduje o zaufaniu: agent nie może meldować
    // roboty, której nie jest pewien.
    const proposal = buildExpenseReviewProposal({
      tenantId: 'ten-1',
      expenseId: 'exp-2',
      facts: facts({ confidence: 0.2 }),
      history,
      applied: { kpirColumn: null, categoryLabel: null },
      now: NOW,
    });

    expect(proposal.title).toContain('do sprawdzenia');
    expect(proposal.body).not.toContain('Zaksięgowałem');
    // Nie ma czego cofać — agent niczego nie przesądził.
    expect(proposal.payload?.undo).toBeUndefined();
    // Sprawa do decyzji jest pilniejsza niż zwykły meldunek.
    expect(proposal.priority).toBeLessThan(60);
  });

  it('AWARIA 3: nieudany odczyt kończy się kartą z drogą wyjścia', () => {
    const proposal = buildOcrFailedProposal('ten-1', 'ocr-7', NOW);

    expect(proposal.title).toContain('Nie odczytałem');
    // Klient musi wiedzieć, że dokument nie przepadł — inaczej wyrzuci
    // paragon i po miesiącu nie będzie czego odtwarzać.
    expect(proposal.body).toContain('archiwum');
    // Drogą wyjścia jest ponowne wgranie dokumentu. Wpisu ręcznego kosztu nie ma
    // (plan kompletnej aplikacji, 2.6; formularz to krok 3.8).
    expect(proposal.body).toMatch(/Wgraj je jeszcze raz.*nowe ujęcie/);
    expect(proposal.body).not.toMatch(/ręcznie/i);
    expect(proposal.topicKey).toBe('expense.review:ocr:ocr-7');
  });

  it('AWARIA 3: karta porażki prowadzi do wydatków zamiast udawać „Zgadza się”', () => {
    // Wydatku nie ma, więc wykonawca zawsze kończył się „Propozycja bez
    // identyfikatora wydatku”. Przycisk ma otworzyć listę wydatków.
    const proposal = buildOcrFailedProposal('ten-1', 'ocr-7', NOW);

    expect(proposal.payload).toEqual({
      // Klucze, na których opiera się baner — bez zmian.
      ocrJobId: 'ocr-7',
      failed: 1,
      primaryIntent: 'open',
      primaryLabel: 'Otwórz Wydatki',
    });
    expect(proposal.evidence?.[0]?.href).toBe('/expenses');
    // Odcisk bez zmian — wciąż tylko z identyfikatora zadania OCR.
    expect(proposal.fingerprint).toBe(fingerprintOf({ ocrJobId: 'ocr-7' }));
    expect(proposal.priority).toBe(45);
  });

  it('kwota w karcie jest sformatowana przez serwer', () => {
    const proposal = buildExpenseReviewProposal({
      tenantId: 'ten-1',
      expenseId: 'exp-3',
      facts: facts({ grossAmount: 12400.5 }),
      history: { count: 12, medianGross: 12000 },
      applied: { kpirColumn: 'col_13', categoryLabel: 'paliwo' },
      now: NOW,
    });
    expect(proposal.title).toContain('12 400,50 zł');
  });
});
