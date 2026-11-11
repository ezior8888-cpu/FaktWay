/**
 * Zdarzenia kalendarza klienta (krok 7.3 planu kompletnej aplikacji). Funkcje
 * czyste; odczyt z bazy robi `zbierz.ts`.
 *
 * TERMINY PODATKÓW I ZUS nie są tu liczone od nowa: biorą się z `terminDla`
 * (`lib/ksiegowosc/kalendarz.ts`, K1) z dniami przesuniętymi przez weekendy
 * i święta tak, jak liczy ten kalendarz. Który termin dotyczy firmy, decyduje
 * `grupyFormy` (jak w przypomnieniach K5): ryczałt albo zaliczka PIT według
 * formy z profilu, składki ZUS zawsze, VAT płatnikowi. Bez profilu nie
 * zgadujemy (K5 też pomija firmę bez profilu).
 *
 * DANE OSOBOWE: z faktury idzie numer, kwota i nazwa firmy nabywcy. NIP-u ani
 * adresu nie ma w kalendarzu, bo adres kalendarza trafia do aplikacji
 * zewnętrznych (Google, Apple, Outlook).
 */

import { monthLabel, monthRange, shiftMonth } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import type { ReceivableInvoice } from '@/lib/dashboard/receivables';
import { terminDla, type RodzajTerminu } from '@/lib/ksiegowosc/kalendarz';
import type { Grupa } from '@/lib/ksiegowosc/przypomnienia';
import { grupyFormy } from '@/lib/ksiegowosc/przypomnienia';
import { wersjaNa, type WersjaProfilu } from '@/lib/ksiegowosc/profil';

import type { ZdarzenieIcal } from './ical';

/** Ile miesięcy rozliczeniowych do przodu pokazujemy (poprzedni, bieżący i 11 następnych). */
const OKRESY_DO_PRZODU = 11;

const DOMENA = 'faktway.pl';

const TERMIN_GRUPY: Readonly<Record<Grupa, RodzajTerminu>> = {
  ryczalt: 'ryczalt',
  pit: 'zaliczkaPit',
  zus: 'zus',
  vat: 'vatJpk',
};

const TYTULY: Readonly<Record<Grupa, string>> = {
  ryczalt: 'Termin: zaliczka na ryczałt',
  pit: 'Termin: zaliczka na PIT',
  zus: 'Termin: Składki ZUS',
  vat: 'Termin: VAT i JPK_V7M',
};

export function zdarzeniaTerminow(wejscie: {
  dzis: string;
  wersje: readonly WersjaProfilu[];
  platnikVat: boolean;
}): ZdarzenieIcal[] {
  const wynik: ZdarzenieIcal[] = [];
  const biezacy = wejscie.dzis.slice(0, 7);
  for (let i = -1; i <= OKRESY_DO_PRZODU; i++) {
    const miesiac = shiftMonth(biezacy, i);
    const profil = wersjaNa(wejscie.wersje, monthRange(miesiac).to);
    if (!profil) continue;
    const [rok, nr] = miesiac.split('-').map(Number) as [number, number];
    const wszystkie: Grupa[] = ['ryczalt', 'pit', 'zus', 'vat'];
    const grupy = grupyFormy(wszystkie, profil.forma).filter((g) => g !== 'vat' || wejscie.platnikVat);
    for (const grupa of grupy) {
      const termin = terminDla({ rodzaj: TERMIN_GRUPY[grupa], rok, miesiac: nr });
      if (!termin || termin.faktyczny < wejscie.dzis) continue;
      const przesuniecie = termin.przesuniety
        ? ` Termin ustawowy ${formatIsoDatePl(termin.nominalny)} przypada na dzień wolny, więc upływa ${formatIsoDatePl(termin.faktyczny)}.`
        : '';
      wynik.push({
        uid: `termin-${grupa}-${miesiac}@${DOMENA}`,
        data: termin.faktyczny,
        tytul: `${TYTULY[grupa]} za ${monthLabel(miesiac)}`,
        opis:
          `Rozliczenie za ${monthLabel(miesiac)}.${przesuniecie} ` +
          'Termin liczy FaktWay według kalendarza dni wolnych; to przypomnienie, nie porada podatkowa.',
      });
    }
  }
  return wynik;
}

export function zdarzeniaNaleznosci(pozycje: readonly ReceivableInvoice[]): ZdarzenieIcal[] {
  const wynik: ZdarzenieIcal[] = [];
  for (const p of pozycje) {
    if (!p.paymentDueDate) continue;
    const numer = p.internalNumber ?? 'bez numeru';
    wynik.push({
      uid: `faktura-${p.id}@${DOMENA}`,
      data: p.paymentDueDate,
      tytul: `Płatność od klienta: ${numer}`,
      opis:
        `Faktura ${numer}${p.buyerName ? `, ${p.buyerName}` : ''}. ` +
        `Do zapłaty ${formatPlMoney(p.outstanding)} zł.`,
    });
  }
  return wynik;
}

export function zdarzeniaCykliczne(
  wiersze: readonly { id: string; name: string; next_run_date: string }[],
): ZdarzenieIcal[] {
  return wiersze.map((w) => ({
    // Data w UID: po przesunięciu pozycji na następny okres to nowy wpis, a nie edycja starego.
    uid: `cykliczna-${w.id}-${w.next_run_date}@${DOMENA}`,
    data: w.next_run_date,
    tytul: `Faktura cykliczna: ${w.name}`,
    opis: 'Dzień wystawienia faktury cyklicznej. FaktWay nie wystawia jej sam, przypomina o niej.',
  }));
}
