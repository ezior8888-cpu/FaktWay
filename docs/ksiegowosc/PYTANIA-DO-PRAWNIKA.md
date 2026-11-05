# Pytania do prawnika: samodzielna księgowość w FaktWay

Prosimy o pisemną opinię w sprawie sześciu pytań z części 2. Opinia jest
warunkiem udostępnienia modułu klientom (warunek B2 w planie
`docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md`, sekcja 11). Odpowiedź nie wymaga
znajomości kodu: część 1 opisuje, co moduł robi i czego nie robi.

Stan opisu: 4.11.2026. Moduł jest w budowie i jest wyłączony dla klientów.

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

## 3. Czego potrzebujemy w odpowiedzi

- Pisemnej opinii (może być jeden dokument) z odpowiedzią na każde pytanie.
- Przy pytaniach 1 i 5: sformułowań dozwolonych i niedozwolonych.
- Przy pytaniu 3: czy potrzebne jest upoważnienie albo pełnomocnictwo,
  a jeśli tak, w jakiej formie.
- Przy pytaniach 4 i 6: wskazówek do regulaminu modułu i polityki prywatności.

## 4. Materiały

- Regulaminy podobnych usług:
  https://fakturownia.pl/regulamin-samodzielna-ksiegowosc ,
  https://www.infakt.pl/regulamin/adkzk/
- Księgi w programie komputerowym od 2026 i 2027 r. (KAS):
  https://www.gov.pl/web/kas/elektroniczna-dokumentacja-ksiegowa-dla-przedsiebiorcow-placacych-pit-obowiazkowa-od-2026-r
- Specyfikacja interfejsów usług JPK (wysyłka plików, dane autoryzujące):
  https://www.podatki.gov.pl/media/c2sdatex/specyfikacja-interfejs%C3%B3w-us%C5%82ug-jpk-wersja-520.pdf
