import { PRICE_GROSS, PRICE_NET, TRIAL_DAYS } from '@/lib/billing/pricing';
import { LEGAL_ENTITY, entityAddress, entityIdentification } from '@/lib/legal/entity';
import { li, note, ol, p, section, type LegalDocument } from '@/lib/legal/doc-model';
import { CONTRACT_VERSION } from '@/lib/legal/versions';

const E = LEGAL_ENTITY;

/**
 * Regulamin świadczenia usług FaktWay.
 *
 * Wymagania, które ten tekst pokrywa (do weryfikacji przez prawnika — memo):
 *  - art. 8 ust. 3 u.ś.u.d.e.: rodzaje i zakres usług, wymagania techniczne,
 *    zakaz treści bezprawnych, zawieranie i rozwiązywanie umów, reklamacje;
 *  - art. 6 u.ś.u.d.e.: szczególne zagrożenia korzystania z usług elektronicznych;
 *  - art. 12 i rozdz. 4 ustawy o prawach konsumenta + art. 7aa (przedsiębiorca
 *    na prawach konsumenta, dalej PNPK): informacje, prawo odstąpienia, wzór
 *    formularza (załącznik nr 1);
 *  - rozdz. 5b ustawy o prawach konsumenta: zgodność usługi cyfrowej z umową,
 *    zmiany usługi;
 *  - art. 385^1–385^5 KC: ograniczenia odpowiedzialności tylko wobec
 *    przedsiębiorców „pełnych”, bez klauzul abuzywnych wobec PNPK;
 *  - art. 11, 12, 14, 16, 17 rozporządzenia 2022/2065 (DSA): punkt kontaktowy,
 *    zasady moderacji, zgłaszanie treści bezprawnych, uzasadnienie decyzji;
 *  - art. 50 ust. 1 rozporządzenia 2024/1689 (AI Act): informacja o interakcji z AI.
 */
export const REGULAMIN: LegalDocument = {
  slug: 'regulamin',
  title: 'Regulamin świadczenia usług FaktWay',
  version: CONTRACT_VERSION,
  summary: [
    `FaktWay to narzędzie do wystawiania i odbierania faktur w KSeF. Konto jest bezpłatne; pełny zakres działa w subskrypcji za ${PRICE_GROSS} brutto miesięcznie, z ${TRIAL_DAYS} dniami bez opłat na start.`,
    'Za treść faktur i rozliczenia podatkowe odpowiadasz Ty — my dostarczamy program, pilnujemy wysyłki i pokazujemy jej status. Nie jesteśmy biurem rachunkowym ani doradcą podatkowym.',
    'Wyniki funkcji AI (odczyt dokumentów, podpowiedzi KPiR, czat) sprawdzasz przed zatwierdzeniem.',
    'Subskrypcję możesz wypowiedzieć w każdej chwili; jako jednoosobowa firma na prawach konsumenta masz też 14 dni na odstąpienie od umowy.',
    'Dane Twojej firmy należą do Ciebie: możesz je wyeksportować, a dane Twoich kontrahentów przetwarzamy wyłącznie na Twoje polecenie (umowa powierzenia).',
  ],
  sections: [
    section(
      'postanowienia-ogolne',
      '§ 1. Postanowienia ogólne',
      ol(
        `Regulamin określa zasady świadczenia usług drogą elektroniczną w serwisie ${E.brand} dostępnym pod adresem ${E.website}, w szczególności rodzaje i zakres usług, warunki ich świadczenia, warunki zawierania i rozwiązywania umów oraz tryb postępowania reklamacyjnego. Jest regulaminem, o którym mowa w art. 8 ustawy z dnia 18 lipca 2002 r. o świadczeniu usług drogą elektroniczną.`,
        `Usługodawcą jest ${entityIdentification()}.`,
        `Z Usługodawcą można kontaktować się: e-mailem pod adresem ${E.email}, pisemnie na adres ${entityAddress()}${E.phone ? ` oraz telefonicznie pod numerem ${E.phone}` : ''}. Adres e-mail ${E.email} jest jednocześnie punktem kontaktowym dla użytkowników oraz dla organów państw członkowskich, Komisji Europejskiej i Europejskiej Rady ds. Usług Cyfrowych w rozumieniu art. 11 i 12 rozporządzenia (UE) 2022/2065 (akt o usługach cyfrowych). Komunikacja odbywa się w języku polskim; z organami — także w języku angielskim.`,
        'Regulamin jest udostępniany nieodpłatnie przed zawarciem umowy, w sposób umożliwiający jego pozyskanie, odtwarzanie i utrwalanie: można go zapisać lub wydrukować ze strony, a po zawarciu umowy Klient otrzymuje go e-mailem jako plik.',
        'Integralną częścią umowy jest [Umowa powierzenia przetwarzania danych osobowych](/legal/umowa-powierzenia). Zasady przetwarzania danych, których administratorem jest Usługodawca, opisuje [Polityka prywatności](/legal/polityka-prywatnosci), a zasady plików cookies — [Polityka cookies](/legal/cookies).',
      ),
    ),
    section(
      'definicje',
      '§ 2. Definicje',
      p('Pojęcia użyte w Regulaminie z wielkiej litery oznaczają:'),
      ol(
        `**Serwis** — aplikację internetową ${E.brand} dostępną pod adresem ${E.website}, wraz z aplikacją instalowaną z przeglądarki (PWA).`,
        '**Klient** — przedsiębiorcę (osobę fizyczną prowadzącą działalność gospodarczą, osobę prawną albo jednostkę organizacyjną, której ustawa przyznaje zdolność prawną), który zawarł z Usługodawcą Umowę. Serwis nie jest przeznaczony dla konsumentów niebędących przedsiębiorcami.',
        '**PNPK** — Klienta będącego osobą fizyczną, który zawiera Umowę bezpośrednio związaną ze swoją działalnością gospodarczą, gdy z treści Umowy wynika, że nie posiada ona dla niego charakteru zawodowego, wynikającego w szczególności z przedmiotu wykonywanej działalności udostępnionego w CEIDG (art. 7aa ustawy o prawach konsumenta, art. 385^5 Kodeksu cywilnego). Postanowienia Regulaminu dotyczące Konsumenta stosuje się do PNPK w zakresie przewidzianym w tych przepisach.',
        '**Konsument** — osobę fizyczną dokonującą z przedsiębiorcą czynności prawnej niezwiązanej bezpośrednio z jej działalnością gospodarczą lub zawodową (art. 22^1 Kodeksu cywilnego).',
        '**Użytkownik** — pełnoletnią osobę fizyczną posiadającą pełną zdolność do czynności prawnych, która korzysta z Serwisu przez Konto — samego Klienta albo osobę działającą w jego imieniu (np. pracownika, wspólnika, księgową).',
        '**Konto** — indywidualny, chroniony hasłem dostęp Użytkownika do Serwisu.',
        '**Organizacja** — wydzielona w Serwisie przestrzeń Klienta, identyfikowana numerem NIP, w której znajdują się Dane Klienta i do której Klient nadaje dostęp Użytkownikom.',
        '**Umowa** — umowę o świadczenie Usług zawieraną między Usługodawcą a Klientem na warunkach Regulaminu.',
        '**Usługi** — usługi świadczone drogą elektroniczną opisane w § 3.',
        `**Subskrypcja** — odpłatny dostęp do pełnego zakresu Usług, rozliczany w okresach miesięcznych (Okres rozliczeniowy), na warunkach [Cennika](/pricing).`,
        '**Okres próbny** — bezpłatny okres na początku Subskrypcji opisany w § 6.',
        '**KSeF** — Krajowy System e-Faktur prowadzony przez Ministra Finansów.',
        '**Dane Klienta** — dane i treści wprowadzone do Serwisu przez Klienta lub Użytkowników albo pobrane na ich polecenie (np. z KSeF lub rejestrów publicznych), w szczególności faktury, dane kontrahentów, dokumenty kosztowe i ich zdjęcia.',
        '**Funkcje AI** — funkcje Serwisu wykorzystujące modele sztucznej inteligencji dostawcy zewnętrznego, opisane w § 9.',
      ),
    ),
    section(
      'uslugi',
      '§ 3. Rodzaje i zakres Usług',
      ol(
        li(
          'Usługodawca świadczy na rzecz Klienta i Użytkowników następujące Usługi:',
          'prowadzenie Konta i Organizacji, w tym zarządzanie dostępem Użytkowników i rolami;',
          'wystawianie faktur ustrukturyzowanych w formacie FA(3) i ich korekt, generowanie ich wizualizacji (PDF) oraz numeracja dokumentów;',
          'przesyłanie faktur do KSeF w imieniu Klienta, pobieranie statusów i Urzędowych Poświadczeń Odbioru (UPO) oraz pobieranie z KSeF faktur, w których Klient jest nabywcą;',
          'ewidencję wydatków, odczyt danych z dokumentów kosztowych (OCR) i pomocnicze zestawienia przychodów i kosztów (KPiR), eksport danych (m.in. JPK, CSV, PDF);',
          'prowadzenie bazy kontrahentów, w tym pobieranie danych z rejestrów publicznych (m.in. REGON/GUS, wykaz podatników VAT, VIES) na podstawie numeru NIP;',
          'monitorowanie płatności i — na polecenie Klienta — wysyłanie kontrahentom Klienta faktur oraz przypomnień o płatności e-mailem;',
          'udostępnianie Danych Klienta osobom wskazanym przez Klienta (np. biuru rachunkowemu) przez zaproszenie albo link dostępu;',
          'powiadomienia e-mail i powiadomienia push w przeglądarce;',
          'pomoc techniczną, w tym czat z asystentem AI i kontakt z zespołem Usługodawcy;',
          'newsletter — na odrębnych zasadach opisanych przy formularzu zapisu i w Polityce prywatności.',
        ),
        'Aktualny opis funkcji znajduje się w Serwisie oraz w [centrum pomocy](/pomoc). Zakres Usług dostępnych bez Subskrypcji i w ramach Subskrypcji określa Cennik.',
        '**Usługi mają charakter narzędziowy.** Usługodawca nie świadczy usług księgowych, usług prowadzenia ksiąg ani doradztwa podatkowego lub prawnego, nie prowadzi ewidencji w imieniu Klienta i nie jest jego pełnomocnikiem w sprawach podatkowych. Obliczenia, podpowiedzi, klasyfikacje, walidacje i odpowiedzi asystenta AI mają charakter pomocniczy i nie zastępują oceny Klienta ani jego księgowego.',
        'Usługodawca może korzystać z podwykonawców, w tym dostawców infrastruktury i usług technicznych wskazanych na stronie [Podmioty przetwarzające](/legal/podprocesorzy). Za ich działania odpowiada jak za własne.',
      ),
    ),
    section(
      'wymagania-techniczne',
      '§ 4. Wymagania techniczne i zagrożenia',
      ol(
        li(
          'Do korzystania z Serwisu potrzebne są:',
          'urządzenie z dostępem do internetu i aktualną przeglądarką internetową (Chrome, Edge lub Firefox w wersji 110 lub nowszej albo Safari 16 lub nowszej) z włączoną obsługą JavaScript i niezbędnych plików cookies;',
          'aktywny adres e-mail;',
          'do wysyłania i odbierania faktur w KSeF — uprawnienia w KSeF oraz token lub certyfikat uwierzytelniający KSeF wygenerowany przez Klienta;',
          'do powiadomień push — przeglądarka obsługująca standard Web Push i zgoda na powiadomienia wyrażona w przeglądarce.',
        ),
        'Usługodawca może ograniczyć dostęp do części funkcji z niektórych urządzeń (np. telefonów), jeżeli nie zapewniają one prawidłowego działania Serwisu. Informacja o takim ograniczeniu jest wyświetlana na urządzeniu.',
        li(
          'Korzystanie z usług świadczonych drogą elektroniczną wiąże się z zagrożeniami, w szczególności:',
          'przejęciem danych logowania (phishing — fałszywe wiadomości i strony podszywające się pod Serwis, złośliwe oprogramowanie, przechwycenie hasła);',
          'nieuprawnionym dostępem osób, którym udostępniono urządzenie lub hasło;',
          'działaniem złośliwego oprogramowania na urządzeniu Użytkownika;',
          'przerwami w działaniu sieci, systemów publicznych (w tym KSeF) i dostawców usług.',
        ),
        `Usługodawca stosuje środki bezpieczeństwa opisane w [Polityce prywatności](/legal/polityka-prywatnosci#bezpieczenstwo). Użytkownik powinien stosować silne, unikalne hasło, włączyć weryfikację dwuetapową (2FA), nie udostępniać danych logowania i sprawdzać adres strony przed zalogowaniem. Usługodawca nigdy nie prosi o podanie hasła e-mailem, telefonicznie ani w czacie.`,
      ),
    ),
    section(
      'zawarcie-umowy',
      '§ 5. Rejestracja, Konto i zawarcie Umowy',
      ol(
        'Rejestracja następuje przez formularz w Serwisie (imię i nazwisko, adres e-mail, hasło) albo przez logowanie kontem Google. Warunkiem rejestracji jest akceptacja Regulaminu i Umowy powierzenia. Utworzenie Konta wymaga potwierdzenia adresu e-mail.',
        'Z chwilą utworzenia Konta zostaje zawarta nieodpłatna umowa o prowadzenie Konta, na czas nieokreślony.',
        'Utworzenie Organizacji oznacza zawarcie Umowy z Klientem, którego dotyczy Organizacja. Użytkownik, który tworzy Organizację, oświadcza, że jest Klientem albo jest uprawniony do zawarcia Umowy w jego imieniu. Osoba działająca bez umocowania odpowiada na zasadach art. 103 Kodeksu cywilnego. Użytkownik, który dołącza do istniejącej Organizacji na zaproszenie, korzysta z Usług w ramach Umowy zawartej przez Klienta.',
        'Klient i Użytkownicy podają dane prawdziwe i aktualne oraz aktualizują je w razie zmiany. Jedno Konto może być używane wyłącznie przez jedną osobę; danych logowania nie wolno udostępniać.',
        'Klient decyduje, którzy Użytkownicy (w tym biuro rachunkowe) mają dostęp do Organizacji i z jaką rolą, oraz odbiera ten dostęp. Działania Użytkowników w Organizacji uważa się za działania Klienta.',
        'Po zawarciu Umowy Klient otrzymuje e-mailem potwierdzenie wraz z treścią Regulaminu i Umowy powierzenia w postaci plików (trwały nośnik).',
      ),
    ),
    section(
      'oplaty',
      '§ 6. Opłaty, Okres próbny i płatności',
      ol(
        'Utworzenie Konta jest bezpłatne. Pełny zakres Usług jest dostępny w ramach Subskrypcji. Ceny podawane są w złotych polskich, w kwotach brutto (z podatkiem VAT) i netto.',
        `Subskrypcja miesięczna kosztuje ${PRICE_GROSS} brutto (${PRICE_NET} netto) za każdy Okres rozliczeniowy, płatne z góry. Subskrypcja odnawia się automatycznie na kolejne Okresy rozliczeniowe do czasu jej wypowiedzenia.`,
        `Subskrypcja rozpoczyna się Okresem próbnym trwającym ${TRIAL_DAYS} dni, w którym Klient nie ponosi opłat. Przy rozpoczęciu Subskrypcji Klient podaje dane karty płatniczej; pierwsza płatność następuje po zakończeniu Okresu próbnego. Wypowiedzenie Subskrypcji przed końcem Okresu próbnego nie powoduje żadnej opłaty. Usługodawca przypomina e-mailem o zbliżającym się końcu Okresu próbnego. Okres próbny przysługuje raz dla danej Organizacji.`,
        'Płatności obsługuje Stripe Payments Europe, Ltd. Dane karty są przekazywane bezpośrednio do Stripe; Usługodawca ich nie przechowuje. Klient upoważnia Usługodawcę do obciążania karty kwotą Subskrypcji za kolejne Okresy rozliczeniowe.',
        'Za Subskrypcję Usługodawca wystawia fakturę, w tym — gdy wymagają tego przepisy — fakturę ustrukturyzowaną w KSeF. Klient akceptuje otrzymywanie faktur w postaci elektronicznej.',
        'Jeżeli płatność się nie powiedzie, Usługodawca informuje o tym Klienta i ponawia próbę obciążenia. Gdy płatność nie zostanie uregulowana w ciągu 14 dni od wezwania, Usługodawca może ograniczyć dostęp do funkcji płatnych. Ograniczenie nigdy nie obejmuje wglądu w Dane Klienta i ich eksportu.',
        'Zmiana cen obowiązuje od Okresu rozliczeniowego rozpoczynającego się po upływie co najmniej 30 dni od powiadomienia Klienta e-mailem. Klient, który nie akceptuje nowej ceny, może wypowiedzieć Subskrypcję przed jej wejściem w życie. Cena za Okres rozliczeniowy już opłacony nie zmienia się.',
        'Opłata za rozpoczęty Okres rozliczeniowy nie podlega zwrotowi w razie wypowiedzenia Subskrypcji przez Klienta — Subskrypcja działa wtedy do końca opłaconego okresu. Nie dotyczy to odstąpienia od Umowy (§ 13), uwzględnionej reklamacji (§ 12), wypowiedzenia Umowy przez Usługodawcę z przyczyn niedotyczących Klienta (§ 14 ust. 3) ani wypowiedzenia w związku ze zmianą Regulaminu (§ 15) — w tych przypadkach Usługodawca zwraca opłatę za niewykorzystaną część okresu.',
      ),
    ),
    section(
      'ksef',
      '§ 7. KSeF i obowiązki Klienta',
      ol(
        'Aby korzystać z KSeF przez Serwis, Klient nadaje uprawnienia w KSeF i wprowadza do Serwisu token albo certyfikat uwierzytelniający. Klient tym samym poleca i upoważnia Usługodawcę do wykonywania w jego imieniu, w KSeF, czynności technicznych: wysyłania faktur, które Klient zatwierdził do wysyłki, pobierania ich statusów i UPO oraz pobierania faktur, w których Klient jest nabywcą. Dane uwierzytelniające są przechowywane w postaci zaszyfrowanej i wykorzystywane wyłącznie w tym celu. Klient może w każdej chwili usunąć je z Serwisu i cofnąć uprawnienia w KSeF.',
        '**Klient odpowiada za treść dokumentów**, które wystawia w Serwisie — w szczególności za dane nabywcy, stawki i kwoty podatku, adnotacje, daty i terminy — oraz za decyzję o ich wysłaniu do KSeF i za terminowe wystawienie. Serwis sprawdza zgodność faktury ze schemą FA(3) i wybrane reguły formalne, ale nie weryfikuje prawidłowości rozliczenia podatkowego.',
        'Faktura jest wystawiona w KSeF dopiero po nadaniu jej numeru KSeF. Serwis pokazuje status każdej wysyłki i informuje o odrzuceniu lub błędzie. Klient obowiązany jest sprawdzać ten status, a w razie błędu — poprawić dokument i wysłać go ponownie albo wystawić go w inny sposób dopuszczony przepisami.',
        'W razie niedostępności KSeF albo Serwisu Klient wykonuje obowiązki wynikające z przepisów o fakturowaniu, w tym w trybach przewidzianych na wypadek niedostępności lub awarii KSeF. Serwis udostępnia funkcje, które to ułatwiają, ale ich użycie nie przenosi tych obowiązków na Usługodawcę.',
        'Usługodawca pobiera z KSeF dane w zakresie, w jakim KSeF je udostępnia, i nie odpowiada za kompletność, poprawność ani dostępność danych w KSeF lub w rejestrach publicznych.',
        'Obowiązek przechowywania faktur i ewidencji przez okres wymagany przepisami podatkowymi ciąży na Kliencie. Faktury przesłane do KSeF przechowuje także KSeF. Serwis przechowuje Dane Klienta przez czas trwania Umowy i umożliwia ich eksport; zasady po rozwiązaniu Umowy określa § 14 ust. 6 i Umowa powierzenia.',
        'Klient odpowiada za to, że ma podstawę prawną do przetwarzania danych swoich kontrahentów i do wysyłania do nich wiadomości (faktur, przypomnień o płatności) za pośrednictwem Serwisu. Wiadomości te są wysyłane w imieniu Klienta i wskazują Klienta jako nadawcę.',
      ),
    ),
    section(
      'zasady-korzystania',
      '§ 8. Zasady korzystania i treści bezprawne',
      ol(
        li(
          'Zabronione jest dostarczanie i przesyłanie przez Serwis treści o charakterze bezprawnym oraz korzystanie z Serwisu w sposób sprzeczny z prawem, dobrymi obyczajami lub Regulaminem, w szczególności:',
          'wystawianie faktur dokumentujących czynności, które nie zostały dokonane, albo zawierających nierzetelne dane;',
          'posługiwanie się cudzymi danymi, w tym cudzymi uprawnieniami lub tokenami KSeF, bez upoważnienia;',
          'wysyłanie przez Serwis wiadomości niezamówionych (spamu) albo wiadomości o treści obraźliwej, wprowadzającej w błąd lub podszywającej się pod inne osoby;',
          'próby obejścia zabezpieczeń, uzyskania dostępu do cudzych danych, przeciążania Serwisu, automatycznego pobierania danych (scrapingu) poza udostępnionymi funkcjami eksportu;',
          'wprowadzanie złośliwego oprogramowania;',
          'odsprzedaż lub udostępnianie Serwisu osobom trzecim bez zgody Usługodawcy — z wyjątkiem udostępniania Organizacji biuru rachunkowemu i współpracownikom Klienta.',
        ),
        'Usługodawca nie prowadzi ogólnego monitorowania Danych Klienta i nie stosuje zautomatyzowanych narzędzi moderowania treści. Reaguje na zgłoszenia i informacje o możliwym naruszeniu prawa lub Regulaminu.',
        'Każdy — także osoba niebędąca Użytkownikiem — może zgłosić treść, którą uważa za bezprawną (np. wiadomość wysłaną przez Serwis), e-mailem na adres ' +
          `${E.email}. Zgłoszenie powinno zawierać: wyjaśnienie, dlaczego treść jest bezprawna; wskazanie treści (np. kopię wiadomości, adres lub identyfikator); imię i nazwisko oraz adres e-mail zgłaszającego; oświadczenie, że zgłaszający w dobrej wierze uważa informacje w zgłoszeniu za prawidłowe i kompletne. Usługodawca potwierdza otrzymanie zgłoszenia, rozpatruje je bez zbędnej zwłoki i informuje zgłaszającego o decyzji i dostępnych środkach odwoławczych.`,
        li(
          'W razie stwierdzenia naruszenia Usługodawca może, proporcjonalnie do jego wagi:',
          'usunąć lub zablokować wysyłkę konkretnej treści;',
          'czasowo zawiesić funkcję (np. wysyłkę wiadomości do kontrahentów) albo Konto;',
          'wypowiedzieć Umowę na zasadach § 14.',
        ),
        'O każdej takiej decyzji Usługodawca informuje Użytkownika e-mailem, podając jej zakres, podstawę faktyczną i prawną oraz możliwość odwołania (reklamacji, § 12). Użytkownik i zgłaszający mogą także skorzystać z pozasądowego rozstrzygania sporów przed organem certyfikowanym zgodnie z art. 21 aktu o usługach cyfrowych oraz z drogi sądowej.',
      ),
    ),
    section(
      'funkcje-ai',
      '§ 9. Funkcje AI',
      ol(
        'Serwis korzysta z modeli sztucznej inteligencji dostawcy zewnętrznego (Anthropic) do: odczytu danych ze zdjęć i plików dokumentów kosztowych, proponowania kolumny KPiR dla wydatku oraz odpowiadania na pytania w czacie pomocy.',
        '**Czat pomocy prowadzi asystent AI, nie człowiek.** Użytkownik może w każdej chwili poprosić o kontakt z człowiekiem — w czacie albo e-mailem. Asystent nie udziela porad podatkowych ani prawnych.',
        '**Wyniki Funkcji AI mogą zawierać błędy.** Użytkownik sprawdza odczytane dane i podpowiedzi przed ich zatwierdzeniem; zatwierdzone dane traktuje się jak dane wprowadzone przez Klienta.',
        'Do dostawcy przekazywane są wyłącznie dane potrzebne do wykonania danej funkcji. Dostawca przetwarza je na zlecenie Usługodawcy i nie wykorzystuje ich do trenowania swoich modeli. Szczegóły — w Polityce prywatności i Umowie powierzenia.',
        'Usługodawca może stosować limity korzystania z Funkcji AI w danym okresie, informując o nich w Serwisie.',
      ),
    ),
    section(
      'dostepnosc',
      '§ 10. Dostępność Serwisu i pomoc techniczna',
      ol(
        'Usługodawca dokłada należytej staranności, aby Serwis działał nieprzerwanie, ale nie gwarantuje jego ciągłej dostępności.',
        'Prace planowane Usługodawca prowadzi w miarę możliwości poza godzinami 8:00–18:00 w dni robocze i zapowiada z wyprzedzeniem w Serwisie lub e-mailem, jeżeli mają trwać dłużej niż 30 minut. Prace awaryjne mogą być prowadzone bez zapowiedzi.',
        'Przerwy w działaniu KSeF, rejestrów publicznych, operatorów telekomunikacyjnych i innych systemów niezależnych od Usługodawcy nie są przerwami w świadczeniu Usług przez Usługodawcę.',
        `Pomoc techniczna jest udzielana e-mailem (${E.email}) i w czacie w Serwisie. Usługodawca odpowiada na zgłoszenia w dni robocze, zwykle w ciągu 2 dni roboczych.`,
      ),
    ),
    section(
      'odpowiedzialnosc',
      '§ 11. Odpowiedzialność',
      ol(
        'Usługodawca odpowiada za niewykonanie lub nienależyte wykonanie Umowy na zasadach określonych w przepisach prawa, z zastrzeżeniem postanowień poniżej.',
        li(
          '**W stosunku do Klientów niebędących Konsumentami ani PNPK:**',
          'Usługodawca odpowiada wyłącznie za szkodę rzeczywistą, z wyłączeniem utraconych korzyści;',
          'łączna odpowiedzialność Usługodawcy z tytułu Umowy jest ograniczona do kwoty opłat zapłaconych przez Klienta w ciągu 12 miesięcy poprzedzających zdarzenie wywołujące szkodę, nie mniej jednak niż 500 zł;',
          'Usługodawca nie odpowiada za szkody wynikające z treści dokumentów i decyzji Klienta, z niezweryfikowania przez Klienta statusu wysyłki lub wyników Funkcji AI, z niedostępności KSeF lub innych systemów niezależnych od Usługodawcy, z działań osób, którym Klient udostępnił dostęp lub dane logowania, ani z siły wyższej;',
          'ograniczenia z pkt 1–3 nie dotyczą szkody wyrządzonej umyślnie lub wskutek rażącego niedbalstwa ani odpowiedzialności, której nie można ograniczyć na mocy bezwzględnie obowiązujących przepisów.',
        ),
        '**W stosunku do Konsumentów i PNPK** Usługodawca odpowiada na zasadach ogólnych, bez ograniczeń wskazanych w ust. 2. Usługodawca odpowiada wobec nich za zgodność Usług z Umową przez cały okres ich świadczenia, na zasadach rozdziału 5b ustawy o prawach konsumenta.',
        'Zasady odpowiedzialności związanej z przetwarzaniem danych osobowych powierzonych przez Klienta określa Umowa powierzenia.',
        'Klient odpowiada wobec Usługodawcy za szkody wynikłe z naruszenia Regulaminu przez Klienta lub Użytkowników Organizacji, w tym za roszczenia osób trzecich związane z treściami lub wiadomościami przesłanymi przez Klienta.',
      ),
    ),
    section(
      'reklamacje',
      '§ 12. Reklamacje',
      ol(
        `Reklamacje dotyczące Usług można składać e-mailem na adres ${E.email} albo pisemnie na adres ${entityAddress()}.`,
        'Reklamacja powinna zawierać dane pozwalające zidentyfikować Klienta lub Użytkownika (np. adres e-mail Konta, NIP Organizacji), opis problemu i datę jego wystąpienia oraz oczekiwany sposób załatwienia sprawy.',
        'Usługodawca rozpatruje reklamację i odpowiada na nią w terminie 14 dni od jej otrzymania, na adres e-mail, z którego ją złożono, albo na inny wskazany adres. Jeżeli reklamacja Konsumenta lub PNPK nie zostanie rozpatrzona w tym terminie, uważa się ją za uwzględnioną.',
        'Jeżeli Usługa jest niezgodna z Umową, Konsument lub PNPK może żądać doprowadzenia jej do zgodności z Umową, a gdy to niemożliwe, wymaga nadmiernych kosztów, nie nastąpiło w rozsądnym czasie lub niezgodność jest istotna — obniżenia ceny albo odstąpienia od Umowy, na zasadach rozdziału 5b ustawy o prawach konsumenta.',
        'Konsument może skorzystać z pozasądowych sposobów rozpatrywania reklamacji i dochodzenia roszczeń, w tym pomocy miejskiego lub powiatowego rzecznika konsumentów i wojewódzkiego inspektora Inspekcji Handlowej. Informacje są dostępne na stronie [prawakonsumenta.uokik.gov.pl](https://prawakonsumenta.uokik.gov.pl). Skorzystanie z nich jest dobrowolne.',
      ),
    ),
    section(
      'odstapienie',
      '§ 13. Prawo odstąpienia od Umowy (Konsument i PNPK)',
      note(
        'Jeśli zawierasz Umowę jako jednoosobowy przedsiębiorca, a jej przedmiot nie ma dla Ciebie charakteru zawodowego, możesz w ciągu 14 dni odstąpić od niej bez podawania przyczyny.',
      ),
      ol(
        'Konsument i PNPK mogą odstąpić od Umowy zawartej na odległość, bez podawania przyczyny, w terminie 14 dni od dnia jej zawarcia, a od Subskrypcji — w terminie 14 dni od dnia jej rozpoczęcia.',
        `Aby odstąpić od Umowy, wystarczy przed upływem terminu wysłać jednoznaczne oświadczenie, np. e-mailem na adres ${E.email} lub pisemnie na adres ${entityAddress()}. Można skorzystać ze [wzoru formularza](#zalacznik-1), ale nie jest to obowiązkowe. Usługodawca niezwłocznie potwierdza otrzymanie oświadczenia e-mailem.`,
        'W razie odstąpienia Umowę uważa się za niezawartą. Usługodawca zwraca dokonane płatności niezwłocznie, nie później niż w terminie 14 dni od otrzymania oświadczenia, tym samym sposobem płatności, którego użyto, chyba że Konsument lub PNPK zgodzi się na inny sposób niewiążący się z kosztami.',
        `Jeżeli Konsument lub PNPK zażądał rozpoczęcia świadczenia Usług przed upływem terminu na odstąpienie, płaci za Usługi świadczone do chwili odstąpienia, proporcjonalnie do ceny Subskrypcji. Okres próbny jest bezpłatny — odstąpienie w trakcie Okresu próbnego nie powoduje żadnej opłaty.`,
        'Bezpłatne Konto można w każdej chwili usunąć w ustawieniach Konta.',
      ),
    ),
    section(
      'rozwiazanie',
      '§ 14. Czas trwania i rozwiązanie Umowy',
      ol(
        'Umowa jest zawarta na czas nieokreślony.',
        // Usunięcia Organizacji nie ma w Serwisie jako samoobsługi (od
        // 15.10.2026 przycisk kieruje do pomocy technicznej) — wypowiedzenie
        // i zlecenie usunięcia idą e-mailem.
        `Klient może w każdej chwili wypowiedzieć Subskrypcję w Serwisie (Ustawienia → Abonament) — ze skutkiem na koniec bieżącego Okresu rozliczeniowego — oraz wypowiedzieć Umowę oświadczeniem wysłanym e-mailem na adres ${E.email}, w tym zlecając usunięcie Organizacji. Usługodawca może poprosić o potwierdzenie, że oświadczenie pochodzi od Klienta (np. z adresu e-mail Konta właściciela Organizacji). Usunięcie Konta Użytkownika nie rozwiązuje Umowy z Klientem: dane Organizacji pozostają do dyspozycji Klienta i innych Użytkowników z dostępem.`,
        li(
          'Usługodawca może wypowiedzieć Umowę z zachowaniem 30-dniowego okresu wypowiedzenia wyłącznie z ważnych przyczyn, którymi są:',
          'zaprzestanie świadczenia Usług lub ich istotnej części dla wszystkich klientów;',
          'zmiana przepisów lub decyzja organu, która uniemożliwia albo istotnie utrudnia świadczenie Usług na dotychczasowych zasadach;',
          'brak zapłaty za Subskrypcję przez co najmniej 30 dni od wezwania do zapłaty;',
          'brak w Organizacji jakiegokolwiek Użytkownika z dostępem przez co najmniej 12 miesięcy — wypowiedzenie Usługodawca wysyła na ostatni znany adres e-mail Klienta.',
        ),
        li(
          'Usługodawca może wypowiedzieć Umowę ze skutkiem natychmiastowym, jeżeli Klient lub Użytkownik Organizacji mimo wezwania do zaprzestania naruszeń (a bez wezwania — gdy naruszenie jest rażące lub zagraża bezpieczeństwu Serwisu albo innych osób):',
          'wykorzystuje Serwis do popełnienia przestępstwa lub wykroczenia, w szczególności do wystawiania faktur niedokumentujących rzeczywistych czynności;',
          'narusza zasady z § 8 ust. 1;',
          'podał dane nieprawdziwe w zakresie istotnym dla zawarcia Umowy.',
        ),
        'Wypowiedzenie przez Usługodawcę wymaga formy elektronicznej (e-mail) i zawiera uzasadnienie.',
        'Po rozwiązaniu Umowy Klient może przez 30 dni wyeksportować Dane Klienta — Organizacja pozostaje w tym czasie dostępna, chyba że Klient zleci wcześniejsze usunięcie danych. Usługodawca informuje Klienta e-mailem o planowanym usunięciu danych. Dalsze postępowanie z danymi osobowymi powierzonymi przez Klienta określa Umowa powierzenia. Konta Użytkowników pozostają aktywne.',
      ),
    ),
    section(
      'zmiany',
      '§ 15. Zmiany Regulaminu i Usług',
      ol(
        li(
          'Usługodawca może zmienić Regulamin z ważnych przyczyn, którymi są:',
          'zmiana przepisów prawa lub wydanie decyzji, orzeczenia albo wytycznych organu, mające wpływ na Usługi;',
          'zmiana zakresu, funkcji lub sposobu świadczenia Usług, w tym wprowadzenie nowych Usług;',
          'konieczność zapobiegania nadużyciom lub poprawy bezpieczeństwa;',
          'zmiana danych Usługodawcy lub podwykonawców;',
          'potrzeba usunięcia niejasności lub błędów redakcyjnych.',
        ),
        'O zmianie Usługodawca powiadamia Klienta e-mailem i w Serwisie co najmniej 14 dni przed jej wejściem w życie (30 dni — gdy zmiana dotyczy ceny). Klient, który nie akceptuje zmian, może wypowiedzieć Umowę przed dniem wejścia ich w życie, bez ponoszenia kosztów; w takim przypadku Usługodawca zwraca opłatę za niewykorzystaną część Okresu rozliczeniowego. Dalsze korzystanie z Serwisu po wejściu zmian w życie, połączone z ich akceptacją w Serwisie, oznacza zgodę na zmiany.',
        'Termin z ust. 2 nie dotyczy zmian wymaganych przez przepisy w krótszym terminie oraz zmian wyłącznie na korzyść Klienta.',
        'Usługodawca może zmieniać Usługi (np. dodawać, rozwijać lub wycofywać funkcje), jeżeli zmiana jest uzasadniona przyczyną z ust. 1, nie powoduje kosztów po stronie Klienta i nie pozbawia go dostępu do Danych Klienta. Jeżeli zmiana istotnie i negatywnie wpływa na dostęp do Usługi lub korzystanie z niej przez Konsumenta lub PNPK, Usługodawca informuje o niej z wyprzedzeniem na trwałym nośniku, a Konsument lub PNPK może wypowiedzieć Umowę w terminie 30 dni od zmiany, na zasadach rozdziału 5b ustawy o prawach konsumenta.',
      ),
    ),
    section(
      'wlasnosc',
      '§ 16. Prawa własności intelektualnej',
      ol(
        'Serwis, w tym oprogramowanie, wygląd, teksty i oznaczenia, jest chroniony prawem. Usługodawca udziela Klientowi i Użytkownikom niewyłącznej, niezbywalnej licencji na korzystanie z Serwisu zgodnie z jego przeznaczeniem, na czas trwania Umowy.',
        'Dane Klienta pozostają własnością Klienta. Usługodawca korzysta z nich wyłącznie w zakresie potrzebnym do świadczenia Usług oraz zgodnie z Umową powierzenia.',
      ),
    ),
    section(
      'dane-osobowe',
      '§ 17. Dane osobowe i komunikacja',
      ol(
        'Administratorem danych osobowych Użytkowników przetwarzanych w związku z Kontem, rozliczeniami i kontaktem jest Usługodawca. Szczegóły zawiera [Polityka prywatności](/legal/polityka-prywatnosci).',
        'Dane osobowe zawarte w Danych Klienta (np. dane kontrahentów będących osobami fizycznymi) Usługodawca przetwarza jako podmiot przetwarzający, na polecenie Klienta, na zasadach [Umowy powierzenia](/legal/umowa-powierzenia), zawieranej razem z Umową.',
        'Usługodawca przesyła na adres e-mail Konta wiadomości związane z wykonywaniem Umowy (np. potwierdzenia, statusy wysyłek do KSeF, powiadomienia o bezpieczeństwie i rozliczeniach, informacje o zmianach Regulaminu). Informacje handlowe i porady marketingowe wysyła wyłącznie po wyrażeniu odrębnej zgody, którą można w każdej chwili wycofać.',
      ),
    ),
    section(
      'postanowienia-koncowe',
      '§ 18. Postanowienia końcowe',
      ol(
        'Umowę zawiera się w języku polskim. Prawem właściwym jest prawo polskie. Wybór prawa nie pozbawia Konsumenta ani PNPK ochrony przyznanej im przez przepisy, których nie można wyłączyć w drodze umowy.',
        'Spory z Klientami niebędącymi Konsumentami ani PNPK rozstrzyga sąd właściwy dla siedziby Usługodawcy. Spory z Konsumentami i PNPK rozstrzyga sąd właściwy według przepisów ogólnych.',
        'Jeżeli którekolwiek postanowienie Regulaminu okaże się nieważne lub bezskuteczne, pozostałe postanowienia pozostają w mocy.',
        `Regulamin obowiązuje od dnia ${CONTRACT_VERSION}.`,
      ),
    ),
    section(
      'zalacznik-1',
      'Załącznik nr 1. Wzór formularza odstąpienia od umowy',
      p('(formularz ten należy wypełnić i odesłać tylko w przypadku chęci odstąpienia od umowy)'),
      ol(
        `Adresat: ${E.name ?? '[DO UZUPEŁNIENIA: pełna nazwa usługodawcy]'}, ${entityAddress()}, e-mail: ${E.email}`,
        `Ja/My(*) niniejszym informuję/informujemy(*) o moim/naszym(*) odstąpieniu od umowy o świadczenie następującej usługi: subskrypcja serwisu ${E.brand}`,
        'Data zawarcia umowy: …………',
        'Imię i nazwisko konsumenta(-ów) / przedsiębiorcy: …………',
        'Adres konsumenta(-ów) / przedsiębiorcy: …………',
        'Adres e-mail Konta i NIP Organizacji: …………',
        'Podpis konsumenta(-ów) / przedsiębiorcy (tylko jeżeli formularz jest przesyłany w wersji papierowej): …………',
        'Data: …………',
      ),
      p('(*) Niepotrzebne skreślić.'),
    ),
  ],
};
