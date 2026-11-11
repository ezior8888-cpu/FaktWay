# Źródła prawdy: na czym sprawdzamy poprawność FaktWay

Stan: 8.11.2026. Dla Bartosza i dla sesji, które zmieniają obliczenia (najpierw `zelazny-filtr` i `plan-pelna-aplikacja`). Bartosz 8.11: „zapisz gdzieś to i przeanalizuj, na czym realnie możemy badać poprawność naszej aplikacji, żeby wyniki były zawsze prawdziwe”.

Ten plik jest warstwą „źródła prawdy” planu [`PLAN-ZELAZNY-FILTR.md`](PLAN-ZELAZNY-FILTR.md) (sekcja B4.0). Pierwsza wersja powstała w notatkach sesji planu księgowości; wersja w repo ma poprawki sesji filtra po sprawdzeniu w kodzie i w źródłach (sekcja 8).

## Najkrócej

1. **Kod konkurencji się do tego nie nadaje.** inFakt, Fakturownia, wFirma i IFIRMA mają zamknięty kod. Nawet ich wyniki nie są wzorcem, bo też mogą być błędne.
2. **Żadne jedno źródło nie da wyników „zawsze prawdziwych”.** Daje je łańcuch:
   1. każda liczba ma urzędowe źródło i datę;
   2. każda reguła jest porównana z niezależnym wzorcem;
   3. każdy plik przyjmuje testowy system państwa;
   4. raz sprawdzony wynik zostaje zamrożony w teście;
   5. czujka wyłapuje zmiany przepisów.

   Gdy czegoś nie da się potwierdzić, program nie pokazuje kwoty. Tak już działa moduł księgowości (decyzja D7: bez podpisu księgowej nie ma kwot).
3. **Wzorce od najmocniejszego:**
   1. system państwowy, który sam liczy albo przyjmuje dokument: testowy KSeF, testowa bramka JPK, e-mikrofirma, e-Płatnik;
   2. dokumenty, które prawdziwe firmy już złożyły i urząd przyjął (pilotaż, za zgodą firm);
   3. dwie niezależne księgowe liczące te same przypadki;
   4. urzędowe przykłady z broszur, objaśnień i poradników;
   5. druga, niezależna implementacja;
   6. na samym końcu programy konkurencji, tylko do sprawdzenia kilku przypadków ręcznie.

## 1. Kod konkurencji (sprawdzone 8.11.2026)

- **Fakturownia** publikuje na GitHubie tylko [dokumentację swojego API](https://github.com/fakturownia/api). Nie ma tam kodu programu ani licencji. Dokumentacja opisuje faktury, korekty, zaliczki, paragony i e-paragony oraz KSeF. Nadaje się jako lista kontrolna rodzajów dokumentów i pól, bez kopiowania tekstu. Biblioteki innych autorów do tego API (np. [Python](https://fakturownia-python.readthedocs.io/en/latest/readme.html), [PHP](https://packagist.org/packages/agsystemspl/fakturownia-rest-client)) tylko łączą się z ich serwerem i nie liczą podatków.
- **inFakt:** publicznego repozytorium nie ma.
- **Ministerstwo Finansów** publikuje na GitHubie ([`CIRFMF`](https://github.com/CIRFMF), odczyt API GitHub 8.11.2026):
  - dokumentację i schematy KSeF 2.0 w [`CIRFMF/ksef-api`](https://github.com/CIRFMF/ksef-api) (dawniej `ksef-docs`; stara nazwa działa tylko dzięki przekierowaniu GitHuba), licencja MIT;
  - oficjalne biblioteki `ksef-client-java` i `ksef-client-csharp`, licencja MIT;
  - oficjalny generator wizualizacji faktury `ksef-pdf-generator` (PDF i kody QR), licencja MIT: wzorzec dla naszego PDF;
  - `ksef-schematy` i `ksef-latarnia` bez licencji: tylko do czytania.

  To najlepszy wzorzec dla naszej obsługi KSeF. Kod na licencji MIT wolno kopiować z zachowaniem informacji o licencji i autorze; kodu bez licencji nie kopiujemy.
- **Wolny kod z polskimi podatkami** istnieje, ale jest go mało:
  - wtyczka WordPress [KPiR](https://nn.wordpress.org/plugins/kpir/) (GPLv3, pliki JPK V7M): wolno ją czytać dla porównania, ale nie kopiować. Repozytorium FaktWay jest publiczne, więc skopiowany kod byłby rozpowszechniany i GPLv3 objęłaby cały program; FaktWay nie ma dziś żadnej licencji (GitHub: brak pliku licencji);
  - moduł JPK do [Odoo](https://apps.odoo.com/apps/modules/18.0/l10n_pl_jpk_vat): płatny i zamknięty.
- **Ręczne porównanie z działającym programem:** na 30-dniowej próbie Fakturowni można wpisać kilka tych samych przypadków i porównać wyniki. Automatyczne porównywanie przez ich API wymaga najpierw sprawdzenia ich regulaminu.

## 2. Wzorce według obszaru

| Obszar | Wzorzec (źródło prawdy) | Jak go używamy | Czego nie złapie |
|---|---|---|---|
| Stawki, progi i kwoty roczne: ZUS, zdrowotna, PIT, ryczałt, limity | Dziennik Ustaw i Monitor Polski (ustawy, płaca minimalna, obwieszczenia GUS i MF), tabele składek na zus.pl, limity MF na podatki.gov.pl | Rejestr parametrów: każda liczba z aktem, pozycją i datą odczytu. Test porównuje ją z zapisaną kopią źródła. Księgowa podpisuje sekcje roku (D7) | Pomyłkę przy przepisywaniu złapie test. Nie złapie złego wyboru, która liczba obowiązuje w danym miesiącu: np. minimalna zdrowotna to 314,96 zł za styczeń 2026, a od lutego 432,54 zł |
| Reguły liczenia: zaliczka PIT, zdrowotna od dochodu, ryczałt, odliczenia, przeniesienia | Teksty jednolite ustaw (ISAP), objaśnienia podatkowe MF, przykłady na podatki.gov.pl i zus.pl, kalkulator składki zdrowotnej ZUS | Każdy urzędowy przykład staje się testem. Złote przypadki podpisuje księgowa. Druga księgowa liczy te same przypadki niezależnie. Kalkulatorem ZUS sprawdzamy ręcznie kilka przypadków | Przypadki spoza przykładów; na nie są testy logiczne z sekcji 4 |
| VAT i JPK_V7M | Ustawa o VAT, schemat i broszura JPK_V7M z regułami, [e-mikrofirma](https://podatki.gov.pl/media/kvdfxrjt/podręcznik-użytkownika-aplikacji-e-mikrofirma-kwiecień-2026.pdf) (aplikacja MF, która sama liczy deklarację z ewidencji i wysyła JPK), testowa bramka MF | Schemat XSD (jest). Sumy kontrolne z broszury jako testy. Kilkanaście ewidencji wpisanych do e-mikrofirmy i porównanych pole po polu. Wysyłka na testową bramkę (próba z K6.0 przeszła: status 200 i UPO) | Bramka sprawdza format i część reguł, ale nie to, czy podatek jest słuszny dla danej firmy |
| JPK_EWP i JPK_PKPIR | Schematy i broszury MF, rozporządzenie o KPiR (wzór od 2026) | Schematy XSD (są), przykładowe pliki MF jako testy, księgowa | Tego, co jest kosztem, schemat nie rozstrzygnie |
| Faktury FA(3) i KSeF | Schemat FA(3), dokumentacja KSeF 2.0 (`CIRFMF/ksef-api`), środowisko testowe KSeF, przykładowe faktury MF, oficjalny generator wizualizacji `CIRFMF/ksef-pdf-generator` | Każdy rodzaj faktury (zwykła, korekta, zaliczkowa, końcowa, w walucie, odwrotne obciążenie i kolejne z planu) wysyłany automatycznie na testowy KSeF. Nasz PDF i kody QR porównane z wizualizacją z generatora MF dla tych samych plików XML. Obserwowanie wydań repozytorium CIRFMF | KSeF przyjmie fakturę z błędną stawką, jeśli pasuje do schematu. To łapią reguły i testy |
| Składki ZUS i DRA | Tabele ZUS, e-Płatnik w eZUS (ZUS sam liczy deklarację) | Porównanie kwot z e-Płatnikiem dla każdego etapu: ulga na start, preferencyjny, pełny, z chorobowym i bez | Potrzebne konto płatnika, więc robi to człowiek przy każdym nowym roku |
| Kursy walut | API NBP (tabela A) i reguła z ustaw: kurs z ostatniego dnia roboczego przed powstaniem obowiązku podatkowego (VAT, art. 31a ust. 1) albo przed dniem przychodu lub poniesienia kosztu (PIT, art. 11a ust. 1 i 2) | Testy na archiwalnych tabelach NBP, z dniami wolnymi i przełomem roku | Wyboru dnia zdarzenia (data sprzedaży, wystawienia, zapłaty), który przepis każe wziąć; to reguła w rejestrze przepisów |
| Terminy i dni wolne | Ustawa o dniach wolnych od pracy (Wigilia wolna od 2025 r.), Ordynacja podatkowa art. 12 § 5 (termin w sobotę albo dzień wolny przechodzi na następny dzień roboczy), terminy z ustaw (20., 25.) | Kalendarz sprawdzany testem na lata 2025-2028, ze świętami ruchomymi | Nowy dzień wolny wprowadzony ustawą; łapie go czujka z sekcji 5 |
| Zaokrąglenia | Ordynacja podatkowa art. 63 (podstawa i podatek do pełnych złotych), zasady z ustawy o VAT | Niezmienniki w testach (sekcja 4) | Nic istotnego |
| Dane kontrahentów | GUS REGON (BIR), biała lista VAT MF (API), VIES (UE) | Przy fakturach i kosztach; GUS już podłączony | Nic istotnego |
| Mikrorachunek podatkowy | Generator MF na podatki.gov.pl | Wektor testowy z generatora (jest od K1) | Nic istotnego |

## 3. Prawdziwe dane: najmocniejszy test (pilotaż)

- **Za zgodą firm pilotażowych** bierzemy ich ostatnie 12 miesięcy faktur i kosztów oraz to, co ich księgowa naprawdę złożyła i co urząd przyjął (JPK_V7 z UPO, DRA, wpłaty PIT i składek). FaktWay przelicza to samo i porównujemy wynik co do grosza. Każda różnica to albo nasz błąd, albo inna decyzja księgowej. Rozstrzyga księgowa z bramy B4.
- **Prawdziwe dane zostają na produkcji w UE.** Do testów w repo trafiają tylko zanonimizowane, z fikcyjnym NIP `1234567890` (zasada z `AGENTS.md`).
- **Zgoda na piśmie i podstawa prawna.** Porównanie na danych firmy pilotażowej wymaga jej pisemnej zgody i zapisu w umowie powierzenia; zakres i okres przechowywania tych danych rozstrzyga prawnik (pytanie 6 w `docs/ksiegowosc/PYTANIA-DO-PRAWNIKA.md`, brama B2).
- **Po starcie kontrola trwa co miesiąc:**
  - wynik FaktWay porównujemy z tym, co urząd i ZUS przyjęli (UPO, stan konta w PUE ZUS);
  - przez pierwsze dwa miesiące sprawdza to księgowa (B6);
  - potem automat z alarmem przy różnicy.

## 4. Logika, gdy nie ma wzorca

- **Niezmienniki,** czyli reguły, które zawsze muszą się zgadzać, sprawdzane na tysiącach losowych przypadków:
  - dodanie kosztu nigdy nie podnosi podatku;
  - kolejność wpisów nie zmienia wyniku;
  - suma miesięcy równa się wynikowi narastająco;
  - ta sama zapłata zapisana dwa razy nie daje podwójnego odliczenia;
  - kwoty liczone są w całych groszach;
  - zaokrąglenia są według ustawy.
- **Druga, niezależna implementacja.** Inna sesja pisze uproszczone liczenie wprost z tekstu ustaw, bez zaglądania do naszego kodu. Porównujemy oba na tysiącach wygenerowanych przypadków. To łapie błędy programistyczne. Nie łapie przepisu źle zrozumianego przez obie strony, dlatego obok zostają księgowa i urzędowe przykłady.
- **Testy na prawdziwej bazie** dla uprawnień, przejść statusów i wyzwalaczy (zasada z protokołu w `AGENTS.md`).

## 5. Czujka na zmiany: żeby wynik był prawdziwy także jutro

- **Przepisy:**
  - [ELI API Sejmu](https://api.sejm.gov.pl/eli_pl.html) podaje w formie dla programów nowe pozycje Dziennika Ustaw i Monitora Polskiego (odczyt dokumentacji 8.11.2026): `GET https://api.sejm.gov.pl/eli/changes/acts?since=RRRR-MM-DDTGG:MM:SS` zwraca akty zmienione od podanej chwili, a `GET https://api.sejm.gov.pl/eli/acts/search` filtruje po wydawcy (`publisher=DU` albo `MP`), roku, typie, tytule, datach (`dateFrom`, `dateTo`, `pubDateFrom`, `dateEffectFrom`) i słowach kluczowych (`keyword`); pojedynczy akt to `/eli/acts/{DU|MP}/{rok}/{pozycja}`;
  - automat codziennie filtruje akty, które nas dotyczą: ustawy o VAT, o PIT, o ryczałcie, o systemie ubezpieczeń społecznych, o świadczeniach zdrowotnych, Ordynację podatkową i ustawę o dniach wolnych, rozporządzenia o KPiR, JPK i płacy minimalnej;
  - każde trafienie to zgłoszenie do przeglądu.
- **Kalendarz publikacji parametrów** (przypomnienie, a do czasu sprawdzenia blokada kwot na nowy rok):
  - płaca minimalna: wrzesień;
  - prognozowane przeciętne wynagrodzenie: ustawa budżetowa;
  - przeciętne wynagrodzenie za IV kwartał (GUS): styczeń;
  - limity w euro: kurs z października;
  - tabele ZUS: grudzień;
  - stopa składki wypadkowej: zmiana od 1 kwietnia;
  - limit odliczenia zdrowotnej przy podatku liniowym: komunikat MF zwykle w grudniu albo w styczniu;
  - odsetki za opóźnienie w transakcjach handlowych (wezwania do zapłaty): obwieszczenie MF na każde półrocze;
  - certyfikat klucza publicznego testowej bramki JPK: ważny do 7.07.2027.
- **Schematy i API:**
  - strony MF ze schematami JPK i FA;
  - wydania repozytorium `CIRFMF/ksef-api` (dawniej `ksef-docs`) obserwowane przez GitHub.
- **Rok bez sprawdzonych parametrów** to brak kwot, z komunikatem i wyjściem (zasada blokady z wyjściem).

## 6. Czego nie da się zagwarantować

- **Interpretacji,** np. czy wydatek jest kosztem. Decyduje klient, a program nie doradza (D8).
- **Błędnych danych klienta,** np. źle wybranej stawki ryczałtu. Program pokazuje, skąd wziął wynik.
- **Przepisów zmienionych w trakcie roku.** Pomaga czujka i szybka aktualizacja.
- **Ostatnie słowo** mają prawnik (B2) i księgowa (B4), a po starcie kontrola na prawdziwych danych.

## 7. Co z tego wchodzi do żelaznego filtra

| Warstwa filtra | Z tej analizy |
|---|---|
| Rejestr źródeł | Każda liczba i reguła z aktem, pozycją, datą obowiązywania i datą odczytu (sekcja 2) |
| Testy z urzędowych przykładów | Broszury, objaśnienia i przykłady ZUS jako testy, które muszą przechodzić |
| Systemy państwowe | Testowy KSeF i testowa bramka JPK w automacie, np. co noc i przed wydaniem. e-mikrofirma i e-Płatnik jako ręczna lista kontrolna przed każdym nowym rokiem i każdą zmianą obliczeń |
| Logika | Niezmienniki, losowe przypadki, druga implementacja (sekcja 4) |
| Ludzie | Złote przypadki podpisane przez dwie niezależne księgowe |
| Prawdziwe dane | Porównanie na danych pilotażu, potem co miesiąc (sekcja 3) |
| Czujka | ELI API, kalendarz parametrów, schematy i KSeF (sekcja 5) |

**Już mamy:**
- walidację XSD dla FA(3), JPK_V7M, JPK_FA, JPK_EWP i JPK_PKPIR;
- próbną wysyłkę JPK_V7M na testową bramkę MF ze statusem 200 i UPO;
- cotygodniową wysyłkę na KSeF TEST i czujkę schematu FA(3);
- parametry 2026 i 2027 ze źródłami;
- szkielet złotych przypadków G1-G14 (13 plików, G13 jeszcze bez pliku, wszystkie bez podpisu);
- wektor mikrorachunku z generatora MF;
- klienta NBP i GUS.

## 8. Poprawki w wersji w repo (sesja `zelazny-filtr`, 8.11.2026)

Sprawdzone w kodzie i w źródłach przed dodaniem pliku do repo:

1. Repozytorium dokumentacji KSeF MF nazywa się dziś `CIRFMF/ksef-api`; `ksef-docs` to stara nazwa, która działa przez przekierowanie GitHuba. Nasza czujka schematu FA(3) wciąż pyta starą nazwę (`scripts/ci/czujka-schematu-fa3.mjs:38`), co plan filtra zapisuje jako sygnał S-16.
2. Licencje repozytoriów MF sprawdzone przez API GitHub (MIT dla `ksef-api`, `ksef-client-java`, `ksef-client-csharp`, `ksef-pdf-generator`; `ksef-schematy` i `ksef-latarnia` bez licencji) zamiast opisu z serwisu firmy trzeciej; dopisany oficjalny generator wizualizacji PDF jako wzorzec dla naszego PDF.
3. Powód zakazu kopiowania kodu GPLv3 doprecyzowany: repozytorium FaktWay jest publiczne, więc kopia byłaby rozpowszechniana.
4. Przy ELI API dopisane konkretne adresy (`/eli/changes/acts`, `/eli/acts/search`) z dokumentacji Sejmu.
5. Kalendarz ogłoszeń uzupełniony o stopę wypadkową, limit odliczenia zdrowotnej przy liniowym, odsetki w transakcjach handlowych i ważność certyfikatu testowej bramki JPK.
6. Kursy walut: dopisana reguła dla kosztów (art. 11a ust. 2 ustawy o PIT) i to, czego wzorzec nie złapie (wybór dnia zdarzenia).
7. Prawdziwe dane pilotażu: dopisana pisemna zgoda firmy i pytanie do prawnika.
8. „Już mamy”: dopisane XSD JPK_FA, KSeF TEST co tydzień i czujka FA(3); stan złotych przypadków.

Bez zmian, bo zgadzają się z kodem: przykład minimalnej zdrowotnej (432,54 zł od lutego 2026 jest w `lib/ksiegowosc/parametry/2026.ts`, a styczeń 2026 należy jeszcze do roku składkowego 2025, którego parametrów moduł nie ma), próba K6.0 (status 200 i UPO), wektor mikrorachunku.
