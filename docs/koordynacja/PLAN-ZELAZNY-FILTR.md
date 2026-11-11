# Plan: żelazny filtr zmian z ryzykiem prawnym

> **„Kontynuuj plan żelazny filtr”**: sesja czyta ten plik od góry, robi
> checklistę startową (B0) i pracuje od wiersza „Następny krok” w dzienniku
> (B12). Jeden krok to jedna gałąź `claude/filtr-fN-<temat>` od `origin/main`
> i jeden PR. Po kroku: wiersz w dzienniku, nowy „Następny krok”, raport
> (status, tabela weryfikacji, numer PR, co dalej) i STOP.
>
> **Stan 8.11.2026, 23:10: plan przyjęty, ETAP 2 w toku.** Bartosz napisał
> „idź dalej” na pytanie o plan i rekomendacje D-F1 do D-F10, więc
> rekomendacje z A11 obowiązują jako decyzje (zmiana tylko jego słowem).
> W nocy 8/9.11 kroki idą stosem PR: każdy krok ma bazę w gałęzi poprzedniego
> (pierwszy w #486), bo nic nie jest scalane bez Bartosza. Scalanie całego
> stosu: `scripts/ops/zloz-scalenie.sh` w kolejności z dziennika (B12).
> Reguły filtra działają dopiero po scaleniu danego kroku do `main`.

Zlecenie Bartosza z 8.11.2026: „zanim cokolwiek zbudujesz zrób ŻELAZNY system
walidacji każdej zmiany, który będzie się zachowywał jak jakiś filtr z wiedzą
prawną i logiczną, ma dotyczyć każdej sesji na moim Macu jak i na komputerach
każdej osoby, która pracuje nad FaktWay. Każda nowa zmiana (i poprzednie,
z planu księgowości) dotycząca funkcji, które mogą wiązać się z ryzykiem
prawnym, jeśli program źle je wyliczy, ma przejść przez ten filtr i na prawie
100% być poprawna (na końcu weryfikacja prawna, więc się nie martw)”.

Odczyt stanu: `origin/main` @ `279e2b4c` (8.11.2026, po #479 i #480), reguły
repozytorium odczytane przez API GitHub tego samego dnia.

Plan ma dwie części. **Część A** jest dla osoby nietechnicznej: co powstanie,
po co, co zmieni się w pracy i co trzeba zrobić samemu. **Część B** jest dla
sesji, które będą to budować: pliki, reguły, kontrole, kolejność.

---

# Część A. Prostym językiem

## A1. O co chodzi

FaktWay liczy rzeczy, za które klient odpowiada przed urzędem: VAT na
fakturze, ryczałt i zaliczki na podatek, składki ZUS i zdrowotną, terminy,
pliki JPK dla Ministerstwa Finansów, faktury w KSeF. Błąd w takim miejscu to
nie brzydki ekran, tylko zła deklaracja, odsetki albo kara dla klienta, a dla
nas roszczenie.

**Filtr** to zestaw automatycznych kontroli, przez które musi przejść każda
zmiana w kodzie, zanim trafi do gałęzi `main`, z której powstaje produkcja.
Działa jak celnik z wiedzą prawną:

1. najpierw sprawdza, czy zmiana dotyka „towaru wysokiego ryzyka”
   (pieniądze, podatki, terminy, dokumenty dla urzędu i kontrahenta,
   przechowywanie danych);
2. jeśli tak, żąda dowodów, że wynik zgadza się z przepisami, i to z kilku
   niezależnych źródeł naraz;
3. bez kompletu dowodów zmiana nie przejdzie, bez względu na to, kto ją
   napisał: Claude na Twoim Macu, Codex u Igora, agent na GitHubie czy
   człowiek.

## A2. Dlaczego to, co mamy, nie wystarcza

Mamy dużo testów (ok. 14,5 tys. w ok. 820 plikach) i 9 wymaganych kontroli
na GitHubie. To dużo, ale:

1. **Zielone testy już raz zawiodły.** Rewizja z 3.10.2026 znalazła ok. 45
   błędów w 350 poprawkach, które przeszły wszystkie testy. Testy sprawdzały
   to, co pomyślał autor, a nie to, co mówi przepis.
2. **Test i kod pisze ten sam autor.** Jeśli agent źle zrozumie przepis,
   napisze zły kod i test, który ten zły kod potwierdza. Oba będą zielone.
3. **Przykłady księgowej (G1-G14) jeszcze niczego nie sprawdzają.** Czekają
   na jej podpis (brama B4, na samym końcu), więc test je pomija. G13 nie ma
   jeszcze nawet pliku.
4. **Strażnik obszarów wrażliwych pilnuje tylko agenta z GitHuba.** Sesje
   Claude na Twoim Macu i Codex u Igora są dla niego „ludźmi”, więc ich
   zmian nie zatrzymuje. Moduł księgowości nie jest nawet na liście obszarów
   wrażliwych.
5. **Testy bazy (RLS) nie blokują scalenia.** Chodzą przy każdym PR, ale
   czerwony wynik nie zatrzymuje przycisku „Merge”.
6. **Kontrolę przed wysłaniem kodu można pominąć** jednym słowem
   (`SKIP_PREPUSH=1` albo `--no-verify`), a na komputerze, na którym nikt nie
   uruchomił skryptu przygotowania, w ogóle jej nie ma.
7. **Sesje Claude na Twoim Macu działają na Twoim koncie GitHub z prawami
   administratora.** Technicznie mogą zrobić wszystko, co Ty: nadać zgodę,
   scalić, zmienić reguły repozytorium. Dziś chroni przed tym tylko
   instrukcja w `AGENTS.md`.
8. **Wiedza prawna jest rozsiana:** część w planie księgowości, część
   w komentarzach w kodzie, część w testach. Nie ma jednego spisu „ten
   przepis, ten kod, ten test”, więc nie da się sprawdzić, czy każdy przepis
   ma test.
9. **Te same reguły są liczone w kilku miejscach na różne sposoby.** Przykład
   z kodu: dwie funkcje zaokrąglające do pełnych złotych dają dla −1,50 zł
   różne wyniki (−1 zł i −2 zł). Faktury liczą kwoty w złotych z ułamkami,
   a silniki księgowości w groszach.

## A3. Jak filtr będzie działał: cztery pytania przy każdej zmianie

**Pytanie 1. Czy to towar wysokiego ryzyka?** Filtr ma **mapę obszarów**
(A4). Każdy plik kodu jest na mapie z poziomem ryzyka. Nowy plik w znanym
katalogu dziedziczy poziom. Nowy plik gdzie indziej, w którym pojawiają się
słowa typu „VAT”, „składka”, „termin”, „kurs”, zostaje zatrzymany, dopóki ktoś
nie wpisze go na mapę. Nic nie przejdzie bokiem.

**Pytanie 2. Na jakim przepisie to stoi?** Filtr ma **rejestr przepisów**.
Każda reguła liczenia ma artykuł, źródło urzędowe, datę obowiązywania,
pewność i pole „kto sprawdził” (księgowa, prawnik). Reguła wskazuje kod, który
ją liczy, i testy, które jej pilnują. Kod w obszarze ryzyka bez reguły
w rejestrze i reguła bez testu to błąd filtra.

**Pytanie 3. Jakie są dowody, że wynik jest dobry?** Nie jeden test, tylko
kilka niezależnych sprawdzeń:

- **zasady zawsze prawdziwe** (niezmienniki), np. dodanie kosztu nigdy nie
  podnosi podatku, termin nigdy nie wypada w niedzielę ani w święto, suma pól
  JPK zgadza się z ewidencją, podatek jest w pełnych złotych, a składka
  w groszach; sprawdzane na tysiącach losowych przykładów;
- **przykłady policzone ręcznie**: przez księgową (G1-G14 i kolejne) i przykłady
  z publikacji urzędowych (tabele ZUS, broszury MF, przykładowe pliki MF);
- **druga, niezależna wersja obliczeń** (wyrocznia): napisana przez inną
  sesję prosto z tekstu ustawy, bez dostępu do kodu aplikacji; obie wersje
  muszą dać ten sam wynik co do grosza na każdym losowym przykładzie;
- **oficjalne schematy plików MF** (XSD): każdy plik, który program
  tworzy, musi przejść schemat, także dla losowych danych;
- **środowiska testowe MF i KSeF**: co tydzień prawdziwa wysyłka danych
  fikcyjnych;
- **drugi czytelnik z prawną listą kontrolną**: osobna sesja przegląda
  zmianę według stałej listy pytań (zaokrąglenia, granice miesiąca i roku,
  waluty, korekty, zaliczki, brak danych, treści bez porad, dane osobowe).

**Skąd filtr wie, co jest prawdą.** Kod konkurencji jest zamknięty, a ich
wyniki też mogą być błędne, więc nie są wzorcem. Wzorce mają kolejność, od
najmocniejszego (szczegóły w [`ZRODLA-PRAWDY.md`](ZRODLA-PRAWDY.md)):

1. systemy państwowe, które same liczą albo przyjmują dokument: testowy KSeF,
   testowa bramka JPK, aplikacja MF e-mikrofirma (liczy deklarację VAT
   z ewidencji), e-Płatnik w eZUS (liczy składki);
2. dokumenty, które prawdziwe firmy już złożyły, a urząd przyjął (pilotaż, za
   pisemną zgodą firm);
3. dwie niezależne księgowe liczące te same przypadki;
4. przykłady urzędowe z broszur, objaśnień i poradników;
5. druga, niezależna wersja obliczeń;
6. na końcu programy konkurencji, tylko do ręcznego sprawdzenia kilku
   przypadków.

Czego nie da się potwierdzić żadnym wzorcem, tego program nie pokazuje jako
kwoty (jak dziś w module księgowości: bez podpisu księgowej nie ma kwot).

**Pytanie 4. Czy ktoś zmienia samą wiedzę albo sam filtr?** Najprostszy
sposób na zielony test to zmienić oczekiwany wynik. Dlatego każda zmiana
oczekiwanych kwot, przepisów, parametrów, schematów albo samego filtra wymaga
**Twojej zgody** (etykieta na PR) i podanego źródła. Zgoda wygasa przy każdej
kolejnej zmianie w PR, więc dotyczy dokładnie tego, co widziałeś.

Zasada ogólna: **zaostrzyć filtr wolno każdemu** (nowa reguła, nowy test, nowy
plik na mapie), **osłabić tylko za Twoją zgodą**.

## A4. Mapa obszarów ryzyka (skrót)

Poziomy:

- **R1, krytyczny:** zły wynik zmienia kwotę podatku albo składki, termin,
  dokument dla urzędu albo kontrahenta (faktura, JPK, KSeF) albo
  przechowywanie danych.
- **R2, wprowadza w błąd:** zły wynik nie jest dokumentem, ale może skłonić
  klienta do złej decyzji o pieniądzach (szacunki, pulpit, przypomnienia,
  teksty o podatkach, regulamin).
- **R3, pomocniczy:** kod, z którego korzystają R1 i R2 (daty, strefa
  czasowa, formatowanie kwot, odczyt danych stronami).
- **R0:** bez ryzyka prawnego (wygląd, logowanie, analityka).

| Obszar | Co może pójść źle | Poziom |
|---|---|---|
| Silniki księgowości: ryczałt, zaliczki PIT, ZUS, zdrowotna, VAT do zapłaty | zła kwota do zapłaty | R1 |
| Parametry roku: stawki, progi, limity, kwoty ZUS | zła liczba u wszystkich klientów naraz | R1 |
| Terminy, kalendarz świąt, przypomnienia o terminach | termin po czasie, odsetki | R1 |
| Mikrorachunek i dane do przelewu | przelew na zły rachunek | R1 |
| Ewidencja przychodów, KPiR, spis z natury | zła księga, zły podatek | R1 |
| Pliki JPK (V7M, EWP, PKPIR, FA) i wysyłka do MF | zła deklaracja w urzędzie | R1 |
| Rozliczenia miesiąca: zatwierdzenie, wersje, zapłaty | zmieniona zatwierdzona kwota, podwójne odliczenie | R1 |
| Wyłącznik modułu i podpis księgowej pod parametrami | niesprawdzone kwoty u klienta | R1 |
| Faktury FA(3): kwoty, stawki, zaokrąglenia, adnotacje, daty, numeracja | zła faktura u kontrahenta i w KSeF | R1 |
| Wysyłka do KSeF, duplikaty, tryb offline, UPO | faktura niewysłana, wysłana dwa razy, po terminie | R1 |
| Korekty i zaliczki (KOR, ZAL, ROZ) | zła różnica, podwójny przychód | R1 |
| Waluty i kursy NBP | zły kurs, zły VAT w złotych | R1 |
| Koszty: kategoryzacja, kolumna KPiR, odliczenie VAT, OCR paragonów | koszt w złym miejscu albo dwa razy | R1 |
| Import faktur z innych programów i z KSeF | zła kwota trafia do ksiąg | R1 |
| PDF faktury i kody QR | dokument dla kontrahenta niezgodny z KSeF | R1 |
| Faktury FaktWay za abonament i zwroty | nasz własny błąd w VAT | R1 |
| Wezwania do zapłaty, odsetki, rekompensata | zła kwota żądana od dłużnika | R1 |
| Przechowywanie i usuwanie danych (faktury, UPO, księgi, kopie, RODO) | dokumenty usunięte przed czasem | R1 |
| Funkcje i wyzwalacze w bazie, które liczą, numerują albo blokują zmiany | dane zmienione obok kodu | R1 albo R3 |
| Szacunki: „Odłóż na podatek”, pulpit, limit zwolnienia z VAT | zła decyzja klienta o pieniądzach | R2 |
| Przypomnienia o płatnościach faktur (push, mail) | zły dług albo termin w wiadomości | R2 |
| Treści o podatkach: ekrany modułu, maile, FLO, pomoc, strona, reklama | porada podatkowa (decyzja D8) | R2 |
| Regulamin, polityka prywatności, umowa powierzenia | zła umowa z klientem | R2 |
| Eksporty dla księgowych (CSV, Optima, Excel KPiR) | złe dane w innym programie | R2 |
| Daty, strefa Warszawy, formatowanie kwot, odczyt stronami | błąd przenosi się do R1 i R2 | R3 |

Pełna mapa z katalogami, plikami i testami jest w B2. Krótką wersję dostaje
sesja planu pełnej aplikacji, żeby każdą nową funkcję oznaczyć poziomem od
początku.

## A5. Gdzie filtr działa i jak dosięga każdego komputera

Filtr ma cztery warstwy. Trzy pierwsze to szybkie ostrzeżenie na komputerze
autora, czwarta to blokada, której nie da się ominąć.

1. **Instrukcje dla agentów** w `AGENTS.md`. Czytają je Claude (przez
   `CLAUDE.md`), Codex u Igora (sam z siebie) i agent na GitHubie. Mówią, co
   to obszar ryzyka i jakie dowody są wymagane.
2. **Sesje Claude Code**, na każdym komputerze, bo ustawienia są
   w repozytorium (`.claude/settings.json`): przy edycji pliku z mapy sesja
   dostaje od razu przypomnienie, jaki to obszar i jakie przepisy, plus szybkie
   kontrole tego pliku; próba pominięcia kontroli albo nadania zgody za Ciebie
   jest zatrzymywana; skill `/filtr` prowadzi przez listę kontrolną.
3. **Kontrola przed wysłaniem kodu** (git pre-push). Włącza się sama przy
   `pnpm install` na każdym komputerze, także u Igora i u pozostałych osób
   z dostępem. Uruchamia testy prawne obszarów, których dotyczy zmiana.
4. **GitHub: wymagane kontrole przy chronionym `main`.** To jedyna warstwa,
   której nie da się ominąć z żadnego komputera: bez zielonych kontroli
   przycisk „Merge” jest nieaktywny dla każdego, także dla Ciebie, bo lista
   wyjątków w regule repozytorium jest pusta. Dochodzą dwie nowe kontrole:
   **„Filtr: straż”** (mapa, zgody, karta zmiany) i **„Filtr: testy prawne”**
   (niezmienniki, wyrocznia, przykłady, schematy). Testy bazy (RLS) stają
   się wymagane.

Wszystko, co ważne, sprawdza warstwa 4. Warstwy 1-3 robią to samo wcześniej,
żeby nie czekać na GitHuba i żeby sesja poprawiła błąd od razu.

**Słaby punkt i jak go zamknąć:** sesje na Twoim Macu działają na Twoim
koncie administratora. Filtr zatrzyma hakami próby nadania zgody za Ciebie,
ale pełną pewność daje **osobne konto GitHub dla agentów** (bez praw
administratora): wtedy zgodę i akceptację PR możesz dać tylko Ty, z przeglądarki
albo aplikacji GitHub na telefonie. Decyzja D-F3.

## A6. Co się dzieje, gdy filtr coś złapie

- **Komunikat po polsku:** co jest nie tak, który przepis z rejestru, który
  plik, przykład danych, na których wynik jest zły, co zrobić i kto może
  zrobić wyjątek.
- **Kto naprawia:** autor zmiany (sesja Claude albo Codex) według protokołu
  naprawy błędu z `AGENTS.md`: przykład danych z komunikatu staje się
  czerwonym testem, naprawa przyczyny we wszystkich miejscach, nowy push.
- **Gdy myli się filtr:** poprawka filtra idzie osobnym PR za Twoją zgodą,
  nigdy w tym samym PR co zmiana, którą filtr zatrzymał.
- **Wyjątek:** tylko Twoją etykietą, z uzasadnieniem w opisie PR, zapisany
  w dzienniku wyjątków. Wyjątek może zwolnić z wymogu formalnego (np. karta
  zmiany przy pilnej poprawce), **nigdy z czerwonego testu prawnego**.
- **Awaria filtra:** w ostateczności wyłączasz wymaganą kontrolę w ustawieniach
  GitHuba (runbook opisze to w 5 krokach), a po włączeniu filtr sprawdza
  wstecz wszystko, co przeszło bez niego.
- **W działającej aplikacji:** ostatnia linia obrony. Jeśli kwota albo plik
  nie przejdzie kontroli spójności tuż przed pokazaniem, pobraniem albo
  wysyłką, klient zobaczy komunikat zamiast złej kwoty, a operator dostanie
  alarm.

## A7. Przegląd wsteczny: to, co już zbudowane

Plan księgowości (K0-K8) jest w `main` i na produkcji za wyłącznikiem. Filtr
przejdzie go cały, obszar po obszarze, tak jakby każdy plik był nową zmianą:

1. spisze każdą regułę z planu (sekcje 4, 5 i 13) do rejestru przepisów
   i sprawdzi, czy ma kod i test;
2. puści na każdy silnik niezmienniki, losowe przykłady i porównanie
   z wyrocznią;
3. porówna wyniki z przykładami urzędowymi;
4. osobne sesje przejrzą kod z listą kontrolną.

Każde znalezisko to osobny wpis (FZ-01, FZ-02 i dalej) z plikiem, linią,
przykładem danych i wagą. **Sesje przeglądu niczego nie naprawiają.** Naprawy
idą według protokołu: najpierw czerwony test, jedna naprawa w jednym PR.
Kolejność: najpierw to, co zmienia kwotę albo termin. Ten sam przegląd
obejmie obszary, które działają dla wszystkich firm już dziś: faktury FA(3),
korekty, zaliczki, waluty, eksporty, pulpit, wezwania do zapłaty, abonament.

**Rozpoznanie do tego planu już coś znalazło.** Przegląd kodu pod mapę
wskazał 16 miejsc, które wyglądają na błędy albo na sprawy dla prawnika
(lista S-01 do S-16 w B7.1). Najpoważniejsze: korekta „przed/po” trafiłaby do
JPK_V7M całą kwotą zamiast różnicy; JPK_V7M nie ma oznaczeń GTU; plik KPiR dla
księgowej liczy inaczej niż ekran KPiR; import z CSV potrafi źle odczytać
kwotę. Żaden z nich nie dotknął jeszcze klienta (klientów nie ma, korekty
i wysyłka JPK są wstrzymane), ale dokładnie takie rzeczy filtr ma łapać
zawczasu.

## A8. Czego filtr nie da, uczciwie

1. **Filtr sprawdza zgodność kodu z tym, jak zapisaliśmy przepisy.** Jeśli
   przepis źle zrozumiemy w rejestrze, kod i testy mogą zgodnie dać zły
   wynik. Dlatego: wyrocznia pisana z tekstu ustawy, a nie z naszego
   streszczenia; przykłady księgowej liczone niezależnie od programu; podpis
   księgowej i prawnika w rejestrze (B2 i B4 z bramy); pilotaż z kontrolą
   księgowej (B6).
2. **Przepisy i interpretacje się zmieniają, a filtr sam o tym nie wie.**
   Dlatego: daty obowiązywania w rejestrze; czujka nowych aktów w Dzienniku
   Ustaw i Monitorze Polskim (ELI API Sejmu), czujki zmian na stronach
   urzędowych i w schematach MF; kalendarz ogłoszeń (GUS w styczniu, ZUS pod
   koniec roku, płaca minimalna we wrześniu, stopa wypadkowa w kwietniu,
   stopy NBP dla odsetek); bezpiecznik roku; zasada „bez sprawdzonych
   parametrów nie ma kwoty”.
3. **Sprawy niejednoznaczne rozstrzyga księgowa albo prawnik, nie filtr**
   (np. próg zdrowotnej w styczniu, zaliczki w ewidencji). Rejestr zapisuje
   pytanie, odpowiedź, kto i kiedy rozstrzygnął. Do rozstrzygnięcia program
   pokazuje brak, a nie zgadnięty wynik.
4. **Dane od klienta.** Jeśli klient wybierze złą stawkę ryczałtu albo nie
   wpisze kosztu, filtr tego nie naprawi. Dlatego każda kwota ma podpis
   „według Twoich danych”.
5. **Testy zmniejszają szansę błędu, ale nie dowodzą jego braku.** „Prawie
   100%” mierzymy dwiema metodami: **testy mutacyjne** (program celowo psuje
   kod setkami drobnych zmian, np. „+” na „−” albo „≥” na „>”, i sprawdza,
   czy filtr każdą złapie) i **próba ogniowa** (wracamy do prawdziwych błędów
   z historii repozytorium i sprawdzamy, czy filtr by je zatrzymał, nawet bez
   testów dopisanych przy ich naprawie).
6. **Filtr chroni przed pomyłką, nie przed celowym obejściem** przez kogoś
   z prawami administratora. Dlatego osobne konto dla agentów (D-F3).
7. **Ostateczną weryfikację robią prawnik i księgowa** z bramy B2 i B4. Filtr
   przygotuje dla nich gotowy materiał: rejestr przepisów z listą pytań,
   przykłady do policzenia, listę słów w treściach dla klienta.
8. **Ryzyko, które zostanie,** pokrywają polisa OC (B3) i regulamin (B5).

## A9. Co musisz zrobić sam

1. Przeczytać plan i napisać „idź dalej” albo poprawki.
2. Podjąć decyzje z A11 (można jednym zdaniem: „przyjmij rekomendacje”).
3. Po scaleniu kroku F2 i F5: dodać nowe kontrole do wymaganych w ustawieniach
   GitHuba (krok po kroku w B5.4, ok. 5 minut).
4. Nadawać zgody (etykiety) na PR-y, które zmieniają wiedzę prawną albo sam
   filtr, po przeczytaniu źródła w opisie PR. Sesja poprosi o to w raporcie.
5. Zalecane: założyć osobne konto GitHub dla agentów (B5.5, ok. 15 minut).
6. Przekazać Igorowi i pozostałym osobom z dostępem (`bielczyk17`,
   `bobbykrysinski-del`): po scaleniu kroku F3 raz `pnpm install` w repo.
7. Na końcu, przy bramie B2 i B4: przekazać prawnikowi i księgowej materiał
   z filtra; jeśli przyjmiesz D-F10, znaleźć drugą księgową do niezależnego
   policzenia części przykładów.
8. Raz przed każdym nowym rokiem parametrów (albo zlecić to księgowej):
   porównać kilka przypadków w e-mikrofirmie (VAT) i w e-Płatniku (ZUS)
   według listy kontrolnej z runbooka filtra. Te systemy nie mają API, więc
   tego nie zrobi automat.

## A10. Kolejność budowy w skrócie

Rozmiary: N mały (jedna sesja, kilka plików), Ś średni, D duży (może iść
w kilku sesjach). Szczegóły w B9.

| Faza | Krok | Co powstaje | Rozmiar | Co zyskujesz |
|---|---|---|---|---|
| I. Bramka | F1 | mapa ryzyka i klasyfikator plików | Ś | wiadomo, które zmiany są ryzykowne; nowe pliki nie przechodzą bokiem |
| I. Bramka | F2 | „Filtr: straż” na GitHubie i karta zmiany w PR | Ś | od tej chwili każda zmiana z ryzykiem wymaga dowodów, a zmiana wiedzy Twojej zgody |
| I. Bramka | F3 | warstwy lokalne: hooki Claude, skill `/filtr`, pre-push na każdym komputerze, sekcja w `AGENTS.md` | Ś | sesje poprawiają błędy od razu, Codex i inni dostają te same reguły |
| II. Wiedza | F4 | rejestr przepisów: księgowość JDG | D | jeden spis „przepis, kod, test” dla modułu |
| II. Wiedza | F5 | niezmienniki i testy na losowych danych, „Filtr: testy prawne” | D | tysiące przykładów na każdą zmianę |
| II. Wiedza | F6 | wyrocznia dla silników księgowości | D | druga, niezależna wersja obliczeń |
| II. Wiedza | F7 | reguły statyczne z zapadką | Ś | zakaz ręcznych zaokrągleń, stawek w kodzie, porad w tekstach |
| II. Wiedza | F8 | przykłady urzędowe i złote pliki | Ś | wyniki zgodne z publikacjami ZUS i MF; każda zmiana pliku widoczna |
| II. Wiedza | F9 | schematy XSD dla losowych danych, przykłady MF, czujka JPK | Ś | żaden plik nie wyjdzie niezgodny ze schematem |
| II. Wiedza | F10 | rejestr, niezmienniki i wyrocznia dla faktur, KSeF, JPK, walut, odsetek, retencji | D | to samo dla funkcji, które działają dziś dla wszystkich |
| III. Przegląd wsteczny | F11 | przegląd K0-K8 (8 obszarów) | D | lista znalezisk FZ z wagą; naprawy osobnymi PR |
| III. Przegląd wsteczny | F12 | przegląd obszarów działających dla wszystkich | D | jak wyżej |
| IV. Czujki i bezpieczniki | F13 | strażnicy w działającej aplikacji | Ś | zła kwota nie dojdzie do klienta nawet przy błędzie |
| IV. Czujki i bezpieczniki | F14 | co tydzień środowiska testowe MF i KSeF; ręczne porównanie z e-mikrofirmą i e-Płatnikiem raz w roku | Ś | wiadomo, że urząd przyjmuje nasze pliki, a państwowe systemy liczą tak samo |
| IV. Czujki i bezpieczniki | F15 | czujka przepisów i kalendarz ogłoszeń | N | zmiana przepisu nie przejdzie niezauważona |
| V. Miara | F16 | testy mutacyjne i próba ogniowa | Ś | liczba, ile błędów filtr łapie |
| V. Miara | F17 | (opcjonalnie) przegląd agenta w CI | Ś | drugi czytelnik także dla zmian spoza Maca |
| poza kolejką | F18 | osobne konto agentów (robisz Ty, sesja pomaga) | N | zgodę możesz dać tylko Ty |

**Nowe funkcje w trakcie budowy** (D-F1): funkcje bez ryzyka (R0, R3) mogą
iść po fazie I; funkcje R1 i R2 dopiero, gdy faza II obejmie ich obszar.

## A11. Decyzje do podjęcia

| # | Decyzja | Rekomendacja |
|---|---|---|
| D-F1 | Kiedy wolno budować nowe funkcje | R0 i R3 po fazie I (F1-F3); R1 i R2 po fazie II dla ich obszaru |
| D-F2 | Dwie nowe biblioteki testowe: `fast-check` (losowe przykłady) i Stryker (testy mutacyjne) | tak: tylko do testów (nie trafiają do aplikacji), przypięte wersje, przez kwarantannę Renovate; bez nich losowe przykłady trzeba pisać ręcznie, gorzej i wolniej |
| D-F3 | Osobne konto GitHub dla agentów i wymagana Twoja akceptacja PR na GitHubie | tak, po F2; akceptacja w GitHubie zastępuje „scal #N” w czacie jako polecenie scalenia |
| D-F4 | Przegląd agenta w CI na tokenie subskrypcji Claude (zjada limit, wynik nie zawsze ten sam) | na razie nie; drugi czytelnik w sesji z listą kontrolną; wrócić po F16 |
| D-F5 | Czy każda zmiana wiedzy prawnej (także nowa, niepodpisana reguła) wymaga Twojej etykiety | tak: prosto i bez wyjątków; jedna etykieta na PR |
| D-F6 | Tylko metoda scalania „Merge” w regule GitHuba | tak (`AGENTS.md` już tego wymaga, reguła na to pozwala inaczej) |
| D-F7 | Strażnicy w aplikacji dla funkcji działających dziś (faktury): najpierw tylko alarm przez 2 tygodnie, potem blokada | tak; w module księgowości blokada od razu |
| D-F8 | Testy RLS jako wymagana kontrola | tak |
| D-F9 | Kiedy naprawiać sygnały z rozpoznania (S-01 do S-16 w B7.1) | po fazie I (F1-F3), żeby same przeszły przez filtr; każdy osobnym PR według protokołu, najpierw czerwony test; najpierw te, które działają dziś (S-05, S-10, S-07, S-06, S-08, S-12); S-01, S-02, S-04 i S-13 przed zdjęciem wstrzymania korekt i przed pilotażem modułu |
| D-F10 | Druga, niezależna księgowa do złotych przypadków (koszt dodatkowego zlecenia) | tak, co najmniej dla przypadków, w których plan księgowości ma pewność niską albo średnią (m.in. G1, G3, G4, G5, G13); różnica między księgowymi rozstrzyga się przed bramą B4 |

---

# Część B. Technicznie

## B0. Start sesji: checklista

1. `git fetch origin && git log --oneline -1 origin/main`. Gałąź kroku od
   świeżego `origin/main`: `claude/filtr-fN-<temat>`.
2. Przeczytaj część A, krok z „Następnego kroku” (B12), jego opis w B9,
   `AGENTS.md` (protokół naprawy błędu, scalanie, migracje) i odpowiednie
   sekcje B.
3. `gh pr list --state open` i unikaj tych samych plików. Pliki filtra
   (`.github/`, `.claude/`, `.githooks/`, `scripts/ci/`, `package.json`) są
   w `CODEOWNERS`; zmiany w nich tylko w krokach tego planu.
4. Ciężkie polecenia pojedynczo (Mac 16 GB): `pnpm build`, pełne
   `pnpm run ci`, `next dev`, Colima. Przed każdym `memory_pressure | tail -1`.
5. Przed PR: `pnpm run ci && pnpm build`; drugi czytelnik (`/code-review`
   w Claude, osobna sesja w Codexie); od F3 także `/filtr`.
6. Scalanie i ustawienia GitHuba tylko na polecenie Bartosza. Etykiet zgody
   (`zgoda:*`) sesja nigdy nie nadaje.
7. Po kroku: wiersz w dzienniku (B12), nowy „Następny krok”, raport i STOP.

## B1. Stan dziś (fakty)

| Obszar | Stan 8.11.2026 | Gdzie |
|---|---|---|
| Wymagane kontrole | 9: „Typecheck + Lint + Unit tests”, „Offline security inventory”, „dependency-review”, „Secret scan”, „CodeQL (actions)”, „CodeQL (javascript-typescript)”, „Next build”, „Test-first (agent)”, „Agent guard”. **Brak „RLS isolation (lokalny Supabase)”**. Gałąź musi być aktualna (`strict`), lista wyjątków pusta, 0 wymaganych recenzji, dozwolone metody scalania: merge, squash, rebase. `AGENTS.md` mówi o 11 kontrolach | ruleset „main - ochrona podstawowa” (id 23339700) |
| Agent guard i Test-first | działają tylko dla PR agenta: gałąź `agent/*` albo commit `claude[bot]`. Sesje Claude na Macu (`claude/*`, autor `BartoszGierszewski`) i Codex (`codex/*`) przechodzą bez sprawdzenia | `scripts/ci/agent-guard.mjs:68-73`, `.github/workflows/ci.yml` (job `test-first`) |
| Obszary wrażliwe | `CODEOWNERS` nie obejmuje m.in. `lib/ksiegowosc/`, `lib/invoices/`, `lib/nbp/`, `lib/import/`, `lib/reports/`, `lib/categorization/`, `lib/dashboard/`, `lib/reminders/`, `lib/retention/`, `lib/legal/`, `tests/fixtures/`, `app/(dashboard)/reports/` | `.github/CODEOWNERS` |
| Konta | `gh` na Macu zalogowany jako `ezior8888-cpu` (administrator); zapis mają też `masloigor`, `bielczyk17`, `bobbykrysinski-del` | API `collaborators` |
| Pre-push | adresy z `infra.env`, `typecheck`, eslint zmienionych plików, `vitest related`; pomijany `SKIP_PREPUSH=1` i `--no-verify`; włącza go tylko `przygotuj-worktree.sh` (hook SessionStart w Claude, w Codexie ręcznie) | `.githooks/pre-push`, `scripts/dev/przygotuj-worktree.sh` |
| Hooki i skille Claude | SessionStart (przygotowanie worktree), PostToolUse (eslint jednego pliku); skille `fa3-ksef`, `migracja`, `naprawa`, `telefon-review`, `wdrozenie` | `.claude/settings.json`, `.claude/skills/` |
| Parametry | `lib/ksiegowosc/parametry/` (2026, 2027): każda liczba ma źródło, datę odczytu i pewność; każda sekcja `sprawdzila: null`, więc moduł nie pokazuje kwot (D7); bezpiecznik roku od 1 grudnia | `parametry/index.ts`, `tests/unit/ksiegowosc-parametry.test.ts` |
| Złote przypadki | 13 plików (G1-G12, G14), G13 bez pliku; wszystkie bez podpisu (`policzyla: ""`), więc test je pomija | `tests/fixtures/ksiegowosc/zlote/`, `tests/unit/ksiegowosc-zlote.test.ts` |
| Testy na losowych danych, mutacyjne | brak biblioteki (`fast-check`, Stryker) i brak takich testów | `package.json` |
| Schematy XSD | FA(3) (`lib/xml/schemas/fa3/`), JPK_V7M(3), JPK_FA(4), JPK_EWP(4), JPK_PKPIR(3) (`lib/exports/schemas/`); `xmllint` w CI; czujka zmian tylko dla FA(3) | `.github/workflows/czujka-schematu-fa3.yml` |
| Środowiska testowe | KSeF TEST co tydzień (`ksef-test-wysylka.yml`); MF test JPK tylko jednorazowa próba K6.0 (`scripts/test-jpk-mf.ts`) | `.github/workflows/` |
| Arytmetyka FA(3) | `pnpm verify:fa3` sprawdza XSD i `P_15 = Σ(P_13 + P_14)` dla wszystkich rodzajów, ale nie jest w CI | `scripts/verify-fa3-all-types.ts` |
| Zaokrąglenia | kilka funkcji o różnym zachowaniu: `ryczalt.ts:75` `doPelnychZlotych` (−1,50 zł daje −1 zł), `pit.ts:58` `doZlotych` (−1,50 zł daje −2 zł), `zus.ts:55` `procentGr`, `lib/xml/invoice-calculator.ts:32` (złote w liczbach zmiennoprzecinkowych z epsilonem), `lib/exports/jpk-v7m-generator.ts:117-126` | pliki obok |
| Treści bez porad (D8) | sprawdzane punktowo w kilku testach (np. `ksiegowosc-parametry.test.ts:116`, `ksiegowosc-profil.test.ts:161`); strażnik tekstów pilnuje myślników, plakietek i nazwy, nie porad | `tests/unit/teksty-straznik.test.ts` |
| Raport rewizji z 3.10 | `docs/automation/13_REWIZJA_2026-10-03.md` nie istnieje na dysku: katalog jest poza gitem, a kopia była w usuniętym worktree; wnioski zostały w `GOTOWOSC-DO-WYDANIA.md`, w protokole `AGENTS.md` i w pamięci sesji | `docs/koordynacja/GOTOWOSC-DO-WYDANIA.md` |

Wnioski z rewizji, na których stoi ten plan: zielony Vitest z bazą w pamięci
nie dowodzi niczego o wyzwalaczach; test, który przechodzi przed naprawą, nie
dowodzi niczego; poprawka zmienia kod, więc może dodać błąd (ETAP 10, AUD-69);
dziennik „naprawione” wpisuje ktoś inny niż autor.

## B2. Mapa ryzyka (pełna)

Stan z odczytu kodu 8.11.2026. W F1 ta tabela staje się plikiem
`filtr/mapa-ryzyka.json`; od tej chwili obowiązuje plik, a tabela jest
opisem. Testy podane przy obszarze to te, które istnieją dziś; luki
wypełniają kroki F4-F10.

### B2.1 Moduł księgowości (K0-K8, za wyłącznikiem)

| Obszar (id na mapie) | Pliki | Poziom | Testy dziś |
|---|---|---|---|
| `ksiegowosc.parametry` | `lib/ksiegowosc/parametry/**` | R1 | `ksiegowosc-parametry` (źródło każdej liczby, bezpiecznik roku, kontrola tabel ZUS) |
| `ksiegowosc.kalendarz` | `lib/ksiegowosc/kalendarz.ts`, `parametry/terminy.ts` | R1 | `ksiegowosc-kalendarz` |
| `ksiegowosc.mikrorachunek` | `lib/ksiegowosc/mikrorachunek.ts` | R1 | `ksiegowosc-mikrorachunek` (wektor z generatora MF) |
| `ksiegowosc.profil` | `lib/ksiegowosc/profil.ts`, `app/actions/ksiegowosc-profil.ts`, `components/ksiegowosc/ustawienia-podatkowe-form.tsx`, migracja 00166 | R1 | `ksiegowosc-profil`, `ksiegowosc-profil-akcja`, `ksiegowosc-ustawienia-strona`, `rls-ksiegowosc-profil` |
| `ksiegowosc.wylacznik` | `lib/ksiegowosc/wylacznik.ts`, `lib/ksiegowosc/odeslanie.ts`, migracja 00165 | R1 | `ksiegowosc-wylacznik`, `ksiegowosc-odeslanie`, `admin-flagi-ksiegowosc`, `rls-ksiegowosc-wylacznik` |
| `ksiegowosc.ewidencja` | `lib/ksiegowosc/ewidencja.ts`, `ewidencja-dane.ts`, `wpisy-reczne.ts`, `app/actions/ksiegowosc-ewidencja.ts`, `components/ksiegowosc/wpis-reczny-form.tsx`, migracja 00167 | R1 | `ksiegowosc-ewidencja`, `-ewidencja-dane`, `-ewidencja-akcje`, `-ewidencja-strona`, `rls-ksiegowosc-wpisy` |
| `ksiegowosc.silniki` | `lib/ksiegowosc/ryczalt.ts`, `zus.ts`, `zdrowotna.ts`, `pit.ts` | R1 | `ksiegowosc-silniki`, `ksiegowosc-pit`, `ksiegowosc-zlote` (czeka na podpis) |
| `ksiegowosc.kpir` | `lib/ksiegowosc/kpir.ts`, `kpir-dane.ts`, `spis-z-natury.ts`, `components/ksiegowosc/spis-z-natury-form.tsx`, migracje 00171, 00173 | R1 | `ksiegowosc-kpir`, `-kpir-dane`, `-kpir-akcje`, `-kpir-strona`, `rls-ksiegowosc-kpir`, `rls-ksiegowosc-spis` |
| `ksiegowosc.vat` | `lib/ksiegowosc/vat.ts`, `vat-dane.ts`, `app/actions/ksiegowosc-vat.ts` | R1 | `ksiegowosc-vat-dane`, `-vat-akcje`, `-vat-strona` |
| `ksiegowosc.rozliczenia` | `lib/ksiegowosc/ten-miesiac.ts`, `ten-miesiac-dane.ts`, `miesiac-strony.ts`, `zaplata-reczna.ts`, `app/actions/ksiegowosc-ten-miesiac.ts`, `components/ksiegowosc/ten-miesiac-akcje.tsx`, migracje 00168, 00172 | R1 | `ksiegowosc-ten-miesiac`, `-ten-miesiac-dane`, `-ten-miesiac-akcje`, `-ten-miesiac-strona`, `-zaplata-reczna-formularz`, `rls-ksiegowosc-rozliczenia` |
| `ksiegowosc.jpk-pit` | `lib/ksiegowosc/jpk-ewp.ts`, `jpk-ewp-walidator.ts`, `jpk-pkpir.ts`, `lib/exports/schemas/jpk-ewp4/`, `jpk-pkpir3/` | R1 | `ksiegowosc-jpk-ewp`, `ksiegowosc-jpk-pkpir` (oficjalne XSD) |
| `ksiegowosc.wysylka-jpk` | `lib/ksiegowosc/wysylka-jpk/**`, migracja 00170 | R1 | `ksiegowosc-wysylka-jpk` (atrapa MF, statusy, brak danych autoryzujących w logach), `rls-ksiegowosc-jpk` |
| `ksiegowosc.przypomnienia` | `lib/ksiegowosc/powiadomienia.ts`, `przypomnienia.ts`, crony `ksiegowosc-miesiac` i `ksiegowosc-terminy`, migracja 00169 | R1 (termin i kwota w treści) | `ksiegowosc-powiadomienia`, `-przypomnienia`, `-ustawienia-push`, `rls-ksiegowosc-powiadomienia` |
| `ksiegowosc.odlozyc` | `lib/ksiegowosc/odlozyc.ts`, `components/przeplywy/finora-1do1/adaptery.ts`, `sloty.tsx` | R2 | `ksiegowosc-odlozyc`, `ksiegowosc-karta-odlozyc` |
| `ksiegowosc.ekrany` | `app/(dashboard)/reports/{ten-miesiac,ewidencja,vat,ustawienia-podatkowe}/**`, `components/reports/ksiegowosc-tabs.tsx`, `components/ksiegowosc/**` | R2 (treści D8), R1 tam, gdzie liczą | testy stron `ksiegowosc-*-strona`, `ksiegowosc-wspolne`, `ksiegowosc-jedna-strona` |

### B2.2 Funkcje działające dziś dla wszystkich firm

| Obszar (id na mapie) | Pliki | Poziom | Testy dziś |
|---|---|---|---|
| `faktury.kwoty` | `lib/xml/invoice-calculator.ts`, `lib/invoices/calculator.ts`, `vat-summary.ts`, `amount-due.ts`, `components/invoices/actions.ts` (zapis faktury i pozycji), `components/invoices/invoice-form-parts/calculations.ts`, `invoice-totals.tsx`, `lib/schemas/invoice-form.ts`, `lib/validators/invoice-validators.ts` | R1 | `lib/xml/invoice-calculator.test.ts` (tsx), `zaokraglenia-groszy`, `fa3-kwoty-pozycji`, `korekta-sumy-roznica`, `invoice-validators`, `formularz-dane-xsd-baza` |
| `faktury.fa3` | `lib/xml/fa3-generator.ts`, `fa3-annotations.ts`, `fa3-p12.ts`, `validator.ts`, `lib/xml/schemas/fa3/**`, `lib/invoices/{annotations,vat-exemption,vat-ue,cash-method,special-data,map-buyer-party,tenant-seller,load-tenant-seller}.ts`, `lib/ksef/special-invoice-data.ts`, `lib/ksef/xml-generated-at.ts` | R1 | `lib/xml/fa3-generator.test.ts`, `lib/xml/validator.test.ts`, `fa3-p12`, `fa3-adnotacje-*`, `fa3-np-ii`, `fa3-vat-exemption`, `formularz-dane-xsd-baza`, `pnpm verify:fa3` (poza CI) |
| `faktury.daty-numeracja` | `lib/invoices/{issue-date,sale-date,display-date,next-number}.ts`, `lib/ksef/special-issue-date.ts` | R1 | testy dat sprzedaży i wystawienia, `abonament-numeracja` |
| `faktury.korekty` | `lib/ksef/fa3-correction-generator.ts`, `lib/invoices/correction-{amount-change,parents,annotations,picker}.ts`, `components/invoices/correction-actions.ts`, `correction-form.tsx`, migracje 00133, 00135 | R1 | `korekta-*` (12 plików), `rls-korekta-jedna-otwarta`, `pdf-korekta-dane` |
| `faktury.zaliczki` | `lib/ksef/fa3-advance-generator.ts`, `lib/invoices/settled-advances.ts`, `advance-settlement.ts`, `components/invoices/final-actions.ts` | R1 | `fa3-roz-kwoty`, `roz-akcja-zaliczki`, `kpir-roz-zaliczki`, `jpk-v7m-roz` |
| `faktury.cykliczne` | `lib/invoices/recurring/**`, `app/actions/recurring-invoice*.ts` | R1 (wystawia faktury sama) | `rls-faktury-cykliczne` i testy harmonogramu |
| `faktury.platnosci` | `lib/invoices/manual-payment.ts`, `paid-labels.ts`, `app/actions/invoice-payments.ts`, migracja 00158 | R1 (metoda kasowa VAT zależy od zapłaty) | `rls-zaplacone`, `rls-lista-faktur-platnosc` |
| `faktury.pdf` | `lib/pdf/**`, `lib/ksef/qr-codes.ts`, `qr-verification.ts`, `upo-pdf-generator.ts` | R1 | `pdf-korekta-dane` i testy PDF |
| `ksef.wysylka` | `lib/ksef/{submit,submit-invoice-full,submission-log,submission-holds,submit-reference-boundary,submit-reconciliation,send-attempt-ledger,send-error-classes,send-error-codes,idempotency,kind-holds,roz-submission-hold}.ts`, `lib/invoices/ksef-{send-policy,send-step,submit-enqueue,requeue-event}.ts`, `lib/jobs/runners/submit-invoice.ts`, migracja 00131 i wyzwalacze cyklu życia | R1 | `rls-cykl-faktury`, `rls-cykl-wyzwalacze`, `rls-kolejkowanie-wysylki`, `rls-dziennik-prob-wysylki`, tygodniowy KSeF TEST |
| `ksef.duplikaty` | `lib/ksef/duplicate-*.ts` | R1 (ta sama faktura dwa razy w KSeF) | `rls-decyzja-duplikatu`, `ksef-duplikat-*` |
| `ksef.offline-upo` | `lib/ksef/offline*.ts`, `offline24-policy.ts`, `idempotency.ts` (termin ponownej wysyłki, dni robocze), `upo-client.ts`, `upo-storage.ts`, `upo-pdf-generator.ts` | R1 (termin, dowód wysyłki) | `rls-kontrola-offline24`, `ksef-offline-deadline`, `offline24-terminy` i testy UPO |
| `ksef.srodowisko` | `lib/ksef/accounting-provenance.ts` (księgi tylko ze środowiska KSeF firmy), `lib/expenses/ksef-environment.ts` | R1 | `rls-environment` |
| `ksef.skrzynka-import` | `lib/ksef/inbox*.ts`, `lib/ksef/history-sync/**`, `lib/jobs/runners/{inbox-polling,ksef-history-sync}.ts`, `lib/import/**` (parsery FA(3), JPK_FA i CSV z Fakturowni, wFirmy, inFaktu, iFirmy, `fa3-line-amounts.ts`) | R1 (kwoty zakupów i sprzedaży trafiają do ksiąg); parsery CSV tworzą szkice, więc R3 | `rls-historia-ksef`, `import-*`, `rls-zapis-oryginalu`, `skrzynka-*` |
| `ksef.transport` | `lib/ksef/{client,session-cache,encryption,credentials-crypto,rate-limiter,health-*,latarnia}.ts` | R3 (bez obliczeń prawnych; bezpieczeństwo pilnuje `CODEOWNERS`) | testy klienta i szyfrowania |
| `waluty` | `lib/nbp/client.ts`, `lib/flo/nbp.ts` (`rateBefore`, reguła dnia kursu), `lib/ocr/currency.ts`, `lib/expenses/ksef-currency-review.ts`, `lib/exports/currency-guard.ts` | R1 | `flo-nbp` i testy kosztów w walucie |
| `jpk.vat-fa` | `lib/exports/{jpk-v7m-generator,jpk-v7m-validator,jpk-fa-generator,jpk-fa-validator,jpk-fa-readiness,jpk-schema-check,suspended-formats,taxpayer-email,tax-office,tax-offices,issuer-address,export-scope,data-fetcher}.ts`, `lib/exports/schemas/{jpk-v7m3,jpk-fa4}/` | R1 | `jpk-v7m3`, `jpk-v7m-np-oo`, `jpk-v7m-roz`, `jpk-v7m-wstrzymany*`, `jpk-xsd-*`, `exports-jpk-v7m-job` |
| `raporty.kpir` | `lib/reports/kpir-data.ts`, `kpir-totals.ts`, `components/reports/kpir/kpir-model.ts`, `lib/exports/kpir-generator.ts`, `lib/categorization/{kpir-revenue,kpir-cost}.ts`, `app/(dashboard)/reports/kpir/**` | R1 (firma bez modułu może prowadzić z niego księgę, a plik XLSX dostaje księgowa) | `eksport-kpir-koszty-domyslnie`, `export-kpir-koszt-vat`, `kpir-roz-zaliczki`, `kpir-data-sprzedazy`, `kpir-model` |
| `eksporty.inne` | `lib/exports/{comarch-optima-generator,csv-generators,zip-packager,form-defaults}.ts`, `lib/jobs/runners/{exports-generate,co-pilot-monthly}.ts`, `app/api/portal/exports/generate` | R2 (pliki dla księgowej) | `csv-roz-kwoty`, `csv-formuly`, `optima-wstrzymana`, `eksport-*` |
| `koszty` | `lib/categorization/**` (kolumna KPiR, przychód, odliczenie VAT, reguły, klasyfikator modelu językowego), `lib/expenses/**`, `lib/ocr/**`, `app/actions/expenses.ts`, `lib/jobs/runners/{auto-categorize-inbox,process-ocr}.ts` | R1 (koszt i VAT naliczony trafiają do KPiR i JPK; model językowy tylko proponuje kategorię) | `auto-categorize-korekta` i testy kategoryzacji |
| `kontrahent` | `lib/validators/invoice-validators.ts` (suma kontrolna NIP), `lib/validation/{vies-client,whitelist-client,cache,contractor-update}.ts`, `app/actions/validation.ts`, `lib/jobs/runners/{nightly-validation-recheck,bulk-validate-contractors}.ts`, `lib/gus/**` | R1 (biała lista i VIES wpływają na prawo do kosztu i stawkę 0 % WDT), GUS R3 | `biala-lista-*`, `rachunek-bankowy-nrb`, `kontrahenci-walidacja-masowa` |
| `windykacja` | `lib/reminders/{pdf-demand-letter,templates,scheduler,prepare-delivery,reconciliation-guard}.ts`, `lib/flo/interest.ts`, `lib/overdue/**`, `lib/flo/functions/payment-chase*.ts`, `lib/jobs/runners/{reminder-scheduler,send-reminder,cancel-reminders-on-payment}.ts` | R1 (wezwanie z odsetkami i rekompensatą), R2 (przypomnienia) | `wezwania-podstawa-prawna` i testy przypomnień |
| `abonament` | `lib/billing/{self-invoice,pricing,operator-config,trial-payment,payment-failure}.ts`, `lib/jobs/runners/self-invoice-payment.ts`, `lib/stripe/**` (płatność, zwroty, sprawy finansowe), funkcje SQL `create_billing_vat_invoice` i strażnicy faktury abonamentu | R1 | `self-invoice-*`, `abonament-numeracja`, `rls-faktura-abonamentu-faktway`, `stripe-*`, `stripe-retencja` |
| `retencja` | `lib/retention/**`, `lib/gdpr/**`, `lib/backup/**`, `lib/storage/**` (XML, UPO), `lib/jobs/runners/{archive-old-invoices,retention-delete,cleanup-audit-logs,cleanup-old-backups,gdpr-process-deletions,support-chat-retention}.ts` | R1 | `retencja-pliki`, `archiwum-glacier-historia`, `kopie-zapasowe-retencja`, `czat-pomocy-retencja`, `stripe-retencja`, `gdpr-*`, `rls-sprzatanie-dziennikow` |
| `szacunki` | `lib/dashboard/{tax-estimate,vat-limit,costs,monthly-figures,cash-flow,cash-movements,inflows,inflow-terms,receivables*,sales-history,rankings}.ts`, `lib/flo/functions/{tax-setaside,tax-deadline,tax-relief,vat-limit,rate-raise,month-close}.ts`, `lib/flo/{tax-params,tax-profile,metrics,money,interest}.ts`, `lib/analytics-finance/**` | R2 | `podatek-od-stycznia`, `pulpit-*`, `flo-tax-*`, `flo-vat-limit`, `analizy-*` |
| `flo.aktywne` | `lib/flo/functions/{payment-chase,payment-chase-handler,payment-confirm,payment-confirm-producer,expense-review,expense-rules,expense-inbox}.ts`, `lib/flo/copy.ts` | R2; R1 tam, gdzie reguły ustawiają kolumnę KPiR albo oznaczają zapłatę | `flo-payment-*`, `flo-expense-*`, `flo-no-auto-send`, `flo-copy` |
| `tresci` | `lib/flo/{tax-topic,llm}.ts`, `lib/support/chat.ts` (czat pomocy: zakaz porad tylko w poleceniu dla modelu), `lib/help/articles.ts`, `content/flo/**` (w tym `DO-AKCEPTACJI-PRAWNIKA.md`), `content/help/**` (15 z 27 plików o podatkach), `content/blog/**`, `components/marketing/**`, `lib/marketing/**`, `app/(marketing)/**`, `app/(home)/**`, `lib/email/templates/**`, teksty push | R2 (D8) | `ui-flo-content`, `teksty-straznik`, `nazwa-produktu`, `marketing-bez-fikcji`, `strony-publiczne-obietnice`, punktowe testy D8 |
| `prawne` | `lib/legal/**` (regulamin, polityka prywatności, umowa powierzenia, wersje, akceptacje, podprocesorzy) | R2 (zmiana tylko z nową wersją dokumentu i za zgodą) | testy wersji i akceptacji |
| `pomocnicze` | `lib/format/**` (`warsaw-date`, `pl`, `iso-date`), `lib/accounting/read-complete-pages.ts`, `lib/pagination/**`, `lib/schemas/**`, `types/invoice*.ts` | R3 | testy dat i paginacji |
| `sql` | funkcje, wyzwalacze i widoki, które liczą, numerują, zmieniają stany albo usuwają dane: płatności i zaległości (`update_invoice_payment_status`, `recalculate_invoice_paid_amount`, widok `invoices_overdue`, `mark_invoice_paid` 00158, CHECK 00200), faktura abonamentu (`create_billing_vat_invoice` 00079-00162), integralność dokumentów (00028, 00117-00119, 00122, 00125, 00132, 00133, 00135, 00137, 00154, 00164), cykl wysyłki i duplikaty (00124, 00131, 00141-00143, 00147, 00148, 00151, 00156), pochodzenie kosztów i `expenses.is_deductible` (00034, 00123, 00127, 00128), ustawienia podatkowe firmy (00091, 00092, 00094, 00153), moduł księgowości (00165-00173), retencja i usuwanie (00009, 00022, 00044, 00051, 00052, 00069-00072, 00104, 00109, 00113, 00157) | R1; reszta migracji według sygnałów (B3) | job „RLS isolation” (`rls-*`) |
| `pozostale` | wygląd, logowanie, analityka produktowa, panel administracyjny bez danych prawnych | R0 | bez wymogów filtra |

**Ta sama reguła w kilku miejscach** (do rozstrzygnięcia w przeglądzie
wstecznym; każda para, która daje różne wyniki, to FZ, a docelowo jedna reguła
to jedna funkcja, NZ-ZAOKR-04):

1. **Zaokrąglenia:** do pełnych złotych `ryczalt.ts:75` i `pit.ts:58`
   (inne wyniki dla kwot ujemnych), `jpk-v7m-generator.ts:117-126`
   (`wholeZloty`); do groszy `invoice-calculator.ts:32` (`roundToCents`,
   złote w liczbach zmiennoprzecinkowych, symetrycznie) i jego opakowania,
   `lib/flo/metrics.ts` (`Math.round` bez poprawki), `lib/import/fa3-parser.ts`
   i `lib/ksef/duplicate-original-projection.ts` (`Math.round(x * 100)`,
   niesymetrycznie dla ujemnych), `zus.ts:55` i `pit.ts:64` (grosze
   całkowite), `ewidencja-dane.ts:87` i `kpir-dane.ts:59` (z bazy na grosze);
   `toFixed` bez zaokrąglenia w generatorze Optimy, sumach CSV, PDF i wezwaniu.
2. **Trzy generatory FA(3)** (`lib/xml/fa3-generator.ts`,
   `lib/ksef/fa3-correction-generator.ts`, `lib/ksef/fa3-advance-generator.ts`)
   mają własne kopie map stawek, kolejności `P_13`, form płatności
   i formatowania; tylko zwykły bierze walutę z danych, normalizuje rachunek
   i obsługuje płatność mobilną, a korekta i zaliczka mają na sztywno PLN.
3. **Stawka na procent** w co najmniej siedmiu miejscach (m.in.
   `getVatPercentage`, `calculateAdvanceTotals`, `advanceSplit`, JPK_FA,
   `VAT_FACTOR` w `lib/schemas/invoice-form.ts`, `VAT_RATE_PCT` w fakturze
   abonamentu i `round(gross/1.23, 2)` w SQL 00110, 00152, 00162); odwrotne
   mapy `P_12` w `fa3-p12.ts` i w `correction-actions.ts`.
4. **Kwota korekty:** nagłówek faktury korygującej to różnica (AUD-21) i z niego
   liczą KPiR, CSV, pulpit i limit VAT; pozycje to stan „po” i z nich liczą
   JPK_V7M, podsumowanie VAT w PDF i `lib/invoices/vat-summary.ts` (sygnał
   S-01 w B7.1).
5. **„Do zapłaty” faktury rozliczającej** w pięciu miejscach (`amountDueOf`,
   `amountDueOnPdf`, SQL 00145 i 00158, `amountsOf` w JPK_FA,
   `calculateFinalInvoiceTotals`).
6. **Podsumowanie VAT według stawek** w czterech (`summarizeVatPerRate`,
   `vatSummaryByRate`, `drawVatSummary` w PDF bez zaokrąglenia, `aggregateSales`
   w JPK_V7M).
7. **Dni robocze i święta:** `lib/ksef/idempotency.ts` (`polishHolidays`,
   `isPolishBusinessDay`) obok `lib/ksiegowosc/kalendarz.ts`; harmonogram
   przypomnień (`lib/reminders/scheduler.ts`) i `lib/flo/tick.ts` pomijają
   tylko weekendy; termin VAT na pulpicie bez przesunięcia (S-06).
8. **„Dzisiaj”:** `todayInWarsaw` obok `toISOString().slice(0, 10)` (UTC)
   w `whitelist-client.ts`, `validation/cache.ts`, `reminders/scheduler.ts`,
   `csv-helpers.ts`; w SQL `CURRENT_DATE` (00023, 00145) obok
   `now() AT TIME ZONE 'Europe/Warsaw'` (00110, 00158).
9. **Kolumny KPiR w trzech wersjach:** ekran (koszt bez kolumny poza sumą),
   XLSX (koszt bez kolumny w kolumnie 13, S-05), JPK_PKPIR (bez kolumny poza
   plikiem); raport `lib/reports/kpir-data.ts` i moduł `lib/ksiegowosc/kpir.ts`
   rozdzielone świadomie (D20), ale wspólne reguły daty przychodu i zaliczek
   muszą dawać ten sam wynik.
10. **Szacunki i parametry:** `lib/dashboard/tax-estimate.ts` (19 % na sztywno),
    `lib/flo/functions/tax-setaside.ts` i silniki modułu; atrapy
    `lib/flo/tax-params.ts` obok `lib/ksiegowosc/parametry/`; profil
    `flo_prefs.tax_profile` obok `tax_profiles`; „240 000 zł” na sztywno
    w `lib/invoices/vat-exemption.ts` obok parametrów.
11. **Drobniejsze:** lista dokumentów z prawem do odliczenia skopiowana
    w `kpir-cost.ts` i `jpk-v7m-generator.ts`; dwie listy krajów UE
    (`vat-ue.ts`, `vies-client.ts`); kilka funkcji formatowania kwot
    (`formatPln` w `lib/billing/pricing.ts` pokazuje −0,50 zł jako „0,50 zł”);
    normalizacja rachunku tylko w zwykłej fakturze; dwa schematy formularza
    faktury z różnymi limitami; trzy definicje należności po terminie
    (pulpit, przypomnienia, widok SQL).

## B3. Jak nowe pliki same trafiają na mapę

Mapa to plik danych `filtr/mapa-ryzyka.json` (nie kod: straż czyta go także
z gałęzi PR, a danych nie wykonuje). Klasyfikator `scripts/filtr/mapa.mjs`
działa tak samo w hooku Claude, w pre-push i w CI.

1. **Katalogi i wzorce.** Obszar ma listę ścieżek (`lib/ksiegowosc/**`).
   Nowy plik w takim katalogu dziedziczy poziom obszaru. Plik pasujący do kilku
   obszarów dostaje najwyższy poziom.
2. **Sygnały w treści.** Plik kodu (`lib/`, `app/`, `components/`, `scripts/`,
   `supabase/migrations/`, `content/`) spoza wszystkich obszarów i spoza listy
   jawnych wyłączeń jest „niesklasyfikowany”, jeśli w dodanych liniach pojawi
   się sygnał: słowa (VAT, ZUS, PIT, ryczał, składk, podat, JPK, KSeF, FA(3),
   kurs, NBP, zaokrągl, grosz, stawk, termin, odsetk, mikrorachun, korekt,
   zaliczk, retencj, przedawn, KPiR, ewidencj), wzorce pól (`P_\d+`, `K_\d+`),
   odwołania do przepisów (`art\. \d+`, `Dz\.U\.`), nazwy tabel z danymi
   prawnymi (`invoices`, `invoice_line_items`, `expenses`, `payments`,
   `tax_*`, `ledger_*`, `jpk_*`, `ksef_*`, `audit_logs`) albo import modułu
   R1 (`@/lib/ksiegowosc/`, `@/lib/xml/`, `@/lib/exports/` i dalsze z mapy).
   Do tego wzorce z rozpoznania: kwoty (`roundToCents`, `toFixed(`,
   `Math.(round|floor|ceil|trunc)(`), stawki (`'23'`, `1.23`, `zw`, `oo`,
   `np_ii`), daty (`Europe/Warsaw`, `CURRENT_DATE`,
   `toISOString().slice(0, 10)`), usuwanie (`.delete(`, `DELETE FROM`,
   `TRUNCATE`, `scheduled_deletion_at`, `interval '… year|month|day'`), SQL
   (`CREATE (OR REPLACE) FUNCTION|TRIGGER|VIEW` przy tabelach faktur,
   płatności, KSeF, JPK, podatków, kosztów, abonamentu i RODO), treści
   (doradztw, kar, nieważn, usuwan). Nazwy plików też są sygnałem: `*vat*`,
   `*jpk*`, `*kpir*`, `*tax*`, `*podat*`, `*zus*`, `*ryczalt*`, `*pit*`,
   `*calculator*`, `*amount*`, `*round*`, `*nbp*`, `*currency*`, `*walut*`,
   `*fa3*`, `*correction*`, `*korekt*`, `*advance*`, `*zalicz*`, `*settle*`,
   `*billing*`, `*pricing*`, `*self-invoice*`, `*interest*`, `*odsetk*`,
   `*reminder*`, `*wezwan*`, `*demand*`, `*retention*`, `*retencj*`,
   `*gdpr*`, `*rodo*`, `*delet*`, `*purge*`, `*cleanup*`, `*prune*`,
   `*archive*`, `*deadline*`, `*termin*`, `*kalendarz*`, `*offline*`,
   `*issue-date*`, `*sale-date*`, `*exemption*`, `*cash-method*`,
   `*whitelist*`, `*vies*`. Niesklasyfikowany plik zatrzymuje PR, dopóki
   autor nie dopisze go do obszaru (wolno bez zgody) albo do wyłączeń
   z powodem (osłabienie, czyli za zgodą).
3. **Zaostrzenie bez zgody, osłabienie za zgodą.** Straż klasyfikuje każdy
   zmieniony plik mapą z `main` i mapą z PR i bierze wyższy poziom. Jeśli mapa
   z PR obniża poziom jakiejkolwiek ścieżki, usuwa obszar albo dodaje
   wyłączenie, PR potrzebuje etykiety `zgoda:zmiana-filtra`.
4. **Pełny skan repozytorium.** Test `tests/filtr/mapa.test.ts` przechodzi
   przez całe repozytorium: każdy plik kodu z sygnałem jest na mapie albo
   w wyłączeniach; każdy wzorzec na mapie pasuje do co najmniej jednego pliku
   (bez martwych wpisów); każdy obszar R1 ma w rejestrze co najmniej jedną
   regułę; każda ścieżka R1 jest w `CODEOWNERS` (od F18).
5. **Zależności.** Plik R3 nie ma własnych testów prawnych, ale jego zmiana
   uruchamia testy prawne obszarów, które go importują (w pre-push przez
   `vitest related`, w CI zawsze cały zestaw).
6. **Raport tygodniowy.** Harmonogram w `filtr-tydzien.yml` liczy pliki według
   poziomów, reguły bez testów, wyjątki i otwarte znaleziska. Rozjazd zakłada
   issue z etykietą `filtr`.

## B4. Wiedza filtra

### B4.0 Źródła prawdy (warstwa nadrzędna)

Analiza „na czym realnie badamy poprawność” leży w
[`docs/koordynacja/ZRODLA-PRAWDY.md`](ZRODLA-PRAWDY.md) (zlecenie Bartosza
z 8.11.2026, wersja w repo z poprawkami tej sesji). Każda kontrola filtra
mówi, z którego wzorca bierze oczekiwany wynik, a wzorzec mocniejszy wygrywa
ze słabszym:

| Wzorzec (od najmocniejszego) | Gdzie w filtrze | Jak często |
|---|---|---|
| 1. System państwowy: KSeF TEST, testowa bramka JPK, e-mikrofirma, e-Płatnik | B4.7 | KSeF TEST i bramka JPK automatycznie co tydzień i przed zmianą generatora; e-mikrofirma i e-Płatnik ręcznie przed każdym nowym rokiem i przy każdej zmianie obliczeń |
| 2. Dokumenty przyjęte przez urząd (pilotaż, potem co miesiąc) | B4.12 | raz na starcie pilotażu, potem co miesiąc z alarmem przy różnicy |
| 3. Dwie niezależne księgowe | B4.3, D-F10 | złote przypadki przed bramą B4 i przy każdym nowym roku |
| 4. Przykłady urzędowe (broszury MF, objaśnienia, ZUS, podatki.gov.pl, generator mikrorachunku, wizualizacja PDF z generatora MF) | B4.3 | każdy PR (testy) |
| 5. Druga, niezależna implementacja | B4.4 | każdy PR i w nocy |
| 6. Programy konkurencji | ręczna lista kontrolna, tylko kilka przypadków | gdy wzorce 1-5 nie wystarczą |

Zasady:

1. Rejestr przepisów (B4.1) przy każdej regule wskazuje jej wzorzec i datę,
   kiedy go ostatnio sprawdzono.
2. Reguła bez żadnego wzorca z poziomów 1-4 może działać tylko za
   wyłącznikiem albo jako brak kwoty dla klienta (fail-closed z wyjściem).
3. Wzorce 5 i 6 nie potwierdzają przepisu, tylko łapią błędy programistyczne;
   wspólne złe zrozumienie przepisu łapią wzorce 1-4.
4. Licencje: kod MF na licencji MIT (`CIRFMF/ksef-api`,
   `ksef-client-java`, `ksef-client-csharp`, `ksef-pdf-generator`) wolno
   kopiować z informacją o licencji; kodu bez licencji i kodu GPL nie
   kopiujemy (repozytorium FaktWay jest publiczne).

### B4.1 Rejestr przepisów

Katalog `filtr/przepisy/`, jeden plik JSON na obszar (`ksiegowosc.json`,
`faktury.json`, `jpk.json`, `ksef.json`, `waluty.json`, `terminy.json`,
`odsetki.json`, `retencja.json`, `tresci.json`), schemat w
`filtr/przepisy/schemat.json`, test spójności w `tests/filtr/rejestr.test.ts`.

Jeden wpis to jedna reguła:

```json
{
  "id": "RP-ZAOKR-01",
  "regula": "Podstawę opodatkowania i podatek zaokrągla się do pełnych złotych: końcówki poniżej 50 gr pomija się, 50 gr i więcej podwyższa do złotego.",
  "podstawa": [{ "akt": "Ordynacja podatkowa", "przepis": "art. 63 § 1", "url": "https://isap.sejm.gov.pl/..." }],
  "obowiazuje": { "od": "1998-01-01", "do": null },
  "obszary": ["ksiegowosc.silniki", "jpk.v7m"],
  "kod": ["lib/ksiegowosc/pit.ts#doZlotych", "lib/ksiegowosc/ryczalt.ts#doPelnychZlotych"],
  "testy": ["tests/filtr/niezmienniki/zaokraglenia.test.ts > RP-ZAOKR-01"],
  "niezmienniki": ["NZ-ZAOKR-01", "NZ-ZAOKR-04"],
  "pewnosc": "wysoka",
  "wzorzec": { "poziom": 4, "opis": "tekst art. 63 § 1 i przykłady z broszury JPK_V7M", "sprawdzono": "2026-11-08" },
  "interpretacja": null,
  "do_rozstrzygniecia": null,
  "sprawdzil": { "ksiegowa": null, "prawnik": null },
  "odczyt": "2026-11-08",
  "uwagi": "Kwoty ujemne: jedna reguła dla wszystkich silników (FZ do ustalenia w przeglądzie wstecznym)."
}
```

Zasady rejestru:

1. **Źródło urzędowe pierwsze:** ISAP (tekst ujednolicony), Dz.U. i M.P.,
   podatki.gov.pl, zus.pl, gov.pl/kas, nbp.pl, stat.gov.pl, broszury
   i objaśnienia MF. Źródło branżowe tylko z pewnością „niska” i pytaniem do
   księgowej.
2. **Liczby zostają w `lib/ksiegowosc/parametry/`** (mają już źródło, odczyt,
   pewność i `sprawdzila`). Rejestr opisuje reguły, a parametry z nich
   korzystają. Test sprawdza, że każdy parametr jest użyty przez jakąś regułę
   i że każde źródło parametru ma odpowiednik w rejestrze.
3. **Śladowość bez zmian w kodzie:** wpis wskazuje kod (`plik#symbol`)
   i testy (`plik > fragment nazwy testu`). Test spójności sprawdza, że plik
   istnieje, symbol jest wyeksportowany, a test o tej nazwie jest w pliku.
   Każdy eksportowany symbol w plikach silników R1 jest przypisany do reguły
   albo wpisany na listę pomocniczych (z zapadką dla kodu sprzed filtra).
4. **Interpretacja i spór:** pole `interpretacja` mówi, jak program rozumie
   przepis; `do_rozstrzygniecia` (`księgowa` albo `prawnik`) i pytanie. Z tych
   pól powstaje lista `docs/filtr/PYTANIA-Z-REJESTRU.md` (generowana, test
   pilnuje aktualności), którą dostaje księgowa i prawnik przy bramie B2 i B4.
5. **Podpis:** `sprawdzil.ksiegowa` i `sprawdzil.prawnik` (imię, nazwisko,
   data). Bez podpisu reguła działa w testach, ale moduł nie pokazuje kwot
   klientom (rozszerzenie D7 z parametrów na reguły).
6. **Każda zmiana rejestru** (nowa reguła, zmiana treści, dat, kodu, testów)
   wymaga etykiety `zgoda:wiedza-prawna` (D-F5) i źródła w karcie PR.

Treść pierwszego wypełnienia (F4) to sekcje 4, 5 i 13 planu księgowości,
w tym wszystkie wiersze o pewności średniej i niskiej z sekcji 5 jako pytania
do księgowej. Drugie wypełnienie (F10) obejmuje faktury, KSeF, JPK_FA
i JPK_V7M (pola i objaśnienia MF), waluty, odsetki, retencję i treści.

### B4.2 Niezmienniki (zasady zawsze prawdziwe)

Każdy niezmiennik ma identyfikator, regułę z rejestru i test w
`tests/filtr/niezmienniki/<obszar>.test.ts`, sprawdzany na losowych danych
(B4.5). Lista na start; dopisywanie jest zaostrzeniem i nie wymaga zgody.

**Wspólne dla silników R1**

| Id | Niezmiennik |
|---|---|
| NZ-WSP-01 | Determinizm: te same wejścia dają ten sam wynik; silnik nie czyta zegara, sieci ani losowości |
| NZ-WSP-02 | Kolejność nie ma znaczenia: permutacja faktur, kosztów i wpisów nie zmienia sum |
| NZ-WSP-03 | Brak to nie zero: brak danych albo parametrów daje „brak” z komunikatem i ścieżką operatora, nigdy 0 zł |
| NZ-WSP-04 | Kwoty to liczby całkowite w groszach; nigdy NaN, nieskończoność ani ułamek |
| NZ-WSP-05 | Nie sumujemy różnych walut; każda kwota w PLN z waluty ma kurs i dzień kursu |
| NZ-WSP-06 | Miesiąc i dzień liczone w strefie Europe/Warsaw; wynik nie zależy od strefy serwera (cały zestaw idzie w CI dwa razy: `TZ=Europe/Warsaw` i `TZ=UTC`, w nocy także `TZ=Pacific/Kiritimati` i `TZ=America/Los_Angeles`) |
| NZ-WSP-07 | Liczby prawne tylko z parametrów albo rejestru (reguła statyczna, B4.8) |
| NZ-WSP-08 | Odczyt stronami: 999, 1000, 1001 i 2500 wierszy dają te same sumy co jeden odczyt (granica PostgREST) |

**Zaokrąglenia**

| Id | Niezmiennik |
|---|---|
| NZ-ZAOKR-01 | Podstawy i podatek (ryczałt, zaliczka PIT, deklaracja VAT) w pełnych złotych według art. 63 § 1 Ordynacji podatkowej |
| NZ-ZAOKR-02 | Składki ZUS i zdrowotna w groszach |
| NZ-ZAOKR-03 | Ewidencje (EWP, KPiR, ewidencja VAT) w groszach, bez zaokrąglania do złotych |
| NZ-ZAOKR-04 | Jedna reguła, jedna funkcja: ta sama kwota (także ujemna) zaokrągla się tak samo w każdym silniku |
| NZ-ZAOKR-05 | Zaokrąglenie zaokrąglonej kwoty nic nie zmienia; deklaracja to zaokrąglona suma ewidencji, nie suma zaokrągleń (chyba że przepis każe inaczej, wtedy wpis w rejestrze) |
| NZ-ZAOKR-06 | Faktura: metoda liczenia VAT (od sumy netto w stawce, art. 106e ust. 1 pkt 14 ustawy o VAT, albo od pozycji) jest jedna i zapisana w rejestrze; pola `P_13_x` i `P_14_x` z niej wynikają; `P_15 = Σ(P_13_x + P_14_x)` |

**Ryczałt**

| Id | Niezmiennik |
|---|---|
| NZ-RYCZ-01 | Ryczałt nie jest ujemny; zerowy przychód bez zaległych odliczeń daje 0 |
| NZ-RYCZ-02 | Więcej przychodu nigdy nie daje mniej ryczałtu (przy tych samych odliczeniach) |
| NZ-RYCZ-03 | Więcej zapłaconych składek nigdy nie daje więcej ryczałtu |
| NZ-RYCZ-04 | Koszty nie zmieniają ryczałtu |
| NZ-RYCZ-05 | Suma przychodów według stawek równa się przychodowi miesiąca; odliczenia rozdzielone proporcjonalnie sumują się do całości bez zgubionego grosza |
| NZ-RYCZ-06 | Niewykorzystane odliczenie przechodzi na kolejne miesiące roku według rejestru (w obrębie roku; reszta do zeznania rocznego, K9) |
| NZ-RYCZ-07 | Próg najmu: stawka niższa do progu, wyższa od nadwyżki, próg liczony narastająco w roku, przekroczenie w trakcie miesiąca dzieli ten miesiąc |
| NZ-RYCZ-08 | Podział faktury na dwie o tej samej sumie i stawce w tym samym miesiącu nie zmienia ryczałtu |
| NZ-RYCZ-09 | Korekta in minus większa niż przychód miesiąca zmniejsza przychód tej samej stawki w kolejnych miesiącach roku |

**ZUS i zdrowotna**

| Id | Niezmiennik |
|---|---|
| NZ-ZUS-01 | Pełny i preferencyjny ZUS 2026 równe tabeli ZUS co do grosza (przykład urzędowy, B4.3) |
| NZ-ZUS-02 | Ulga na start: zero składek społecznych przez ustawowy okres; potem preferencyjny przez ustawowy okres; potem pełny; bez luki i bez nakładania |
| NZ-ZUS-03 | Etat obok (zbieg tytułów): zero składek społecznych, zdrowotna zostaje |
| NZ-ZUS-04 | Dobrowolne chorobowe: z chorobowym nigdy mniej niż bez; różnica to stopa chorobowa razy podstawa |
| NZ-ZUS-05 | Fundusz Pracy tylko przy podstawie co najmniej równej płacy minimalnej; preferencyjny bez FP |
| NZ-ZUS-06 | Stopa wypadkowa zmienia się 1 kwietnia, nie 1 stycznia |
| NZ-ZUS-07 | Miesiąc niepełny (poza startem ulgi): brak z komunikatem, dopóki nie ma reguły proporcji |
| NZ-ZDR-01 | Ryczałt: kwota zależy od progu przychodu i roku składkowego; po przekroczeniu progu nie spada do końca roku kalendarzowego; styczeń według rozstrzygnięcia księgowej (G5, pewność niska w planie księgowości) |
| NZ-ZDR-02 | Ryczałt: więcej przychodu narastająco nigdy nie daje niższej składki |
| NZ-ZDR-03 | Skala i liniowy: nigdy mniej niż minimum roku składkowego; strata daje minimum |
| NZ-ZDR-04 | Rok składkowy luty-styczeń: styczeń z parametrów poprzedniego roku składkowego; przy skali i liniowym z dochodu grudnia |
| NZ-ZDR-05 | Skala i liniowy: dodanie kosztu w poprzednim miesiącu nigdy nie podnosi składki |

**PIT: skala i liniowy**

| Id | Niezmiennik |
|---|---|
| NZ-PIT-01 | Zaliczka nie jest ujemna; zaliczka to podatek od początku roku minus zaliczki należne za wcześniejsze miesiące (art. 44 ust. 3f ustawy o PIT) |
| NZ-PIT-02 | Dodanie kosztu nigdy nie podnosi sumy zaliczek do zapłaty od początku roku (do każdego miesiąca). Doprecyzowane w F5: zaliczka jednego późniejszego miesiąca może wzrosnąć, bo wcześniej zapłacono mniej |
| NZ-PIT-03 | Dodanie przychodu nigdy nie obniża podatku od początku roku |
| NZ-PIT-04 | Skala: ciągłość na progu 120 000 zł; dochód do kwoty wolnej daje 0 zł podatku |
| NZ-PIT-05 | Liniowy: odliczenie zdrowotnej od początku roku nie przekracza limitu rocznego |
| NZ-PIT-06 | Podstawa do pełnych złotych przed podatkiem, zaliczka do pełnych złotych (podatek od początku roku liczy się w groszach, zaokrągla się zaliczka; doprecyzowane w F5) |
| NZ-PIT-07 | Strata miesiąca zmniejsza dochód od początku roku; nie przechodzi na kolejny rok w zaliczkach |
| NZ-PIT-08 | Składki odliczane od dochodu nie trafiają do kosztów KPiR (bez podwójnego odliczenia); FP i FS są kosztem w kolumnie 13 w dniu zapłaty, dokładnie raz |

**VAT i JPK_V7M**

| Id | Niezmiennik |
|---|---|
| NZ-VAT-01 | Pola deklaracji według objaśnień MF; nigdy jednocześnie kwota do wpłaty (`P_51`) i nadwyżka (`P_62`) większe od zera |
| NZ-VAT-02 | Sumy kontrolne ewidencji (`SprzedazCtrl`, `ZakupCtrl`): liczba wierszy i suma podatku zgadzają się z wierszami; deklaracja zgadza się z ewidencją w granicy zaokrąglenia do złotych |
| NZ-VAT-03 | Łańcuch nadwyżki: `P_39` miesiąca to `P_62` poprzedniego (przyjętego albo zatwierdzonego); nigdy zgadnięte zero |
| NZ-VAT-04 | Odliczenie 50 % (samochód): część nieodliczona trafia do kosztu, nigdy do obu miejsc i nigdy do żadnego |
| NZ-VAT-05 | Korekta faktury trafia do okresu według reguły z rejestru (in minus, in plus) |
| NZ-VAT-06 | Faktury, których plik nie wykaże poprawnie (odwrotne obciążenie, waluta, dokument spoza FaktWay), dają jawny brak, nigdy cicho pominięty wiersz |
| NZ-VAT-07 | Zwolniony podmiotowo: brak JPK_V7M; licznik limitu z proporcją przy starcie w trakcie roku |

**Faktury FA(3), korekty, zaliczki, waluty**

| Id | Niezmiennik |
|---|---|
| NZ-FA-01 | `P_15 = Σ(P_13_x + P_14_x)` dla VAT, KOR, ZAL i ROZ (dziś tylko w `verify:fa3`, poza CI) |
| NZ-FA-02 | Suma pozycji w stawce równa się `P_13_x` tej stawki; VAT w stawce zgodny z metodą z NZ-ZAOKR-06 |
| NZ-FA-03 | Stawki i oznaczenia spójne: „zw” z podstawą zwolnienia, „np”, „oo”, 0 % KR/WDT/EX we właściwych polach; podatnik zwolniony nie wystawia faktury z 23 % |
| NZ-FA-04 | Korekta: „przed” to stan po poprzedniej korekcie, różnica to „po” minus „przed”; druga korekta tej samej faktury liczy od ostatniego stanu (błąd K4 z rewizji) |
| NZ-FA-05 | Zaliczki: zaliczki plus faktura rozliczająca dają wartość zamówienia; przychód bez dublowania |
| NZ-FA-06 | Waluta: kurs NBP z ostatniego dnia roboczego przed dniem powstania obowiązku podatkowego (art. 31a ust. 1 ustawy o VAT); VAT na fakturze w walucie wykazany także w złotych |
| NZ-FA-07 | Daty: data wystawienia, data sprzedaży i termin wystawienia w granicach przepisów; dzień liczony w strefie Warszawy |
| NZ-FA-08 | Numer faktury jednoznaczny w firmie i serii (art. 106e ust. 1 pkt 2 ustawy o VAT) |
| NZ-FA-09 | Obowiązkowe elementy dla danego rodzaju faktury; adnotacja „mechanizm podzielonej płatności”, gdy kwota należności ogółem przekracza 15 000 zł i towar lub usługa jest z załącznika 15 (art. 106e ust. 1 pkt 18a) |
| NZ-FA-10 | Każdy wygenerowany XML przechodzi XSD FA(3), także dla losowych faktur |
| NZ-FA-11 | PDF pokazuje te same kwoty, numer KSeF i dane co XML |
| NZ-FA-12 | Ta sama faktura nie trafia do KSeF dwa razy (decyzja o duplikacie) |
| NZ-KURS-01 | Dzień kursu: ostatni dzień roboczy przed dniem zdarzenia (art. 11a ustawy o PIT, art. 31a ustawy o VAT); weekend i święto cofają dalej; nigdy dzień zdarzenia ani późniejszy |
| NZ-KURS-02 | Kurs średni z tabeli A; brak kursu to brak z wyjściem, nie kurs z innego dnia |
| NZ-KURS-03 | Przeliczenie kwota razy kurs do groszy jedną funkcją, bez błędu liczb zmiennoprzecinkowych |

**Terminy, kalendarz, mikrorachunek**

| Id | Niezmiennik |
|---|---|
| NZ-TERM-01 | Termin nigdy w sobotę, niedzielę ani dzień ustawowo wolny; przesunięcie na następny dzień roboczy (art. 12 § 5 Ordynacji podatkowej) |
| NZ-TERM-02 | Termin nie wcześniej niż dzień ustawowy (20., 25.) w miesiącu po okresie; grudzień daje termin w styczniu następnego roku |
| NZ-TERM-03 | Kalendarz świąt (ruchome i stałe, Wigilia od 2025 r.) zgodny z oficjalną listą dni wolnych na lata 2026-2030 |
| NZ-TERM-04 | Przypomnienia dokładnie 5 i 1 dzień przed terminem, jedno na firmę, rozliczenie i etap, także po ponowieniu zadania |
| NZ-TERM-05 | Terminy KSeF (wysyłka po awarii i w trybie offline) liczone według rejestru i kalendarza dni roboczych |
| NZ-MIKRO-01 | Mikrorachunek z NIP ma poprawne cyfry kontrolne (mod 97) i zgadza się z wektorem z generatora MF |
| NZ-MIKRO-02 | NIP z błędną sumą kontrolną daje brak, nigdy rachunek |

**KPiR, ewidencja, rozliczenia, wyłącznik**

| Id | Niezmiennik |
|---|---|
| NZ-KPIR-01 | Kolumna 9 to 7 plus 8; kolumna 14 to 12 plus 13 (wzór 2026) |
| NZ-KPIR-02 | Każdy koszt w dokładnie jednej kolumnie; koszt bez kolumny to brak z wyjściem |
| NZ-KPIR-03 | Suma miesiąca to suma wierszy; od początku roku to suma miesięcy |
| NZ-KPIR-04 | Przychód w KPiR równa się przychodowi w ewidencji dla tych samych faktur (wspólna data przychodu i zaliczki) |
| NZ-EWP-01 | Jeden wiersz to jeden przychód z jedną stawką; suma według stawek to przychód |
| NZ-PKPIR-01 | JPK_PKPIR: `P_3` to wydatki plus `P_1` minus `P_2`; `P_4` to przychód minus `P_3` |
| NZ-ROZL-01 | Zatwierdzone rozliczenie się nie zmienia (wyzwalacz w bazie, test RLS) |
| NZ-ROZL-02 | Zmiana danych po zatwierdzeniu daje nową wersję i komunikat, nigdy zmianę starej |
| NZ-ROZL-03 | Odliczenie liczy tylko przyrost zapłaty ponad najwyższą zapłaconą wersję okresu (bez podwójnego odliczenia) |
| NZ-ROZL-04 | Bez podpisu księgowej pod sekcją parametrów żadna kwota nie trafia do klienta: ekran, push, mail, „Odłóż na podatek” (D7) |
| NZ-WYL-01 | Globalny stop i brak flagi firmy zatrzymują moduł wszędzie: ekrany, akcje, crony; `wysylka_jpk` zablokowany do B2 |

**Odsetki, abonament, retencja, dane osobowe, treści**

| Id | Niezmiennik |
|---|---|
| NZ-ODS-01 | Odsetki w wezwaniu liczone stopą z rejestru (ustawa o przeciwdziałaniu nadmiernym opóźnieniom w transakcjach handlowych; stopa na półrocze), od dnia po terminie do dnia zapłaty |
| NZ-ODS-02 | Rekompensata (40, 70 albo 100 euro według kwoty) i jej kurs według rejestru; granice progów sprawdzone testem |
| NZ-ABON-01 | Faktura za abonament: netto plus VAT 23 % równa się cenie brutto co do grosza; numer jednoznaczny; zwrot daje korektę |
| NZ-RET-01 | Faktury, UPO, księgi i migawki rozliczeń nie są usuwane przed końcem okresu przechowywania (FaktWay: 10 lat dla danych fakturowych; ustawowo do przedawnienia zobowiązania, art. 112 ustawy o VAT i art. 86 Ordynacji podatkowej); usunięcie konta respektuje blokady |
| NZ-RET-02 | Dane autoryzujące JPK nigdzie nie są zapisywane ani logowane; imię, nazwisko i data urodzenia są tylko w pliku |
| NZ-TRESC-01 | Teksty dla klienta w obszarach R1 i R2 bez trybu rozkazującego i bez porad; lista słów zatwierdzona przez prawnika (pytanie 1 w `PYTANIA-DO-PRAWNIKA.md`), do tego czasu lista robocza: zapłać, musisz, powinieneś, należy, zalecamy, radzimy, wybierz, opłaca się, lepiej, najkorzystniej, oszczędzisz |
| NZ-TRESC-02 | Każda kwota w module ma podpis „według Twoich danych i stawek na {rok}” |
| NZ-TRESC-03 | Model językowy nie liczy i nie objaśnia przepisów (`lib/flo/tax-topic.ts`) |
| NZ-TRESC-04 | Każdy brak ma komunikat z nazwą braku i tym, co z nim będzie, bez trybu rozkazującego |
| NZ-SQL-01 | Wyzwalacze niezmienności, przejścia stanów i RLS sprawdzone na prawdziwej bazie (job RLS wymagany, D-F8) |

### B4.3 Złote przypadki, przykłady urzędowe i złote pliki

1. **Złote przypadki księgowej (G1-G14).** Zostają bez zmian i bez naszych
   kwot w arkuszu: księgowa liczy niezależnie (pokazanie jej wyniku programu
   zabiłoby niezależność). Dochodzą: plik G13; przypadki faktur (GF:
   FA, KOR in minus, KOR in plus, ZAL, ROZ, np II, zw, oo, konsument, UE,
   waluta; to są przypadki z kryterium G5 w `GOTOWOSC-DO-WYDANIA.md`); JPK
   (GJ); terminy (GT); kursy (GW); odsetki (GO). Do podpisu księgowej
   przy B4. **Druga, niezależna księgowa** (D-F10) liczy te same przypadki
   bez wglądu w wynik pierwszej; różnica między nimi to pytanie do
   rozstrzygnięcia w rejestrze, zanim przypadek zostanie złoty.
2. **Wyniki tymczasowe z wyroczni.** Do podpisu księgowej przypadki G mają
   wyniki z wyroczni (B4.4) w osobnym katalogu `tests/filtr/zlote-tymczasowe/`,
   poza arkuszem dla księgowej. Silnik musi się z nimi zgadzać. Po podpisie
   test porównuje trzy strony: księgowa, wyrocznia, aplikacja.
3. **Przykłady urzędowe** (`tests/filtr/przyklady-urzedowe/`, każdy z adresem
   i datą odczytu): tabele składek ZUS (2026 już odtwarzane co do grosza),
   przykłady z podatki.gov.pl (odliczenia na ryczałcie, skala, liniowy),
   przykłady z broszur JPK_PKPIR(3) i JPK_EWP(4), przykładowe pliki JPK_V7M
   z gov.pl, przykładowe faktury FA(3) z `CIRFMF/ksef-api` (dawniej
   `ksef-docs`), wizualizacje PDF i kody QR z oficjalnego generatora MF
   (`CIRFMF/ksef-pdf-generator`, MIT) dla tych samych plików XML, kursy NBP
   z archiwum tabel A dla zestawu dni ze świętami, oficjalne wykazy dni
   wolnych.
4. **Złote pliki** (`tests/filtr/zlote-pliki/`): wygenerowane XML dla
   stałego zestawu danych (FA(3) wszystkich rodzajów, JPK_V7M, JPK_EWP,
   JPK_PKPIR, JPK_FA), bez znaczników czasu. Każda różnica bajtowa czerwieni
   test; świadoma zmiana pliku to zmiana wiedzy (`zgoda:wiedza-prawna`),
   a job wypisuje różnicę w podsumowaniu.
5. **Kontrprzykłady** (`tests/filtr/kontrprzyklady/`): każdy przykład, na
   którym niezmiennik albo wyrocznia się nie zgodziły, zostaje na stałe jako
   test regresji (dopisanie bez zgody, usunięcie za zgodą).

### B4.4 Wyrocznia (niezależna druga implementacja)

1. **Gdzie:** `tests/filtr/wyrocznia/<obszar>.ts`. Kod tylko testowy.
   Reguła statyczna: nic z `app/`, `lib/` i `components/` jej nie importuje,
   a ona nie importuje niczego z aplikacji, nawet typów (wejście ma własny
   kształt, a mapowanie robi test różnicowy).
2. **Czysty pokój:** wyrocznię pisze osobna sesja w worktree z
   `git sparse-checkout`, w którym nie ma plików implementacji danego obszaru
   (np. bez `lib/ksiegowosc/`). Dostaje tekst przepisów (ISAP), wpisy
   rejestru, parametry roku jako dane i przykłady urzędowe. Nie dostaje kodu
   aplikacji ani jego testów. Gdy to możliwe, inny model niż autor
   implementacji.
3. **Inna arytmetyka:** `BigInt` w groszach albo ułamki zwykłe, własna funkcja
   zaokrąglenia napisana z tekstu art. 63 Ordynacji podatkowej, bez
   optymalizacji, bez bazy i bez interfejsu.
4. **Zakres:** ryczałt, ZUS, zdrowotna, zaliczki PIT, VAT z wierszy
   (deklaracja JPK_V7M), terminy i kalendarz, mikrorachunek, dzień i przeliczenie
   kursu, sumy FA(3) i korekt, sumy KPiR i JPK_PKPIR, odsetki i rekompensata.
5. **Test różnicowy:** losowe wejścia (B4.5) idą do obu wersji; każda
   różnica to błąd z najmniejszym przykładem (fast-check go zmniejsza),
   zapisanym w `tests/filtr/kontrprzyklady/`.
6. **Kto ma rację przy różnicy:** z góry nikt. Sesja sprawdza przepis
   i rejestr; poprawia błędną stronę osobnym PR; gdy przepis jest niejasny,
   pytanie trafia do `do_rozstrzygniecia`, a aplikacja pokazuje brak do
   rozstrzygnięcia.
7. **Zmiana przepisu** zmienia obie wersje w osobnych PR i osobnych
   sesjach (dwa klucze); złoty przypadek jest trzecim.

### B4.5 Testy na losowych danych i testy metamorficzne

1. **Biblioteka:** `fast-check` w `devDependencies`, przypięta wersja (D-F2).
2. **Generatory dziedzinowe** (`tests/filtr/generatory/`): faktury (stawki
   23, 8, 5, 0, zw, np, oo; PLN, EUR, USD; daty na granicach miesięcy i lat,
   w dni zmiany czasu i w święta; łańcuchy korekt; zaliczki), koszty
   (kolumny KPiR, odliczenie 100 % i 50 %), profile (formy, etapy ZUS, daty
   startu), zapłaty (daty, częściowe, ręczne), miesiące 2026-2027.
3. **Przebiegi:** w PR stałe ziarno i co najmniej 300 przypadków na
   własność; w nocy losowe ziarno i 50 000 przypadków (`filtr-noc.yml`).
   Błąd w nocy zakłada issue z ziarnem i przykładem.
4. **Relacje metamorficzne** (zmiana wejścia, o której wiadomo, jak zmienia
   wynik):

| Id | Relacja |
|---|---|
| M-01 | Podział faktury na dwie o tej samej sumie i stawce w tym samym dniu: ryczałt i PIT bez zmian; VAT w granicy zaokrąglenia opisanej w rejestrze |
| M-02 | Przesunięcie kosztu w obrębie miesiąca: bez zmian |
| M-03 | Faktura i jej pełna korekta in minus w tym samym miesiącu: wynik jak bez obu |
| M-04 | Zmiana kolejności wprowadzania danych: bez zmian |
| M-05 | Ta sama sprzedaż w walucie i w PLN po tym samym kursie: ta sama kwota w PLN |
| M-06 | Strefa serwera (`TZ`): bez zmian |
| M-07 | Dwa wygenerowania pliku z tych samych danych: identyczny plik poza datą wytworzenia |
| M-08 | Przesunięcie przychodu z grudnia na styczeń zmienia tylko te dwa miesiące i lata, do których należą |
| M-09 | Dodanie miesiąca bez zdarzeń: wcześniejsze miesiące bez zmian |

### B4.6 Schematy XSD i przykładowe pliki MF

1. Każdy generator z mapy (FA(3), JPK_V7M(3), JPK_EWP(4), JPK_PKPIR(3),
   JPK_FA(4)) ma test „losowe poprawne dane, plik przechodzi XSD” (B4.5).
2. Walidator też jest testowany: przykładowe pliki MF przechodzą, a pliki
   celowo zepsute (brak pola, zła przestrzeń nazw, zły typ) są odrzucane.
   Walidator, który przepuszcza wszystko, czerwieni test.
3. Czujka zmian schematu (dziś tylko FA(3)) obejmuje także JPK_V7M, JPK_EWP,
   JPK_PKPIR i JPK_FA (`scripts/ci/czujka-schematu-*.mjs`, jedno issue na
   wersję MF).
4. Reguły z objaśnień MF do pól (np. które pola deklaracji z których pól
   ewidencji) są w rejestrze i mają niezmienniki (NZ-VAT-01, NZ-VAT-02).

### B4.7 Środowiska testowe MF i KSeF

1. **KSeF TEST:** istniejący `ksef-test-wysylka.yml` (plan zero zgubionych
   faktur, H1a) dostaje scenariusze dla każdego rodzaju faktury z GF
   i porównanie: XML przyjęty przez KSeF, PDF i wiersz ewidencji mają te same
   kwoty. Bez nowego workflow; uzgodnić z sesją tamtego planu.
2. **MF test JPK:** nowy `jpk-mf-test.yml` co tydzień: `scripts/test-jpk-mf.ts`
   z danymi fikcyjnymi i publicznym certyfikatem testowym (bez sekretów),
   oczekiwany status 200 i UPO. Środowisko testowe MF nie sprawdza danych
   autoryzujących ani sumy kontrolnej NIP, więc potwierdza technikę, nie dane
   (pułapka z planu księgowości).
3. **Bez blokowania PR:** przerwa po stronie MF albo KSeF nie może blokować
   scalania. Błąd zakłada issue. Przed włączeniem modułu klientom (B6)
   i przed zmianą generatora albo wysyłki wymagany jest zielony przebieg
   ręczny (`workflow_dispatch`) z linkiem w karcie PR.
4. Certyfikat testowy MF wygasa 7.07.2027: czujka przypomina 60 dni wcześniej.
5. **Systemy państwowe liczone ręcznie** (wzorzec 1 z B4.0, bez API, więc
   robi to człowiek): kilkanaście ewidencji VAT wpisanych do e-mikrofirmy
   (aplikacja MF sama liczy część deklaracyjną JPK_V7M) i porównanych pole po
   polu z naszym plikiem; składki dla każdego etapu ZUS (ulga na start,
   preferencyjny, pełny, z chorobowym i bez) porównane z e-Płatnikiem w eZUS.
   Robi to księgowa albo Bartosz przed każdym nowym rokiem parametrów i przy
   każdej zmianie obliczeń VAT albo ZUS; wynik to protokół
   w `docs/filtr/PROTOKOLY-RECZNE.md` z datą i wersją kodu. Lista kontrolna
   jest w `docs/runbooks/filtr.md`.

### B4.8 Reguły statyczne z zapadką

Najpierw wbudowane reguły ESLint `no-restricted-syntax` i
`no-restricted-imports` z wzorcami plików z mapy, tak jak dziś granica danych
przykładowych w `eslint.config.mjs` (PLAN-PRAWDZIWE-DANE §5.2). Lokalna
wtyczka (`eslint/filtr/*.mjs`, bez nowej zależności) tylko tam, gdzie wzorzec
składni nie wystarczy (np. lista słów w tekstach):

| Reguła | Gdzie | Co zabrania |
|---|---|---|
| `filtr/kwoty-bez-float` | silniki R1 | `Math.round`, `toFixed`, `parseFloat` na kwotach poza jednym modułem kwot i zaokrągleń |
| `filtr/liczby-z-rejestru` | silniki księgowości, szacunki pulpitu | literałów równych znanym liczbom prawnym (stawki, progi, limity, kwoty ZUS) poza `parametry/`; w generatorach FA(3) i JPK dozwolone kody stawek ze schematu |
| `filtr/data-warszawa` | R1 i R3 | liczenia miesiąca i dnia z `new Date()` bez pomocników `lib/format/warsaw-date.ts` |
| `filtr/bez-trybu-testowego` | R1 | `process.env.VITEST`, `NODE_ENV === 'test'` i podobnych gałęzi |
| `filtr/bez-porad` | teksty R1 i R2 | słów z listy NZ-TRESC-01 w literałach widocznych dla klienta |
| `filtr/wyrocznia-osobno` | całe repozytorium | importu `tests/filtr/wyrocznia/` spoza testów i importu aplikacji w wyroczni |
| `filtr/testy-bez-pomijania` | `tests/filtr/` | `.skip`, `.only`, `.todo` i `vi.mock` modułów R1; `.fails` tylko z odwołaniem do otwartego FZ |

Zapadka (`filtr/zapadka.json`): naruszenia w kodzie sprzed filtra są
spisane według pliku i reguły; liczba może tylko maleć. Nowe naruszenie
czerwieni lint. Wzrost liczby w zapadce to zmiana filtra (zgoda).
Pojedynczy wyjątek: komentarz `// filtr-wyjatek: <reguła> <powód>` i etykieta
`zgoda:wyjatek-filtra`.

### B4.9 Lista kontrolna prawna (drugi czytelnik)

Plik `docs/filtr/LISTA-KONTROLNA.md`, wspólny dla Claude (skill `/filtr`)
i Codexa (`AGENTS.md`). Drugi czytelnik to osobna sesja, która nie pisała
zmiany. Odpowiada na każde pytanie z plikiem i linią albo „nie dotyczy, bo…”:

1. Który przepis z rejestru (id)? Czy data obowiązywania obejmuje okresy,
   które kod liczy?
2. Czy źródło jest urzędowe? Jeśli branżowe: pewność „niska” i pytanie do
   księgowej.
3. Zaokrąglenia: która reguła, w którym miejscu (pozycja, suma, podstawa,
   podatek), co z kwotami ujemnymi?
4. Czy kwoty są groszami od wejścia do wyjścia? Jak wchodzą z bazy (typ
   `numeric` jako tekst)?
5. Granice czasu: miesiąc w Warszawie, ostatni dzień miesiąca, rok, rok
   składkowy zdrowotnej (luty-styczeń), rok stopy wypadkowej
   (kwiecień-marzec), zmiana czasu, rok przestępny.
6. Terminy: dzień ustawowy, przesunięcie z weekendu i święta, grudzień
   i styczeń.
7. Waluty: kurs, dzień kursu, tabela, brak kursu.
8. Korekty: okres ujęcia, łańcuch korekt, korekta większa niż przychód.
9. Zaliczki: brak dublowania, rozliczenie w fakturze końcowej.
10. Faktura do paragonu, faktury spoza KSeF, środowisko KSeF (test
    i produkcja).
11. Brak danych: komunikat z nazwą braku, wyjście dla klienta i operatora;
    nigdy 0 zamiast braku.
12. Parametry: tylko z rejestru; podpis księgowej; następny rok.
13. Wersje i niezmienność zatwierdzonych rozliczeń.
14. Ponowienie zadania od zera: idempotencja maila, pusha, wysyłki JPK
    i KSeF.
15. Odczyt stronami (1000 wierszy PostgREST).
16. Treści: bez porad i trybu rozkazującego; podpis „według Twoich danych”;
    „FaktWay”; bez długich myślników.
17. Dane osobowe: co zapisujemy, co logujemy, jak długo; dane autoryzujące
    nigdzie.
18. Wyłącznik i podpis księgowej: czy nowa ścieżka je respektuje?
19. Dowody: test czerwony przed zmianą; niezmienniki dotkniętych reguł;
    wyrocznia; złote przypadki; XSD; test na bazie dla wyzwalaczy.
20. Wszystkie wystąpienia: czy ta sama reguła jest liczona gdzie indziej
    (drugi generator, pulpit, eksport, FLO, PDF)?
21. Co zobaczy klient, jeśli to jest źle, i czy ten obszar działa dziś dla
    wszystkich firm?

Wynik przeglądu idzie do karty PR (B5.6).

### B4.10 Strażnicy w działającej aplikacji

Ostatnia linia: kontrola spójności tuż przed pokazaniem, pobraniem albo
wysyłką. Moduł `lib/bezpieczniki/` (czyste funkcje), po jednym na dokument:

| Gdzie | Co sprawdza | Co przy błędzie |
|---|---|---|
| „Ten miesiąc” przed pokazaniem, zatwierdzeniem i powiadomieniem | grosze całkowite, podatki w pełnych złotych, sumy pozycji, brak kwot bez podpisu (D7) | pozycja staje się brakiem z komunikatem „Tej kwoty nie pokazujemy, bo kontrola spójności wykryła błąd po naszej stronie. Zgłosiliśmy go.” |
| JPK_V7M, JPK_EWP, JPK_PKPIR przed pobraniem i wysyłką | XSD, sumy kontrolne, zgodność deklaracji z ewidencją | odmowa pliku z komunikatem i kodem |
| FA(3) przed wysyłką do KSeF | NZ-FA-01, NZ-FA-02, NZ-FA-03, XSD (już jest) | faktura czeka z komunikatem, operator dostaje alarm |
| Przypomnienia o terminach | termin w dniu roboczym, kwota z podpisem | przypomnienie nie wychodzi, alarm |

Każdy alarm ma kod `FILTR-RT-<id>`: Sentry, `critical-alerts-monitor`
(Telegram, issue) i wiersz w `/admin/centrum`. Ścieżka operatora w
`docs/runbooks/filtr.md`. Dla faktur najpierw tryb „tylko alarm” przez
2 tygodnie (D-F7), w module od razu blokada.

### B4.11 Miara siły filtra

1. **Testy mutacyjne** (`filtr-mutacje.yml`, co tydzień i ręcznie): Stryker
   z uruchamianiem Vitest, jeśli działa z Vitest 4 (sprawdzić w F16); jeśli nie,
   własny prosty mutator (`scripts/filtr/mutacje.mjs`: zamiany `+`/`-`,
   `<`/`<=`, `Math.floor`/`Math.ceil`, stałe ±1, usunięcie warunku). Cel dla
   silników R1: co najmniej 90 % zabitych mutantów; każdy ocalały opisany
   w raporcie (równoważny albo brakujący test).
2. **Próba ogniowa** (`docs/filtr/PROBA-OGNIOWA.md`): lista prawdziwych
   błędów R1 z historii repozytorium. Materiału jest dużo: od lipca 2026
   ok. 70 commitów z poprawkami w katalogach R1 (np. K4 druga korekta i K1
   numer faktury abonamentu z rewizji 3.10, data sprzedaży do 60 dni (P-11),
   np. II dla Irlandii Północnej (AUD-70), koszty w walucie (C-11), 33
   potwierdzone ustalenia drugiego czytelnika w K4 i poprawki z przeglądów
   K5-K7.1).
   Dla każdego: tymczasowa gałąź, cofnięcie poprawki **razem z testem
   regresji dopisanym przy niej**, przebieg filtra. Cel: 100 % złapanych przez
   pozostałe warstwy. Niezłapany błąd to nowy niezmiennik.
3. **Kanarek:** w testach filtra stały, celowo zły silnik (np. zaokrąglenie
   w dół), który filtr musi odrzucić. Jeśli kiedyś przejdzie, filtr jest
   zepsuty.

### B4.12 Prawdziwe dane: pilotaż i kontrola po starcie

Najmocniejszy test poza systemem państwowym (wzorzec 2 z B4.0):

1. **Na starcie pilotażu (B6),** za pisemną zgodą firmy i z zapisem w umowie
   powierzenia: jej ostatnie 12 miesięcy faktur i kosztów oraz to, co jej
   księgowa naprawdę złożyła i co urząd przyjął (JPK_V7 z UPO, DRA, wpłaty PIT
   i składek). FaktWay przelicza to samo; porównanie co do grosza. Każda
   różnica to nasz błąd albo inna decyzja księgowej; rozstrzyga księgowa
   z bramy B4, a wynik idzie do rejestru (pole `interpretacja`) albo jako FZ.
2. **Dane zostają na produkcji w UE.** Do testów w repo trafiają tylko
   zanonimizowane przypadki z fikcyjnym NIP `1234567890`, jako nowe złote
   przypadki (za `zgoda:wiedza-prawna`).
3. **Po starcie co miesiąc:** wynik „Ten miesiąc” porównany z tym, co urząd
   i ZUS przyjęli (UPO, stan konta w PUE ZUS wpisany przez klienta albo
   księgową); przez pierwsze dwa miesiące sprawdza księgowa (B6), potem
   automat zakłada alarm `FILTR-RT-ROZNICA` przy każdej różnicy.
4. Zakres i okres przechowywania tych danych rozstrzyga prawnik (pytanie 6
   w `PYTANIA-DO-PRAWNIKA.md`).

## B5. Gdzie działa

### B5.1 Instrukcje dla agentów

- `AGENTS.md`: nowa krótka sekcja „Żelazny filtr” (F3) z poziomami,
  wymaganymi dowodami, zakazem nadawania etykiet `zgoda:*` i odnośnikiem do
  `docs/filtr/LISTA-KONTROLNA.md`; w protokole naprawy błędu pkt 2 (czerwony
  test w obszarze R1 to niezmiennik albo przykład, nie tylko punkt), pkt 6
  (`pnpm filtr:lokalnie` i lista kontrolna) i pkt 7 (karta zmiany). Czytają to
  Claude (`CLAUDE.md` importuje `AGENTS.md`), Codex u Igora (czyta `AGENTS.md`
  sam) i agent na GitHubie (`agent.yml`, `--append-system-prompt`).
- Odsyłacze w planach, które budują funkcje (księgowość, pełna aplikacja):
  „przed krokiem R1 i R2 sprawdź fazę filtra dla obszaru”.

### B5.2 Claude Code: hooki i skill

Wszystko w `.claude/settings.json` w gicie, więc działa w każdej sesji Claude
w tym repozytorium na każdym komputerze (lokalne `settings.local.json` może
hooki wyłączyć, dlatego to tylko warstwa ostrzegawcza).

| Hook | Skrypt | Co robi |
|---|---|---|
| PostToolUse `Edit\|Write\|MultiEdit` | `scripts/filtr/po-edycji.sh` (obok istniejącego lintu) | klasyfikuje plik; dla R1 i R2 dokłada sesji kontekst (`additionalContext`): obszar, poziom, reguły z rejestru wskazujące ten plik, wymagane dowody, polecenie `pnpm filtr:lokalnie`; uruchamia reguły statyczne na pliku; błąd kończy się kodem 2, więc sesja poprawia od razu |
| PreToolUse `Bash` | `scripts/filtr/przed-poleceniem.sh` | odmawia: `git push --no-verify`, `SKIP_PREPUSH=1`, nadania albo zdjęcia etykiety `zgoda:*` (`gh pr edit`, `gh label`, `gh api …/labels`), zmian reguł repozytorium (`gh api` z `rulesets`, `branches/*/protection`, metody inne niż GET), `gh pr merge --admin` |
| SessionStart | istniejący `przygotuj-worktree.sh` | bez zmian; od F3 sprawdza też, czy hook pre-push jest włączony |

Do tego `permissions.deny` dla tych samych poleceń (pierwsza linia obrony,
dopasowanie po prefiksie) i skill `.claude/skills/filtr/SKILL.md` (dostępny
także dla modelu): „Użyj, gdy zmiana dotyka pliku z mapy ryzyka
(`filtr/mapa-ryzyka.json`) albo przed PR z takimi plikami: lista kontrolna,
karta zmiany, `pnpm filtr:lokalnie`”. Drugi czytelnik (`/code-review`) dostaje
listę kontrolną jako wejście.

### B5.3 Pre-push i instalacja na każdym komputerze

1. `.githooks/pre-push` dostaje krok filtra: gdy push dotyka plików R1 lub R2
   (klasyfikator z mapą z wysyłanego drzewa), uruchamia `pnpm filtr:lokalnie`:
   reguły statyczne zmienionych plików, testy prawne dotkniętych obszarów
   (konfiguracja `vitest.filtr.config.ts`, jeden wątek) i rejestr. Budżet:
   do 3 minut. Pomijanie (`SKIP_PREPUSH=1`, `--no-verify`) zostaje dla
   awarii, ale w Claude blokuje je hook, a CI i tak powtarza wszystko.
2. Instalacja wszędzie: w `package.json` skrypt `prepare`
   (`node scripts/dev/wlacz-hooki.mjs`), który przy każdym `pnpm install`
   ustawia `core.hooksPath .githooks`. Skrypt nigdy nie kończy się błędem: poza
   repozytorium git (obraz Docker, `pnpm install --frozen-lockfile` w
   `Dockerfile:34`) i w CI nic nie robi. Tak hook dostaje każdy komputer, także
   Igora i pozostałych osób z dostępem, bez pamiętania o skrypcie.
3. Codex: skille i hooki Claude go nie dotyczą. Dla Codexa działają
   instrukcje w `AGENTS.md`, hook pre-push (z `pnpm install`) i CI.

### B5.4 GitHub: kontrole i ustawienia

**Nowe workflow:**

| Plik | Zdarzenie | Job (nazwa kontroli) | Co robi |
|---|---|---|---|
| `filtr-straz.yml` | `pull_request_target` (`opened`, `synchronize`, `reopened`, `edited`, `labeled`, `unlabeled`, `ready_for_review`) | **Filtr: straż** | kod i mapa z `main`; z PR czyta przez API tylko dane: listę plików z liczbą linii, fragmenty zmian, mapę i rejestr z PR (JSON), opis PR, etykiety i ich autorów. **Kodu z PR nie pobiera i nie uruchamia**, więc PR nie osłabi kontroli, która go ocenia (ten sam wzór co `agent-guard.yml`). Uprawnienia: `contents: read`, `pull-requests: write` (zdjęcie zgód po pushu), `issues: read`; bez sekretów |
| `filtr.yml` | `pull_request` | **Filtr: testy prawne** (zbiera wyniki) | Vitest z `vitest.filtr.config.ts` wywołany wprost w pliku workflow (nie przez skrypt z `package.json`, żeby zmiana skryptu nie osłabiła joba), w dwóch częściach (`TZ=Europe/Warsaw`, `TZ=UTC`): rejestr, mapa, niezmienniki, wyrocznia, przykłady, złote pliki, XSD, reguły statyczne; do tego test-first dla wszystkich autorów, nie tylko agenta: zmiana kodu R1 z nowymi albo zmienionymi testami, które przechodzą na `main`, czerwieni job, chyba że karta mówi „refaktor bez zmiany zachowania” albo „tylko testy”; `xmllint`; bez sekretów |
| `filtr-noc.yml` | harmonogram (noc) | raport | 50 000 przypadków z losowym ziarnem, cztery strefy czasowe; błąd zakłada issue |
| `filtr-tydzien.yml` | harmonogram (tydzień) | raport | testy mutacyjne, MF test JPK, czujki schematów JPK, czujka przepisów, raport stanu filtra |

`tests/filtr/` wychodzi z głównej konfiguracji Vitest do
`vitest.filtr.config.ts`, żeby testy nie szły dwa razy.

**Logika straży** (`scripts/filtr/straz.mjs`, testy `node --test`):

1. Klasyfikacja plików mapą z `main` i z PR (B3), poziom PR to najwyższy
   poziom pliku. Podsumowanie joba: tabela plik, obszar, poziom.
2. Pliki niesklasyfikowane z sygnałem: czerwień z poleceniem dopisania do
   mapy.
3. Zmiany chronione:

| Zmiana | Wymaga |
|---|---|
| maszyneria filtra: `.github/workflows/**`, `scripts/filtr/**`, `scripts/ci/**`, `eslint/filtr/**`, `eslint.config.mjs`, `vitest.filtr.config.ts`, `.githooks/**`, `.claude/**`, `.github/pull_request_template.md`, `filtr/zgody.json`, wzrost `filtr/zapadka.json`, osłabienie mapy, usunięta albo zmieniona linia w `tests/filtr/**` (dopisywanie jest wolne). `package.json` i zależności nie są tu potrzebne, bo job filtra nie korzysta ze skryptów z `package.json`; zależności pilnują dziś `dependency-review` i kwarantanna Renovate | `zgoda:zmiana-filtra` |
| wiedza prawna: `filtr/przepisy/**`, `lib/ksiegowosc/parametry/**`, `tests/fixtures/ksiegowosc/zlote/**`, `tests/filtr/zlote-tymczasowe/**`, `tests/filtr/zlote-pliki/**`, `tests/filtr/przyklady-urzedowe/**`, `tests/filtr/wyrocznia/**`, schematy `lib/**/schemas/**`, lista słów D8 | `zgoda:wiedza-prawna` i pole „Źródło zmiany” w karcie |
| wyjątki: nowy komentarz `filtr-wyjatek`, kod R1 bez testu w `tests/` | `zgoda:wyjatek-filtra` i uzasadnienie w karcie |

4. Etykieta liczy się tylko od osoby z `filtr/zgody.json` (z `main`; dziś
   `ezior8888-cpu`). Każdy nowy push zdejmuje etykiety `zgoda:*`.
5. PR R1 i R2: karta zmiany (B5.6) z wypełnionymi polami; dla R1 pole
   „Przepisy” wskazuje istniejące id z rejestru, a „Dowody” pliki testów
   istniejące w PR albo w repo; zmiana kodu R1 ma zmieniony albo nowy test
   w `tests/`.
6. Komunikat błędu mówi: który wymóg, które pliki, co zrobić, kto może
   zrobić wyjątek.

`agent-guard.yml` zostaje bez zmian (pilnuje agenta z GitHuba także poza
mapą).

**Ustawienia GitHuba, krok po kroku (robi Bartosz):**

Po scaleniu F2, gdy „Filtr: straż” pojawi się raz na dowolnym PR (kontrola
`pull_request_target` działa dopiero z pliku w `main`, więc PR, który ją
dodaje, sam jej jeszcze nie ma):

1. github.com, repozytorium `ezior8888-cpu/FaktWay`, **Settings**.
2. Po lewej **Rules**, potem **Rulesets**, kliknij „main - ochrona
   podstawowa”.
3. Sekcja **Require status checks to pass**: **Add checks**, wpisz
   `Filtr: straż`, wybierz z listy (źródło GitHub Actions). Tak samo
   `RLS isolation (lokalny Supabase)` (D-F8).
4. Zostaw zaznaczone **Require branches to be up to date before merging**.
5. Sekcja **Require a pull request before merging**, pole **Allowed merge
   methods**: zostaw tylko **Merge** (D-F6).
6. Sprawdź, że **Bypass list** jest pusta.
7. **Save changes** na dole strony.
8. Settings, **Actions**, **General**, sekcja o zatwierdzaniu przebiegów
   z forków (PR od osób spoza repozytorium): wybierz najostrzejszą opcję,
   czyli zatwierdzanie dla wszystkich zewnętrznych współtwórców
   (repozytorium jest publiczne). Straż i tak nie uruchamia ich kodu; chodzi
   o to, żeby obcy PR nie zużywał minut Actions bez Twojej wiedzy.

Po scaleniu F5 to samo dla `Filtr: testy prawne` (krok 3). Po F18 (konto
agentów) w sekcji **Require a pull request before merging**: **Required
approvals** 1, **Require review from Code Owners**, **Dismiss stale pull
request approvals when new commits are pushed**, **Require approval of the
most recent reviewable push**.

Etykiety `zgoda:zmiana-filtra`, `zgoda:wiedza-prawna`, `zgoda:wyjatek-filtra`
i `filtr` zakłada sesja w F2 za zgodą Bartosza, zanim hook z F3 zacznie
blokować polecenia z `zgoda:`.

### B5.5 Osobne konto agentów (wariant pełny, F18)

1. Bartosz zakłada konto GitHub dla agentów (np. `faktway-agent`) na osobny
   adres e-mail, z 2FA.
2. Repozytorium, **Settings**, **Collaborators**, **Add people**: to konto
   z prawem zapisu (w repozytorium konta osobistego współpracownik nie zmienia
   ustawień ani reguł).
3. Na Macu: `gh auth login` tym kontem (pęk kluczy trzyma oba, `gh auth
   switch` wybiera); sesje pushują i otwierają PR jako agent.
4. Ruleset jak w B5.4 (wymagana akceptacja i Code Owners).
5. `CODEOWNERS`: wszystkie ścieżki R1 i R2 z mapy (test z B3 pkt 4 pilnuje
   zgodności).
6. Skutek: agent nie zaakceptuje własnego PR i nie nada ważnej etykiety;
   scalenie wymaga Twojego kliknięcia „Approve” w przeglądarce albo aplikacji
   GitHub. To kliknięcie zastępuje „scal #N” w czacie. PR, którego autorem
   jesteś Ty sam, wymaga akceptacji kogoś innego (unikać: kod piszą agenci).

### B5.6 Karta zmiany prawnej w PR

Nowa sekcja w `.github/pull_request_template.md` (F2). Dla PR R0 wystarczy
„n/d”; dla R1 i R2 straż wymaga pól:

```markdown
## Karta zmiany prawnej (filtr)

- Poziom i obszary z mapy:
- Rodzaj: naprawa / nowa funkcja / refaktor bez zmiany zachowania / tylko testy / tylko wiedza
- Przepisy z rejestru (id) albo nowy przepis ze źródłem:
- Źródło zmiany wiedzy (Dz.U., ISAP, MF, ZUS, podpis księgowej) albo n/d:
- Co zmienia się dla klienta (kwoty, terminy, pliki, teksty, nic):
- Zaokrąglenia i kwoty ujemne:
- Granice czasu (miesiąc, rok, rok składkowy, strefa):
- Waluty, korekty, zaliczki:
- Brak danych: komunikat dla klienta i ścieżka operatora:
- Treści (D8) i dane osobowe:
- Dowody: test czerwony przed zmianą, niezmienniki, wyrocznia, przykłady, XSD:
- Drugi czytelnik z listą kontrolną (kto, wynik, odpowiedzi na uwagi):
- Wyjątki od filtra (etykieta, powód) albo brak:
```

Refaktor bez zmiany zachowania: złote pliki i wyniki wyroczni nie mogą się
zmienić, a test-first nie dotyczy. „Tylko testy”: test-first nie dotyczy,
nowe testy przechodzą na `main`.

## B6. Gdy filtr coś złapie

**Format komunikatu** (wszędzie ten sam):

```
[FILTR R1 ksiegowosc.silniki] NZ-PIT-02 złamany: dodanie kosztu podniosło zaliczkę.
Przepis: RP-PIT-03 (art. 44 ust. 3f ustawy o PIT).
Przykład: tests/filtr/kontrprzyklady/NZ-PIT-02-<skrót>.json (ziarno 4711, przypadek 128).
Wynik: 1 234 zł przed, 1 236 zł po dodaniu kosztu 100 zł w marcu 2027.
Co zrobić: przykład to gotowy czerwony test; napraw przyczynę według protokołu (AGENTS.md).
Wyjątek: brak (testy prawne nie mają wyjątku); gdy myli się filtr, osobny PR z etykietą zgoda:zmiana-filtra.
```

**Gdzie i co dalej:**

| Gdzie złapał | Co się dzieje | Kto naprawia |
|---|---|---|
| hook Claude po edycji | sesja dostaje błąd (kod 2) i poprawia od razu | ta sama sesja |
| pre-push | push zatrzymany, ostatnie linie testów | autor |
| „Filtr: straż” | PR czerwony, lista brakujących wymogów | autor; zgody Bartosz |
| „Filtr: testy prawne” | PR czerwony, kontrprzykład w podsumowaniu joba | autor według protokołu |
| noc i tydzień | issue z etykietą `filtr`, ziarnem i przykładem | Bartosz decyduje: sesja albo `agent:napraw` |
| aplikacja (strażnik) | klient widzi komunikat zamiast kwoty; alarm `FILTR-RT-*` | operator według runbooka, potem naprawa według protokołu |

**Wyjątki** (`docs/filtr/WYJATKI.md`): data, PR, reguła, powód, kto, do kiedy,
FZ do zamknięcia. Wyjątek zwalnia tylko z wymogu straży (karta, test-first,
reguła statyczna), nigdy z czerwonego testu prawnego.

**Awaria filtra** (`docs/runbooks/filtr.md`): gdy filtr sam blokuje pilną
poprawkę produkcji:

1. Jeśli czerwony jest wymóg straży: `zgoda:wyjatek-filtra` z powodem.
2. Jeśli czerwony jest test prawny, a poprawka dotyczy czego innego: najpierw
   osobny PR poprawiający test albo filtr (za zgodą), potem poprawka.
3. Ostateczność: Bartosz zdejmuje kontrolę z wymaganych (B5.4 krok 3
   odwrotnie), scala, przywraca ją tego samego dnia i wpisuje wyjątek.
4. W ciągu 24 godzin sesja uruchamia pełny filtr na `main` i zapisuje wynik.
5. Każda awaria filtra to FZ z przyczyną i testem filtra.

## B7. Przegląd wsteczny

**Zasady:** sesje przeglądu tylko czytają, uruchamiają filtr na `main`
i zapisują znaleziska; nie naprawiają (rozdzielenie znajdowania i naprawy,
jak w rewizji z 3.10). Narzędzia z faz I i II muszą być gotowe dla obszaru,
zanim zacznie się jego przegląd.

**Obszary i kolejność:**

| # | Obszar | Kroki planu | Rozmiar |
|---|---|---|---|
| P1 | parametry, kalendarz, terminy, mikrorachunek | K1 | N |
| P2 | profil podatkowy i wyłącznik | K1, K2, K8 | N |
| P3 | ewidencja przychodów i JPK_EWP | K3 | Ś |
| P4 | ryczałt, ZUS, zdrowotna | K4 | D |
| P5 | „Ten miesiąc”: rozliczenia, wersje, zapłaty, zapłaty spoza wyliczenia, przypomnienia, „Odłóż na podatek” | K4, K5, K7.1, K7.2 | Ś |
| P6 | VAT, JPK_V7M, wysyłka JPK | K6, K7.1 | Ś |
| P7 | KPiR, PIT, zdrowotna od dochodu, FP, spis z natury, JPK_PKPIR | K7, K7.3, K7.4 | D |
| P8 | treści modułu (D8) i dane osobowe | K3, K6, K7 | N |
| P9 | faktury FA(3), korekty, zaliczki, waluty, KSeF, PDF | działa dla wszystkich | D |
| P10 | eksporty, raport KPiR, pulpit, wezwania i odsetki, abonament, import, koszty, retencja | działa dla wszystkich | D |

**Każda sesja przeglądu:**

1. Czyta wpisy rejestru obszaru i tekst przepisów.
2. Uruchamia na `main` niezmienniki, wyrocznię, przykłady urzędowe i XSD
   obszaru.
3. Przechodzi każdy plik obszaru z listą kontrolną (B4.9).
4. Sprawdza każdą regułę z planu księgowości (sekcje 4, 5, 13): kod, test,
   wynik.
5. Zapisuje znaleziska i STOP.

**Rejestr znalezisk** `docs/filtr/USTALENIA.md`:

| Id | Data | Obszar | Plik:linia | Przepis | Co jest źle dla klienta | Dowód | Waga | Widoczne dziś | Stan |
|---|---|---|---|---|---|---|---|---|---|

Wagi: **KRYT** zła kwota, termin albo dokument R1 przy typowych danych;
**WYS** zła kwota w rzadkim przypadku albo brak fail-closed; **ŚRED** błąd R2
albo brak testu przy poprawnym wyniku; **NISK** czytelność i dokumentacja.

**Co z tym robimy:**

1. Jedno FZ to jedna gałąź `claude/fz-NN-<temat>` od `origin/main` i jeden PR,
   najpierw czerwony test (dowód ze znaleziska), naprawa przyczyny we
   wszystkich wystąpieniach (pkt 3 protokołu).
2. Kolejność: KRYT i WYS z obszarów działających dziś dla wszystkich firm;
   KRYT i WYS modułu przed pilotażem (B6); ŚRED przed włączeniem modułu dla
   wszystkich; NISK później.
3. Kod jest na produkcji za wyłącznikiem i żadna firma nie ma modułu, więc
   naprawy modułu nie wymagają pilnego wdrożenia: idą z najbliższym wydaniem.
4. Sprawy interpretacyjne nie są naprawą kodu: idą do `do_rozstrzygniecia`
   w rejestrze i na listę dla księgowej albo prawnika; do rozstrzygnięcia
   program pokazuje brak.
5. „Naprawione” wpisuje ktoś inny niż autor, z plikiem i linią na `main`
   (pkt 8 protokołu). Niezmiennik oznaczony `.fails` z numerem FZ zmienia się
   w zwykły test w PR naprawy.
6. Po każdym obszarze krótki raport dla Bartosza: liczba FZ według wag, co
   pilne.

### B7.1 Pierwsze sygnały z rozpoznania (8.11.2026)

Przegląd całego kodu do tej mapy (jedna sesja pomocnicza, tylko odczyt)
już wskazał miejsca, które wyglądają na błędy. To nie są jeszcze FZ: każdy
sygnał staje się znaleziskiem dopiero wtedy, gdy czerwony test go potwierdzi
(F11, F12). Kolumna „Stan” mówi, co sprawdziła ta sesja, a „Dziś” mówi, czy
skutek może dziś dotknąć firmę (klientów jeszcze nie ma).

| # | Sygnał | Dowód | Stan | Dziś | Waga wstępna |
|---|---|---|---|---|---|
| S-01 | Korekta „przed/po” w JPK_V7M: pozycje korekty to stan „po”, nagłówek to różnica; JPK_V7M sumuje pozycje, więc wykazałby całą kwotę „po” zamiast różnicy. To samo może dotyczyć podsumowania VAT w PDF korekty | `components/invoices/correction-actions.ts:330` (pozycje „po”) i `:498` (`fa3_data`), `lib/exports/data-fetcher.ts:383`, `lib/exports/jpk-v7m-generator.ts:140` | potwierdzony odczytem kodu, bez testu; PDF do sprawdzenia | nie: korekty wstrzymane na produkcji (`lib/ksef/kind-holds.ts`), eksport JPK_V7M wyłączony, moduł za wyłącznikiem | KRYT; przed zdjęciem wstrzymania korekt i przed pilotażem |
| S-02 | Okres VAT według daty wystawienia (`issue_date`) dla sprzedaży i kosztów, choć obowiązek podatkowy powstaje co do zasady z dostawą (art. 19a ust. 1 ustawy o VAT), a prawo do odliczenia nie wcześniej niż w okresie otrzymania faktury (art. 86 ust. 10b; w KSeF data nadania numeru); brak metody kasowej w JPK (faktura z `P_16`); `TypKorekty` domyślnie „2” | `lib/exports/data-fetcher.ts:182-183` (koszty) i `:292-293` (sprzedaż); brak obsługi metody kasowej w `jpk-v7m-generator.ts` i `lib/ksiegowosc/vat*.ts`; `fa3-correction-generator.ts` | daty potwierdzone; reguły do rejestru i pytanie do księgowej | nie (jak S-01) | WYS |
| S-03 | Koszty z OCR i ze skrzynki KSeF liczą się w KPiR i JPK bez przeglądu człowieka; VAT do odliczenia zawsze pełny, bez reguły 50 % dla samochodu (art. 86a) | `expenses.is_deductible DEFAULT TRUE` (00034:81), `lib/jobs/runners/{process-ocr,auto-categorize-inbox}.ts` | wartość domyślna potwierdzona, reszta do sprawdzenia | raporty i pulpit tak, JPK nie | WYS |
| S-04 | Brak oznaczeń GTU i procedur w wierszach JPK_V7M dla faktur wystawionych w FaktWay | `lib/exports/jpk-v7m-generator.ts` (0 wystąpień „GTU”) | potwierdzony | nie (jak S-01) | WYS; przed pilotażem i włączeniem wysyłki JPK |
| S-05 | XLSX KPiR dla księgowej liczy koszt bez kolumny w kolumnie 13, a ekran KPiR i JPK_PKPIR go pomijają, więc sumy się różnią | `lib/exports/kpir-generator.ts:36-46` (`kpirCostColumn(null)` daje 13) | potwierdzony | tak (eksport KPiR) | WYS |
| S-06 | Termin VAT na pulpicie zawsze 25. następnego miesiąca, bez przesunięcia z weekendu i święta | `lib/dashboard/monthly-figures.ts:316` | potwierdzony | tak (pulpit) | ŚRED (pokazuje termin wcześniejszy niż prawdziwy) |
| S-07 | Umowa powierzenia obiecuje usunięcie danych w 30 dni po 30 dniach na eksport, a kod trzyma faktury ok. 10 lat; teksty FAQ „po 30 dniach permanentnie usuwane” leżą w kodzie bez importera | `lib/legal/documents/umowa-powierzenia.ts:131-135`, `components/marketing/faq-section.tsx:18`, `lib/marketing/landing-faqs.ts:19`, `lib/jobs/runners/{archive-old-invoices,retention-delete}.ts` | potwierdzony odczytem; rozstrzyga prawnik (B5) | umowa tak, FAQ nie | WYS |
| S-08 | Wpis na blogu o KSeF z datami obowiązku, karami i zdaniem o nieważności faktury poza KSeF | `content/blog/ksef-2026-co-musi-wiedziec-mikrofirma.mdx` | do sprawdzenia przez prawnika (D8) | tak | ŚRED |
| S-09 | PDF UPO na wbudowanej czcionce Helvetica, która według `lib/pdf/invoice-renderer.ts` nie ma polskich znaków; wezwanie do zapłaty do sprawdzenia | `lib/ksef/upo-pdf-generator.ts:53-87` | czcionka potwierdzona, wydruk nie | tak | ŚRED (dowodem jest UPO w XML) |
| S-10 | Import CSV czyta „-1.234,56” jako −1,234 i „1.234” jako 1,234, usuwa „EUR” i „USD” i traktuje kwotę jak PLN; data domyślna to „dziś” w UTC | `lib/import/csv-parsers/csv-helpers.ts:5-19`, `:42`, `:63` | potwierdzony odczytem kodu | tak (import tworzy szkice) | WYS |
| S-11 | Faktury FaktWay: bez `FAKTFLOW_OPERATOR_TENANT_ID` nie powstaje faktura VAT; zwrot po fakturze to „sprawa finansowa”, a nie faktura korygująca; przed wysyłką zwykłej faktury i faktury abonamentu brak kontroli daty wystawienia po północy (art. 106na) | `lib/billing/operator-config.ts:31`, migracje 00079 i 00080, `lib/jobs/runners/submit-invoice.ts` | zmienna potwierdzona, reszta do sprawdzenia | przy pierwszej płatności | WYS |
| S-12 | Czat pomocy (model językowy): zakaz porad podatkowych tylko w poleceniu dla modelu, bez klasyfikatora tematów jak w FLO | `lib/support/chat.ts:43`, porównaj `lib/flo/tax-topic.ts` | potwierdzony | tak, gdy czat jest włączony | ŚRED |
| S-13 | Biała lista: nic nie wyklucza z kosztów zapłaty powyżej 15 000 zł na rachunek spoza wykazu (art. 22p ustawy o PIT) | `lib/validation/whitelist-client.ts`, silniki KPiR | do sprawdzenia | nie dla PIT (moduł za wyłącznikiem), tak dla ostrzeżeń | WYS przed pilotażem |
| S-14 | `audit_logs` czyszczone po 12 miesiącach, a trzymają ślady wysyłek do MF i zatwierdzeń rozliczeń, które mogą być dowodem dłużej | `lib/jobs/runners/cleanup-audit-logs.ts`, migracje 00044, 00052, 00104, 00157 | do sprawdzenia, decyzja prawnika | tak | ŚRED |
| S-15 | `formatPln` pokazuje −0,50 zł jako „0,50 zł” | `lib/billing/pricing.ts:34-37` | potwierdzony | tylko przy kwotach ujemnych | NISK |
| S-16 | Czujka schematu FA(3) i runbook pytają `CIRFMF/ksef-docs`, które MF przemianowało na `CIRFMF/ksef-api`; działa tylko dzięki przekierowaniu GitHuba | `scripts/ci/czujka-schematu-fa3.mjs:38`, `docs/runbooks/fa3-ksef.md:53` | potwierdzony (API GitHub 8.11.2026) | tak (czujka co tydzień) | NISK; poprawka w F9 |

Kiedy je naprawiać, rozstrzyga decyzja D-F9 (A11).

## B8. Ograniczenia i jak je zmniejszamy

| Ograniczenie | Jak zmniejszamy |
|---|---|
| Wspólny błąd w rozumieniu przepisu (rejestr, kod i wyrocznia mylą się tak samo) | wyrocznia z tekstu ustawy w czystym pokoju; przykłady urzędowe; złote przypadki księgowej liczone bez wyników programu; podpisy w rejestrze; pilotaż z kontrolą księgowej |
| Zmiany przepisów i komunikatów | daty obowiązywania; czujka przepisów (ELI API Sejmu dla Dz.U. i M.P., odcisk liczb na stronach ZUS i MF, F15); kalendarz ogłoszeń; czujki schematów i wydań `CIRFMF/ksef-api`; bezpiecznik roku; fail-closed bez podpisu |
| Przypadki, których nikt nie przewidział | niezmienniki ogólne zamiast tylko przykładów; losowe dane w nocy; strażnicy w aplikacji; jawny brak dla nieobsługiwanych sytuacji (np. odwrotne obciążenie) |
| Systemy zewnętrzne (MF, KSeF, NBP) bywają niedostępne | ich testy nie blokują PR; issue; przebieg ręczny przed zmianą generatora |
| Warstwy lokalne da się wyłączyć | wszystko powtarza CI, którego nie da się ominąć |
| Konto administratora w sesjach agentów | hooki i `deny`; pełne zamknięcie przez osobne konto (F18) |
| Testy nie dowodzą braku błędów | testy mutacyjne, próba ogniowa, kanarek |
| Model językowy jako recenzent bywa niekonsekwentny | jest dodatkiem; blokują tylko kontrole deterministyczne |
| Dane od klienta | podpis „według Twoich danych”; braki z komunikatem; klient zatwierdza miesiąc |

## B9. Kroki budowy

Jeden krok to jeden PR. Kryterium odbioru każdego kroku: `pnpm run ci &&
pnpm build` zielone, drugi czytelnik, raport. Przy każdym kroku, który zmienia
maszynerię filtra albo wiedzę, Bartosz nadaje etykietę po ostatnim pushu.

| Krok | Rozmiar | Co powstaje | Kryterium odbioru | Bartosz |
|---|---|---|---|---|
| **F1** Mapa i klasyfikator | Ś | `filtr/mapa-ryzyka.json`, `scripts/filtr/mapa.mjs` z testami, `tests/filtr/mapa.test.ts` (pełny skan), `vitest.filtr.config.ts` | każdy plik kodu ma poziom; 0 niesklasyfikowanych z sygnałem (każdy rozstrzygnięty z powodem); próba na 5 dawnych PR (#446, #452, #464, #477, #479) daje sensowne poziomy | przegląd mapy |
| **F2** Straż i karta | Ś | `filtr-straz.yml`, `scripts/filtr/straz.mjs` z testami (co najmniej 30 przypadków: klasyfikacja, osłabienie mapy, etykiety i ich autorzy, wygasanie po pushu, karta, test przy kodzie R1), `filtr/zgody.json`, sekcja karty w szablonie PR, etykiety | testy straży zielone; tryb `--tylko-raport` na tych samych 5 PR | zgoda na etykiety; po scaleniu wymagana kontrola (B5.4) |
| **F3** Warstwy lokalne | Ś | hooki i `deny` w `.claude/settings.json`, `scripts/filtr/po-edycji.sh`, `scripts/filtr/przed-poleceniem.sh` (z testami na przykładowych wejściach), skill `/filtr`, krok w `.githooks/pre-push`, `prepare` i `scripts/dev/wlacz-hooki.mjs`, sekcja w `AGENTS.md`, `docs/filtr/LISTA-KONTROLNA.md`, `docs/runbooks/filtr.md` | hook blokuje `--no-verify` i `zgoda:` w próbie; `pnpm install` w świeżym klonie włącza pre-push; budowa obrazu Docker bez zmian | `zgoda:zmiana-filtra`; przekazać Igorowi `pnpm install` |
| **F4** Rejestr: księgowość JDG | D | `filtr/przepisy/{schemat,ksiegowosc,terminy}.json`, `tests/filtr/rejestr.test.ts`, `docs/filtr/PYTANIA-Z-REJESTRU.md` | każda reguła z sekcji 4, 5 i 13 planu księgowości jest w rejestrze z kodem i testem; każdy eksport silników księgowości przypisany albo w zapadce | `zgoda:wiedza-prawna` |
| **F5** Niezmienniki i losowe dane | D | `fast-check`, `tests/filtr/generatory/`, `tests/filtr/niezmienniki/` dla księgowości, terminów i zaokrągleń, `filtr.yml`, `filtr-noc.yml` | wszystkie niezmienniki B4.2 dla tych obszarów; każdy złamany na `main` oznaczony `.fails` z numerem FZ i wpisem w `USTALENIA.md`; czas joba do 6 minut | zgoda na `fast-check` (D-F2); wymagana kontrola „Filtr: testy prawne” |
| **F6** Wyrocznia: księgowość | D (kilka sesji) | `tests/filtr/wyrocznia/{ryczalt,zus,zdrowotna,pit,vat,terminy,mikrorachunek}.ts` z testami różnicowymi; każda w czystym pokoju | 0 różnic na 300 przypadkach w PR i 50 000 w nocy; każda różnica to FZ | `zgoda:wiedza-prawna` |
| **F7** Reguły statyczne | Ś | `eslint/filtr/*.mjs`, zapadka, włączenie według mapy | lint zielony z zapadką; każda reguła ma test na przykładzie dobrym i złym | `zgoda:zmiana-filtra` |
| **F8** Przykłady urzędowe i złote pliki | Ś | `tests/filtr/przyklady-urzedowe/`, `tests/filtr/zlote-pliki/`, `tests/filtr/zlote-tymczasowe/`, plik G13 | przykłady ZUS, podatki.gov.pl i broszur MF zielone; złote pliki dla wszystkich generatorów | `zgoda:wiedza-prawna` |
| **F9** XSD, przykłady MF, czujka JPK | Ś | testy XSD na losowych danych dla każdego generatora, testy walidatora na plikach zepsutych, czujki schematów JPK, `pnpm verify:fa3` w `filtr.yml` | każdy generator ma test XSD na losowych danych; walidator odrzuca zepsute pliki | `zgoda:zmiana-filtra` |
| **F10** Wiedza dla funkcji działających dziś | D (kilka sesji) | rejestr, niezmienniki i wyrocznia dla FA(3), korekt, zaliczek, walut, JPK_FA, eksportów, odsetek, abonamentu, retencji, treści | jak F4-F6 dla tych obszarów | `zgoda:wiedza-prawna` |
| **F11** Przegląd wsteczny K0-K8 | D (P1-P8) | `docs/filtr/USTALENIA.md`, raport po każdym obszarze | każdy obszar przejrzany; każde FZ z dowodem; naprawy osobnymi PR | decyzje o kolejności napraw |
| **F12** Przegląd wsteczny funkcji działających dziś | D (P9-P10) | jak F11 | jak F11 | jak F11 |
| **F13** Strażnicy w aplikacji | Ś | `lib/bezpieczniki/`, wpięcie w „Ten miesiąc”, JPK, FA(3), przypomnienia; alarmy `FILTR-RT-*` | testy każdego strażnika; dla faktur tryb „tylko alarm” | D-F7; po 2 tygodniach zgoda na blokadę |
| **F14** Środowiska testowe co tydzień | Ś | scenariusze GF w KSeF TEST, `jpk-mf-test.yml`, porównanie naszego PDF z wizualizacją z `CIRFMF/ksef-pdf-generator`, lista kontrolna i `docs/filtr/PROTOKOLY-RECZNE.md` dla e-mikrofirmy i e-Płatnika | zielony pierwszy przebieg obu; pierwszy protokół ręczny dla 2026 r. | porównanie w e-mikrofirmie i e-Płatniku (albo księgowa) |
| **F15** Czujka przepisów i kalendarz ogłoszeń | Ś | `scripts/filtr/czujka-przepisow.mjs`: codziennie ELI API Sejmu (`/eli/changes/acts?since=…` i `/eli/acts/search` dla Dz.U. i M.P.), filtr na akty z rejestru (ustawy o VAT, PIT, ryczałcie, systemie ubezpieczeń społecznych, świadczeniach zdrowotnych, Ordynacja podatkowa, dni wolne, rozporządzenia o KPiR, JPK i płacy minimalnej), każde trafienie to issue `filtr`; dodatkowo odcisk liczb ze stron ZUS i podatki.gov.pl z rejestru; wydania `CIRFMF/ksef-api`; kalendarz ogłoszeń w rejestrze (`nastepna_zmiana`) z issue przed i po terminie | pierwszy przebieg bez fałszywych alarmów; próbne trafienie na akcie z 2026 r. (np. Dz.U. 2026 poz. 1213, płaca minimalna 2027) | nic |
| **F16** Testy mutacyjne i próba ogniowa | Ś | `filtr-mutacje.yml`, `docs/filtr/PROBA-OGNIOWA.md` | co najmniej 90 % zabitych mutantów w silnikach R1; 100 % błędów z próby ogniowej złapanych | zgoda na Stryker (D-F2) |
| **F17** Przegląd agenta w CI (opcjonalnie) | Ś | job z `claude-code-action` tylko do odczytu dla PR R1 z gałęzi repozytorium; komentarz z uwagami; karta wymaga odpowiedzi | działa na 3 PR bez fałszywych blokad | D-F4 |
| **F18** Osobne konto agentów | N | konto, ruleset, `CODEOWNERS` z mapy, test zgodności | agent nie może zaakceptować własnego PR | konto i ustawienia (B5.5) |

**Kiedy filtr jest gotowy** (wszystko naraz):

1. Każdy plik kodu ma poziom; 0 niesklasyfikowanych z sygnałem.
2. Każda reguła R1 w rejestrze ma kod i co najmniej jeden test; każdy eksport
   silników R1 ma regułę.
3. Niezmienniki z B4.2 działają dla wszystkich obszarów R1; co najmniej 300
   przypadków na własność w PR i 50 000 w nocy.
4. Wyrocznia dla silników księgowości, terminów, kursów i sum FA(3) i JPK;
   0 różnic.
5. Testy mutacyjne: co najmniej 90 % zabitych mutantów w silnikach R1.
6. Próba ogniowa: 100 % historycznych błędów R1 złapanych bez ich testów
   regresji.
7. Wymagane na GitHubie: „Filtr: straż”, „Filtr: testy prawne”, „RLS
   isolation (lokalny Supabase)”.
8. Przegląd wsteczny zakończony; 0 otwartych KRYT i WYS.
9. Materiał dla bramy B2 i B4 gotowy: rejestr z pytaniami, przykłady, lista
   słów.
10. Każda reguła R1 w rejestrze ma wzorzec z poziomów 1-4 z B4.0 albo działa
    tylko jako brak kwoty; protokół ręcznego porównania z e-mikrofirmą
    i e-Płatnikiem dla roku, za który moduł liczy, jest zapisany.

## B10. Ryzyka samego planu

| Ryzyko | Jak ograniczamy |
|---|---|
| Fałszywe alarmy zniechęcą do filtra | zapadka zamiast naprawiania wszystkiego naraz; wyjątki z powodem; co miesiąc przegląd sygnałów mapy |
| Dłuższe CI | joby filtra równolegle do istniejących; budżet 6 minut; długie przebiegi w nocy |
| Tarcie przy zgodach | jedna etykieta na PR; sesja prosi o nią dopiero po ostatnim pushu |
| Błąd w samym filtrze | testy straży i klasyfikatora; kanarek; próba ogniowa; drugi czytelnik także dla kroków filtra |
| Wyrocznia skopiuje błąd aplikacji | czysty pokój (`sparse-checkout`), inna arytmetyka, inna sesja i model |
| Pamięć Maca | testy filtra w jednym wątku; ciężkie polecenia pojedynczo |
| Codex nie zna hooków Claude | ta sama blokada w CI i w pre-push |
| Kolizja z innymi planami (pełna aplikacja, zero zgubionych faktur, usprawnienia) | pliki filtra tylko w krokach tego planu; uzgodnienie KSeF TEST z planem zero zgubionych faktur |

## B11. Pliki, które powstaną

| Ścieżka | Krok |
|---|---|
| `docs/koordynacja/ZRODLA-PRAWDY.md` (źródła prawdy, B4.0) | ten PR (#486) |
| `filtr/mapa-ryzyka.json`, `filtr/zgody.json`, `filtr/zapadka.json` | F1, F2, F7 |
| `filtr/przepisy/*.json` | F4, F10 |
| `scripts/filtr/{mapa,straz,po-edycji,przed-poleceniem,czujka-przepisow,mutacje}.*` | F1-F3, F15, F16 |
| `scripts/dev/wlacz-hooki.mjs` | F3 |
| `.github/workflows/{filtr-straz,filtr,filtr-noc,filtr-tydzien,jpk-mf-test,filtr-mutacje}.yml` | F2, F5, F14, F16 |
| `vitest.filtr.config.ts`, `tests/filtr/**` | F1, F5-F10 |
| `eslint/filtr/*.mjs` | F7 |
| `lib/bezpieczniki/**` | F13 |
| `.claude/skills/filtr/SKILL.md`, zmiany w `.claude/settings.json`, `.githooks/pre-push`, `package.json` | F3 |
| `docs/filtr/{LISTA-KONTROLNA,USTALENIA,WYJATKI,PYTANIA-Z-REJESTRU,PROBA-OGNIOWA,PROTOKOLY-RECZNE}.md`, `docs/runbooks/filtr.md` | F3, F4, F11, F14, F16 |
| sekcja „Żelazny filtr” w `AGENTS.md`, karta w `.github/pull_request_template.md` | F2, F3 |

## B12. Dziennik

| Data | Krok | PR | Stan | Uwagi |
|---|---|---|---|---|
| 8.11.2026 | plan (ETAP 1) | #486 | otwarty, czeka na decyzję Bartosza | rozpoznanie stanu (`279e2b4c`), reguł repozytorium i kodu; 16 sygnałów możliwych błędów (B7.1, S-01 do S-16); źródła prawdy z notatki sesji K0 jako `docs/koordynacja/ZRODLA-PRAWDY.md` (B4.0); mapa ryzyka dla sesji planu pełnej aplikacji w folderze notatek |

| 8.11.2026 | F1 mapa i klasyfikator | #488 | otwarty, w stosie na #486 | `filtr/mapa-ryzyka.json`: 71 obszarów (R1 47, R2 12, R3 12), 5 wyłączeń z powodem, 32 sygnały treści i 8 nazw; `scripts/filtr/mapa.mjs` (klasyfikacja pliku i zmiany, pełny skan, diff, porównanie map dla straży F2); 89 testów; pełny skan: R1 456, R2 409, R3 516, R0 219 (153 wyłączone), 0 niesklasyfikowanych, 0 martwych wzorców; próba na #446, #452, #464, #479: R1 z obszarów modułu; #477 (otwarty) pokazał 7 nowych plików runnera wysyłki poza mapą, dopisane z góry; decyzje kroku w opisie PR |

| 9.11.2026 | F2 straż i karta | #490 | otwarty, w stosie na #488 | `scripts/filtr/straz.mjs` (ocena PR na danych z API: klasyfikacja mapą z `main` i z PR, zmiany chronione, ważność etykiet, karta), `.github/workflows/filtr-straz.yml` (`pull_request_target`, bez kodu z PR i bez sekretów), `filtr/zgody.json` (`ezior8888-cpu`), karta w szablonie PR, `scripts/ops/filtr-etykiety.sh` dla Bartosza; 37 testów straży; próba `--tylko-raport` na #446, #452, #464, #477, #479: każdy R1 bez karty (karty jeszcze nie było), #446 dodatkowo `zgoda:wiedza-prawna` (parametry i XSD); kontrola zadziała dopiero z pliku na `main` |

| 9.11.2026 | F3 warstwy lokalne | #491 | otwarty, w stosie na #490 | hooki Claude w `.claude/settings.json` (po edycji: mapa i kontekst R1/R2 raz na sesję, plik poza mapą kod 2; przed poleceniem: `--no-verify`, `SKIP_PREPUSH=1`, `core.hooksPath`, etykiety `zgoda:*`, reguły repozytorium, `--admin`) i 7 nowych zakazów w `permissions.deny`; krok filtra w `.githooks/pre-push` (plik poza mapą zatrzymuje push, R1/R2 uruchamia testy filtra); `prepare` z `scripts/dev/wlacz-hooki.mjs` (CI, obraz Docker i brak gita: nic nie robi); `pnpm filtr:lokalnie`; skill `/filtr`; `docs/filtr/LISTA-KONTROLNA.md`; `docs/runbooks/filtr.md`; sekcja w `AGENTS.md`; 39 nowych testów |

| 9.11.2026 | F4 rejestr: księgowość JDG | #492 | otwarty, w stosie na #491 | `filtr/przepisy/ksiegowosc.json` (64 reguły) i `terminy.json` (4) z sekcji 4, 5 i 13 planu księgowości: przepis, kod `plik#symbol`, testy `plik > fragment`, parametry, pewność, wzorzec, pytania; `pomocnicze.json` (66 eksportów bez reguły z powodem); `schemat.json`; `scripts/filtr/rejestr.mjs` (spójność i lista pytań); `docs/filtr/PYTANIA-Z-REJESTRU.md` (21 pytań do księgowej, 3 do prawnika); test: każdy z 183 eksportów silników przypisany, każdy z 39 parametrów roku użyty, każdy obszar R1 modułu ma regułę; nic nie podpisane |

| 9.11.2026 | F5 niezmienniki i losowe dane | #499 | otwarty, w stosie na #492 | `fast-check` 4.10.2 (tylko testy, D-F2); generatory `tests/filtr/generatory/`; 43 własności w `tests/filtr/niezmienniki/` (zaokrąglenia, ryczałt, ZUS, zdrowotna, PIT, terminy, mikrorachunek), 300 przypadków w PR, 50 000 w nocy (lokalnie 63 s na strefę, ziarno 4711 zielone); `filtr.yml` („Filtr: testy prawne”, TZ Warszawa i UTC, Vitest wprost), `filtr-noc.yml` (4 strefy, losowe ziarno, issue `filtr`); rejestr wskazuje niezmienniki, a test pilnuje, że każdy ma test; FZ-001 w `docs/filtr/USTALENIA.md` (`.fails`); NZ-PIT-02 i NZ-PIT-06 doprecyzowane |

| 9.11.2026 | F7 reguły statyczne z zapadką | #500 | otwarty, w stosie na #499 | `scripts/filtr/reguly.mjs`: 7 reguł z B4.8 (`kwoty-bez-float`, `liczby-z-rejestru`, `data-warszawa`, `bez-trybu-testowego`, `bez-porad`, `wyrocznia-osobno`, `testy-bez-pomijania`), zakres z mapy ryzyka, kod bez komentarzy (i bez napisów tam, gdzie przykład w napisie to nie wywołanie), wyjątek `// filtr-wyjatek: <reguła> <powód>`; `filtr/zapadka.json`: 100 naruszeń w 66 plikach sprzed filtra (liczba tylko maleje); test pełnego przebiegu i przykładów dobrych i złych; hook po edycji zatrzymuje nowe naruszenie (kod 2). Odstępstwo od B4.8: własny skaner zamiast ESLint, bo ESLint nie ma zapadki |

| 9.11.2026 | F15 czujka przepisów | #501 | otwarty, w stosie na #500 | `scripts/filtr/czujka-przepisow.mjs` i `filtr/czujka-przepisow.json`: 12 aktów obserwowanych (ELI sprawdzone w API), słowa w tytułach, kalendarz 8 ogłoszeń (płaca minimalna, kurs euro z października, limit zdrowotnej liniowego, odsetki, prognozowane i przeciętne wynagrodzenie, stopa wypadkowa), wydania `CIRFMF/ksef-api`; `filtr-czujka.yml` codziennie, issue `filtr` bez powtórek; próba od 1.09.2026: 24 trafienia, w tym nowelizacje ustawy o VAT (Dz.U. 2026 poz. 1270 i 1446, ta od 18.11.2026), ustawy o PIT (poz. 1371, od 5.11.2026; poz. 1354), płaca minimalna 2027 (poz. 1213), tekst jednolity ustawy o VAT (poz. 1263), zmiana rozporządzenia o mikrorachunku (poz. 1351), obniżone stawki VAT (poz. 1288), kwota ograniczenia podstawy składek 2027 (M.P. 2026 poz. 1098). Odciski liczb ze stron ZUS i podatki.gov.pl: odłożone (strony zmieniają układ, fałszywe alarmy) |

| 9.11.2026 | F9 i F8 (część): XSD na losowych danych i złote pliki JPK w PIT | #503 | otwarty, w stosie na #501 | `tests/filtr/xsd/jpk-pit.test.ts`: losowe JPK_EWP(4) i JPK_PKPIR(3) (polskie znaki, znaki specjalne XML, korekty, numery KSeF, koszty w kolumnach) przechodzą oficjalne XSD MF przez xmllint, 30 przypadków w PR i 400 w nocy (24 s); generator NIP poprawiony (kod urzędu bez „00”, jak wzorzec TNumerKSeF); `tests/filtr/zlote-pliki/`: pełne pliki JPK_EWP i JPK_PKPIR dla stałych danych (zmiana znaku widoczna w PR, chroni straż). Reszta F8 i F9 (przykłady ZUS i podatki.gov.pl poza istniejącymi testami, złote pliki V7M, FA i FA(3), testy walidatora na plikach zepsutych, czujki schematów JPK) czeka |

| 9.11.2026 | F9 i F8 (część 2): FA(3) | #514 | otwarty, w stosie na #503 | `tests/filtr/xsd/fa3.test.ts`: losowe faktury zwykłe (1-12 pozycji, stawki 23, 8, 5, 0 i zw z podstawą zwolnienia, ilości z częścią dziesiętną, znaki specjalne XML) przechodzą oficjalny XSD FA(3) i spełniają NZ-FA-01 (P_15 = Σ P_13_x + Σ P_14_x) oraz Σ P_13_x = Σ P_11; 25 w PR, 300 w nocy (10 s); złoty plik `tests/filtr/zlote-pliki/fa3-zwykla.xml` (sumy sprawdzone ręcznie). Dalej: KOR, ZAL, ROZ, JPK_V7M i JPK_FA |

| 9.11.2026 | F6 (część): wyrocznia zaliczek PIT | #515 | otwarty, w stosie na #514 | `tests/filtr/wyrocznia/pit.ts` napisana w czystym pokoju (osobna sesja, model Claude Sonnet, katalog bez repozytorium, tylko `SPEC-pit.md` z przepisami art. 26, 27, 30c, 44 ust. 3f ustawy o PIT i art. 63 § 1 OP; BigInt w groszach); `tests/filtr/roznicowe/pit.test.ts`: aplikacja i wyrocznia porównane miesiąc po miesiącu (zaliczka, podstawa, podatek), skala i liniowy: 0 różnic na 300 latach w PR i 2 × 50 000 lokalnie; próba ze zmienionym zaokrągleniem w wyroczni daje czerwień; rejestr: RP-ZALICZKA-PIT-01, RP-SKALA-01, RP-LIN-01 i RP-ZAOKR-01 wskazują test różnicowy. Dalej: ryczałt, ZUS, zdrowotna, VAT, terminy, mikrorachunek |

| 9.11.2026 | F6 (część 2): wyrocznie ryczałtu, ZUS i zdrowotnej | #516 | otwarty, w stosie na #515 | `tests/filtr/wyrocznia/{ryczalt,zus,zdrowotna}.ts` z czystego pokoju (ta sama metoda, `SPEC-skladki.md`); `tests/filtr/roznicowe/skladki-ryczalt.test.ts`: składki społeczne (cztery etapy, chorobowe, stawka wypadkowa od kwietnia), zdrowotna ryczałtu (wyrocznia liczy kwoty od przeciętnego wynagrodzenia, więc test sprawdza też parametry 2026: 498,35 / 830,58 / 1 495,04 zł i minimum 432,54 zł), zdrowotna od dochodu, ryczałt (odliczenia, podział co do grosza, podstawy, ujemne): 0 różnic na 300 w PR i 2 × 50 000 lokalnie; próby kontrolne: zmieniony mnożnik zdrowotnej czerwony; zmiana remisu reszt przeszła losowe dane, więc dopisany przypadek celowany (czerwony po zmianie) |

| 9.11.2026 | F9 i F8 (część 3): FA(3) KOR | #529 | otwarty, w stosie na #516 | `tests/filtr/xsd/fa3-korekta.test.ts`: losowe korekty „przed/po” (1-8 pozycji przed; każda zostaje, zmienia ilość, cenę albo stawkę, albo znika; do 3 nowych), anulowania i korekty kwotowe (|netto| od 1 zł, znak dowolny; kwoty tylko w polach swojej stawki), stawki 23, 8, 5 i 0: oficjalny XSD FA(3) (NZ-FA-10), P_15 = Σ P_13_x + Σ P_14_x (NZ-FA-01), P_13_x każdej stawki = netto po minus netto przed (NZ-FA-04); 25 w PR, 300 w nocy (ok. 12 s); próby z generatorem pomijającym stan przed i z odwróconym znakiem korekty kwotowej dają czerwień. Przy okazji: anulowanie wykazuje stawkę z pozycją za 0,00 zł jako P_13_x = 0.00, a „przed/po” stawkę bez różnicy pomija (XSD przyjmuje oba, kwoty zgodne). Poza zakresem: „zw” (generator korekt odmawia), „oo”, „np II”. Zgodność JPK_V7M z P_13 i P_14 korekty: test różnicowy w #526 (S-01, od `main`) |

| 9.11.2026 | F9 (część 4): JPK_V7M | #530 | otwarty, w stosie na #529 | `tests/filtr/xsd/jpk-v7m.test.ts`: losowe okresy (do 15 faktur sprzedaży: zwykłe i korekty in minus, z NIP-em i konsument, z numerem KSeF i BFK, stawki 23, 8, 5, 0, zw; do 10 kosztów: faktury i paragony, odliczenie 100, 50 i 0%, korekty in minus; nadwyżka z poprzedniego okresu) przechodzą oficjalny XSD JPK_V7M(3), a sumy spełniają wzory z opisów pól w schemacie MF: PodatekNalezny, PodatekNaliczony, P_38, P_48, P_51 minus P_53 = P_38 minus P_48, liczby wierszy; pola K_ stawek równe kwotom faktur z `amountsOf`; kontrola, że wiersze i pola są w pliku (bez pustego 0 = 0); 25 w PR, 300 w nocy; próba z groszem więcej w K_19 daje czerwień |

| 9.11.2026 | F9 (część 5): FA(3) ROZ | #532 | otwarty, w stosie na #530 | `tests/filtr/xsd/fa3-rozliczenie.test.ts`: losowe zamówienia (1-6 pozycji, stawki 23, 8 i 5) i zaliczki (do 2 na stawkę, 1-49% brutto stawki; rozbicie z ZAL brak, zgodne ze wzorem albo o grosz inne; z numerem KSeF i bez) przechodzą XSD FA(3) (NZ-FA-10), P_15 = Σ P_13 + Σ P_14 (NZ-FA-01), P_15 = zamówienie minus zaliczki, P_13 i P_14 każdej stawki po odjęciu zaliczek, Σ P_11 = netto zamówienia (NZ-FA-05); VAT zaliczki bez rozbicia liczy test wzorem z art. 106f ust. 1 pkt 3; 25 w PR, 300 w nocy, 0 różnic; próba z generatorem pomijającym rozbicie z ZAL daje czerwień |

| 9.11.2026 | F9 (część 6): FA(3) ZAL | #540 | otwarty, w stosie na #532 | `tests/filtr/xsd/fa3-zaliczka.test.ts`: losowe zaliczki (stawki 23, 8, 5 i 0; zamówienie od 1 zł do 10 mln zł; zaliczka 0,1-100% zamówienia; opis z polskimi znakami i znakami specjalnymi XML) przechodzą XSD FA(3) (NZ-FA-10); P_15 = kwota zaliczki (NZ-FA-01); P_14_x = KP ze wzoru z art. 106f ust. 1 pkt 3 liczonego w teście na groszach, P_13_x = ZB minus KP, tylko w polu stawki; `Zamowienie`: wartość, netto plus VAT i VAT ze wzoru; 25 w PR, 300 w nocy, 0 różnic; próba z groszem więcej w P_11VatZ daje czerwień |

| 9.11.2026 | F6 (część 3): wyrocznia terminów | #542 | otwarty, w stosie na #540 | `tests/filtr/wyrocznia/terminy.ts` z czystego pokoju (podagent Claude Sonnet, katalog bez repozytorium, tylko `SPEC-terminy.md`: ustawa o dniach wolnych od pracy z Wigilią od 2025, art. 12 § 5 OP, art. 44 ust. 6 PIT, art. 21 ust. 1 ryczałtu, art. 47 ust. 1 pkt 1 sus, art. 99 ust. 1 i 109 ust. 3b VAT); `tests/filtr/roznicowe/terminy.test.ts`: pełne porównanie, nie losowe: Wielkanoc 1990-2100, święta 2011-2100, każdy dzień 2011-2060 (dzień terminu i przesunięcie), terminy za każdy miesiąc 2026-2060 we wszystkich czterech rodzajach; 0 różnic; próba z Wigilią od 2026 daje czerwień; rejestr: RP-TERM-01 i RP-TERM-02 z nowym dowodem. Ustalenie: 6 stycznia jest wolny dopiero od 2011 r., a aplikacja traktuje go jako wolny w każdym roku (bez znaczenia dla terminów od 2026; porównanie od 2011) |

| 9.11.2026 | F6 (część 4): wyrocznia deklaracji VAT | #543 | otwarty, w stosie na #542 | `tests/filtr/wyrocznia/vat.ts` z czystego pokoju (podagent Claude Sonnet, tylko `SPEC-vat.md`: art. 63 § 1 OP, art. 87 ust. 1 i 103 ust. 1 VAT, opisy pól P_37, P_38, P_48 w schemacie MF); `tests/filtr/roznicowe/vat.test.ts`: losowe okresy (sprzedaż w stawkach 23, 8, 5, 0, zw, np, np II, korekty in minus; zakupy z odliczeniem 100, 50 i 0%, paragony; nadwyżka) dają te same pola P_10-P_62 w pliku i te same kwoty modułu VAT (`summarizeJpkV7m`) co wyrocznia: 300 w PR, 5000 lokalnie, 0 różnic w kwotach; próba z końcówką 50 gr obciętą w dół daje czerwień; rejestr: RP-ZAOKR-03 i RP-VAT-01 z nowym dowodem. Ustalenie FZ-002 (INFO): `wholeZloty` daje -0 dla kwoty ujemnej poniżej 50 gr, dziś niewidoczne |

| 9.11.2026 | F9 i F8 (część 7): JPK_FA, złote pliki JPK_V7M i JPK_FA | #544 | otwarty, w stosie na #543 | `tests/filtr/xsd/jpk-fa.test.ts`: losowe JPK_FA(4) (1-15 faktur, stawki 23, 8, 5, 0, zw z podstawą, np, oo; konsument; kasowa i MPP) przechodzą oficjalny XSD, sumy kontrolne zgodne z opisami pól MF (LiczbaFaktur, WartoscFaktur = Σ P_15, LiczbaWierszyFaktur, WartoscWierszyFaktur = Σ P_11), P_15 każdej faktury = Σ P_13 + Σ P_14; 25 w PR, 300 w nocy; próba z groszem więcej w WartoscFaktur daje czerwień. `tests/filtr/zlote-pliki/jpk-vat.test.ts`: złote pliki `jpk-v7m3.xml` (osoba fizyczna, wszystkie stawki, konsument bez KSeF, korekty in minus, odliczenie 50%, nadwyżka; sumy policzone ręcznie i zgodne) i `jpk-fa4.xml` (przekrój stawek, ZAL i ROZ; WartoscFaktur 8 073,01 zł policzone ręcznie), oba przez XSD |

| 9.11.2026 | F9 (część 8): walidatory odrzucają zepsute pliki | #545 | otwarty, w stosie na #544 | `tests/filtr/xsd/walidatory-odrzucaja.test.ts`: dla FA(3), JPK_V7M, JPK_FA, JPK_EWP i JPK_PKPIR złoty plik przechodzi, a pięć zepsuć (brak elementu wymaganego, kwota z przecinkiem, nieznany element, zła przestrzeń nazw, plik ucięty) jest odrzuconych z komunikatem; żaden walidator nie przepuszcza po cichu. Ścieżka produkcyjna `assertJpkMatchesSchema` nie łapie wyjątku walidatora (fail-closed) |

| 9.11.2026 | F10 (część 1): dzień kursu NBP | #546 | otwarty, w stosie na #545 | `tests/filtr/roznicowe/kurs-dzien.test.ts` (NZ-KURS-01, RP-WAL-01): NBP symulowany jako tabela w każdy dzień roboczy według wyroczni dni wolnych z #542, okno 10 dni jak w `lib/nbp/client.ts`; dla każdego dnia 2026-2060 `rateBefore` znajduje kurs z ostatniego dnia roboczego przed zdarzeniem i nigdy nie odrzuca go jako przestarzałego; najdłuższa luka 6 dni (Wigilia w poniedziałek), próg 7 wystarcza; próba z progiem 5 daje czerwień (27.12.2029). Uwaga: komentarz przy `MAX_PUBLICATION_GAP_DAYS` (`lib/flo/nbp.ts:33-34`) mówi „wyjątkowo pięć dni”, sprzed Wigilii wolnej; do poprawy przy okazji zmiany w `lib/flo/` |

| 9.11.2026 | F10 (część 2): rejestr reguł faktur | #547 | otwarty, w stosie na #546 | `filtr/przepisy/faktury.json` (nowy): RP-FA-KOR-01 (różnica w korekcie „przed/po”, art. 106j ust. 2 pkt 5), RP-FA-ZAL-01 (wzór zaliczki, art. 106f ust. 1 pkt 3), RP-FA-ROZ-01 (rozliczenie po odjęciu zaliczek, art. 106f ust. 3; pewność średnia, pytanie do księgowej z przykładem), RP-FA-DATA-01 (60 dni, art. 106i ust. 7), RP-FA-SUMY-01 (P_15 = Σ P_13 + Σ P_14); wzorzec poziomu 4 z opisów pól w schemacie FA(3), przeczytanych w XSD; `docs/filtr/PYTANIA-Z-REJESTRU.md` odświeżone (22 pytania dla księgowej). Przy okazji poprawiony cytat wzoru zaliczki (pkt 3, nie pkt 4) w testach #532 i #540 |

| 9-11.11.2026 | F11: przegląd wsteczny księgowości K0-K8 | #548, #550, #551, #553, #569, #570, #589, #630, #631, #633, #635, #636 | #548-#589 w `main` przez #620; #630-#636 otwarte od `main` | przegląd w notatkach koordynatora (`F11-PRZEGLAD-KSIEGOWOSCI-2026-11-09.md`, sekcje A-C); naprawy (scalone albo w otwartych PR): A1 (VAT a wpisy ręczne), A4, A6, B1-B3, B5, B6, C1, C2 (część), C3, C4; do decyzji albo w innych torach: A2, A3, A5, A7-A9, B4, B7, B8, C5 (księgowa), C6 (zapłata składek dwoma przelewami: model wersji liczy łączną kwotę za okres), C7, C8 |
| 10-11.11.2026 | F12: przegląd funkcji działających dziś (KOR, ZAL, ROZ; PDF i CSV; cykliczne) | #556, #565, #566, #571, #572, #580, #581, #601, #605, #606, #626, #627, #634 | do #606 i #626 w `main` (przez #620 i #629); #627, #634 otwarte | przegląd w `F11-…` (sekcje D-E) i `F12-FAKTURY-CYKLICZNE-2026-11-11.md`; G3 (`OkresFa`) wstrzymane: `recurringPeriodKey` to okres dnia wystawienia, nie usługi, więc przy fakturowaniu z dołu wpisałby zły okres (potrzebne ustawienie pozycji i migracja); G4 zmiana modelu; G5, G7 i reszta G6 po #621; E1 tor „zero zgubionych faktur”, E3 po D3 |
| 10-11.11.2026 | F13 (części 1-3, 2b): strażnicy w aplikacji | #592, #594, #596, #637 | 1-3 w stosie; 2b otwarty na stosie | „Ten miesiąc”, JPK_V7M w module i w Centrum eksportu, JPK_EWP i JPK_PKPIR; alarmy `FILTR-RT-*` w Sentry (odcisk: kod, rodzaj, miesiąc); część 4 (FA(3) „tylko alarm”) do zrobienia |
| 11.11.2026 | Stos do `main` po #620 i #629; FZ-003; hook bez `GIT_DIR` | #504, #622, #638 | otwarte | łatka mapy koordynatora z poprawkami (obszary R1 `ksef.uprawnienia`, `sql.dostep`), 26 komentarzy `filtr-wyjatek` przy fałszywych alarmach, rejestr (RP-FP-01, 8 symboli), xmllint skryptem z #624; prawdziwy błąd FZ-003 (Biała Lista „dzisiaj” w UTC) w #622; testy hooków dziedziczyły `GIT_DIR` z hooka i ustawiły głównemu repo `core.bare=true` (przywrócone; naprawa #638 i w stosie) |

**Następny krok:** F10 część 3: termin wysyłki faktury offline do KSeF w dniach roboczych (`lib/ksef/offline-queue.ts`, `calculateOfflineDeadline`) kontra wyrocznia dni wolnych z F6 (część 3), test różnicowy na losowych datach 2026-2060; dalej F10 dla odsetek (gdy powstanie liczenie), abonamentu i retencji, F13 część 4 (FA(3) „tylko alarm”). F6 dla mikrorachunku czeka na tekst rozporządzenia (poz. 1351 tylko w PDF, bez pobierania); F14, F16-F18 wymagają decyzji albo kont (A11).
