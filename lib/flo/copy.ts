/**
 * Szablony treści agenta (krok 14 planu, własność W2 i mechanizm M5).
 *
 * ŻADNA LICZBA NA EKRANIE NIE POCHODZI OD MODELU JĘZYKOWEGO.
 *
 * Model — gdy w ogóle wejdzie do gry (krok 15) — dostaje policzone wartości
 * i zwraca ZDANIE Z PLACEHOLDERAMI. Liczby podstawia ten plik, z danych
 * wyliczonych przez kod. Dzięki temu zmyślona kwota nie jest „mało
 * prawdopodobna”, tylko strukturalnie niemożliwa: model nigdy nie ma dostępu
 * do miejsca, w którym liczba trafia na ekran.
 *
 * ZASADA, KTÓREJ PILNUJE TEST: w żadnym szablonie nie ma ani jednej cyfry.
 * Wszystko, co wygląda jak liczba, musi przyjść z danych — inaczej za pół
 * roku ktoś wpisze w szablon „14 dni” na sztywno i agent zacznie kłamać
 * klientom, którzy mają inny termin płatności.
 *
 * Treści docelowe pisze tor interfejsu (`content/flo/*`, kroki 25-31 Masła).
 * To, co tu jest, to szkielet o poprawnym kształcie i tonie — nie ostateczne
 * brzmienie.
 */

import type { FloProposalKind } from '@/types/flo';

export interface FloTemplate {
  title: string;
  body: string;
}

export class FloCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FloCopyError';
  }
}

/** `{{nazwa}}` — jedyna dozwolona forma placeholdera. */
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export const FLO_TEMPLATES: Partial<Record<FloProposalKind, FloTemplate>> = {
  'payment.chase': {
    title: '{{kontrahent}} — {{kwota}}, {{dni}} po terminie',
    body: 'Faktura {{numer}} na {{kwota}} minęła termin {{dni}} temu. Przygotowałem wiadomość — przeczytaj ją i zdecyduj, sam jej nie wyślę.',
  },
  'payment.confirm': {
    title: '{{kontrahent}} zapłacił za fakturę {{numer}}?',
    body: '{{kwota}}, termin minął {{dni}} temu. Pytam raz — potem się już nie odezwę w tej sprawie.',
  },
  'payment.interest': {
    title: 'Odsetki do faktury {{numer}}: {{kwota}}',
    body: 'Mogę dołączyć rozliczenie odsetek do wezwania. Domyślnie tego nie robię — decydujesz Ty.',
  },
  'invoice.draft': {
    title: 'Faktura dla {{kontrahent}} gotowa',
    body: 'Te same pozycje co poprzednio, {{kwota}}. Numer nadam dopiero przy wysyłce.',
  },
  'invoice.batch': {
    title: 'Przygotowałem faktury na nowy miesiąc',
    body: 'Razem {{kwota}}. Pozycje odbiegające od tego, co zwykle wystawiasz, są odznaczone — zaznaczysz je po obejrzeniu.',
  },
  'invoice.final': {
    title: 'Faktura końcowa dla {{kontrahent}}',
    body: 'Po zaliczce zostało do rozliczenia {{kwota}}. Jeśli projekt jeszcze trwa, odłóż to na później.',
  },
  'expense.review': {
    title: '{{sprzedawca}}, {{kwota}}',
    body: 'Zaksięgowałem to jako {{kategoria}}. Sprawdź, jeśli to nie był firmowy zakup.',
  },
  'expense.rule': {
    title: '{{sprzedawca}} drugi raz',
    body: 'Zawsze księgować jako {{kategoria}} i już nie pytać?',
  },
  'expense.missing': {
    title: 'Brakuje dokumentu: {{sprzedawca}}',
    body: 'Co miesiąc masz tu koszt około {{kwota}}. W tym miesiącu go nie widzę — zgubił się dokument?',
  },
  'ksef.status': {
    title: 'Faktura {{numer}} przyjęta przez KSeF',
    body: 'Poświadczenie odbioru pobrane i schowane w archiwum.',
  },
  'ksef.fix': {
    title: 'KSeF odrzucił fakturę {{numer}}',
    body: 'Poprawiłem pole {{pole}}. Zobacz różnicę i zdecyduj, czy wysłać ponownie.',
  },
  'tax.deadline': {
    title: '{{deklaracja}} — termin {{termin}}',
    body: 'Z Twoich dokumentów wychodzi {{kwota}}. Policzone na podstawie {{dokumenty}}. To nie jest deklaracja podatkowa — wysyła ją Twoja księgowa albo Ty.',
  },
  'tax.setaside': {
    title: 'Wpłynęło {{kwota}} — odłóż {{doOdlozenia}}',
    body: 'Reszta jest Twoja. Licznik prowadzę narastająco, więc na koniec okresu skoryguję, jeśli koszty to zmienią.',
  },
  'accountant.package': {
    title: 'Miesiąc domknięty — wysłać paczkę księgowej?',
    body: 'W paczce {{zawartosc}}. Podaj adres, a wyślę — sam tego nie zrobię.',
  },
  'milestone.money': {
    title: 'Przekroczyłeś {{prog}} opłaconych faktur',
    body: 'Od założenia konta wpłynęło do Ciebie {{kwota}}.',
  },
};

/**
 * Warianty tej samej sprawy.
 *
 * Ten sam rodzaj propozycji potrafi mieć dwa różne zdania w zależności od
 * tego, co agent zastał: „zaksięgowałem, sprawdź” to co innego niż „nie
 * jestem pewien, zapytam”. Trzymanie tego jako osobnych rodzajów rozdęłoby
 * kontrakt i zmusiło interfejs do rozróżniania rzeczy, które rysuje tak samo.
 */
export const FLO_TEMPLATE_VARIANTS: Record<string, FloTemplate> = {
  // W-01: odczyt pewny, koszt zaksięgowany — zostaje potwierdzenie.
  'expense.review:done': {
    title: '{{sprzedawca}}, {{kwota}}',
    body: 'Zaksięgowałem to jako {{kategoria}}. Sprawdź, jeśli to nie był firmowy zakup — cofnę jednym kliknięciem.',
  },
  // W-01: coś się nie zgadza — agent NIE twierdzi, że zaksięgował.
  'expense.review:ask': {
    title: '{{sprzedawca}}, {{kwota}} — do sprawdzenia',
    body: '{{powod}} Zajrzyj na chwilę, zanim to zaksięguję.',
  },
  // W-01: odczyt się nie udał, zdjęcie jest w archiwum.
  'expense.review:failed': {
    title: 'Nie odczytałem tego zdjęcia',
    body: 'Zdjęcie zostało w archiwum, nic nie przepadło. Wgraj je jeszcze raz albo zrób nowe ujęcie. Gdy wyczerpał się limit odczytów, zrób to po jego odnowieniu.',
  },
};

export function renderCopyVariant(
  kind: FloProposalKind,
  variant: string,
  values: Record<string, string>,
): FloTemplate {
  const template = FLO_TEMPLATE_VARIANTS[`${kind}:${variant}`];
  if (!template) {
    throw new FloCopyError(`Brak wariantu „${variant}" dla rodzaju: ${kind}`);
  }
  return {
    title: renderTemplate(template.title, values),
    body: renderTemplate(template.body, values),
  };
}

/**
 * Podstawia wartości do szablonu.
 *
 * Placeholder bez wartości to WYJĄTEK, nie pusty napis. Zdanie
 * „Faktura  na  minęła termin  temu” jest gorsze od braku propozycji —
 * cisza jest dopuszczalna, bełkot nie.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new FloCopyError(
        `Brak wartości dla „{{${name}}}" — nie renderuję niepełnego zdania.`,
      );
    }
    return value;
  });
}

export function renderCopy(
  kind: FloProposalKind,
  values: Record<string, string>,
): FloTemplate {
  const template = FLO_TEMPLATES[kind];
  if (!template) {
    throw new FloCopyError(`Brak szablonu dla rodzaju: ${kind}`);
  }
  return {
    title: renderTemplate(template.title, values),
    body: renderTemplate(template.body, values),
  };
}

/** Nazwy placeholderów użytych w szablonie — do walidacji wyjścia modelu. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}
