import { describe, expect, it } from 'vitest';

import {
  INVOICE_PAYMENT_SOURCES,
  PAYMENT_NOTE_MAX,
  formatPaymentMoney,
  isVoidableSource,
  parseInvoicePaymentsRpc,
  parsePaymentAmount,
  paymentEntrySchema,
  paymentSourceLabel,
  paymentStateLabel,
  recordPaymentRefusalText,
  recordedPaymentToast,
  summarizeInvoicePayments,
  voidPaymentRefusalText,
  voidedPaymentToast,
  type InvoicePaymentEntry,
  type RecordPaymentRefusal,
  type VoidPaymentRefusal,
} from '@/lib/invoices/invoice-payments';

/**
 * Wpłaty częściowe i historia wpłat (plan kompletnej aplikacji, krok 3.1):
 * walidacja pól „Zapisz wpłatę” (ten sam schemat Zod w formularzu i w akcji),
 * odczyt historii z RPC `invoice_payments` (00176) i przeliczenie, które
 * lustrzanie powtarza wyzwalacz `recalculate_invoice_paid_amount`: liczą się
 * tylko wpłaty niecofnięte. Same RPC i wyzwalacze sprawdza
 * `tests/rls-wplaty-czesciowe.test.ts` na prawdziwej bazie.
 */

const TODAY = '2026-11-09';
const NBSP = /[  ]/g;
const plain = (text: string) => text.replace(NBSP, ' ');

function entry(over: Partial<InvoicePaymentEntry> = {}): InvoicePaymentEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    amount: 300,
    paidOn: '2026-11-02',
    source: 'manual_entry',
    note: null,
    recordedAt: '2026-11-02T09:00:00Z',
    voidedAt: null,
    ...over,
  };
}

describe('kwota wpłaty wpisana przez człowieka', () => {
  it.each([
    ['300', 300],
    ['300,5', 300.5],
    ['300.50', 300.5],
    ['1 234,56', 1234.56],
    ['1 234,56', 1234.56],
    ['  930,00 ', 930],
    ['0,01', 0.01],
  ])('%j → %d', (text, value) => {
    expect(parsePaymentAmount(text)).toBe(value);
  });

  it.each(['', '0', '0,00', '-5', '12,345', '1,2,3', 'abc', '1 23', '12e3', '300 zł'])(
    '%j: nie kwota (null), a nie zgadywanie',
    (text) => {
      expect(parsePaymentAmount(text)).toBeNull();
    },
  );

  it('grosze bez błędu zmiennoprzecinkowego: 0,1 + 0,2 nie daje 0,30000000000000004', () => {
    expect(parsePaymentAmount('0,30')).toBe(0.3);
    expect(parsePaymentAmount('1 000 000,10')).toBe(1000000.1);
  });
});

describe('schemat pól „Zapisz wpłatę” (formularz i akcja)', () => {
  const schema = paymentEntrySchema({ today: TODAY });

  it('poprawne pola przechodzą; notatka przycięta', () => {
    expect(schema.safeParse({ amount: '300,00', paidOn: TODAY, note: '  przelew z mBanku ' })).toEqual({
      success: true,
      data: { amount: '300,00', paidOn: TODAY, note: 'przelew z mBanku' },
    });
  });

  it('data domyślnie dziś: wcześniejszy dzień też przechodzi', () => {
    expect(schema.safeParse({ amount: '1', paidOn: '2026-10-01', note: '' }).success).toBe(true);
  });

  it.each([
    ['', 'Wpisz kwotę wpłaty.'],
    ['0', 'Wpisz kwotę większą od zera, np. 300 albo 1 234,56.'],
    ['-10', 'Wpisz kwotę większą od zera, np. 300 albo 1 234,56.'],
    ['12,345', 'Wpisz kwotę większą od zera, np. 300 albo 1 234,56.'],
  ])('kwota %j: odmowa z komunikatem', (amount, message) => {
    const result = schema.safeParse({ amount, paidOn: TODAY, note: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['amount'], message });
  });

  it('data z przyszłości (jutro w Warszawie): odmowa', () => {
    const result = schema.safeParse({ amount: '10', paidOn: '2026-11-10', note: '' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['paidOn'],
      message: 'Data wpłaty nie może być z przyszłości. Wpisz dzisiejszą albo wcześniejszą datę.',
    });
  });

  it.each(['2026-02-30', '2026-13-01', 'wczoraj', ''])('data %j: odmowa', (paidOn) => {
    const result = schema.safeParse({ amount: '10', paidOn, note: '' });
    expect(result.error?.issues[0]?.path).toEqual(['paidOn']);
  });

  it('rok z literówki (przed 2000): odmowa jak w RPC', () => {
    const result = schema.safeParse({ amount: '10', paidOn: '0202-10-01', note: '' });
    expect(result.error?.issues[0]).toMatchObject({ path: ['paidOn'], message: 'Sprawdź rok w dacie wpłaty: wygląda na literówkę.' });
  });

  it(`notatka najwyżej ${PAYMENT_NOTE_MAX} znaków`, () => {
    expect(schema.safeParse({ amount: '10', paidOn: TODAY, note: 'x'.repeat(PAYMENT_NOTE_MAX) }).success).toBe(true);
    const result = schema.safeParse({ amount: '10', paidOn: TODAY, note: 'x'.repeat(PAYMENT_NOTE_MAX + 1) });
    expect(result.error?.issues[0]).toMatchObject({ path: ['note'], message: 'Notatka może mieć najwyżej 500 znaków.' });
  });

  it('z górną granicą (formularz zna resztę do zapłaty): kwota ponad resztę to odmowa z kwotą reszty', () => {
    const withMax = paymentEntrySchema({ today: TODAY, maxAmount: 930 });
    expect(withMax.safeParse({ amount: '930,00', paidOn: TODAY, note: '' }).success).toBe(true);
    const result = withMax.safeParse({ amount: '930,01', paidOn: TODAY, note: '' });
    expect(result.error?.issues[0]?.path).toEqual(['amount']);
    expect(plain(result.error!.issues[0]!.message)).toBe('Kwota jest większa niż pozostało do zapłaty (930,00 PLN).');
  });
});

describe('historia z RPC invoice_payments (00176)', () => {
  it('czyta wiersze bazy: kwota jako liczba, cofnięcie, notatka, źródło', () => {
    expect(parseInvoicePaymentsRpc([
      {
        id: 'p1', amount: '300.00', paid_on: '2026-11-02', source: 'manual_entry', note: 'zaliczka',
        recorded_at: '2026-11-02T09:00:00+00:00', voided_at: null,
      },
      {
        id: 'p2', amount: 930, paid_on: '2026-11-05', source: 'manual', note: null,
        recorded_at: '2026-11-05T09:00:00+00:00', voided_at: null,
      },
      {
        id: 'p3', amount: 50, paid_on: '2026-11-01', source: 'manual_entry', note: null,
        recorded_at: '2026-11-01T09:00:00+00:00', voided_at: '2026-11-03T08:00:00+00:00',
      },
    ])).toEqual([
      { id: 'p1', amount: 300, paidOn: '2026-11-02', source: 'manual_entry', note: 'zaliczka', recordedAt: '2026-11-02T09:00:00+00:00', voidedAt: null },
      { id: 'p2', amount: 930, paidOn: '2026-11-05', source: 'manual', note: null, recordedAt: '2026-11-05T09:00:00+00:00', voidedAt: null },
      { id: 'p3', amount: 50, paidOn: '2026-11-01', source: 'manual_entry', note: null, recordedAt: '2026-11-01T09:00:00+00:00', voidedAt: '2026-11-03T08:00:00+00:00' },
    ]);
  });

  it('nieznane źródło wpłaty to „other”, a nie błąd odczytu', () => {
    expect(parseInvoicePaymentsRpc([{ id: 'p', amount: 1, paid_on: '2026-11-01', source: 'cos-nowego' }])?.[0]?.source).toBe('other');
  });

  it.each([
    ['null', null],
    ['obiekt zamiast listy', { amount: 1 }],
    ['kwota nieliczbowa', [{ id: 'p', amount: 'dużo', paid_on: '2026-11-01', source: 'manual_entry' }]],
    ['kwota zerowa', [{ id: 'p', amount: 0, paid_on: '2026-11-01', source: 'manual_entry' }]],
    ['brak daty', [{ id: 'p', amount: 1, paid_on: null, source: 'manual_entry' }]],
    ['brak identyfikatora', [{ amount: 1, paid_on: '2026-11-01', source: 'manual_entry' }]],
  ])('%s: null (ekran mówi, że historii nie udało się wczytać), nie pusta historia', (_label, data) => {
    expect(parseInvoicePaymentsRpc(data)).toBeNull();
  });

  it('pusta lista to pusta historia', () => {
    expect(parseInvoicePaymentsRpc([])).toEqual([]);
  });
});

describe('przeliczenie: lustro wyzwalacza recalculate_invoice_paid_amount', () => {
  it('suma liczy tylko wpłaty niecofnięte', () => {
    const entries = [entry({ amount: 300 }), entry({ amount: 200, voidedAt: '2026-11-03T08:00:00Z' }), entry({ amount: 100.1 })];
    expect(summarizeInvoicePayments(entries, 1230)).toEqual({ paid: 400.1, remaining: 829.9, state: 'partial', voided: 1 });
  });

  it('bez wpłat: nieopłacona; wszystkie cofnięte: też nieopłacona', () => {
    expect(summarizeInvoicePayments([], 1230)).toEqual({ paid: 0, remaining: 1230, state: 'unpaid', voided: 0 });
    expect(summarizeInvoicePayments([entry({ voidedAt: '2026-11-03T08:00:00Z' })], 1230)).toMatchObject({ paid: 0, state: 'unpaid', voided: 1 });
  });

  it('suma równa kwocie do zapłaty: opłacona, reszta zero', () => {
    expect(summarizeInvoicePayments([entry({ amount: 300 }), entry({ amount: 930 })], 1230)).toEqual({ paid: 1230, remaining: 0, state: 'paid', voided: 0 });
  });

  it('grosze: 0,1 + 0,2 to 0,30, a nie 0,30000000000000004', () => {
    expect(summarizeInvoicePayments([entry({ amount: 0.1 }), entry({ amount: 0.2 })], 1)).toMatchObject({ paid: 0.3, remaining: 0.7 });
  });
});

describe('teksty dla klienta', () => {
  const RECORD_CODES: RecordPaymentRefusal[] = [
    'not_found', 'not_sales', 'not_accepted', 'invoice_currency', 'payment_currency', 'invalid_amount',
    'future_date', 'invalid_date', 'note_too_long', 'already_paid', 'nothing_to_pay', 'corrected_to_zero',
    'over_remaining', 'key_reused',
  ];
  const VOID_CODES: VoidPaymentRefusal[] = ['not_found', 'not_voidable', 'manual_first'];

  it('każda odmowa zapisu ma tekst bez długich myślników; dokument z numerem tam, gdzie go dotyczy', () => {
    for (const code of RECORD_CODES) {
      const text = recordPaymentRefusalText(code, { number: 'FV/1/2026', remaining: 930, currency: 'EUR' });
      expect(text, code).not.toMatch(/[—–]/);
      expect(text.length, code).toBeGreaterThan(20);
    }
    for (const code of ['not_sales', 'not_accepted', 'invoice_currency', 'already_paid', 'nothing_to_pay', 'corrected_to_zero', 'over_remaining'] as const) {
      expect(recordPaymentRefusalText(code, { number: 'FV/1/2026', remaining: 930 }), code).toContain('FV/1/2026');
    }
  });

  it('wpłata ponad resztę: kwota reszty i wyjaśnienie, że nadpłat nie zapisujemy', () => {
    expect(plain(recordPaymentRefusalText('over_remaining', { number: 'FV/1/2026', remaining: 930 }))).toBe(
      'Kwota jest większa niż pozostało do zapłaty na fakturze FV/1/2026 (930,00 PLN). FaktWay nie zapisuje nadpłat: wpisz kwotę najwyżej do tej reszty.',
    );
  });

  it('faktura w walucie: nazwa waluty i informacja, że dziś tylko złote', () => {
    expect(recordPaymentRefusalText('invoice_currency', { number: 'FV/9', currency: 'EUR' })).toBe(
      'Faktura FV/9 jest w walucie EUR. Wpłaty zapisujemy na razie tylko do faktur w złotych (PLN). Wpłatę tej faktury trzeba na razie odnotować poza FaktWay.',
    );
  });

  it('każda odmowa cofnięcia ma tekst bez długich myślników i z wyjściem', () => {
    for (const code of VOID_CODES) {
      const text = voidPaymentRefusalText(code, { number: 'FV/1/2026', manualPaidOn: '2026-11-05', manualAmount: 930 });
      expect(text, code).not.toMatch(/[—–]/);
    }
    expect(plain(voidPaymentRefusalText('manual_first', { number: 'FV/1/2026', manualPaidOn: '2026-11-05', manualAmount: 930 }))).toBe(
      'Faktura FV/1/2026 ma oznaczenie „Zapłacone” z 05.11.2026 na 930,00 PLN, policzone jako reszta po tej wpłacie. Najpierw cofnij to oznaczenie, potem tę wpłatę.',
    );
    expect(voidPaymentRefusalText('not_voidable', {})).toMatch(/Pomoc/);
  });

  it('komunikaty sukcesu: kwota po polsku, numer faktury, pełna zapłata osobnym zdaniem', () => {
    expect(plain(recordedPaymentToast(300, 'FV/1/2026', false))).toBe('Zapisano wpłatę 300,00 PLN do faktury FV/1/2026.');
    expect(plain(recordedPaymentToast(930, 'FV/1/2026', true))).toBe('Zapisano wpłatę 930,00 PLN do faktury FV/1/2026. Faktura jest zapłacona w całości.');
    expect(plain(recordedPaymentToast(10, null, false))).toBe('Zapisano wpłatę 10,00 PLN.');
    expect(plain(voidedPaymentToast(300))).toBe('Cofnięto wpłatę 300,00 PLN.');
    // Polski CLDR grupuje tysiące od pięciu cyfr (jak `formatPlMoney` w `lib/format/pl.ts`).
    expect(plain(formatPaymentMoney(1234.5))).toBe('1234,50 PLN');
    expect(plain(formatPaymentMoney(12345.5))).toBe('12 345,50 PLN');
  });

  it('stan płatności z bazy po polsku', () => {
    expect(paymentStateLabel('unpaid')).toBe('nieopłacona');
    expect(paymentStateLabel('overdue')).toBe('nieopłacona, po terminie');
    expect(paymentStateLabel('partial')).toBe('częściowo opłacona');
    expect(paymentStateLabel('paid')).toBe('opłacona');
    expect(paymentStateLabel('cos')).toBeNull();
  });

  it('źródła wpłat: podpis i to, co wolno cofnąć w historii', () => {
    expect([...INVOICE_PAYMENT_SOURCES]).toEqual(['manual_entry', 'manual', 'flo_confirmation', 'bank_import', 'other']);
    expect(paymentSourceLabel('manual_entry')).toBeNull();
    expect(paymentSourceLabel('manual')).toBe('Oznaczona przyciskiem „Zapłacone” (cała reszta)');
    expect(paymentSourceLabel('bank_import')).toBe('Z wyciągu bankowego');
    expect(isVoidableSource('manual_entry')).toBe(true);
    expect(isVoidableSource('manual')).toBe(true);
    expect(isVoidableSource('flo_confirmation')).toBe(true);
    expect(isVoidableSource('bank_import')).toBe(false);
    expect(isVoidableSource('other')).toBe(false);
    for (const source of INVOICE_PAYMENT_SOURCES) {
      expect(paymentSourceLabel(source) ?? '').not.toMatch(/[—–]/);
    }
  });
});
