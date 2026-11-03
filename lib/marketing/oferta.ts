import 'server-only';

import { PRICE_GROSS, TRIAL_DAYS } from '@/lib/billing/pricing';
import { trialPaymentMethodLabel } from '@/lib/billing/trial-payment';

/**
 * Jedno zdanie oferty FaktWay 1.0 (FAKTWAY-1-0, sekcja 3 pkt 8). Zmiana
 * oferty to zmiana tego pliku: cennik, opisy meta (także strony głównej),
 * stopka, ekran logowania, manifest i obrazek do udostępniania biorą tekst
 * stąd. Pilnuje tests/unit/strony-publiczne-obietnice.test.ts.
 *
 * Części nagłówka mają twarde spacje, żeby przyimek ani „zł” nie zostały same
 * na końcu linii, a środkowa część stoi pod podkreśleniem markerem.
 */
/**
 * Nagłówek strony głównej od 03.11.2026 (decyzja Bartosza): hasło w formacie
 * dawnego „bez stresu”, czyli czarny początek i wyróżnione zakończenie
 * podkreślone markerem. Zdanie oferty zostaje w opisach meta i w cenniku.
 * Pilnuje tests/unit/strona-glowna.
 */
export const HASLO = {
  przed: 'Faktury w\u00a0KSeF ',
  wyroznienie: 'z\u00a0głowy',
} as const;

export const OFERTA_NAGLOWEK = {
  przed: 'Faktury z\u00a0KSeF, koszty i\u00a0należności ',
  wyroznienie: 'w\u00a0jednym programie',
  po: `, także w\u00a0telefonie, za\u00a0${PRICE_GROSS.replace(' ', '\u00a0')} miesięcznie.`,
} as const;

/** Zdanie do tekstu na stronie: z twardymi spacjami, żeby kwota i „zł” się nie rozdzieliły. */
export const OFERTA_TEKST = `${OFERTA_NAGLOWEK.przed}${OFERTA_NAGLOWEK.wyroznienie}${OFERTA_NAGLOWEK.po}`;

/** To samo zdanie zwykłymi spacjami: do opisów meta, manifestu i porównań. */
export const OFERTA = OFERTA_TEKST.replaceAll('\u00a0', ' ');

/**
 * Jedyny tekst o metodzie płatności na stronach publicznych: "karta przy
 * starcie", a po włączeniu BLIK-a cyklicznego "karta albo BLIK przy starcie".
 * Napis daje `trialPaymentMethodLabel()` (lib/billing/trial-payment.ts), czyli ta
 * sama odpowiedź co w panelu i w Checkout, więc strona nie obieca metody, której
 * Stripe nie pokaże.
 *
 * Przełącznik `STRIPE_BLIK_RECURRING` czyta tylko serwer: w przeglądarce zmiennej
 * nie ma, więc komponent kliencki z tym modułem pokazałby inny tekst niż serwer.
 * Stąd `server-only` na górze pliku (import z komponentu klienckiego nie zbuduje
 * się), a do komponentów klienckich napis idzie przez właściwości. Strony statyczne
 * (strona główna, cennik) biorą wartość z chwili budowania, więc zmiana przełącznika
 * wymaga pełnego wdrożenia (docs/runbooks/stripe-blik.md).
 */
export const METODA_PLATNOSCI = `${trialPaymentMethodLabel()} przy starcie`;

/** „30 dni za darmo, karta przy starcie”: okres próbny z metodą płatności. */
export const PROBA = `${TRIAL_DAYS} dni za darmo, ${METODA_PLATNOSCI}`;
