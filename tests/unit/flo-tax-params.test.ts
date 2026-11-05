import { describe, expect, it } from 'vitest';

import { createProposal } from '@/lib/flo/proposals';
import {
  easterSunday,
  holidaysOf,
  isBusinessDay,
  isPublicHoliday,
  PARAMS_MAX_AGE_DAYS,
  PARAMS_REVIEWED_ON,
  PARAMS_VERIFIED,
  paramsAgeDays,
  paramsFor,
  paramsStale,
  quarterEndMonth,
  shiftToBusinessDay,
  TAX_PARAMS,
  taxDeadline,
} from '@/lib/flo/tax-params';
import {
  canComputeTax,
  isTaxKind,
  isTaxProfileUsable,
  missingProfileFields,
  parseTaxProfile,
  TAX_KINDS,
  taxGateOpen,
} from '@/lib/flo/tax-profile';
import { createFakeDb } from './flo-fake-db';

/**
 * Krok 35 — profil podatkowy i parametry roczne.
 *
 * Dwie rzeczy pilnowane tutaj są ważniejsze od poprawności arytmetyki:
 * agent bez profilu MILCZY, a tabela parametrów prawnych nie ma prawa
 * zestarzeć się po cichu.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// ═══════════════════════════════════════════════════════════════
// Bezpieczniki
// ═══════════════════════════════════════════════════════════════

describe('bezpiecznik wieku parametrów', () => {
  it('TABELA PARAMETRÓW JEST ŚWIEŻA — ten test ma popsuć build, gdy się zestarzeje', () => {
    // Nie jest to test arytmetyki, tylko budzik. Parametry podatkowe,
    // o których wszyscy zapomnieli, są gorsze od ich braku: brak widać
    // od razu, a stara liczba wygląda dokładnie tak samo jak świeża.
    expect(paramsStale(new Date())).toBe(false);
  });

  it('liczy wiek tabeli od daty ostatniego przeglądu', () => {
    const reviewed = d(PARAMS_REVIEWED_ON);
    const later = new Date(reviewed.getTime() + 10 * 86_400_000);
    expect(paramsAgeDays(later)).toBe(10);
  });

  it('dzień po granicy tabela jest przeterminowana', () => {
    const over = new Date(
      d(PARAMS_REVIEWED_ON).getTime() + (PARAMS_MAX_AGE_DAYS + 1) * 86_400_000,
    );
    expect(paramsStale(over)).toBe(true);
  });

  it('wartości są nadal NIEPOTWIERDZONE — grupa T nie ma prawa liczyć klientowi', () => {
    // Gdy ktoś przestawi flagę, ten test upadnie i zmusi do sprawdzenia,
    // czy każdy wiersz ma wypełnione pole `source`.
    expect(PARAMS_VERIFIED).toBe(false);
    expect(TAX_PARAMS.every((row) => row.source === '')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Tabela parametrów
// ═══════════════════════════════════════════════════════════════

describe('parametry z datami obowiązywania', () => {
  it('zwraca zestaw obowiązujący w danym dniu', () => {
    expect(paramsFor(d('2026-06-15'))?.validFrom).toBe('2026-01-01');
  });

  it('przed pierwszym wierszem milczy, zamiast podstawiać najstarszy znany', () => {
    expect(paramsFor(d('2019-06-15'))).toBeNull();
  });

  it('wiersze są posortowane rosnąco', () => {
    const dates = TAX_PARAMS.map((row) => row.validFrom);
    expect([...dates].sort()).toEqual(dates);
  });
});

// ═══════════════════════════════════════════════════════════════
// Kalendarz
// ═══════════════════════════════════════════════════════════════

describe('kalendarz dni wolnych', () => {
  it('wyznacza Wielkanoc 2026–2028', () => {
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
    expect(easterSunday(2027).toISOString().slice(0, 10)).toBe('2027-03-28');
    expect(easterSunday(2028).toISOString().slice(0, 10)).toBe('2028-04-16');
  });

  it('zna święta ruchome liczone od Wielkanocy', () => {
    const y2026 = holidaysOf(2026);
    expect(y2026.has('2026-04-06')).toBe(true); // poniedziałek wielkanocny
    expect(y2026.has('2026-05-24')).toBe(true); // Zielone Świątki
    expect(y2026.has('2026-06-04')).toBe(true); // Boże Ciało
  });

  it('zna święta o stałej dacie', () => {
    expect(isPublicHoliday(d('2026-11-11'))).toBe(true);
    expect(isPublicHoliday(d('2026-12-26'))).toBe(true);
    // Od 2025 r. Wigilia jest dniem wolnym od pracy (kalendarz z lib/ksiegowosc,
    // krok K1 planu księgowości; ten sam wyjątek ma lib/ksef/idempotency.ts).
    expect(isPublicHoliday(d('2026-12-24'))).toBe(true);
    expect(isPublicHoliday(d('2024-12-24'))).toBe(false);
  });

  it('weekend nie jest dniem roboczym', () => {
    expect(isBusinessDay(d('2026-08-15'))).toBe(false); // sobota i święto naraz
    expect(isBusinessDay(d('2026-08-17'))).toBe(true);
  });

  it('przesuwa ZAWSZE DO PRZODU, przez ciąg dni wolnych', () => {
    // 1 maja 2026 to piątek-święto, potem sobota, niedziela-święto.
    expect(shiftToBusinessDay(d('2026-05-01')).toISOString().slice(0, 10)).toBe(
      '2026-05-04',
    );
  });

  it('dzień roboczy zostaje na miejscu', () => {
    expect(shiftToBusinessDay(d('2026-09-15')).toISOString().slice(0, 10)).toBe(
      '2026-09-15',
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Terminy 2026–2028
// ═══════════════════════════════════════════════════════════════

describe('terminy na lata 2026–2028', () => {
  it('VAT za marzec 2026: 25 kwietnia to sobota, termin idzie na poniedziałek', () => {
    expect(taxDeadline({ kind: 'vat', year: 2026, month: 3 })).toEqual({
      kind: 'vat',
      nominal: '2026-04-25',
      due: '2026-04-27',
      shifted: true,
    });
  });

  it('VAT za grudzień 2025 rozlicza się w styczniu 2026', () => {
    // Przełom roku: miesiąc następny wypada w kolejnym roku.
    expect(taxDeadline({ kind: 'vat', year: 2025, month: 12 })?.due).toBe('2026-01-26');
  });

  it('VAT za marzec 2027: niedziela → poniedziałek', () => {
    expect(taxDeadline({ kind: 'vat', year: 2027, month: 3 })?.due).toBe('2027-04-26');
  });

  it('VAT za marzec 2028: wtorek, bez przesunięcia', () => {
    const deadline = taxDeadline({ kind: 'vat', year: 2028, month: 3 });
    expect(deadline?.due).toBe('2028-04-25');
    expect(deadline?.shifted).toBe(false);
  });

  it('VAT za maj 2028: niedziela → poniedziałek', () => {
    expect(taxDeadline({ kind: 'vat', year: 2028, month: 5 })?.due).toBe('2028-06-26');
  });

  it('zaliczka PIT i ZUS mają własny dzień miesiąca', () => {
    expect(taxDeadline({ kind: 'pit', year: 2026, month: 3 })?.due).toBe('2026-04-20');
    expect(taxDeadline({ kind: 'zus', year: 2026, month: 3 })?.due).toBe('2026-04-20');
  });

  it('termin nominalny jest zachowany obok faktycznego', () => {
    // Komunikat ma prawo powiedzieć „termin wypada w sobotę, więc masz czas
    // do poniedziałku" — bez obu dat nie da się tego napisać uczciwie.
    const deadline = taxDeadline({ kind: 'vat', year: 2026, month: 3 });
    expect(deadline?.nominal).toBe('2026-04-25');
    expect(deadline?.due).not.toBe(deadline?.nominal);
  });

  it('bez znanych parametrów nie zgaduje terminu', () => {
    expect(taxDeadline({ kind: 'vat', year: 2019, month: 3 })).toBeNull();
  });

  it('kwartał kończy się na ostatnim miesiącu kwartału', () => {
    expect(quarterEndMonth(1)).toBe(3);
    expect(quarterEndMonth(5)).toBe(6);
    expect(quarterEndMonth(12)).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════════
// Profil podatkowy
// ═══════════════════════════════════════════════════════════════

describe('profil podatkowy', () => {
  const complete = { form: 'liniowy', vat: true, period: 'M', startedOn: '2025-03-01' };

  it('czyta poprawny profil z JSON-a', () => {
    expect(parseTaxProfile(complete)).toEqual({
      form: 'liniowy',
      vat: true,
      period: 'M',
      startedOn: '2025-03-01',
      // Dodane w kroku 39: agent nie wybiera stawki ryczałtu za człowieka.
      ryczaltRate: null,
    });
  });

  it('czyta stawkę ryczałtu, ale tylko sensowną', () => {
    expect(parseTaxProfile({ ...complete, form: 'ryczalt', ryczaltRate: 0.085 })?.ryczaltRate).toBe(
      0.085,
    );
    // 8.5 zamiast 0.085 to typowa pomyłka o dwa rzędy wielkości — odrzucamy,
    // zamiast policzyć klientowi 850% podatku.
    expect(parseTaxProfile({ ...complete, ryczaltRate: 8.5 })?.ryczaltRate).toBeNull();
    expect(parseTaxProfile({ ...complete, ryczaltRate: '0.085' })?.ryczaltRate).toBeNull();
  });

  it('ryczałt bez stawki nie pozwala policzyć podatku, choć profil jest kompletny', () => {
    const ryczalt = parseTaxProfile({ ...complete, form: 'ryczalt' });
    expect(isTaxProfileUsable(ryczalt)).toBe(true);
    expect(canComputeTax(ryczalt)).toBe(false);
    expect(canComputeTax(parseTaxProfile({ ...complete, form: 'ryczalt', ryczaltRate: 0.085 }))).toBe(
      true,
    );
  });

  it('brak profilu to normalny stan konta, nie awaria', () => {
    expect(parseTaxProfile(null)).toBeNull();
    expect(parseTaxProfile('coś')).toBeNull();
    expect(parseTaxProfile({ form: 'skala' })).toBeNull(); // brak okresu
  });

  it('data spoza kalendarza nie zostaje profilem', () => {
    // 31 lutego przechodzi przez Date.parse i cofa się na marzec.
    const profile = parseTaxProfile({ ...complete, startedOn: '2026-02-31' });
    expect(profile?.startedOn).toBeNull();
  });

  it('forma „nieznana" NIE otwiera grupy podatkowej', () => {
    // Kreator ma prawo zapisać „klient jeszcze nie wie". Agent ma wtedy
    // obowiązek milczeć, a nie wybrać za niego skalę.
    expect(isTaxProfileUsable(parseTaxProfile({ ...complete, form: 'nieznana' }))).toBe(
      false,
    );
  });

  it('brak daty rozpoczęcia działalności NIE otwiera grupy podatkowej', () => {
    // Bez niej T-02 nie policzy proporcji limitu, a T-03 nie ma od czego
    // odliczać ulgi.
    const profile = parseTaxProfile({ ...complete, startedOn: null });
    expect(isTaxProfileUsable(profile)).toBe(false);
    expect(missingProfileFields(profile)).toContain('data rozpoczęcia działalności');
  });

  it('kompletny profil otwiera bramkę', () => {
    expect(isTaxProfileUsable(parseTaxProfile(complete))).toBe(true);
    expect(missingProfileFields(parseTaxProfile(complete))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Bramka M12
// ═══════════════════════════════════════════════════════════════

describe('M12 — bez profilu grupa T milczy', () => {
  const profile = { form: 'skala', vat: false, period: 'M', startedOn: '2025-03-01' };

  it('lista rodzajów objętych bramką pokrywa całą grupę T', () => {
    expect(TAX_KINDS).toHaveLength(5);
    expect(TAX_KINDS.every((kind) => kind.startsWith('tax.'))).toBe(true);
    expect(isTaxKind('tax.deadline')).toBe(true);
    expect(isTaxKind('invoice.final')).toBe(false);
  });

  it('bramka jest zamknięta, dopóki tabela parametrów nie jest potwierdzona', async () => {
    // Nawet z kompletnym profilem: sam profil nie wystarczy, jeśli limity
    // i terminy nie zostały sprawdzone przez człowieka.
    const db = createFakeDb({
      flo_prefs: [{ tenant_id: 't1', tax_profile: profile }],
    });
    expect(await taxGateOpen('t1', db.client)).toBe(false);
    expect(PARAMS_VERIFIED).toBe(false);
  });

  it('propozycja podatkowa nie zostawia ŚLADU W BAZIE bez profilu', async () => {
    // Gdyby powstawała mimo bramki, po włączeniu grupy T wysypałaby się
    // na klienta lawina kart sprzed miesięcy.
    const db = createFakeDb({ flo_prefs: [{ tenant_id: 't1', tax_profile: null }] });

    const result = await createProposal(
      {
        tenantId: 't1',
        kind: 'tax.deadline',
        topicKey: 'tax.deadline:2026-03',
        title: 'VAT za marzec',
        body: 'test',
        fingerprint: 'x',
        expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      },
      db.client,
      async () => false,
    );

    expect(result.status).not.toBe('created');
    expect(db.tables.flo_proposals).toHaveLength(0);
  });

  it('rodzaj spoza grupy T nie pyta o profil podatkowy', async () => {
    const db = createFakeDb({ flo_prefs: [] });

    const result = await createProposal(
      {
        tenantId: 't1',
        kind: 'invoice.final',
        topicKey: 'invoice.final:root',
        title: 'Faktura końcowa',
        body: 'test',
        fingerprint: 'x',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
      db.client,
      async () => false,
    );

    expect(result.status).toBe('created');
    expect(db.tables.flo_proposals).toHaveLength(1);
  });
});
