# Wzorce z Mobbin: co poprawić w aplikacji na telefon

> Przegląd z 12.11.2026, stan `main` po M4b (dane przykładowe). Pięć obszarów
> porównanych z biblioteką Mobbin (iOS), około 30 wyszukiwań. Linki prowadzą
> do Mobbin i otwierają się po zalogowaniu na konto FaktWay.
>
> Z Mobbin bierzemy **układ, hierarchię, przepływy, stany ekranu i
> mikrointerakcje**. Wygląd: marka FaktWay (D12: Outfit, niebieski `#2463EF`,
> ikony Remix) z wykończeniem Copilota (D15 od 12.11: gradient, karty 18 pt bez
> obwódki, liczby w Outfit). Decyzje D3, D5, D7, D11, D13 obowiązują bez zmian. Plan: [`PLAN-APLIKACJA-MOBILNA.md`](../koordynacja/PLAN-APLIKACJA-MOBILNA.md),
> zasady: [`ZASADY-DESIGNU.md`](ZASADY-DESIGNU.md).

---

## 1. Najważniejsze

**Wybrany wzór (12.11.2026, plan D14): szkielet z Copilota, faktury z Revolut
Business, w jasnym motywie FaktWay.** Po makiecie Bartosz przyjął też
wykończenie Copilota w całości (D15, „Wszystko jak Copilot”): gradient pod
nagłówkiem, karty 18 pt bez obwódki, kolorowe kategorie, grosze w indeksie,
liczby w Outfit. Zasady: `ZASADY-DESIGNU.md` w wersji 3. Poprawki niżej dalej
obowiązują i są rozpisane na etapy M4c do M4f.

**Jeden problem powtarza się na trzech zakładkach: treść ląduje pod zgięciem.**
Na Fakturach pierwszy wiersz jest pod paskiem zakładek (około 810 pt), na
Kosztach żaden wydatek nie mieści się na pierwszym ekranie, na „Ten miesiąc”
terminy płatności są pod sześcioma kaflami. Wszędzie winne są cztery do sześciu
równorzędnych kafli po około 150 pt. Najlepsze aplikacje biznesowe (Revolut
Business, Mercury, Brex) pokazują listę albo zadania od razu pod jedną liczbą
i główną akcją.

| # | Zmiana | Sekcje | Koszt | Kiedy |
|---|---|---|---|---|
| 1 | Treść nad zgięciem: kafle kompaktowe, lista i zadania od razu pod bloczkiem | 2.2, 3.1, 4.1 | mały | teraz (dane przykładowe) |
| 2 | „Do zrobienia” na Pulpicie, „Do dokończenia” w Fakturach, „Do opisania” w Kosztach | 2.1, 3.4, 4.1 | mały do średniego | teraz |
| 3 | „Ten miesiąc”: terminy na górze, dane przelewu do skopiowania (cofnięcie względem M3) | 5.1, 5.2 | średni | teraz |
| 4 | Wystawienie: podgląd przed KSeF, ekran „Przyjęta w KSeF”, po wysłaniu szczegół faktury | 3.2, 8.4 | średni | teraz |
| 5 | Wspólne stany: szkielet, błąd i brak sieci, odświeżanie, pusty stan z akcją, pasek „Cofnij”, potwierdzenia w arkuszu akcji | 8.1 do 8.6 | średni | przed M7 (fundament pod dane z bazy) |
| 6 | Szczegół faktury: oś statusu, rząd akcji, jedna nazwa „Przyjęta w KSeF” | 3.3, 3.7 | średni | teraz |
| 7 | Logowanie według gotowego przepływu | 7 | średni | M5 |
| 8 | Więcej: nagłówek konta, grupy ze stanem, wyszukiwarka, „Wyloguj” | 6.1 | mały | „Wyloguj” w M5, reszta teraz |
| 9 | Formularz faktury: kolejność, zwinięte pozycje, wybór kontrahenta | 3.5, 3.6 | duży | z M8 (wysyłka do KSeF) |
| 10 | Koszty: aparat od razu, odczyt w tle, sprawdzanie ze zdjęciem | 4.2 do 4.4 | średni | M9 (skaner i OCR) |
| 11 | Pigułki filtrów (Faktury, KPiR), księga po dniach, formularze księgowości w arkuszach | 3.8, 5.3, 5.4 | średni | M10 |
| 12 | Wykresy: przeciąganie palcem, czytelny wykres Finanse, krótszy Pulpit i Analizy | 2.3 do 2.7 | mały do średniego | dowolnie |

Etapy (plan, sekcja 7, od 12.11.2026): **M4c** wykończenie Copilota w
komponentach (D15), **M4d** układ Copilota na Pulpicie, Fakturach i Kosztach
(pozycje 1 i 2), **M4e** wystawienie i szczegół według Revolut Business
(pozycje 4 i 6), **M4f** Księgowość, Więcej i wspólne stany (pozycje 3, 5 i 8).
M4c i M4d zrobione 12.11.2026 w jednym PR (#663). M4e (3.2, 3.3, 3.5, 3.7, 8.4) 13.11.2026; 3.6 i 3.9 czekają. Potem M5 według sekcji 7 tego pliku.

**Do decyzji Bartosza**
- Kolejność: M4c do M4f przed logowaniem (M5) czy po nim (rekomendacja:
  przed, bo M5 składa ekrany z tych samych komponentów).
- Dotknięcie bloczka „Nowa faktura” od razu otwiera zwykłą fakturę, rodzaj
  w przytrzymaniu i w formularzu (3.9).
- Mały przycisk „Dodaj koszt” obok bloczka na Pulpicie (koniec sekcji 2).
- Lekka wibracja przy przeciąganiu palcem po wykresie (2.3).
- Kategoryzacja kosztów (4.5) i mikrorachunek z NIP (5.2) to R1: idą
  z kartą zmiany prawnej.

---

## 2. Pulpit

**2.1 Karta „Do zrobienia” pod bloczkiem, należności wyżej.** Sygnały „wymaga
działania” leżą nisko (`(pulpit)/index.tsx:99-111` należności, `:138-140`
„Podłącz KSeF” na samym dole) albo na innych zakładkach (skrzynka KSeF to tylko
plakietka „2” na Kosztach); odrzuconych przez KSeF na Pulpicie nie ma wcale.
Wzorce: [Revolut Business](https://mobbin.com/screens/c7540ba2-78b0-4272-a8cf-d6f771c32a91?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(karta zadania z przyciskiem zaraz pod saldem),
[Deel](https://mobbin.com/screens/dbd3d480-4be5-4834-ba16-89e591d60ae3?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„Upcoming actions”, przycisk w każdym wierszu),
[Monarch](https://mobbin.com/screens/eff6b2af-549f-4f68-88f0-1a50b8237bbe?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(stan „wszystko przejrzane”).
Zmiana: pod „Nowa faktura” (D7 bez zmian) karta „Do zrobienia”: „2 faktury
z KSeF do opisania”, „3 po terminie, 3321 zł” z akcją „Przypomnij”, „1 odrzucona
przez KSeF”, a przed podłączeniem KSeF „Podłącz KSeF” jako pierwszy wiersz.
Pusta karta: „Wszystko załatwione”. Należności zaraz pod nią. Koszt: średni,
z istniejących `Sekcja` i `Wiersz`.

**2.2 Jedna liczba główna, kafle niższe, bez dubla „Raport”.** Zysk nie mówi,
czy to dobrze (`:53-58`), 4 kafle zajmują około 300 pt (`:64-71`), sekcja
„Raport” (`:85-89`) powtarza zysk, przychód i koszty trzeci raz. Wzorce:
[Rocket Money](https://mobbin.com/screens/a7178626-d08b-41df-bb7e-b1ac96f4d459?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(kwota, różnica do poprzedniego miesiąca i mały wykres w jednej karcie),
[Revolut](https://mobbin.com/screens/0f3fc978-ae0e-44f7-ae02-f81311e5fc8f?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(niskie kafle z liczbą, zmianą i mini wykresem).
Zmiana: pod zyskiem plakietka ze zmianą wobec poprzedniego miesiąca i linia
„Przychód 34,6 tys. · Koszty 11,3 tys.”; kafle w wariancie kompaktowym (liczba
i zmiana w jednym rzędzie, bez okrągłej ikony, około 90 pt); „Raport” pod
dotknięciem nagłówka zysku. Koszt: mały, wariant `kompakt` w `kafle.tsx`.

**2.3 Wykres: przeciąganie palcem, wartości nad wykresem.** Słupek wybiera się
tylko dotknięciem (`komponenty/wykres.tsx:87-98`), dymek (`:131-143`) zasłania
słupki, legenda (`:129`) nie ma kwot. Wzorce:
[Turo](https://mobbin.com/screens/b5ec6e73-ce66-42aa-9f32-074f1cda1059?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Acorns](https://mobbin.com/screens/29624482-0645-4774-8ac3-1de769640ff2?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[TradingView](https://mobbin.com/screens/026f33ac-0107-4a9d-b4ce-b8f8a4a37972?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: `Gesture.Pan` z `activeOffsetX` (przewijanie w pionie działa dalej),
pionowa kreska, legenda zamienia się w wiersze „kolor, nazwa, kwota” dla
wybranego miesiąca (domyślnie bieżącego), dymek znika. Koszt: średni, jeden
komponent, korzystają wszystkie wykresy. **Do decyzji:** lekki tick przy zmianie
słupka wymaga dopisania do tabeli wibracji (zasady, sekcja 7).

**2.4 Wykres Finanse czytelny na telefonie.** Koszty, zysk i VAT w stosie trzech
odcieni niebieskiego (`index.tsx:74-82`); VAT doklejony do przychodu myli.
Wzorce: [Ubank](https://mobbin.com/screens/beea14a3-2aea-452f-b31c-d108331d7add?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(pary słupków, pod spodem wybrany miesiąc wierszami),
[Monarch](https://mobbin.com/screens/b64ebb8d-96e8-41f8-b777-3db7f8dbf9ff?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: słupek przychodu z wydzielonym zyskiem (dwa odcienie), VAT tylko
w wierszach pod wykresem, dwie linie siatki. Koszt: mały.

**2.5 Krótszy Pulpit.** 10 sekcji; VAT należny (`:91-97`), dwa rankingi
(`:113-130`) i sekcja linków „Analizy” (`:132-136`) dublują Analizy
i Księgowość. Wzorzec: [Revolut Business, analityka](https://mobbin.com/screens/0559cf9d-0b59-4600-acc5-bc0fb81fe385?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: VAT jako jeden wiersz „VAT w listopadzie 7950 zł ›” do `/ksiegowosc/vat`,
rankingi po 3 pozycje z „Wszystkie”, sekcja linków znika (te same linki są
w nagłówkach kart). Nic nie znika z aplikacji (D3). Koszt: mały.

**2.6 Analizy: pierścień i ranking w jednej karcie.** Pięć niebieskich trudnych
do odróżnienia i osobna lista tych samych pozycji (`analizy.tsx:83-102`), razem
około 650 pt. Wzorzec: [YNAB](https://mobbin.com/screens/656350e9-3b79-4849-9d2d-ce66620fe66d?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: poziomy pasek udziałów (`rodzaj="pasek"` w `Wykres`) albo mniejszy
pierścień i wiersze z kropką, kwotą i procentem; dotknięcie wiersza podświetla
wycinek. Koszt: mały do średniego.

**2.7 Okres widoczny, nie schowany w ikonie.** Miesiąc w Analizach wybiera się
menu pod ikoną kalendarza (`analizy.tsx:40-48`). Wzorce:
[GoPay](https://mobbin.com/screens/90f5d989-adb3-45ba-b537-b3702e2c96ee?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Quicken](https://mobbin.com/screens/c36b0064-68a5-4649-89ea-d5ec7d88f608?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(prognoza na dzień).
Zmiana: wiersz „‹ Listopad 2026 ›” pod przełącznikiem; w Przepływach
„Spodziewane wpływy (30 dni)” zaraz pod wykresem salda. Koszt: mały.

**Do decyzji (D7):** obok bloczka „Nowa faktura” mały kwadratowy przycisk
„Dodaj koszt” (aparat), bo wydatek ze zdjęcia to jedno z głównych
zadań; rząd akcji jak w [Revolut Business](https://mobbin.com/screens/f8ac896a-9fea-4a20-a7bd-55f3c411a6e5?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zasady mówią dziś o jednym przycisku głównym na ekran.

---

## 3. Faktury

**3.1 Lista zaczyna się pod paskiem zakładek.** Na `m4b/faktury-jasny.png`
(402 × 874 pt) nagłówek „Listopad 2026” leży na około 767 pt, pierwszy wiersz
na około 810 pt, czyli pod paskiem zakładek: **na starcie nie widać żadnej
faktury.** Kafle zajmują około 320 pt (`faktury/index.tsx:154-189`); „Kontrahenci”
to skrót do Więcej, „Cykliczne” dubluje zakładkę. Wzorzec:
[Revolut Business, faktury](https://mobbin.com/screens/32f812e0-1a47-461b-abfb-93889b7471d9?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(tytuł, rząd przycisków, szukanie, pigułki; pierwszy wiersz na około 410 pt).
Zmiana: kafle zostają (D3), ale jako jeden rząd małych kafli przewijany
w poziomie (około 88 pt); bloczek D7 bez zmian. Cel: pierwsza faktura powyżej
500 pt. Koszt: mały, wariant w `Kafle`.

**3.2 Podgląd przed KSeF i ekran po wysłaniu.** „Wystaw i wyślij do KSeF”
wysyła od razu z formularza (`faktury/nowa/[rodzaj].tsx:211-252`), potem wraca
na listę, gdzie nowej faktury nie widać (3.1). Wzorce:
[Jobber, przepływ](https://mobbin.com/flows/5a312970-1e30-45f5-92f1-3dc41eebdf9d?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„Review and Send”, podgląd, wysyłka),
[Revolut Business](https://mobbin.com/screens/4d79ef3f-b8e5-44f6-87f2-44d702cd5631?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(potwierdzenie jako arkusz nad szczegółem),
[PayPal](https://mobbin.com/screens/b239f8f7-cec0-4434-a011-649c78f248a8?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„Gotowe” i „Wyślij kolejną”).
Zmiana: „Sprawdź i wyślij” prowadzi do `nowa/podglad.tsx` (kwota, nabywca,
pozycje, VAT, termin, rachunek, zdanie „Po wysłaniu do KSeF zmienisz fakturę
tylko korektą.”, `PrzyciskGlowny` „Wyślij do KSeF”). Po wysłaniu szczegół
faktury z arkuszem „Wysyłamy do KSeF” → „Przyjęta w KSeF” (sekcja 8.4):
„Wyślij e-mailem nabywcy”, „Udostępnij PDF”, „Gotowe”. Koszt: średni.

**3.3 Oś statusu w szczególe.** Karta „Status” to wiersze „KSeF: Zaakceptowana”,
numer, UPO (`faktury/[id].tsx:166-185`). Nazwa statusu się rozjeżdża:
„Zaakceptowana” (`[id].tsx:18`), „Przyjęte w KSeF” w filtrze (`index.tsx:24`),
„Przyjęta” w M3. Wzorce:
[Remote](https://mobbin.com/screens/6d0a48dc-8ca8-41bf-a66e-7caaf08fda80?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Brex](https://mobbin.com/screens/fdf16c74-5c67-4189-9ffb-4d2b83819811?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: `OsStatusu`: Szkic, Wysłana do KSeF, Przyjęta w KSeF (numer i UPO),
Zapłacona, każdy krok z datą; krok w toku pulsuje jak `Znacznik trwa`; przy
odrzuceniu krok 2 czerwony z powodem i „Popraw”; kreska w SVG. Jedna nazwa:
„Przyjęta w KSeF”. Koszt: średni, nowy komponent.

**3.4 Szkice i odrzucone osobno, nad miesiącami.** Dziś leżą między zwykłymi
fakturami (`index.tsx:203`), widać je tylko w kaflu „+1 szkic poza KSeF”.
Wzorzec: [Revolut Business](https://mobbin.com/screens/32f812e0-1a47-461b-abfb-93889b7471d9?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(grupa „Drafts” nad datami).
Zmiana: sekcja „Do dokończenia” (szkice, odrzucone, wysyłane) nad miesiącami,
schowana, gdy pusta; kafel szkiców przewija do niej. Koszt: mały.

**3.5 Formularz: najpierw to, co trzeba wpisać.** Pierwsze są 4 wypełnione
już pola „Numer i daty”, nabywca ma do 8 pól, każda pozycja to karta z 5 polami
(`[rodzaj].tsx:438-446`), wysyłka na samym dole (`:496`). Wzorce:
[Revolut Business, formularz](https://mobbin.com/screens/0bc424c4-6527-455f-bb32-3dddc3652473?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(dane jako wiersze z wartością, pozycje zwinięte, „Additional options”),
[Jobber, pozycja](https://mobbin.com/screens/c0bd0a87-4de2-4589-b0c0-969278b3c490?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(pozycja w osobnym arkuszu).
Zmiana: kolejność Nabywca, Pozycje, Płatność; „Numer i daty” jako wiersze
z wartościami, dotknięcie rozwija pola; wypełniona pozycja zwija się do wiersza
„1 × 9800,00 zł, VAT 23%, 12 054,00 zł”, edycja w arkuszu; „Więcej opcji” (MPP,
uwagi, VAT-UE) rozwija się samo przy błędzie albo wymaganym MPP. Lista błędów
nad przyciskiem zostaje. Koszt: duży.

**3.6 Wybór kontrahenta z wyszukiwaniem.** `PoleWyboru` otwiera arkusz akcji ze
wszystkimi kontrahentami (`[rodzaj].tsx:350-355`). Wzorce:
[Revolut Business, wybór klienta](https://mobbin.com/screens/fd5380a0-4a10-463b-9640-c4224331e612?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[PayPal](https://mobbin.com/screens/496b6d62-daf4-419a-a10c-d3842c5e8acd?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: arkusz `nowa/kontrahent.tsx` z `Stack.SearchBar` („Nazwa albo NIP”),
sekcje „Ostatnio” (3 do 5) i „Wszyscy”, wiersz „Nowy kontrahent po NIP (GUS)”;
po wyborze w formularzu karta kontrahenta z „Zmień” zamiast 5 pól. Koszt: średni.

**3.7 Akcje szczegółu na wierzchu, przypomnienie z faktury.** E-mail, PDF, XML,
korekta, duplikat i cykliczna są tylko w menu „…” (`[id].tsx:84-123`),
przypomnienie tylko z zakładki Po terminie (`index.tsx:256`), własne dane
sprzedawcy wyżej niż pozycje. Wzorce:
[PayPal](https://mobbin.com/screens/d9c61da8-23a9-4b75-be15-1fb6d6aa074f?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„Send reminder” i siatka akcji),
[Revolut Business](https://mobbin.com/screens/5d07fb33-27ec-40fc-9a81-8015ca29d087?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(kolejność: status, klient, pozycje, historia).
Zmiana: pod przyciskiem głównym rząd 3 do 4 okrągłych akcji z podpisem: PDF,
E-mail, Przypomnij (po terminie), Duplikuj; reszta w „…”. Kolejność: Status,
Nabywca, Pozycje i VAT, Płatność, Dokument, Sprzedawca. Koszt: mały do
średniego (`RzadAkcji`).

**3.8 Filtry widoczne jako pigułki.** Filtry są w menu ikony
(`index.tsx:124-148`), aktywny zdradza tylko kolor ikony. Wzorce:
[Revolut Business](https://mobbin.com/screens/32f812e0-1a47-461b-abfb-93889b7471d9?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Jobber](https://mobbin.com/screens/27df60ff-6c9f-4bff-ae2f-6ce9e1124894?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: pod zakładkami przewijany rząd pigułek „Szkice”, „Nieopłacone”,
„Odrzucone”, „Więcej filtrów” (obecne menu); aktywna na 10% tle z „×”, cel
dotyku 44 pt. Ten sam komponent co chipy w KPiR (5.4). Koszt: średni.

**3.9 „Nowa faktura” jednym dotknięciem (dopracowanie D7).** Bloczek otwiera
najpierw wybór 4 rodzajów (`m4/nowa-faktura-rodzaj.png`). Wzorzec:
[Revolut Business, wystawienie](https://mobbin.com/flows/27ab137d-4f85-4868-926e-e3239e2a1b22?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„New invoice” od razu prowadzi do wyboru klienta).
Zmiana: dotknięcie otwiera fakturę zwykłą; przytrzymanie (`Link.Menu`) daje
korygującą, zaliczkową, rozliczającą i „Duplikuj ostatnią”; w formularzu wiersz
„Rodzaj: Faktura zwykła ›”. Koszt: mały. **Do decyzji Bartosza** (zmienia
zachowanie bloczka z D7, nie jego miejsce).

---

## 4. Koszty

Nad zgięciem: tytuł, suma, „Dodaj wydatek”, trzy kafle (kafel KSeF na cały
rząd) i zakładki. **Żaden wydatek nie mieści się nad zgięciem.**

**4.1 „Do opisania” jako zadania nad zgięciem.** Dziś to licznik w kaflu
(`koszty/index.tsx:129-140`), a kafel „Ostatnie pobranie z KSeF” zajmuje około
150 pt. Wzorce: [Brex](https://mobbin.com/screens/e65a9422-cea1-4681-879d-3e449eb7e4af?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(brak jako zadanie z „Add” w wierszu),
[Airwallex](https://mobbin.com/screens/fe120572-a6e8-4b1a-90b0-34482d642776?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Monarch](https://mobbin.com/flows/a1ae5455-ecef-49b2-99db-31753798ec66?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„Needs review” i stan „wszystko przejrzane”).
Zmiana: pod „Dodaj wydatek” karta „Do opisania (n)”, do 3 wierszy z sugerowaną
kategorią i przyciskiem „Zaakceptuj”, „Wszystkie” w nagłówku; pusta: „Wszystko
opisane”. Ostatnie pobranie z KSeF do stopki skrzynki, sprawdzenie odświeżaniem
pociągnięciem. Koszt: mały do średniego (mały przycisk w `Wiersz`).

**4.2 Sprawdzanie odczytu: zdjęcie i decyzja na górze.** `koszty/[id].tsx` nie
pokazuje zdjęcia (strona tak: `components/expenses/expense-edit-form.tsx:379-386`),
„Zaakceptuj” stoi na samym dole (`:120`), pola faktury z KSeF da się edytować
jak pola paragonu. Wzorce: [GoPay](https://mobbin.com/screens/465e2773-660b-4a11-b7af-fb9747fef87e?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(miniatura, „Rescan”, niepewna kwota na bursztynowym tle),
[Splitwise](https://mobbin.com/screens/ba220c78-9ede-4bd0-ba41-16c6476716fa?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana dla zdjęć: miniatura w nagłówku (pełny ekran z powiększeniem), „Zrób
ponownie”, pola niespójne (netto + VAT różne od brutto, brak NIP) z obwódką
`ostrzezenie` i zdaniem pod polem. Dla KSeF: na górze tylko decyzje (kategoria,
kolumna, „w KPiR”) i „Zaakceptuj”, dane faktury niżej do odczytu, edycja za
„Popraw dane”. Serwer daje pewność dla dokumentu (`lib/ocr/schema.ts:75`) i dla
kategorii, nie dla pól: podświetlenie pól na start z reguł sprawdzających sumy.
Koszt: średni.

**4.3 Jedno stuknięcie do aparatu (M9).** Dziś „Dodaj wydatek”, arkusz z trzema
wierszami (`koszty/dodaj.tsx:72-76`), „Zrób zdjęcie”. Wzorce:
[Brex, dodanie paragonu](https://mobbin.com/flows/47ce9154-2898-4635-ac62-4fbfd306f65c?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(aparat od razu, galeria w rogu, licznik serii),
[Expensify](https://mobbin.com/flows/96eca170-e2c5-41da-be39-bc51510e7837?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: „Dodaj wydatek” otwiera systemowy skaner dokumentów; „Z galerii lub
pliku” i „Wpisz ręcznie” w menu przy przytrzymaniu i jako dwa linki pod
przyciskiem. Obecny arkusz zostaje jako zapas bez zgody na aparat.

**4.4 Odczyt w tle zamiast kręciołka na cały arkusz.** `dodaj.tsx:58-68`
blokuje arkusz („Rozpoznaję…”), zamknięcie przerywa odczyt (`:41`), a serwer
i tak działa asynchronicznie. Wzorce:
[Mindtrip](https://mobbin.com/flows/bb70bcb1-20c6-4c60-a409-10a6cb8e3534?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(szkielet wiersza „analizuję plik”),
[Expensify](https://mobbin.com/screens/6918b4ce-6c97-403c-9f0f-5d7cd90bc436?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(plakietki „Processing”, „SmartScan Failed”).
Zmiana: po zdjęciu arkusz się zamyka, na górze kolejki wiersz-szkielet
z miniaturą i plakietką „Odczytujemy”; potem „Do sprawdzenia” (wibracja success)
albo „Nie odczytano” z „Wpisz ręcznie” i „Zrób ponownie” (blokada ma wyjście).
Koszt: średni.

**4.5 Szybka kategoryzacja (R1, dotyka KPiR).** Kategoria to pełna lista 11
pozycji (`[id].tsx:112`), wiersze kosztów nie mają gestów (`index.tsx:68-80`).
Wzorce: [Vinted](https://mobbin.com/screens/04e7a37c-ac02-404c-b53f-fdf66af9d709?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„Suggested” nad listą),
[Lloyds](https://mobbin.com/screens/997576f3-4196-40e9-9f4d-eefb6535ff93?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Wealthfront](https://mobbin.com/screens/a50a8d16-fa4b-47b2-b209-201c5cdecf53?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: rząd plakietek: sugerowana, dwie ostatnie dla tego sprzedawcy, „Inna…”;
na liście przesunięcie daje „Zaakceptuj” z „Cofnij”, przytrzymanie „Zmień
kategorię”. Strona już uczy się z poprawek (`lib/categorization/name-rule.ts`).
Koszt: średni (gest z `WierszFaktury` do uogólnienia).

**4.6 Skrzynka KSeF: nowe osobno, akceptacja zbiorcza.** Dziś jedna sekcja
i kolorowy podpis „Nowa”/„Opisana” (`index.tsx:167-180`). Wzorce:
[Expensify Inbox](https://mobbin.com/screens/893fd6ff-a900-4a89-8d58-1ab5cef57042?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(kropka przy nowych),
[YNAB](https://mobbin.com/screens/6be05d9b-ece8-49a8-ba40-238e42e53695?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Airwallex](https://mobbin.com/screens/a26206bd-cb56-4405-89bf-21e9ce1718a4?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(zaznaczanie wielu).
Zmiana: sekcje „Nowe (n)” i „Przejrzane”, kropka z etykietą VoiceOver, stan jako
`Znacznik`, „Zaznacz” w górnym pasku i akcje „Zaakceptuj sugestie”, „Ustaw
kategorię” (zbiorczo tylko pewne sugestie z reguły po NIP). Koszt: średni.

---

## 5. Księgowość

**5.1 „Ten miesiąc”: terminy na górze zamiast sześciu kafli.** Nagłówek „7981,12 zł,
najbliższy termin za 11 dni” jest dobry, ale pod nim 6 kafli bez terminów
(`ksiegowosc/index.tsx:63-72`), a płatności z kwotą, terminem i „Oznacz jako
zapłacone” leżą pod zgięciem (`:95-121`). W M3 (`zrzuty/m3/miesiac-jasny.png`)
lista „Podatki i składki” z „do 20 lis” odpowiadała szybciej: **to cofnięcie
względem M3.** Wzorce: [Afterpay](https://mobbin.com/screens/896a8f02-33b2-45e2-8d85-2d30cba028b8?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(oś terminów „zapłacone” i „następna”),
[Rocket Money](https://mobbin.com/screens/117a0083-80d1-40ea-96a2-6e4e451ee582?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„za 18 dni”, potwierdzenie zapłaty),
[Copilot](https://mobbin.com/screens/9b90fb9b-60eb-4a4c-9755-56c0ae9e2893?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(pierścień „zostało / zapłacono”).
Zmiana: pod nagłówkiem karta „Do zapłaty” pogrupowana po terminie („20 listopada,
za 8 dni”: PIT, ZUS społeczne, zdrowotna; „25 listopada”: VAT); wiersz: nazwa,
kwota, plakietka „Zapłacone 12 lis” albo „Za 8 dni” (bursztynowa przy 3 dniach
i mniej); „Zapłacono 1 z 4” jako pierścień. Przychód i koszty niżej,
„Zatwierdź miesiąc” pod kartą płatności. Koszt: średni.

**5.2 Dane przelewu do skopiowania jednym dotknięciem.** „Dane do przelewu” to
ciąg tekstu (`index.tsx:104`); przy PIT nie ma numeru mikrorachunku, tylko napis
(`dane-przykladowe/ksiegowosc.ts:52`); w VAT numer tylko do zaznaczenia
(`vat.tsx:48`); brak `expo-clipboard`. Wzorce:
[Lightyear](https://mobbin.com/screens/49c9d2d9-2dca-484e-a5a6-3cf065805518?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(każde pole z ikoną kopiowania),
[N26](https://mobbin.com/screens/b7a79288-da79-44c7-b615-6983ee8fae41?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(arkusz z „Udostępnij”).
Zmiana: dotknięcie płatności otwiera arkusz `ksiegowosc/przelew`: rachunek,
kwota, symbol formularza, okres, identyfikator, każde z kopiowaniem (ikona na
chwilę zmienia się w znacznik, lekka wibracja); „Udostępnij dane przelewu”;
`PrzyciskGlowny` „Oznacz jako zapłacone” z „Cofnij”. Koszt: średni (nowa
biblioteka natywna, nowy build). Mikrorachunek liczony z NIP to R1.

**5.3 Formularze z ekranów przeglądu do arkuszy.** Pola stoją wprost na ekranach:
„Zapłaty spoza wyliczenia” (`index.tsx:123-147`), wpisy ręczne, spis z natury
i dane osoby do JPK (`ewidencja.tsx:57-94`), imię, nazwisko i data urodzenia
w VAT (`vat.tsx:52-58`, pół ekranu na `m4/vat-jasny.png`). Łamie zasady
(sekcja 2: tworzenie i edycja w arkuszu). Wzorce:
[State Farm](https://mobbin.com/screens/52562e16-b7df-4098-a63c-3545cb75a7e0?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Chime](https://mobbin.com/screens/3573fbdc-81d6-4a31-a0a7-99d2000a911f?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(wiersz-streszczenie prowadzi głębiej).
Zmiana: na ekranie wiersz „Zapłaty spoza wyliczenia: 1 zapisana”, „Spis z natury:
brak na 2026”; pola w arkuszach z Anuluj i Zapisz. Dane osoby do JPK z ustawień
firmy, wiersz „Dane w pliku: Jan Kowalski” z edycją w arkuszu. Koszt: średni.

**5.4 KPiR i ewidencja: księga po dniach, chipy filtrów, wiersz otwiera dokument.**
Dwa filtry naraz (`Segmenty` i ukryty filtr po dotknięciu kolumny, który ma
strzałkę, ale nie nawiguje: `kpir.tsx:76-85`); wpisy to płaska lista bez dat
i bez `onPress` (`kpir.tsx:109-118`, `ewidencja.tsx:42-51`). Wzorce:
[Mercury](https://mobbin.com/screens/6aa8686b-430d-49dd-a4df-6b9fadcba678?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Wise](https://mobbin.com/screens/62ecd9e8-86a2-4d2b-8d67-678e1693356c?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp),
[Monzo](https://mobbin.com/screens/5b0342c9-fa08-4d58-9848-c1089e131e76?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: jeden rząd chipów (Wszystko, Przychody, Koszty, kol. 10 do 13, Do
sprawdzenia); dotknięcie kolumny ustawia chip i przewija do księgi; księga
w kartach po dniu, wiersz otwiera `/faktury/[id]` albo `/koszty/[id]`;
`Stack.SearchBar` po kontrahencie i numerze dowodu. Koszt: średni (chipy:
nowy mały komponent albo wariant `Segmenty`).

---

## 6. Więcej i kontrahenci

**6.1 Nagłówek konta, wyszukiwarka, małe grupy ze stanem, „Wyloguj”.** Nagłówek
to sama firma (`wiecej/index.tsx:33-35`), e-maila i planu nie widać, dziesięć
ustawień w jednej karcie (`:45-49`), brak wyszukiwania; stan po prawej ma tylko
KSeF. **W aplikacji nie ma „Wyloguj”.** Wzorce:
[Google Account](https://mobbin.com/screens/c0a704b6-ec0d-470e-b424-6878cc715d37?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(osoba i e-mail, karty po 1 do 3 pozycji z podtytułem stanu, wyszukiwarka),
[Deel](https://mobbin.com/screens/d1c72cb0-829b-414a-92df-dd39bbb5c45e?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: karta nagłówka (firma, NIP, e-mail konta, plakietki „KSeF połączony”
i plan tylko do odczytu, D5); `Stack.SearchBar` ze słowami kluczowymi („2FA”,
„metoda kasowa”, „certyfikat”); cztery karty: Firma i KSeF; Powiadomienia
i przypomnienia; Zespół i abonament; Bezpieczeństwo i dane. Stan po prawej
(„2FA włączone”, „3 osoby”). „Wyloguj” na dole. Koszt: mały.

**6.2 Karta kontrahenta: przypomnienie przy należnościach, szybkie akcje.**
Nagłówek „W tym po terminie…” nie daje akcji, przypomnienia to tylko przełącznik
(`wiecej/kontrahenci/[id].tsx:83-85`), e-mail i telefon to tekst. Wzorce:
[Monzo](https://mobbin.com/screens/0709b323-452c-4737-9d73-b3f0e59578ee?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(„owes you” i „Send reminder” w jednej karcie),
[Shopify](https://mobbin.com/screens/eef0daad-490b-4e23-862c-2f97c11f1b6a?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(podsumowanie klienta, „Email”, „Phone”, kopiowanie).
Zmiana: przy zaległościach drugorzędny „Wyślij przypomnienie” (arkusz
`faktury/przypomnienie` już jest); rząd akcji Zadzwoń, E-mail, Kopiuj NIP; na
liście kafle działają jak filtry („Z zaległościami”). Koszt: mały.

---

## 7. Logowanie (etap M5): przepływ ekran po ekranie

Klient ma konto ze strony, więc bez ekranu powitalnego „Załóż konto / Zaloguj”:
aplikacja startuje od logowania, jak Mercury.

| Ekran | Co zawiera | Wzorzec |
|---|---|---|
| 1. Start | logo FaktWay; brak sesji prowadzi do logowania, sesja z blokadą do ekranu 5, sesja bez blokady na Pulpit z danymi z poprzedniego otwarcia | [Mercury, logowanie](https://mobbin.com/flows/575d2687-46a9-46b7-86be-4b7c23d0bf60?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) |
| 2. Logowanie | `PasekMarki`, „Zaloguj się”, E-mail i Hasło (oko, autouzupełnianie `username`/`password`), „Nie pamiętasz hasła?” (strona w przeglądarce w aplikacji), `PrzyciskGlowny`, „albo”, „Zaloguj przez Google”, miejsce na Apple za flagą (M11, wytyczna 4.8: nie mniej widoczny niż Google), „Nie masz konta? Załóż je na faktway.pl” (przed M13 sprawdzić wytyczną 3.1). Po wygaśnięciu sesji e-mail wpisany i Face ID w polu | [Mercury](https://mobbin.com/flows/575d2687-46a9-46b7-86be-4b7c23d0bf60?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) |
| 3. 2FA | „Kod z aplikacji”, jedno pole z cyframi tabelarycznymi (`oneTimeCode`, `number-pad`), „Wklej”, wysyłka sama po 6 cyfrach, błędy jak na stronie (`app/(auth)/login/two-factor/page.tsx:25`), „Nie masz dostępu do aplikacji? Napisz do pomocy”. Jedno pole zamiast sześciu kratek: jak na stronie, lepiej z autouzupełnianiem i dużym tekstem | [Kraken](https://mobbin.com/screens/a9dbfe44-8408-4108-8c3c-76fa060330a4?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp), [Family](https://mobbin.com/screens/544d8ce4-1f52-4caa-8d02-3d01bc5c6c5e?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp), kratki dla porównania: [Wise](https://mobbin.com/screens/26cc7fb1-5062-4cf4-9fbb-7dbdc6fba9a9?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) |
| 4. Propozycja Face ID | raz, po pierwszym logowaniu, tylko gdy telefon ma biometrię. `KoloIkony`, „Odblokowuj FaktWay twarzą”, jedno zdanie, „Włącz Face ID” i tekstowe „Nie teraz”; ten sam przełącznik co `wiecej/ustawienia/bezpieczenstwo.tsx:79`; nazwa z `supportedAuthenticationTypesAsync` | [Fidelity](https://mobbin.com/screens/8b44ab13-a693-4ebb-9359-ae0829de6db3?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp), [Betterment](https://mobbin.com/screens/9aaf12b8-f572-4043-8834-5b4a4cb1616f?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) |
| 5. Blokada przy powrocie | logo, „Dzień dobry, Anna”, nazwa firmy (księgowe z kilkoma firmami); systemowe pytanie Face ID samo; po anulowaniu „Odblokuj” i „Zaloguj się na inne konto”. Bez własnego PIN-u (zapas: kod telefonu). Blokada po kilku minutach w tle, w przełączniku aplikacji treść zasłonięta (kwoty) | [Revolut Business, odblokowanie](https://mobbin.com/flows/9a8b70af-4837-42ea-b60a-a2ec74064090?tab=screens&utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp) |
| 6. Wyloguj, usuń konto | „Wyloguj” w Więcej (dziś brak). Usuwanie jest (`wiecej/ustawienia/konto.tsx:35`), ale potwierdza się je hasłem (`:41`), a konto z Google hasła nie ma: dla niego Face ID albo kod 2FA | |

Na później (duży koszt, potrzebny serwer): logowanie kodem QR z komputera, jak
w Mercury; nasi klienci zakładają konto na komputerze.

---

## 8. Stany ekranu (cała aplikacja)

Sprawdzone w kodzie 12.11: w `mobile/src` nie ma szkieletu, `RefreshControl`,
stanu błędu, `expo-clipboard` ani „Wyloguj”; `StanPusty` nie ma akcji.

**8.1 Szkielet ładowania (przed M7).** Kręciołki w `koszty/dodaj.tsx:61`
i `wiecej/ustawienia/ksef.tsx:119`. Wzorzec:
[Mercury](https://mobbin.com/screens/f0d19b48-c4fa-4fc2-9cdc-bf999b23836e?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(tytuł, wyszukiwarka i filtry od razu, szkielet tylko w wierszach).
Zmiana: `Szkielet` w wariantach wiersz, kafel i nagłówek kwoty, w karcie
`Sekcja`; słabe pulsowanie, wyłączone przy „Ogranicz ruch”. Kręciołki przy OCR
i sprawdzaniu KSeF zostają (proces z krokami). Koszt: średni.

**8.2 Pusty stan z akcją, w karcie.** `komponenty/stan-pusty.tsx:7` bez akcji,
`paddingTop: xxl*2` (`:27`) wiesza go wysoko; `faktury/index.tsx:199-201` odsyła
słowami do przycisku i filtrów. Wzorce:
[Wealthsimple](https://mobbin.com/screens/84f21c08-4eee-46a7-bf3d-5bd8e46a8a3c?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(pusty stan w karcie z obwódką pod zakładkami),
[Careem](https://mobbin.com/screens/3bfb007f-4b3a-45a3-8881-0d60de65a072?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: opcjonalna `akcja` („Wyczyść filtry”, „Dodaj wydatek”), pod segmentami
w środku `Sekcja`. Koszt: mały.

**8.3 Błąd, brak sieci, odświeżanie.** Wzorce:
[Glow](https://mobbin.com/screens/40002101-c026-4d71-9f55-82cef3db9415?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(nagłówek zostaje, błąd tylko w miejscu treści),
[GoPay](https://mobbin.com/screens/95483b32-a4d7-4025-b6e7-64220245eff5?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp).
Zmiana: `StanBledu` (czerwony `KoloIkony`, co się stało, „Spróbuj ponownie”)
tylko bez danych z poprzedniego otwarcia; z danymi cienki dopisek „Brak
połączenia. Dane z 12:40.”; odświeżanie pociągnięciem na listach. Koszt: średni.

**8.4 Ekran przyjęcia przez KSeF.** Po „Wystaw i wyślij” arkusz się zamyka
(`faktury/nowa/[rodzaj].tsx:252`), a status zmienia się po cichu z wibracją
sukcesu, nawet gdy klient jest już na innej zakładce (`stan/faktury.tsx:58-67`).
Wzorce: [Jobber](https://mobbin.com/screens/ffc24d22-55cf-4e32-afa6-39c76c713375?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(okrągła ikona, jedno zdanie z kwotą, „Pokaż” i „Gotowe”),
[Lloyds](https://mobbin.com/screens/2b966b9f-f6f5-461a-aa99-7c942a862619?utm_source=claude&utm_medium=ai-assistant&utm_source_platform=mcp)
(ile to potrwa).
Zmiana: arkusz „Wysyłamy do KSeF”, który na żywo przechodzi w „Przyjęta przez
KSeF” z numerem KSeF (`selectable`), kwotą i kontrahentem;
„Udostępnij” i „Gotowe”; wibracja sukcesu tylko tu. Przy zwłoce: „KSeF zwykle
potwierdza w kilka sekund. Możesz zamknąć, status odświeży się sam.” Koszt: średni.

**8.5 Pasek „Cofnij” po geście.** Przesunięcie „Zapłacona” zmienia stan, ale
paska „Cofnij” nie ma (`komponenty/wiersz-faktury.tsx:84,124`); przy filtrze
„Po terminie” wiersz znika od razu (`faktury/index.tsx:64-65`). Zasady (sekcja 5)
wymagają „Cofnij”. Zmiana: `PasekCofnij` nad paskiem zakładek przez 5 s
(„Oznaczono jako zapłaconą: FV/…”, „Cofnij”), z komunikatem dla VoiceOver.
Koszt: mały.

**8.6 Potwierdzenia przez arkusz akcji, nie okno na środku.** Zasady (sekcja 2)
każą potwierdzać usunięcie systemowym arkuszem akcji z czerwoną opcją; dziś
10 miejsc używa `Alert.alert` (m.in. `faktury/[id].tsx:61`,
`faktury/nowa/[rodzaj].tsx:149`, `koszty/[id].tsx:132`,
`wiecej/kontrahenci/[id].tsx:100`, `wiecej/ustawienia/ksiegowa.tsx:83`,
`bezpieczenstwo.tsx:46,63`, `zespol.tsx:37`, `cykliczna.tsx:96,115`). Zmiana:
jeden pomocnik `potwierdz()` na `ActionSheetIOS` (na Androidzie menu Material).
Koszt: mały.

---

## 9. Jak pracujemy z Mobbin

1. **Przed każdym nowym albo przerabianym ekranem** 2 do 4 wyszukiwań w Mobbin
   (narzędzia `search_screens`, `search_flows`, platforma iOS). Szukaj
   w aplikacjach biznesowych i fintech (Revolut Business, Qonto, Mercury, Wise,
   Brex, Ramp, Expensify, Monzo, Stripe). Nazwa aplikacji w zapytaniu zawęża
   wyniki.
2. **Bierzemy wzorzec, nie wygląd.** Układ, kolejność, gęstość, przepływ, stany
   i gesty; wygląd według `ZASADY-DESIGNU.md` (D12 i D15).
3. **Linki, nie zrzuty.** W PR i w tym pliku tylko linki do Mobbin. Zrzutów
   z Mobbin nie zapisujemy w repo (jest publiczne, licencja Mobbin). Wybrane
   wzorce trzymamy w kolekcji Mobbin konta FaktWay.
4. **W opisie PR ekranu** jedno zdanie: z którego wzorca co wzięliśmy i czego
   świadomie nie (checklista w `ZASADY-DESIGNU.md`, sekcja 12).
5. Mobbin jest podpięty w Claude Code na Macu Bartosza (serwer MCP). Codex nie
   ma tego połączenia: korzysta z linków w tym pliku.
