import { ATTRIBUTION_COOKIE } from '@/lib/analytics/attribution';
import { CONSENT_KEY, CONSENT_META_KEY } from '@/lib/analytics/consent';
import {
  PASSKEY_OFFER_COOKIE,
  PASSKEY_OFFER_DISMISSED_KEY,
  PASSKEY_SESSION_COOKIE,
  REMEMBER_ME_COOKIE,
} from '@/lib/auth/device-cookies';
import { LEGAL_ENTITY } from '@/lib/legal/entity';
import { p, section, table, type LegalDocument } from '@/lib/legal/doc-model';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
import { THEME_STORAGE_KEY } from '@/lib/theme/theme';
import { COOKIE_POLICY_VERSION } from '@/lib/legal/versions';

const E = LEGAL_ENTITY;

/**
 * Polityka cookies — art. 399 ustawy Prawo komunikacji elektronicznej
 * (od 10.11.2024, wcześniej art. 173 Prawa telekomunikacyjnego): przechowywanie
 * informacji w urządzeniu użytkownika i dostęp do nich wymagają zgody, chyba że
 * są niezbędne do świadczenia usługi, której użytkownik żąda.
 *
 * Lista odpowiada kodowi z 22.10.2026 (spis: memo dla prawnika). Nowe
 * ciasteczko albo klucz w localStorage → wiersz tutaj w tym samym PR —
 * pilnuje tego tests/unit/polityka-cookies-kod.test.ts.
 */
export const POLITYKA_COOKIES: LegalDocument = {
  slug: 'cookies',
  title: 'Polityka plików cookies',
  version: COOKIE_POLICY_VERSION,
  summary: [
    'Bez Twojej zgody zapisujemy w przeglądarce tylko to, bez czego serwis nie zadziała: sesję logowania, wybraną firmę, Twoje ustawienia i Twoją decyzję w sprawie analityki.',
    'Analityka (PostHog) włącza się dopiero po kliknięciu „Akceptuję”. Za tą samą zgodą zapisujemy jedno własne ciasteczko ze źródłem wejścia. Zgodę zmienisz w każdej chwili poniżej.',
    'Nie używamy cookies reklamowych ani śledzących między stronami.',
  ],
  sections: [
    section(
      'czym-sa',
      '1. Czym są pliki cookies i podobne technologie',
      p('Pliki cookies to małe pliki tekstowe zapisywane przez przeglądarkę. Podobnie działają pamięć lokalna przeglądarki (localStorage, sessionStorage) i pamięć aplikacji instalowanej z przeglądarki (PWA). W tej Polityce wszystkie te technologie nazywamy „cookies”.'),
      p(`Administratorem danych zbieranych przez cookies jest ${E.name ?? 'usługodawca wskazany w Polityce prywatności'}. Więcej o danych osobowych — w [Polityce prywatności](/legal/polityka-prywatnosci).`),
    ),
    section(
      'niezbedne',
      '2. Cookies niezbędne (bez zgody)',
      p('Te technologie są niezbędne do świadczenia usługi, o którą prosisz — bez nich nie zalogujesz się ani nie skorzystasz z serwisu. Nie wymagają zgody (art. 399 ust. 3 Prawa komunikacji elektronicznej).'),
      table(
        ['Nazwa', 'Rodzaj', 'Do czego służy', 'Jak długo'],
        [
          ['sb-…-auth-token', 'cookie (własne)', 'utrzymanie zalogowanej sesji', 'do wylogowania; odnawiane w trakcie korzystania'],
          [ACTIVE_ORG_COOKIE, 'cookie (własne, niedostępne dla skryptów)', 'zapamiętanie, w której firmie (Organizacji) pracujesz', 'do 30 dni'],
          // Logowanie biometrią i „Zapamiętaj mnie” (lib/auth/device-cookies.ts).
          [PASSKEY_SESSION_COOKIE, 'cookie (własne, niedostępne dla skryptów)', 'potwierdzenie, że ta sesja zaczęła się od logowania biometrią', 'do 30 dni albo do wylogowania'],
          [REMEMBER_ME_COOKIE, 'cookie (własne, niedostępne dla skryptów)', 'Twój wybór „Zapamiętaj mnie”: panel nie wylogowuje po godzinie bezczynności', 'do 90 dni albo do wylogowania'],
          [`${PASSKEY_OFFER_COOKIE}, ${PASSKEY_OFFER_DISMISSED_KEY}`, 'cookie (własne) / localStorage', 'jednorazowa propozycja logowania biometrią na telefonie i zapamiętanie, że ją odrzuciłeś', 'cookie do 1 godziny; localStorage do wyczyszczenia danych przeglądarki'],
          [`${CONSENT_KEY}, ${CONSENT_META_KEY}`, 'localStorage', 'zapamiętanie Twojej decyzji w sprawie analityki i chwili jej podjęcia', 'do zmiany decyzji lub wyczyszczenia danych przeglądarki'],
          [THEME_STORAGE_KEY, 'localStorage', 'motyw jasny lub ciemny, który wybrałeś', 'jw.'],
          // Menu boczne panelu (shadcn, plan Finora) — components/ui/sidebar.tsx.
          ['sidebar_state', 'cookie (własne)', 'zapamiętanie, czy menu boczne panelu jest rozwinięte, czy zwinięte', 'do 7 dni'],
          ['install-prompt-dismissed-at, klucze zamkniętych komunikatów', 'localStorage / sessionStorage', 'żeby nie pokazywać ponownie komunikatu, który zamknąłeś', 'jw. (sessionStorage — do zamknięcia karty)'],
          ['pamięć aplikacji (Service Worker)', 'pamięć PWA', 'działanie aplikacji instalowanej z przeglądarki, w tym praca przy słabym połączeniu', 'do odinstalowania aplikacji lub wyczyszczenia danych'],
          ['Cloudflare Turnstile', 'skrypt dostawcy (challenges.cloudflare.com)', 'sprawdzenie, czy formularz logowania, rejestracji, resetu hasła albo potwierdzenia hasła w ustawieniach wypełnia człowiek', 'na czas weryfikacji'],
          ['Sentry', 'skrypt w aplikacji (bez cookies)', 'wykrywanie błędów aplikacji; zgłoszenia są oczyszczane z danych osobowych', 'nie zapisuje danych w przeglądarce'],
        ],
      ),
    ),
    section(
      'analityczne',
      '3. Analityka (tylko za zgodą)',
      p('Za Twoją zgodą korzystamy z PostHog (serwery w UE), żeby rozumieć, których części serwisu używasz, i poprawiać produkt. PostHog nie zapisuje plików cookies ani danych w pamięci przeglądarki (działa wyłącznie w pamięci otwartej karty), nie zbiera adresu IP ani treści dokumentów, a adresy stron skraca do nazwy sekcji. Nie nagrywamy sesji i nie śledzimy kliknięć automatycznie.'),
      p('Za tą samą zgodą zapisujemy jedno własne ciasteczko, żeby wiedzieć, skąd do nas trafiłeś. Przechowuje parametry kampanii z adresu (utm), sam host strony odsyłającej, stronę wejścia i datę. Nie zapisujemy identyfikatorów kliknięć reklam. Przy rejestracji dane te trafiają do Twojego konta. Przy wycofaniu zgody usuwamy je z konta i zdejmujemy z Twojego profilu w PostHogu. Zdarzenia, które PostHog już od nas dostał, zostają tam pod pseudonimowym identyfikatorem do końca okresu przechowywania (24 miesiące) albo do usunięcia na Twoją prośbę.'),
      table(
        ['Nazwa', 'Rodzaj', 'Do czego służy', 'Jak długo'],
        [
          [ATTRIBUTION_COOKIE, 'cookie (własne)', 'zapamiętanie, skąd do nas trafiłeś, żeby przypisać to do konta przy rejestracji', 'do rejestracji, do zapisania decyzji na koncie, do wylogowania albo do wycofania zgody, najdłużej 90 dni; po rejestracji zostaje sam znacznik bez danych, do następnego wejścia na stronę'],
        ],
      ),
      p('Zgoda jest dobrowolna. Możesz ją wycofać w każdej chwili przyciskiem w sekcji „Twoje ustawienia”, a po zalogowaniu także w Ustawienia → Konto i dane (RODO). Wycofanie działa od razu w tej przeglądarce. Dla zdarzeń wysyłanych z naszego serwera działa od zapisu na koncie: gdy klikniesz, będąc wylogowanym, zapiszemy je na koncie przy najbliższym logowaniu w tej przeglądarce, a do tego czasu te zdarzenia mogą jeszcze wychodzić. Wycofanie nie wpływa na zgodność z prawem wcześniejszego przetwarzania.'),
    ),
    section(
      'zewnetrzne',
      '4. Serwisy zewnętrzne',
      p('Gdy klikniesz „Zaloguj przez Google” albo przejdziesz do płatności, przekierujemy Cię na stronę Google lub Stripe. Te serwisy stosują własne cookies na swoich stronach, na zasadach swoich polityk prywatności. Nie osadzamy na naszych stronach reklam, przycisków serwisów społecznościowych ani zewnętrznych czcionek.'),
    ),
    section(
      'zarzadzanie',
      '5. Jak zarządzać cookies',
      p('Oprócz ustawień poniżej możesz usunąć cookies i dane witryny w ustawieniach przeglądarki lub zablokować ich zapisywanie. Zablokowanie cookies niezbędnych uniemożliwi zalogowanie się.'),
      p(`Wersja z dnia ${COOKIE_POLICY_VERSION}. Pytania: ${E.email}.`),
    ),
  ],
};
