import { LEGAL_ENTITY, entityIdentification } from '@/lib/legal/entity';
import { li, note, ol, p, section, table, ul, type LegalDocument } from '@/lib/legal/doc-model';
import { subprocessorsFor } from '@/lib/legal/subprocessors';
import { CONTRACT_VERSION } from '@/lib/legal/versions';

const E = LEGAL_ENTITY;

/**
 * Umowa powierzenia przetwarzania danych osobowych (art. 28 ust. 3 RODO).
 *
 * Do 15.10.2026 strona RODO obiecywała „DPA do pobrania na e-mail”, ale
 * takiego dokumentu nie było — a FaktWay przetwarza dane kontrahentów
 * klientów (faktury, przypomnienia o płatności, OCR) od pierwszego dnia.
 * Bez umowy powierzenia przetwarzanie narusza art. 28 RODO po obu stronach.
 *
 * Umowę zawiera się razem z Umową (regulamin § 5, § 17) — akceptacja jednym
 * oświadczeniem (lib/legal/versions.ts, TERMS_STATEMENT), ta sama wersja.
 * Elementy obowiązkowe z art. 28 ust. 3 lit. a–h oznaczone w komentarzach
 * memo dla prawnika.
 */
export const UMOWA_POWIERZENIA: LegalDocument = {
  slug: 'umowa-powierzenia',
  title: 'Umowa powierzenia przetwarzania danych osobowych',
  version: CONTRACT_VERSION,
  summary: [
    'Gdy wystawiasz fakturę albo dodajesz kontrahenta, jesteś administratorem jego danych, a FaktWay przetwarza je w Twoim imieniu. RODO wymaga na to umowy — to jest ta umowa.',
    'Przetwarzamy te dane wyłącznie po to, żeby świadczyć Ci usługę, i tylko w sposób, jaki wynika z Twoich działań w serwisie.',
    'Wiesz, z jakich dostawców korzystamy, i dowiesz się z wyprzedzeniem o każdej zmianie — możesz się sprzeciwić.',
    'O naruszeniu bezpieczeństwa dowiesz się od nas bez zbędnej zwłoki, nie później niż w 36 godzin.',
  ],
  sections: [
    section(
      'strony',
      '§ 1. Strony i zawarcie umowy',
      ol(
        'Umowa powierzenia przetwarzania danych osobowych (dalej „Umowa powierzenia”) zostaje zawarta między Klientem w rozumieniu Regulaminu FaktWay, jako administratorem danych (dalej „Administrator”), a ' +
          `${entityIdentification()}, jako podmiotem przetwarzającym (dalej „Przetwarzający”).`,
        'Umowa powierzenia jest zawierana razem z Umową o świadczenie Usług na podstawie [Regulaminu](/legal/regulamin), przez akceptację w Serwisie, i obowiązuje przez czas jej trwania oraz do zakończenia czynności opisanych w § 9. Pojęcia z wielkiej litery mają znaczenie nadane w Regulaminie, a pojęcia dotyczące danych osobowych — w rozporządzeniu (UE) 2016/679 (RODO).',
        'Jeżeli Klient korzysta z Serwisu jako podmiot przetwarzający na rzecz innego administratora (np. biuro rachunkowe prowadzące Organizację klienta), Przetwarzający działa jako dalszy podmiot przetwarzający, a Klient zapewnia, że ma zgodę swojego administratora na korzystanie z Przetwarzającego.',
      ),
    ),
    section(
      'przedmiot',
      '§ 2. Przedmiot, charakter i cel przetwarzania',
      ol(
        'Administrator powierza Przetwarzającemu przetwarzanie danych osobowych zawartych w Danych Klienta, w zakresie i celu niezbędnym do świadczenia Usług opisanych w Regulaminie.',
        li(
          'Charakter przetwarzania obejmuje operacje wykonywane automatycznie w ramach funkcji Serwisu, w szczególności:',
          'przechowywanie, porządkowanie, wyszukiwanie i wyświetlanie danych Użytkownikom Organizacji;',
          'tworzenie faktur i innych dokumentów, ich przesyłanie do KSeF i pobieranie z KSeF;',
          'odczyt danych z dokumentów kosztowych (OCR) i proponowanie ich klasyfikacji, w tym z użyciem Funkcji AI;',
          'pobieranie danych kontrahentów z rejestrów publicznych na podstawie NIP;',
          'wysyłanie wiadomości e-mail do kontrahentów Administratora (faktury, przypomnienia o płatności), gdy Administrator to zleci;',
          'tworzenie eksportów i udostępnianie danych osobom wskazanym przez Administratora;',
          'tworzenie kopii zapasowych, monitorowanie błędów i zapewnianie bezpieczeństwa.',
        ),
      ),
    ),
    section(
      'zakres',
      '§ 3. Rodzaj danych i kategorie osób',
      ol(
        li(
          'Kategorie osób, których dane dotyczą:',
          'kontrahenci Administratora (nabywcy i sprzedawcy) będący osobami fizycznymi, w tym przedsiębiorcy i konsumenci;',
          'osoby reprezentujące kontrahentów lub wskazane jako osoby kontaktowe;',
          'pracownicy i współpracownicy Administratora wskazani w dokumentach;',
          'inne osoby, których dane znajdują się w dokumentach przesłanych do Serwisu (np. na paragonach lub fakturach kosztowych).',
        ),
        li(
          'Rodzaje danych:',
          'dane identyfikacyjne: imię i nazwisko, firma, NIP, REGON, adres, numer identyfikacyjny dla podatku od wartości dodanej;',
          'dane kontaktowe: adres e-mail, numer telefonu;',
          'dane finansowe i transakcyjne: numery rachunków bankowych, pozycje, kwoty i daty transakcji, statusy płatności;',
          'inne dane zawarte w treści dokumentów i ich zdjęciach.',
        ),
        'Administrator nie powierza danych szczególnych kategorii (art. 9 RODO) ani danych dotyczących wyroków skazujących (art. 10 RODO), chyba że wynikają one z obowiązkowej treści dokumentu (np. opisu usługi na fakturze). W takim przypadku Administrator odpowiada za istnienie podstawy prawnej, a Przetwarzający stosuje wobec tych danych środki z załącznika do Umowy powierzenia.',
      ),
    ),
    section(
      'polecenia',
      '§ 4. Przetwarzanie na udokumentowane polecenie',
      ol(
        'Przetwarzający przetwarza powierzone dane wyłącznie na udokumentowane polecenie Administratora, także w zakresie przekazywania danych do państwa trzeciego. Poleceniami są: Regulamin i Umowa powierzenia, działania Użytkowników Organizacji w Serwisie (np. wystawienie i wysyłka faktury, zlecenie przypomnienia, nadanie dostępu biuru rachunkowemu) oraz polecenia przesłane e-mailem na adres ' +
          `${E.email}.`,
        'Jeżeli prawo Unii lub prawo polskie nakłada na Przetwarzającego obowiązek przetwarzania danych (np. na żądanie uprawnionego organu), Przetwarzający informuje o tym Administratora przed rozpoczęciem przetwarzania, chyba że prawo zabrania takiego poinformowania.',
        'Przetwarzający niezwłocznie informuje Administratora, jeżeli jego zdaniem wydane polecenie narusza RODO lub inne przepisy o ochronie danych.',
        'Przetwarzający nie wykorzystuje powierzonych danych do własnych celów. Może tworzyć z nich dane zanonimizowane i zagregowane statystyki (np. liczba wystawionych faktur, czas wysyłki do KSeF), które nie pozwalają zidentyfikować osób ani Administratora, wyłącznie w celu utrzymania, zabezpieczenia i rozwoju Serwisu. Administrator wydaje na to polecenie, akceptując Umowę powierzenia.',
      ),
    ),
    section(
      'bezpieczenstwo',
      '§ 5. Poufność i bezpieczeństwo',
      ol(
        'Przetwarzający dopuszcza do danych wyłącznie osoby, które tego potrzebują do świadczenia Usług, posiadają jego upoważnienie i zobowiązały się do zachowania tajemnicy lub podlegają ustawowemu obowiązkowi tajemnicy. Obowiązek trwa także po ustaniu współpracy z tymi osobami.',
        'Przetwarzający stosuje środki techniczne i organizacyjne odpowiednie do ryzyka (art. 32 RODO), opisane w [załączniku](#srodki). Może je zmieniać, jeżeli nie obniża to poziomu ochrony.',
      ),
    ),
    section(
      'podprocesorzy',
      '§ 6. Dalsze podmioty przetwarzające',
      ol(
        'Administrator udziela Przetwarzającemu ogólnej zgody na korzystanie z dalszych podmiotów przetwarzających. Aktualna lista znajduje się w załączniku i na stronie [Podmioty przetwarzające](/legal/podprocesorzy).',
        'Przetwarzający nakłada na dalsze podmioty przetwarzające, w drodze umowy, te same obowiązki ochrony danych, które wynikają z Umowy powierzenia, i odpowiada wobec Administratora za ich wykonanie.',
        'O zamiarze dodania lub zastąpienia dalszego podmiotu przetwarzającego Przetwarzający informuje Administratora e-mailem co najmniej 14 dni wcześniej. Administrator może w tym terminie zgłosić umotywowany sprzeciw. Jeżeli strony nie uzgodnią rozwiązania, Administrator może wypowiedzieć Umowę ze skutkiem natychmiastowym, a Przetwarzający zwraca opłatę za niewykorzystaną część Okresu rozliczeniowego.',
        'W nagłych przypadkach (np. konieczność zastąpienia dostawcy z powodu zagrożenia bezpieczeństwa) Przetwarzający może dokonać zmiany wcześniej, informując Administratora niezwłocznie wraz z uzasadnieniem.',
        'Przekazanie danych do państwa trzeciego następuje wyłącznie przy zastosowaniu zabezpieczeń z rozdziału V RODO (decyzja stwierdzająca odpowiedni stopień ochrony albo standardowe klauzule umowne).',
      ),
    ),
    section(
      'pomoc',
      '§ 7. Pomoc Administratorowi',
      ol(
        'Przetwarzający pomaga Administratorowi wywiązywać się z obowiązku odpowiadania na żądania osób, których dane dotyczą (art. 15–22 RODO) — przede wszystkim przez funkcje Serwisu pozwalające wyszukać, poprawić, wyeksportować i usunąć dane. Żądanie skierowane omyłkowo do Przetwarzającego przekazuje Administratorowi w ciągu 5 dni roboczych i nie odpowiada na nie samodzielnie, chyba że Administrator tak poleci.',
        'Przetwarzający pomaga Administratorowi w wywiązaniu się z obowiązków z art. 32–36 RODO (bezpieczeństwo, zgłaszanie naruszeń, ocena skutków, uprzednie konsultacje), z uwzględnieniem charakteru przetwarzania i dostępnych mu informacji.',
      ),
    ),
    section(
      'naruszenia',
      '§ 8. Naruszenia ochrony danych',
      ol(
        'Przetwarzający zgłasza Administratorowi naruszenie ochrony powierzonych danych bez zbędnej zwłoki, nie później niż w ciągu 36 godzin od jego stwierdzenia, e-mailem na adres właściciela Organizacji.',
        'Zgłoszenie zawiera, w miarę dostępności, informacje z art. 33 ust. 3 RODO: charakter naruszenia, kategorie i przybliżoną liczbę osób i wpisów, możliwe konsekwencje, zastosowane i proponowane środki oraz dane kontaktowe. Informacje niedostępne od razu Przetwarzający przekazuje niezwłocznie później.',
        'Przetwarzający dokumentuje naruszenia i podejmuje działania ograniczające ich skutki. Zawiadomienie organu nadzorczego i osób, których dane dotyczą, należy do Administratora, chyba że strony uzgodnią inaczej.',
      ),
    ),
    section(
      'koniec',
      '§ 9. Zakończenie przetwarzania',
      ol(
        'Po rozwiązaniu Umowy Administrator może przez 30 dni wyeksportować dane z Serwisu. Na żądanie Administratora zgłoszone w tym terminie Przetwarzający przekazuje mu dane w formacie eksportu Serwisu.',
        // Terminy kopii = stałe w lib/jobs/runners/cleanup-old-backups.ts
        // (test rodo-terminy-usuwania pilnuje zgodności). Do 15.10.2026 tekst
        // obiecywał 30 dni, a kopie tygodniowe zostają 8 tygodni.
        'Po upływie terminu z ust. 1 Przetwarzający usuwa powierzone dane w ciągu kolejnych 30 dni, a ich kopie zapasowe — w cyklu nadpisywania kopii, nie dłuższym niż 60 dni (kopie dzienne do 30 dni, tygodniowe do 8 tygodni), chyba że prawo Unii lub prawo polskie nakazuje ich dalsze przechowywanie. Kopie wykonane ręcznie (np. przed pracami serwisowymi) Przetwarzający usuwa w tym samym terminie. Jeżeli wykonywanie nowych kopii zawiedzie, ostatnie poprawne kopie mogą być przechowywane dłużej — do czasu wykonania nowych. Do czasu nadpisania Przetwarzający korzysta z kopii wyłącznie w celu odtworzenia Serwisu po awarii. Na żądanie Administratora Przetwarzający potwierdza usunięcie danych.',
        'Administrator może wcześniej polecić usunięcie danych, w szczególności wiadomością e-mail.',
      ),
    ),
    section(
      'audyt',
      '§ 10. Informacje i audyt',
      ol(
        'Przetwarzający udostępnia Administratorowi informacje niezbędne do wykazania spełnienia obowiązków z art. 28 RODO — w pierwszej kolejności w formie pisemnych wyjaśnień, odpowiedzi na kwestionariusz i dokumentacji, w terminie 14 dni od prośby.',
        'Jeżeli informacje z ust. 1 są niewystarczające, Administrator albo upoważniony audytor zobowiązany do zachowania tajemnicy może przeprowadzić audyt, w tym inspekcję, po uprzedzeniu Przetwarzającego co najmniej 14 dni wcześniej, w dni robocze i w sposób nieutrudniający świadczenia Usług innym klientom — nie częściej niż raz na 12 miesięcy, chyba że audyt wynika z naruszenia ochrony danych lub żądania organu nadzorczego. Koszty audytu ponosi Administrator.',
        'Przetwarzający niezwłocznie informuje Administratora o kontroli organu nadzorczego dotyczącej powierzonych danych, o ile prawo tego nie zabrania.',
      ),
    ),
    section(
      'odpowiedzialnosc',
      '§ 11. Odpowiedzialność i postanowienia końcowe',
      ol(
        'Odpowiedzialność stron wobec osób, których dane dotyczą, określa art. 82 RODO. W stosunkach między stronami stosuje się postanowienia Regulaminu o odpowiedzialności (§ 11 Regulaminu).',
        'W sprawach nieuregulowanych stosuje się Regulamin, RODO i przepisy prawa polskiego. W razie sprzeczności między Regulaminem a Umową powierzenia w zakresie ochrony danych osobowych pierwszeństwo ma Umowa powierzenia.',
        'Zmiany Umowy powierzenia wprowadza się w trybie przewidzianym dla zmian Regulaminu (§ 15 Regulaminu), z wyjątkiem zmian listy dalszych podmiotów przetwarzających, które następują w trybie § 6.',
      ),
    ),
    section(
      'srodki',
      'Załącznik. Środki techniczne i organizacyjne oraz dalsze podmioty przetwarzające',
      p('**A. Środki techniczne i organizacyjne**'),
      ul(
        'szyfrowanie transmisji danych (HTTPS/TLS) między przeglądarką a Serwisem;',
        'szyfrowanie tokenów i certyfikatów KSeF w bazie danych kluczem przechowywanym poza bazą;',
        'izolacja danych Organizacji na poziomie bazy danych (Row Level Security) — Użytkownik widzi wyłącznie dane Organizacji, do których ma dostęp;',
        'kontrola dostępu oparta na rolach w Organizacji; weryfikacja dwuetapowa (TOTP) dostępna dla Użytkowników i wymagana dla operacji szczególnie wrażliwych, gdy jest włączona;',
        'hasła przechowywane wyłącznie jako skróty kryptograficzne; blokada haseł znanych z wycieków (k-anonimowość); ograniczenie liczby prób logowania; ochrona formularzy przed botami;',
        'dziennik istotnych zdarzeń zapisywany po stronie serwera, którego Użytkownicy nie mogą zmieniać;',
        'serwery w centrum danych w Niemczech; dostęp administracyjny wyłącznie kluczami SSH przez ograniczone grono osób; zapora sieciowa dostawcy chmury;',
        'codzienne kopie zapasowe bazy danych z ograniczonym okresem przechowywania (kopie dzienne do 30 dni, tygodniowe do 8 tygodni) i procedurą odtworzenia;',
        'oczyszczanie raportów błędów i zdarzeń analitycznych z danych osobowych przed wysłaniem do dostawców;',
        'przekazywanie do Funkcji AI wyłącznie danych potrzebnych do danej funkcji, z oddzieleniem treści dokumentu od poleceń dla modelu;',
        'procedura obsługi naruszeń ochrony danych i rejestr kategorii czynności przetwarzania (art. 30 ust. 2 RODO);',
        'upoważnienia i zobowiązania do zachowania tajemnicy dla osób z dostępem do danych.',
      ),
      p('**B. Dalsze podmioty przetwarzające (stan na dzień wersji Umowy powierzenia)**'),
      table(
        ['Podmiot', 'Zakres', 'Lokalizacja danych', 'Przekazanie poza EOG'],
        subprocessorsFor('client_data').map((s) => [`${s.name} (${s.seat})`, s.purpose, s.location, s.transfer]),
      ),
      note('Gdy Administrator korzysta z KSeF, rejestrów publicznych lub wysyła dane do biura rachunkowego, przekazuje je tym podmiotom na własne polecenie — nie są one dalszymi podmiotami przetwarzającymi Przetwarzającego.'),
    ),
  ],
};
