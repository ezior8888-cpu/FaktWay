import type { Metadata } from 'next';
import Link from 'next/link';

import { LegalPage } from '@/components/legal/legal-page';
import { GDPR_COOLING_OFF_DAYS } from '@/lib/gdpr/deletion-constants';
import { LEGAL_ENTITY } from '@/lib/legal/entity';

export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'RODO i bezpieczeństwo',
  description: 'Jak FaktWay chroni dane: lokalizacja serwerów, umowa powierzenia, prawa osób i zgłaszanie naruszeń.',
};

/**
 * Skrót dla klientów. Do 15.10.2026 ta strona obiecywała rzeczy, których nie
 * było: dane „we Frankfurcie u Vercela”, szyfrowanie dysków AES-256, „brak
 * cookies analitycznych” (jest PostHog za zgodą) i DPA „do pobrania na e-mail”
 * (nie istniało). Każde zdanie tutaj musi mieć pokrycie w kodzie lub umowie —
 * obietnica bez pokrycia to wprowadzanie klienta w błąd.
 */
export default function GdprPage() {
  const email = LEGAL_ENTITY.email;
  // Twarda spacja: „i” nie może zostać samo na końcu linii nagłówka.
  return (
    <LegalPage title={<>RODO i{'\u00a0'}bezpieczeństwo</>} current="/legal/rodo">
      <h2>Kto jest kim</h2>
      <p>
        Dla danych z Twoich faktur (np. danych kontrahentów) <strong>Ty jesteś administratorem</strong>, a
        FaktWay — podmiotem przetwarzającym. Zasady opisuje{' '}
        <Link href="/legal/umowa-powierzenia">umowa powierzenia</Link>, którą zawieramy z każdym klientem
        razem z regulaminem. Dla danych Twojego konta administratorem jesteśmy my — patrz{' '}
        <Link href="/legal/polityka-prywatnosci">polityka prywatności</Link>.
      </p>

      <h2>Gdzie są dane</h2>
      <p>
        Serwery aplikacji i bazy danych stoją w centrum danych w Norymberdze (Niemcy). Część dostawców ma
        siedzibę w USA — ich listę, zakres i podstawę przekazania danych znajdziesz na stronie{' '}
        <Link href="/legal/podprocesorzy">podmioty przetwarzające</Link>.
      </p>

      <h2>Jak chronimy dane</h2>
      <ul>
        <li>szyfrowane połączenia (HTTPS/TLS);</li>
        <li>tokeny i certyfikaty KSeF zaszyfrowane w bazie;</li>
        <li>izolacja danych każdej firmy na poziomie bazy danych (Row Level Security);</li>
        <li>weryfikacja dwuetapowa (2FA) i blokada haseł znanych z wycieków;</li>
        <li>dziennik istotnych zdarzeń, którego użytkownicy nie mogą zmieniać;</li>
        <li>codzienne kopie zapasowe.</li>
      </ul>

      <h2>Twoje dane — Twoja kontrola</h2>
      <ul>
        <li>kopię danych konta pobierzesz w ustawieniach konta;</li>
        <li>
          usunięcie konta zlecisz w ustawieniach — masz {GDPR_COOLING_OFF_DAYS} dni na wycofanie decyzji,
          a usunięcie następuje najpóźniej w ciągu miesiąca od żądania;
        </li>
        <li>analitykę w przeglądarce włączasz i wyłączasz w <Link href="/legal/cookies#ustawienia">ustawieniach cookies</Link>;</li>
        <li>e-maile marketingowe wysyłamy tylko po Twojej zgodzie.</li>
      </ul>

      <h2>Naruszenia ochrony danych</h2>
      <p>
        O naruszeniu dotyczącym danych powierzonych przez Ciebie zawiadomimy Cię bez zbędnej zwłoki, nie
        później niż w ciągu 36 godzin od jego stwierdzenia — tak, żebyś zdążył z własnym zgłoszeniem do
        Prezesa UODO (72 godziny, art. 33 RODO).
      </p>

      <h2>Kontakt</h2>
      <p>
        Sprawy dotyczące danych osobowych: <a href={`mailto:${email}`}>{email}</a>.
      </p>
    </LegalPage>
  );
}
