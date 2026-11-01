import { PRICE_GROSS, TRIAL_DAYS } from '@/lib/billing/pricing';

/**
 * Jedno zdanie oferty FaktWay 1.0 (FAKTWAY-1-0, sekcja 3 pkt 8). Zmiana
 * oferty to zmiana tego pliku: nagłówek strony głównej, cennik, opisy meta,
 * stopka, ekran logowania, manifest i obrazek do udostępniania biorą tekst
 * stąd. Pilnuje tests/unit/strony-publiczne-obietnice.test.ts.
 *
 * Części nagłówka mają twarde spacje, żeby przyimek ani „zł” nie zostały same
 * na końcu linii, a środkowa część stoi pod podkreśleniem markerem.
 */
export const OFERTA_NAGLOWEK = {
  przed: 'Faktury z KSeF, koszty i należności ',
  wyroznienie: 'w jednym programie',
  po: `, także w telefonie, za ${PRICE_GROSS.replace(' ', ' ')} miesięcznie.`,
} as const;

/** To samo zdanie zwykłymi spacjami: do opisów meta, akapitów i obrazków. */
export const OFERTA = `${OFERTA_NAGLOWEK.przed}${OFERTA_NAGLOWEK.wyroznienie}${OFERTA_NAGLOWEK.po}`.replaceAll(
  ' ',
  ' ',
);

/**
 * Jedyny tekst o metodzie płatności na stronach publicznych. BLIK zależy od
 * przełącznika, więc tu go nie ma: dopisze go gałąź zbiorcza, w tym jednym
 * miejscu.
 */
export const METODA_PLATNOSCI = 'karta przy starcie';

/** „30 dni za darmo, karta przy starcie”: okres próbny z metodą płatności. */
export const PROBA = `${TRIAL_DAYS} dni za darmo, ${METODA_PLATNOSCI}`;
