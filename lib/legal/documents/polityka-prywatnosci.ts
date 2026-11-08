import { GDPR_COOLING_OFF_DAYS } from '@/lib/gdpr/deletion-constants';
import { LEGAL_ENTITY, entityAddress, entityIdentification } from '@/lib/legal/entity';
import { note, p, section, table, ul, type LegalDocument } from '@/lib/legal/doc-model';
import { SUBPROCESSORS } from '@/lib/legal/subprocessors';
import { PRIVACY_POLICY_VERSION } from '@/lib/legal/versions';

const E = LEGAL_ENTITY;

/**
 * Polityka prywatności — obowiązek informacyjny z art. 13 i 14 RODO dla
 * danych, których ADMINISTRATOREM jest usługodawca (konta, rozliczenia,
 * bezpieczeństwo, kontakt, marketing, analityka). Danych kontrahentów
 * w fakturach dotyczy umowa powierzenia — tu tylko informacja, do kogo się
 * zwrócić (sekcja „Dane w fakturach naszych klientów”).
 *
 * Każde zdanie o retencji i odbiorcach ma odpowiadać kodowi; rozjazdy, które
 * trzeba jeszcze usunąć w kodzie, wymienia memo dla prawnika.
 */
export const POLITYKA_PRYWATNOSCI: LegalDocument = {
  slug: 'polityka-prywatnosci',
  title: 'Polityka prywatności FaktWay',
  version: PRIVACY_POLICY_VERSION,
  summary: [
    'Dane Twojego konta przetwarzamy, żeby świadczyć usługę, rozliczać subskrypcję i chronić serwis. Nie sprzedajemy danych i nie wyświetlamy reklam.',
    'Dane z faktur (np. Twoich kontrahentów) przetwarzamy wyłącznie na Twoje polecenie — to Ty jesteś ich administratorem, a my podmiotem przetwarzającym.',
    'Serwery stoją w Niemczech. Niektórzy dostawcy (np. AI, e-mail) są z USA — przekazanie danych zabezpieczają standardowe klauzule umowne lub certyfikacja Data Privacy Framework.',
    'Analityka w przeglądarce działa tylko po Twojej zgodzie; e-maile marketingowe — też tylko po zgodzie.',
    `Konto możesz usunąć sam w ustawieniach (${GDPR_COOLING_OFF_DAYS} dni na zmianę decyzji) i w każdej chwili pobrać kopię swoich danych.`,
  ],
  sections: [
    section(
      'administrator',
      '1. Administrator danych',
      p(`Administratorem danych osobowych opisanych w tej Polityce jest ${entityIdentification()} (dalej „my” lub „Usługodawca”).`),
      p(`We wszystkich sprawach dotyczących danych osobowych możesz pisać na adres **${E.email}** albo na adres ${entityAddress()}. Nie wyznaczyliśmy inspektora ochrony danych — nie mamy takiego obowiązku (art. 37 RODO).`),
    ),
    section(
      'zakres',
      '2. Kogo dotyczy ta Polityka',
      ul(
        'osób, które zakładają Konto w FaktWay i z niego korzystają — w tym właścicieli firm, ich pracowników i księgowych zaproszonych do Organizacji;',
        'osób, które odwiedzają naszą stronę, piszą do nas, korzystają z czatu pomocy albo zapisują się na newsletter;',
        'osób reprezentujących naszych klientów w sprawach rozliczeń.',
      ),
      note(
        'Jeśli Twoje dane znalazły się w fakturze lub wiadomości wysłanej przez jednego z naszych klientów (np. jesteś jego kontrahentem), administratorem tych danych jest ten klient — patrz punkt 10.',
      ),
    ),
    section(
      'cele',
      '3. Cele, podstawy prawne i okres przechowywania',
      table(
        ['Cel', 'Dane', 'Podstawa prawna', 'Jak długo'],
        [
          [
            'Założenie i prowadzenie Konta, świadczenie usług (Regulamin)',
            'imię i nazwisko, e-mail, skrót hasła, role w Organizacjach, ustawienia, dane z logowania Google (jeśli go użyjesz), klucz publiczny i nazwa urządzenia do logowania biometrią (jeśli je dodasz; odcisk palca ani obraz twarzy do nas nie trafiają)',
            'art. 6 ust. 1 lit. b RODO (umowa) — gdy jesteś stroną umowy; art. 6 ust. 1 lit. f (prawnie uzasadniony interes: obsługa klienta, w imieniu którego działasz) — gdy korzystasz z Konta jako pracownik lub księgowy klienta',
            `do usunięcia Konta (usunięcie następuje po ${GDPR_COOLING_OFF_DAYS} dniach na wycofanie decyzji, najpóźniej w ciągu miesiąca od żądania)`,
          ],
          [
            'Rozliczenie subskrypcji, wystawienie i przechowanie faktur',
            'dane firmy (nazwa, NIP, adres), e-mail rozliczeniowy, historia płatności (bez pełnych danych karty)',
            'art. 6 ust. 1 lit. b i c RODO (umowa; obowiązki z ustawy o VAT i Ordynacji podatkowej)',
            'przez okres wymagany przepisami podatkowymi — co do zasady 5 lat od końca roku, w którym upłynął termin płatności podatku',
          ],
          [
            'Bezpieczeństwo serwisu i zapobieganie nadużyciom',
            'adres IP, dane przeglądarki, dziennik zdarzeń (kto i kiedy wykonał istotną czynność), wyniki weryfikacji Turnstile, raporty błędów aplikacji (Sentry)',
            'art. 6 ust. 1 lit. f RODO (ochrona serwisu, danych klientów i dochodzenie roszczeń)',
            'dziennik zdarzeń — 12 miesięcy, po usunięciu Konta wpisy są anonimizowane; raporty błędów — do 90 dni',
          ],
          [
            'Wykazanie akceptacji Regulaminu i udzielonych zgód',
            'wersja dokumentu i brzmienia oświadczenia, data, sposób złożenia; w dzienniku zdarzeń także adres IP i dane przeglądarki',
            'art. 6 ust. 1 lit. c RODO w zw. z art. 7 ust. 1 RODO; art. 6 ust. 1 lit. f (obrona przed roszczeniami)',
            'zapis przy Koncie — do usunięcia Konta; wpis w dzienniku zdarzeń — 12 miesięcy',
          ],
          [
            'Obsługa żądań dotyczących danych (np. usunięcia Konta)',
            'e-mail, data i rodzaj żądania, sposób jego realizacji, adres IP i dane przeglądarki z chwili złożenia',
            'art. 6 ust. 1 lit. c RODO w zw. z art. 5 ust. 2 i art. 12 RODO (rozliczalność); art. 6 ust. 1 lit. f (obrona przed roszczeniami)',
            'do 6 lat od realizacji żądania (termin przedawnienia roszczeń)',
          ],
          [
            'Dostarczalność poczty (lista adresów, które odbiły wiadomość albo zgłosiły ją jako spam)',
            'adres e-mail, rodzaj zdarzenia, data',
            'art. 6 ust. 1 lit. f RODO (żeby nie wysyłać wiadomości do osób, które sobie tego nie życzą, i chronić reputację domeny)',
            'dopóki blokada adresu jest potrzebna; zgłoszenie spamu blokuje adres trwale, chyba że poprosisz o odblokowanie',
          ],
          [
            'Kontakt i pomoc techniczna, w tym czat z asystentem AI',
            'treść wiadomości i rozmów, e-mail, ocena rozmowy, notatki zespołu wsparcia dotyczące zgłoszenia',
            'art. 6 ust. 1 lit. b RODO (obsługa umowy); art. 6 ust. 1 lit. f (odpowiedź na zapytanie, ulepszanie pomocy)',
            'do 24 miesięcy od ostatniej wiadomości',
          ],
          [
            'E-maile z poradami, nowościami i ofertami FaktWay',
            'e-mail, imię, informacja o zgodzie',
            'art. 6 ust. 1 lit. a RODO (zgoda) w zw. z art. 398 ustawy Prawo komunikacji elektronicznej',
            'do wycofania zgody',
          ],
          [
            'Newsletter (zapis na stronie bloga)',
            'e-mail, data zapisu',
            'art. 6 ust. 1 lit. a RODO (zgoda)',
            'do wypisania się',
          ],
          [
            'Analityka korzystania z serwisu (PostHog): w przeglądarce i zdarzenia z serwera (np. rejestracja, podłączenie KSeF, pierwsza faktura, próba, płatność, rezygnacja), wyłącznie za zgodą',
            'pseudonimowy identyfikator użytkownika i firmy, odwiedzane sekcje serwisu, typ urządzenia i przeglądarki, zdarzenie z zamkniętej listy, źródło wejścia (kanał, parametry kampanii, host strony odsyłającej, strona wejścia); bez treści dokumentów i bez adresu IP',
            'art. 6 ust. 1 lit. a RODO i art. 399 Prawa komunikacji elektronicznej (zgoda)',
            'do wycofania zgody, nie dłużej niż 24 miesiące; po wycofaniu usuwamy źródło wejścia z konta i z profilu osoby w PostHogu, a zdarzenia już wysłane zostają tam pod pseudonimowym identyfikatorem do końca tego okresu albo do usunięcia na Twoją prośbę, także po usunięciu Konta',
          ],
          [
            'Zbiorcze statystyki firm w panelu administratora (np. ile nowych firm w danym tygodniu podłączyło KSeF i zaczęło płacić)',
            'liczby wyliczane z danych firm i płatności w naszej bazie, bez wskazania konkretnej osoby',
            'art. 6 ust. 1 lit. f RODO (prawnie uzasadniony interes: rozwój i utrzymanie usługi)',
            'liczone na bieżąco, nie zapisujemy ich osobno',
          ],
          [
            'Powiadomienia push',
            'adres subskrypcji przeglądarki (endpoint) i klucze szyfrujące',
            'art. 6 ust. 1 lit. b RODO (umowa — na Twoje żądanie wyrażone w przeglądarce)',
            'do wyłączenia powiadomień lub usunięcia Konta',
          ],
          [
            'Dochodzenie i obrona przed roszczeniami',
            'dane potrzebne do wykazania faktów',
            'art. 6 ust. 1 lit. f RODO',
            'do upływu terminu przedawnienia roszczeń',
          ],
        ],
      ),
      // Terminy kopii = stałe w lib/jobs/runners/cleanup-old-backups.ts
      // (test rodo-terminy-usuwania pilnuje zgodności).
      p('Usunięte dane mogą jeszcze pozostać w kopiach zapasowych bazy danych, dopóki ich nie nadpiszemy (kopie dzienne do 30 dni, tygodniowe do 8 tygodni). Z kopii korzystamy wyłącznie, aby odtworzyć serwis po awarii.'),
      p('Podanie danych przy rejestracji i w ustawieniach rozliczeń jest dobrowolne, ale bez nich nie możemy zawrzeć i wykonywać umowy. Zgody są w pełni dobrowolne — brak zgody nie ogranicza korzystania z serwisu.'),
    ),
    section(
      'zrodla',
      '4. Skąd mamy Twoje dane',
      p('Większość danych podajesz sam. Jeśli logujesz się kontem Google, otrzymujemy od Google Twoje imię i nazwisko, adres e-mail i identyfikator konta. Jeśli zaprosił Cię inny użytkownik (np. właściciel firmy), otrzymujemy od niego Twój adres e-mail. Dane firmy możemy uzupełnić z publicznych rejestrów (REGON, wykaz podatników VAT) na podstawie NIP.'),
    ),
    section(
      'odbiorcy',
      '5. Komu przekazujemy dane',
      p('Korzystamy z dostawców, którzy przetwarzają dane na nasze zlecenie i na podstawie umów powierzenia:'),
      table(
        ['Dostawca', 'W jakim celu', 'Gdzie są dane', 'Przekazanie poza EOG'],
        SUBPROCESSORS.map((s) => [`${s.name} (${s.seat})`, s.purpose, s.location, s.transfer]),
      ),
      p('Aktualna lista jest też na stronie [Podmioty przetwarzające](/legal/podprocesorzy).'),
      ul(
        '**Google Ireland Ltd.** — jeśli logujesz się kontem Google; Google jest wtedy odrębnym administratorem danych w zakresie swojego konta.',
        '**Stripe** — w zakresie zapobiegania oszustwom i obowiązków prawnych operatora płatności Stripe działa jako odrębny administrator.',
        '**Dostawcy powiadomień push** (np. Google, Mozilla, Apple — zależnie od przeglądarki) — przekazują zaszyfrowaną treść powiadomienia; nie mogą jej odczytać.',
        '**Ministerstwo Finansów (KSeF), rejestry publiczne** — dane przekazujemy na polecenie klienta, w ramach funkcji serwisu.',
        '**Osoby wskazane przez klienta** — np. biuro rachunkowe lub współpracownicy z dostępem do Organizacji.',
        '**Organy publiczne** — wyłącznie gdy obowiązek wynika z przepisów prawa.',
      ),
    ),
    section(
      'transfer',
      '6. Przekazywanie danych poza Europejski Obszar Gospodarczy',
      p('Serwery FaktWay znajdują się w Niemczech. Część dostawców ma siedzibę w USA (patrz tabela w punkcie 5). Przekazanie danych do państwa trzeciego odbywa się na podstawie decyzji Komisji Europejskiej stwierdzającej odpowiedni stopień ochrony (EU-US Data Privacy Framework — art. 45 RODO), jeśli odbiorca jest certyfikowany, albo standardowych klauzul umownych przyjętych przez Komisję Europejską (art. 46 ust. 2 lit. c RODO). Kopię zabezpieczeń możesz otrzymać, pisząc na adres kontaktowy.'),
    ),
    section(
      'prawa',
      '7. Twoje prawa',
      ul(
        '**dostęp** do danych i otrzymanie ich kopii — kopię danych Konta pobierzesz sam w ustawieniach Konta;',
        '**sprostowanie** nieprawidłowych danych;',
        `**usunięcie** danych — Konto usuniesz w ustawieniach (masz ${GDPR_COOLING_OFF_DAYS} dni na wycofanie decyzji); nie usuniemy danych, które musimy zachować na podstawie przepisów (np. faktur za subskrypcję);`,
        '**ograniczenie** przetwarzania;',
        '**przenoszenie** danych przetwarzanych na podstawie umowy lub zgody — w formacie JSON lub CSV;',
        '**sprzeciw** wobec przetwarzania na podstawie prawnie uzasadnionego interesu (art. 21 RODO), także wobec zbiorczych statystyk;',
        '**wycofanie zgody** w dowolnym momencie, bez wpływu na zgodność z prawem przetwarzania przed wycofaniem; zgodę na analitykę zmienisz w [ustawieniach cookies](/legal/cookies#ustawienia) albo w Ustawieniach → Konto i dane (RODO), a na e-maile linkiem w wiadomości lub w Ustawieniach → Powiadomienia;',
        '**skarga** do Prezesa Urzędu Ochrony Danych Osobowych (ul. Stawki 2, 00-193 Warszawa, [uodo.gov.pl](https://uodo.gov.pl)).',
      ),
      p(`Żądania wyślij na adres ${E.email}. Odpowiadamy bez zbędnej zwłoki, nie później niż w ciągu miesiąca. Możemy poprosić o potwierdzenie tożsamości, jeśli mamy uzasadnione wątpliwości, kto składa żądanie.`),
    ),
    section(
      'automatyzacja',
      '8. Zautomatyzowane decyzje i AI',
      p('Nie podejmujemy wobec Ciebie decyzji opartych wyłącznie na zautomatyzowanym przetwarzaniu, które wywołują skutki prawne lub w podobny sposób istotnie na Ciebie wpływają (art. 22 RODO). Nie profilujemy w celach marketingowych.'),
      p('Funkcje AI (odczyt dokumentów, podpowiedź kolumny KPiR, czat pomocy) przygotowują propozycje, które zatwierdza człowiek. Dane przekazujemy dostawcy AI tylko w zakresie potrzebnym do danej funkcji; dostawca nie trenuje na nich swoich modeli, a przechowuje je wyłącznie przez krótki okres określony w jego warunkach (w celach bezpieczeństwa i wykrywania nadużyć).'),
    ),
    section(
      'bezpieczenstwo',
      '9. Bezpieczeństwo',
      ul(
        'połączenia z serwisem są szyfrowane (HTTPS/TLS);',
        'hasła przechowujemy wyłącznie w postaci skrótu kryptograficznego; przy rejestracji i zmianie hasła sprawdzamy je w bazie znanych wycieków metodą k-anonimowości — do serwisu Have I Been Pwned trafia tylko fragment skrótu, nigdy hasło;',
        'tokeny i certyfikaty KSeF są szyfrowane w bazie;',
        'dane każdej firmy są odizolowane od innych na poziomie bazy danych (Row Level Security);',
        'udostępniamy weryfikację dwuetapową (2FA, aplikacja TOTP) z kodami ratunkowymi przechowywanymi w postaci skrótu;',
        'prowadzimy dziennik istotnych zdarzeń, którego użytkownicy nie mogą zmieniać;',
        'wykonujemy kopie zapasowe i ograniczamy dostęp do serwerów do niezbędnych osób.',
      ),
      p('O naruszeniu ochrony danych powodującym ryzyko zawiadamiamy Prezesa UODO w ciągu 72 godzin od jego stwierdzenia, a gdy ryzyko jest wysokie — także osoby, których dane dotyczą (art. 33 i 34 RODO). Klientów, których dane powierzone zostały naruszone, zawiadamiamy na zasadach umowy powierzenia.'),
    ),
    section(
      'dane-klientow',
      '10. Dane w fakturach i wiadomościach naszych klientów',
      p('Faktury, dane kontrahentów, dokumenty kosztowe i wiadomości wysyłane przez serwis do kontrahentów (np. faktura e-mailem, przypomnienie o płatności) przetwarzamy na polecenie naszego klienta, na podstawie [umowy powierzenia](/legal/umowa-powierzenia). Administratorem tych danych jest klient — to on decyduje, po co i jak są przetwarzane.'),
      p(`Jeśli otrzymałeś taką wiadomość albo chcesz skorzystać z praw dotyczących takich danych, zwróć się do firmy, która ją wysłała (jest wskazana w wiadomości i na fakturze). Jeśli nie możesz się z nią skontaktować, napisz do nas na ${E.email} — przekażemy żądanie klientowi.`),
    ),
    section(
      'cookies',
      '11. Pliki cookies i podobne technologie',
      p('Zasady opisuje [Polityka cookies](/legal/cookies). W skrócie: bez Twojej zgody używamy wyłącznie technologii niezbędnych do działania serwisu (sesja, bezpieczeństwo, zapamiętanie wyboru). Analityka w przeglądarce działa tylko po zgodzie.'),
    ),
    section(
      'zmiany',
      '12. Zmiany Polityki',
      p('Politykę aktualizujemy, gdy zmieniają się sposoby przetwarzania danych, dostawcy lub przepisy. O istotnych zmianach informujemy e-mailem lub w serwisie. Poprzednie wersje udostępniamy na żądanie.'),
      p(`Wersja z dnia ${PRIVACY_POLICY_VERSION}.`),
    ),
  ],
};
