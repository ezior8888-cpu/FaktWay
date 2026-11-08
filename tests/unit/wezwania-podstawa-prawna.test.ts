import { describe, expect, it } from 'vitest';

import { demandLetterConsequences, demandLetterOpening } from '@/lib/reminders/pdf-demand-letter';
import { DEFAULT_TEMPLATES } from '@/lib/reminders/templates';

/**
 * Przegląd prawny 15.10.2026. Przypomnienia i przedsądowe wezwanie wysyłamy
 * w imieniu klienta do jego kontrahentów — często konsumentów i jednoosobowych
 * firm. Treść miała trzy błędy, za które odpowiadałby klient, a za nim my:
 *  - „na podstawie art. 187 § 1 pkt 3 KPC wzywam” — ten przepis mówi
 *    o treści pozwu, nie daje podstawy do wezwania (podstawą jest umowa);
 *  - „odsetki ustawowe za opóźnienie w transakcjach handlowych” także wobec
 *    dłużnika bez NIP — te odsetki są tylko między przedsiębiorcami;
 *  - „sprawa ZOSTANIE skierowana do sądu” — zapowiedź, o której decyduje
 *    klient; wobec konsumenta groźba działań, których się nie podejmie,
 *    to nieuczciwa praktyka rynkowa.
 */

const LETTER = {
  sellerName: 'Fikcyjna Firma', sellerNip: '1234567890', sellerAddress: 'ul. Testowa 1, 00-001 Testowo',
  buyerName: 'Jan Testowy', buyerAddress: 'ul. Próbna 2, 00-002 Testowo',
  invoiceNumber: 'FV/1/2026', issueDate: '2026-09-01', dueDate: '2026-09-15',
  grossAmount: 1230, paidAmount: 0, amountDue: 1230, bankAccount: '00000000000000000000000000',
  daysOverdue: 20, senderName: 'Jan Kowalski', senderEmail: 'a@example.test',
  placeOfIssue: 'Testowo', letterDate: '2026-10-05',
};

describe('wezwania do zapłaty — podstawy prawne i zapowiedzi', () => {
  it('pismo nie powołuje się na art. 187 KPC jako podstawę wezwania', () => {
    expect(demandLetterOpening(LETTER.invoiceNumber)).not.toMatch(/187/);
  });

  it('dłużnik bez NIP (konsument): zwykłe odsetki ustawowe, bez rekompensaty B2B', () => {
    const text = demandLetterConsequences(LETTER);
    expect(text).toContain('odsetek ustawowych za opóźnienie');
    expect(text).not.toContain('w transakcjach handlowych');
    expect(text).not.toContain('rekompensaty');
  });

  it('dłużnik z NIP: odsetki w transakcjach handlowych i rekompensata', () => {
    const text = demandLetterConsequences({ ...LETTER, buyerNip: '1234567890' });
    expect(text).toContain('odsetek ustawowych za opóźnienie w transakcjach handlowych');
    expect(text).toContain('rekompensaty za koszty odzyskiwania należności (40 EUR');
  });

  it('pismo nie przesądza, że sprawa trafi do sądu, ani że koszty na pewno obciążą dłużnika', () => {
    const text = demandLetterConsequences({ ...LETTER, buyerNip: '1234567890' });
    expect(text).not.toContain('zostanie skierowana');
    expect(text).not.toContain('wiązać się będzie');
  });

  it.each(Object.entries(DEFAULT_TEMPLATES))('szablon %s: bez art. 187 KPC i bez przesądzonych zapowiedzi', (_stage, t) => {
    expect(t.body).not.toMatch(/187/);
    expect(t.body).not.toMatch(/zostanie skierowana|zostaną naliczone|obciążą dłużnika/);
  });

  it('mail z fakturą wskazuje sprzedawcę jako nadawcę i FaktWay jako przetwarzającego', async () => {
    const { invoiceEmailFooter } = await import('@/lib/email/send');
    const footer = invoiceEmailFooter('Firma <Test> & Syn');
    expect(footer).toContain('Firma &lt;Test&gt; &amp; Syn');
    expect(footer).toContain('na zlecenie');
    expect(footer).toContain('skontaktuj się bezpośrednio');
    expect(footer).not.toContain('<Test>');
  });
  // Wpis na blogu o „art. 187 KPC” poprawia i pilnuje #266
  // (tests/unit/marketing-bez-fikcji.test.ts) — oba PR-y zmieniały to samo zdanie.
});
