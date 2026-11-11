# Pytania do prawnika: samodzielna księgowość w FaktWay

Prosimy o pisemną opinię w sprawie pytań z części 2. Odpowiedź nie wymaga
znajomości kodu.

- **Pytania 1-6** dotyczą modułu księgowości. Opinia o nich jest warunkiem
  udostępnienia modułu klientom (warunek B2 w planie
  `docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md`, sekcja 11). Część 1 opisuje, co
  moduł robi i czego nie robi.
- **Pytania 7-17** dotyczą kolejnych funkcji z planu
  `docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md` (sekcja 7.1). Każde ma
  własny krótki opis funkcji, bo nie wszystkie dotyczą modułu księgowości.
  Żadna z tych funkcji jeszcze nie działa: opinia rozstrzyga, czy i jak je
  zbudować.

Stan opisu: pytania 1-6 z 4.11.2026, pytania 7-17 z 9.11.2026. Moduł jest
w budowie i jest wyłączony dla klientów.

## 1. Co robi moduł

### Produkt i klienci

- **FaktWay** to aplikacja internetowa do wystawiania i odbierania faktur
  w Krajowym Systemie e-Faktur (KSeF).
- Klienci to głównie jednoosobowe działalności gospodarcze (JDG), często bez
  pracowników i bez biura rachunkowego.
- Jest jeden plan za 29,99 zł brutto miesięcznie. Moduł księgowości ma być
  w tej cenie, bez dopłaty.
- Dane trzymamy w Unii Europejskiej (serwery Hetzner w Norymberdze).
- Operatorem usługi ma być spółka. Dziś spółki jeszcze nie ma; jej założenie
  jest jednym z warunków włączenia modułu.

### Cel modułu

JDG bez pracowników rozlicza się sama. Co miesiąc widzi, ile i do kiedy ma
zapłacić: ryczałt albo zaliczkę na PIT, składki ZUS, składkę zdrowotną i VAT.
Ewidencję przychodów albo KPiR prowadzi w programie i wysyła JPK_V7M bez
wychodzenia z FaktWay. Od 1 stycznia 2027 r. prowadzenie ewidencji i ksiąg
w programie komputerowym obowiązuje wszystkich podatników PIT.

### Co moduł robi

1. **Ustawienia podatkowe wpisuje klient:** formę opodatkowania (ryczałt,
   skala, podatek liniowy), stawkę ryczałtu, status VAT, rodzaj składek ZUS
   (ulga na start, preferencyjne, pełne), dobrowolne chorobowe i to, czy obok
   działalności ma etat. Stawkę ryczałtu wybiera klient. Program jej nie
   dobiera, pokazuje tylko opis grup stawek i odnośnik do podatki.gov.pl.
2. **Liczy miesiąc z danych klienta:** z faktur w KSeF, kosztów (także ze
   zdjęć paragonów) i wpisów ręcznych, np. raportu z kasy. Wynik to kwoty
   ryczałtu albo zaliczki na PIT, składek ZUS, składki zdrowotnej i VAT.
3. **Pokazuje terminy z przepisów i dane do przelewu** (mikrorachunek
   podatkowy, tytuł, kwota). Przypomina o terminach powiadomieniem
   w telefonie i mailem. Podaje, ile odłożyć na zobowiązania bieżącego
   miesiąca, z wyraźnym oznaczeniem, że to szacunek.
4. **Prowadzi ewidencję przychodów** (ryczałt) albo **podatkową księgę
   przychodów i rozchodów** (skala, liniowy) i tworzy pliki JPK_EWP
   i JPK_PKPIR.
5. **Tworzy JPK_V7M** (ewidencja i deklaracja VAT) i docelowo wysyła go do
   Ministerstwa Finansów (opis w pytaniu 3). Do czasu opinii klient pobiera
   plik i wysyła go sam.
6. **Klient zatwierdza miesiąc.** Zatwierdzone rozliczenie się nie zmienia.
   Gdy dane zmienią się później, powstaje nowa wersja i komunikat dla klienta.
   Zmiany ustawień i zatwierdzenia zapisujemy w dzienniku zdarzeń.

### Czego moduł nie robi

- **Nie doradza.** Nie zaleca formy opodatkowania ani stawki, nie porównuje
  form i nie pisze w trybie rozkazującym. Przykład tekstu: „Według Twoich
  danych wychodzi 1 234 zł, termin 20 marca”. Przy każdej kwocie jest podpis
  „według Twoich danych i stawek na 2027 r.”.
- **Model językowy (AI) nie liczy i nie objaśnia przepisów.** Kwoty liczą
  stałe reguły w programie. Stawki i progi na każdy rok mają podane źródło
  i sprawdza je księgowa.
- Nie obsługuje pracowników, środków trwałych, ulg (IP Box, B+R, internet,
  dzieci), wspólnego rozliczenia małżonków ani zeznań rocznych (PIT-28,
  PIT-36, PIT-36L). Część z tego planujemy na 2028 r.
- Gdy brakuje danych albo sprawdzonych stawek na dany rok, program nie
  pokazuje kwoty, tylko komunikat, czego brakuje i co uzupełnić.

### Warunki włączenia dla klientów

Moduł włączymy klientom dopiero po spełnieniu wszystkich warunków:

1. spółka jako operator usługi (regulamin, umowy);
2. pisemna opinia prawnika, o którą prosimy w tym dokumencie;
3. polisa OC;
4. księgowa sprawdziła parametry roku i podpisała 14 przykładów obliczeń,
   które program musi powtórzyć co do grosza;
5. regulamin modułu (odpowiedzialność, JDG jako konsument, dane podatkowe
   w RODO);
6. pilotaż na 3-5 firmach, w którym księgowa sprawdza dwa pierwsze miesiące.

Podobne usługi już działają, np. samodzielna księgowość w Fakturowni
i w inFakcie. Ich regulaminy są w części 4 do porównania.

## 2. Pytania

### Pytanie 1. Czy to doradztwo podatkowe?

Program liczy podatek, składki i terminy wyłącznie z danych, które wpisał
klient, według stałych reguł. Nie ocenia sytuacji klienta i nie wybiera za
niego formy ani stawki.

**Pytanie:** Czy samoobsługowe wyliczenie podatku, ZUS i terminów z danych
klienta to czynność doradztwa podatkowego? Jakie sformułowania są bezpieczne?

Najbardziej pomoże nam lista sformułowań dozwolonych i niedozwolonych
w aplikacji, mailach i powiadomieniach, np. „wychodzi”, „do zapłaty”,
„termin”, „zapłać”, „musisz”.

### Pytanie 2. Usługowe prowadzenie ksiąg i obowiązek OC

Klient sam wprowadza dane i sam zatwierdza miesiąc. Program układa je
w ewidencję przychodów albo KPiR, liczy kwoty i tworzy pliki JPK. Nikt
z FaktWay nie księguje dokumentów za klienta, nie sprawdza ich i nie podpisuje
za niego deklaracji. Planujemy polisę OC na wzór innej usługi tego typu
(mojaKsięgowa.ai, suma 1 mln zł).

**Pytanie:** Czy to „usługowe prowadzenie ksiąg” (art. 76a ustawy
o rachunkowości) z obowiązkiem OC?

Jeśli tak: jakiej sumy i jakiego zakresu polisy wymagają przepisy. Jeśli nie:
czy mimo to polisa jest wskazana i w jakim zakresie.

### Pytanie 3. Wysyłka JPK danymi autoryzującymi klienta

Bramka Ministerstwa Finansów (e-dokumenty.mf.gov.pl) przyjmuje pliki JPK
podpisane danymi autoryzującymi zamiast podpisu kwalifikowanego. Planowany
przebieg:

1. Program tworzy plik XML zgodny ze schematem MF, pakuje go i szyfruje tak,
   jak wymaga specyfikacja MF.
2. Przy każdej wysyłce klient wpisuje w naszej aplikacji dane autoryzujące:
   NIP, imię, nazwisko, datę urodzenia i kwotę przychodu z zeznania za rok
   sprzed dwóch lat (przy wysyłce w 2027 r. za 2025 r.).
3. Program podpisuje nimi dane wysyłki według wzoru MF (dokument SIG-2008),
   wysyła plik i pobiera Urzędowe Poświadczenie Odbioru (UPO), które
   zapisujemy.
4. Danych autoryzujących nie zapisujemy w bazie ani w logach. Są w pamięci
   tylko na czas jednej wysyłki.

Bramka zwraca m.in. odpowiedzi „brak pełnomocnictwa” i „dane autoryzujące
tylko dla osoby fizycznej”. Zanim cokolwiek trafi do klientów, zrobimy próbę
na środowisku testowym MF. To samo pytanie wyślemy do MF
(jpkPD.helpdesk@mf.gov.pl).

**Pytanie:** Czy możemy wysyłać JPK podpisany danymi autoryzującymi, które
klient wpisuje u nas przy każdej wysyłce? Czy potrzebne jest upoważnienie albo
pełnomocnictwo?

Jeśli potrzebne: kto komu ma go udzielić (klient spółce, czy konkretnej
osobie), w jakiej formie i czy wystarczy zgoda zaznaczona w aplikacji.

### Pytanie 4. Odpowiedzialność wobec JDG z prawami konsumenta

Od 2021 r. JDG ma część praw konsumenta przy umowach, które nie mają dla niej
charakteru zawodowego. Nie wiemy, czy abonament na program do rozliczeń jest
taką umową. Moduł jest częścią abonamentu za 29,99 zł miesięcznie. Przykłady
sytuacji, które regulamin powinien objąć:

- klient wybrał stawkę ryczałtu, która nie pasuje do jego usług;
- dane z faktury albo kosztu są błędne;
- błąd programu albo stawek wpisanych na dany rok;
- klient nie zapłacił w terminie mimo przypomnienia;
- przerwa w działaniu usługi tuż przed terminem płatności albo wysyłki.

**Pytanie:** Jak sformułować odpowiedzialność w regulaminie, skoro JDG ma
prawa konsumenta?

### Pytanie 5. Hasło reklamowe

W komunikacji chcemy mówić, że przy prostej działalności moduł zastępuje
biuro rachunkowe. Robocze hasła: „księgowość bez księgowej” i „zamiast
księgowej za 300 zł”.

**Pytanie:** Czy hasło „księgowość bez księgowej” jest dopuszczalne
w reklamie?

Prosimy też o ocenę drugiego hasła i warunków, przy których oba są bezpieczne
(np. dopisek o zakresie usługi).

### Pytanie 6. RODO

Poza fakturami, które już przetwarzamy, moduł przetwarza:

- ustawienia podatkowe: formę opodatkowania, stawkę ryczałtu, rodzaj składek
  ZUS, chorobowe, informację o etacie obok działalności i (opcjonalnie) numer
  rachunku składkowego ZUS;
- wyliczone kwoty podatku i składek, ich wersje i daty zapłaty;
- dane autoryzujące przy wysyłce JPK (tylko w pamięci, bez zapisu) i UPO;
- dziennik zdarzeń: kto i kiedy zmienił ustawienia albo zatwierdził miesiąc.

**Pytanie:** RODO: przetwarzanie danych podatkowych i danych autoryzujących,
okres przechowywania (KPiR 5 lat, faktury 10 lat).

W szczególności: podstawa prawna, czy przy tych danych jesteśmy
administratorem, czy podmiotem przetwarzającym (umowa powierzenia), jak długo
przechowywać ewidencje, rozliczenia i UPO oraz co zrobić z danymi po
rezygnacji klienta.

### Pytanie 7. Linki do płatności

Chcemy, żeby klient mógł dodać do faktury link „Zapłać” (szybki przelew,
BLIK, karta). Link tworzy operator płatności, z którym klient sam zawiera
umowę (np. Przelewy24, PayU, Autopay, Stripe). Pieniądze płyną od nabywcy
przez operatora prosto na rachunek klienta. FaktWay ich nie przyjmuje, nie
przechowuje i nie rozlicza. FaktWay zapisuje klucze dostępu klienta do jego
konta u operatora (zaszyfrowane), tworzy link przez API operatora i odbiera
od operatora potwierdzenie wpłaty, żeby oznaczyć fakturę jako zapłaconą.

**Pytanie:** Czy w takim układzie FaktWay świadczy usługę płatniczą albo inną
usługę, która wymaga zezwolenia lub wpisu do rejestru (ustawa o usługach
płatniczych)?

W szczególności: czy ocenę zmienia przechowywanie kluczy klienta, czy zmienia
ją model, w którym FaktWay jest „platformą” u operatora (np. Stripe Connect,
z kontami klientów podpiętymi pod konto FaktWay), i co musi znaleźć się
w regulaminie.

### Pytanie 8. Import wyciągu bankowego

Klient pobiera ze swojego banku plik z operacjami na rachunku (np. MT940,
CSV albo XML w standardzie ISO 20022) i wgrywa go do FaktWay, żeby program
sam oznaczył zapłacone faktury. FaktWay nie łączy się z bankiem. Plik
zawiera też operacje prywatne i dane osób trzecich: imiona i nazwiska,
numery rachunków, tytuły przelewów.

**Pytanie:** RODO: na jakiej podstawie i w jakiej roli przetwarzamy dane
z pliku, co wolno nam przechowywać i jak długo?

W szczególności: czy wystarczy zachować tylko operacje dopasowane do faktur
i kosztów, a resztę usunąć zaraz po imporcie, oraz jak opisać to
w polityce prywatności.

### Pytanie 9. Wysyłka zeznań i deklaracji

To rozszerzenie pytania 3. Poza plikami JPK program przygotuje i wyśle przez
bramkę e-Deklaracje Ministerstwa Finansów zeznania PIT-28, PIT-36 i PIT-36L
oraz deklaracje VAT-UE, VAT-8, VAT-9M i VAT-26. Wysyłka idzie danymi
autoryzującymi klienta (kwota przychodu z zeznania sprzed dwóch lat), które
klient wpisuje przy wysyłce; nie zapisujemy ich. Klient sam klika „Wyślij”
po obejrzeniu dokumentu.

**Pytanie:** Czy wysyłka tych dokumentów przez FaktWay danymi autoryzującymi
klienta wymaga pełnomocnictwa (np. UPL-1) albo innej zgody i czy odpowiedź
różni się od odpowiedzi na pytanie 3?

### Pytanie 10. Plik deklaracji dla ZUS

Program przygotuje deklarację rozliczeniową ZUS DRA w pliku KEDU. Klient sam
wczytuje plik do programu ZUS (ePłatnik na eZUS) i sam go wysyła. FaktWay nie
łączy się z ZUS i nie ma dostępu do konta klienta w ZUS.

**Pytanie:** Czy przygotowanie takiego pliku wymaga pełnomocnictwa ZUS (np.
ZUS-PEL) albo innego upoważnienia i kto odpowiada za błąd w pliku, który klient
sam wczytał i wysłał?

### Pytanie 11. Kadry i płace dla mikrofirm

Po module księgowości chcemy dodać rachunki do umów zlecenia i o dzieło,
a potem listy płac dla kilku pracowników na umowie o pracę: wynagrodzenie,
składki ZUS, zaliczka PIT pracownika, PPK, deklaracje PIT-11 i PIT-4R.
Program przetwarzałby dane pracowników i zleceniobiorców, w tym zwolnienia
lekarskie (dane o zdrowiu). Nie planujemy ewidencji czasu pracy, urlopów ani
akt osobowych.

**Pytanie:** Jaka jest odpowiedzialność FaktWay przy błędzie na liście płac
albo w deklaracji i jaka umowa z klientem (pracodawcą) jest potrzebna?

W szczególności: umowa powierzenia danych pracowników, zabezpieczenie danych
o zdrowiu, zapisy w regulaminie i czy taki moduł zmienia odpowiedź na
pytanie 2 (usługowe prowadzenie ksiąg).

### Pytanie 12. Ulgi i wspólne rozliczenie w zeznaniu

W zeznaniach PIT-36 i PIT-36L klient będzie mógł wpisać ulgi (np. na dzieci,
termomodernizacyjną, internetową) i rozliczyć się wspólnie z małżonkiem.
Wymaga to danych małżonka i dzieci: imion, nazwisk, numerów PESEL i dochodów.

**Pytanie:** RODO: na jakiej podstawie przetwarzamy dane członków rodziny
klienta i kto jest ich administratorem? Kto odpowiada, gdy klient wpisze
ulgę, do której nie ma prawa, a program ją uwzględni?

### Pytanie 13. Porównanie form opodatkowania i ulgi

Chcemy pokazać klientowi symulację: ile zapłaciłby na ryczałcie, skali
podatkowej i podatku liniowym przy swoich danych z ostatnich miesięcy.
Chcemy też podawać informacje o IP Box i uldze badawczo-rozwojowej oraz
ostrzegać, że zapłata za usługę z zagranicy może wymagać pobrania podatku
u źródła. Program niczego nie wybiera za klienta.

**Pytanie:** Czy taka symulacja, informacje i ostrzeżenia są doradztwem
podatkowym w rozumieniu ustawy o doradztwie podatkowym? Jakie sformułowania
są bezpieczne, a jakich unikać?

### Pytanie 14. KSeF bez plików (uprawnienie dla FaktWay)

Dziś klient łączy FaktWay z KSeF swoim certyfikatem albo tokenem, które
wgrywa do programu. Prościej byłoby tak: klient w Aplikacji Podatnika KSeF
nadaje uprawnienie do wystawiania i odbierania faktur podmiotowi, który
prowadzi FaktWay (jego NIP), a FaktWay działa na tym uprawnieniu, bez plików
klienta.

**Pytanie:** Jaka umowa z klientem jest potrzebna, kto odpowiada za fakturę
wysłaną przez FaktWay na tym uprawnieniu i czy potrzebne jest dodatkowe
zabezpieczenie (np. kod firmy, którym klient potwierdza wysyłkę)?

### Pytanie 15. Publiczne API

FaktWay udostępni API: klient albo jego programista będzie mógł wystawiać
faktury, pobierać dane i dostawać powiadomienia o zdarzeniach z własnego
systemu (np. sklepu albo programu do zamówień).

**Pytanie:** Co musi zawierać regulamin API i kto odpowiada za faktury
wystawione przez integrację klienta, np. przy błędzie w jego systemie? Jakie
ograniczenia odpowiedzialności są dopuszczalne wobec JDG z prawami
konsumenta (pytanie 4)?

### Pytanie 16. Archiwum po rezygnacji i kontrola skarbowa

Po rezygnacji klient zachowuje bezpłatny dostęp tylko do odczytu do swoich
faktur, ewidencji, ksiąg i plików JPK do końca okresu przechowywania. Na
kontrolę skarbową program przygotuje jedną paczkę: faktury, UPO, księgi,
pliki JPK i dziennik zmian.

**Pytanie:** Jakie mamy obowiązki wobec danych byłego klienta (jak długo,
w jakiej roli według RODO) i co zrobić, gdy klient zażąda usunięcia danych
przed końcem okresu przechowywania? Czy paczka na kontrolę rodzi
odpowiedzialność za jej kompletność?

### Pytanie 17. Interfejs po angielsku i ukraińsku

Chcemy przetłumaczyć aplikację i maile na angielski i ukraiński. Regulamin,
polityka prywatności i treści o podatkach są po polsku.

**Pytanie:** Czy tłumaczenie regulaminu i treści o podatkach musi być
wiążące, czy wystarczy tłumaczenie pomocnicze z zastrzeżeniem, że wiąże
wersja polska?

## 3. Czego potrzebujemy w odpowiedzi

- Pisemnej opinii (może być jeden dokument) z odpowiedzią na każde pytanie.
- Przy pytaniach 1 i 5: sformułowań dozwolonych i niedozwolonych.
- Przy pytaniu 3: czy potrzebne jest upoważnienie albo pełnomocnictwo,
  a jeśli tak, w jakiej formie.
- Przy pytaniach 4 i 6: wskazówek do regulaminu modułu i polityki prywatności.
- Przy pytaniu 7: czy model z kontem klienta u operatora i model „platformy”
  różnią się w ocenie; jeśli któryś wymaga zezwolenia, tego, który nie wymaga.
- Przy pytaniach 9, 10 i 14: czy potrzebne jest upoważnienie albo
  pełnomocnictwo, w jakiej formie i kto je składa.
- Przy pytaniach 8, 11, 12 i 16: wskazówek do umowy powierzenia, polityki
  prywatności i okresów przechowywania.
- Przy pytaniu 13: sformułowań dozwolonych i niedozwolonych, jak przy
  pytaniu 1.
- Przy pytaniach 15 i 17: wskazówek do regulaminu.

## 4. Materiały

- Regulaminy podobnych usług:
  https://fakturownia.pl/regulamin-samodzielna-ksiegowosc ,
  https://www.infakt.pl/regulamin/adkzk/
- Księgi w programie komputerowym od 2026 i 2027 r. (KAS):
  https://www.gov.pl/web/kas/elektroniczna-dokumentacja-ksiegowa-dla-przedsiebiorcow-placacych-pit-obowiazkowa-od-2026-r
- Specyfikacja interfejsów usług JPK (wysyłka plików, dane autoryzujące):
  https://www.podatki.gov.pl/media/c2sdatex/specyfikacja-interfejs%C3%B3w-us%C5%82ug-jpk-wersja-520.pdf
- Ustawa o usługach płatniczych (pytanie 7):
  https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20111991175
- e-Deklaracje, dane autoryzujące (pytanie 9):
  https://www.podatki.gov.pl/e-deklaracje/informacje-podstawowe
- Import plików KEDU w ePłatniku (pytanie 10):
  https://www.zus.pl/portal/pomoc/epl0017.html
- Ustawa o doradztwie podatkowym (pytanie 13):
  https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19961020475
- Uprawnienia w KSeF (pytanie 14): https://ksef.podatki.gov.pl/
