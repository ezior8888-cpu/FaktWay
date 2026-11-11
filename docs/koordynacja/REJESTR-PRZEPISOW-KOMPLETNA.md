# Rejestr przepisów planu kompletnej aplikacji (szkic w formie żelaznego filtra)

Stan na 9.11.2026, odczyt źródeł 8.11.2026. To szkic wpisów dla nowych obszarów planu [`PLAN-KOMPLETNA-APLIKACJA.md`](PLAN-KOMPLETNA-APLIKACJA.md) w tych samych polach co rejestr przepisów żelaznego filtra (`filtr/przepisy/*.json`, plan filtra w PR #486, sekcja B4.1). Po fazach F4 i F10 filtra wpisy przejdą do JSON. Każdy krok planu poda identyfikatory z tego pliku w karcie zmiany prawnej PR.

Zasady:

1. Źródło urzędowe jest pierwsze. Źródło branżowe daje pewność „niska” i pozycję w „Do rozstrzygnięcia”.
2. Liczby roku zostają w `lib/ksiegowosc/parametry/`. Rejestr opisuje reguły, nie kwoty.
3. Wzorzec: 1 system państwowy, 2 dokumenty przyjęte przez urząd, 3 dwie księgowe, 4 urzędowe przykłady, 5 druga implementacja, 6 programy konkurencji.
4. Adresy źródeł są w sekcji 11 planu kompletnej aplikacji. Wpisy powstały z tej sekcji i nie zawierają przepisów spoza niej.


## KSEF: KSeF od 2027 r.

#### RP-KSEF-01. Zakres obowiązkowego KSeF od 2027 r.

- Reguła: Od 1.01.2027 KSeF obowiązuje wszystkich podatników. Do 31.12.2026 sprzedaż do 10 000 zł brutto miesięcznie mogła iść poza KSeF, a faktury z kas i paragony z NIP do 450 zł (100 euro) mogły być fakturami uproszczonymi poza KSeF.
- Podstawa: Strona MF „Zakres obowiązkowego KSeF” (zmiana 06.02.2026), https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/zakres-obowiazkowego-ksef/
- Obowiązuje: od 2026-02-01 (etapami), wyjątki do 2026-12-31; od 2027-01-01 bez wyjątków
- Obszary mapy: `faktury.ksef`, `faktury.fa3`
- Pewność: wysoka
- Wzorzec: poziom 1, strona MF o zakresie KSeF; sprawdzenie w KSeF TEST
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.1, 1.3, 1.6

#### RP-KSEF-02. Dokumenty poza KSeF

- Reguła: Poza KSeF zostają proforma, dowody wewnętrzne, noty uznaniowe i obciążeniowe. Noty korygujące zostały uchylone od 1.02.2026.
- Podstawa: Strona MF „Zakres obowiązkowego KSeF”, ta sama co KSEF-01
- Obowiązuje: od 2026-02-01, bez daty końca
- Obszary mapy: `faktury.ksef`, `faktury.proforma`
- Pewność: wysoka
- Wzorzec: poziom 1, strona MF o zakresie KSeF
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.6, 2.4, 2.9

#### RP-KSEF-03. Przechowywanie faktur w KSeF

- Reguła: Faktura jest w KSeF przechowywana 10 lat od końca roku wystawienia. Potem podatnik sam przechowuje dokument do przedawnienia.
- Podstawa: MF, https://ksef.podatki.gov.pl/ksef-news/zasady-obowiazywania-ksef-i-przepisy-prawne/
- Obowiązuje: od 2026-02-01, bez daty końca
- Obszary mapy: `faktury.archiwum`, `ksef.retencja`
- Pewność: wysoka
- Wzorzec: poziom 1, strona MF o zasadach KSeF
- Do rozstrzygnięcia: prawnik: do kiedy dokładnie liczyć przedawnienie przy eksporcie i wyjściu klienta z programu (krok 6.4)
- Odczyt: 2026-11-08
- Kroki planu: 6.4

#### RP-KSEF-04. Paragon z NIP i kasy od 2027 r. (projekt)

- Reguła: Projekt zmiany rozporządzenia o kasach: od 2027 r. kasa nie wystawia faktur, a paragon z NIP nie jest fakturą uproszczoną. Program nie może na tym opierać obliczeń, dopóki nie ma publikacji w Dzienniku Ustaw.
- Podstawa: Źródła branżowe: infor 7614495 i 7697833 (7.11.2026), adresy w sekcji 11 planu. Brak aktu urzędowego.
- Obowiązuje: od 2027-01-01 (projekt), bez daty końca
- Obszary mapy: `koszty.paragon`, `kasa.faktury`
- Pewność: niska
- Wzorzec: poziom 6, źródło branżowe, bez potwierdzenia urzędowego
- Do rozstrzygnięcia: prawnik: czy rozporządzenie jest opublikowane i w jakim brzmieniu; do czasu potwierdzenia pozycja zostaje przy „niska”
- Odczyt: 2026-11-08
- Kroki planu: 1.3


## FP: Faktura do paragonu

#### RP-FP-01. Faktura do paragonu tylko z NIP

- Reguła: Firmie wystawia się fakturę do paragonu tylko wtedy, gdy paragon ma jej NIP (art. 106b ust. 5 ustawy o VAT). Żądanie zgłoszone w ciągu 3 miesięcy od końca miesiąca sprzedaży musi być zrealizowane.
- Podstawa: Ustawa o VAT art. 106b ust. 5; objaśnienia MF „Paragony fiskalne” z 16.10.2020, https://www.gov.pl/attachment/d0dad28f-849a-4336-acc3-7d71fccb32e5
- Obowiązuje: od 2020-01-01 (art. 106b ust. 5), bez daty końca; objaśnienia MF z 16.10.2020
- Obszary mapy: `faktury.fp`, `faktury.ksef`
- Pewność: wysoka
- Wzorzec: poziom 4, objaśnienia MF z 16.10.2020
- Do rozstrzygnięcia: prawnik: jak ten przepis współgra z projektem z KSEF-04 po 1.01.2027
- Odczyt: 2026-11-08
- Kroki planu: 1.2

#### RP-FP-02. Typ dokumentu FP w JPK_V7

- Reguła: Faktura do paragonu jest w JPK_V7 oznaczana typem dokumentu FP.
- Podstawa: Broszura JPK_VAT z deklaracją od 1.02.2026, https://podatki.gov.pl/media/wgbkrejs/broszura-jpk_vat-z-deklaracj%C4%85-od-1-lutego-2026-r.pdf
- Obowiązuje: od 2026-02-01, bez daty końca
- Obszary mapy: `jpk.v7`
- Pewność: średnia
- Wzorzec: poziom 4, broszura JPK_VAT 2026
- Do rozstrzygnięcia: księgowa: jak FP wpływa na sumy deklaracji, żeby sprzedaż z paragonu nie była policzona dwa razy
- Odczyt: 2026-11-08
- Kroki planu: 1.2, 4.5


## PLAT: Płatności i numer KSeF

#### RP-PLAT-01. Numer KSeF w tytule przelewu

- Reguła: Od 1.01.2027 w płatnościach między czynnymi podatnikami VAT w tytule przelewu podaje się numer KSeF faktury albo identyfikator zbiorczy, także przy podzielonej płatności (MPP).
- Podstawa: Strona MF „Numer KSeF i zbiorczy identyfikator” (zmiana 06.02.2026), https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/numer-ksef-i-zbiorczy-identyfikator/
- Obowiązuje: od 2027-01-01, bez daty końca
- Obszary mapy: `faktury.platnosci`, `banki.wyciag`
- Pewność: wysoka
- Wzorzec: poziom 1, strona MF; sprawdzenie w Aplikacji Podatnika
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.4, 3.2

#### RP-PLAT-02. Identyfikator zbiorczy

- Reguła: Identyfikator zbiorczy ma 35 znaków. Tworzy go wystawca albo odbiorca w Aplikacji Podatnika albo przez API KSeF.
- Podstawa: Strona MF, ta sama co PLAT-01
- Obowiązuje: od 2027-01-01, bez daty końca
- Obszary mapy: `faktury.platnosci`
- Pewność: wysoka
- Wzorzec: poziom 1, strona MF; sprawdzenie na API KSeF TEST
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.4

#### RP-PLAT-03. Podstawa prawna obowiązku w tytule przelewu

- Reguła: Obowiązek podania numeru w przelewie wiąże się według źródeł branżowych z art. 108g ustawy o VAT. Program opiera się na stronie MF, a numer artykułu zostaje do potwierdzenia.
- Podstawa: Źródła branżowe, bez potwierdzenia w ISAP (https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20040540535)
- Obowiązuje: od 2027-01-01, bez daty końca
- Obszary mapy: `faktury.platnosci`
- Pewność: średnia
- Wzorzec: poziom 6, źródło branżowe
- Do rozstrzygnięcia: prawnik: czy art. 108g jest właściwą podstawą i czy obejmuje też sankcję za brak numeru
- Odczyt: 2026-11-08
- Kroki planu: 1.4


## TRYB: Tryby wystawiania w KSeF

#### RP-TRYB-01. Tryb online

- Reguła: W trybie online faktura jest wystawiana w KSeF i dostaje numer KSeF (art. 106na ustawy o VAT).
- Podstawa: Strona MF o trybach (zmiana 24.02.2026), https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/tryby-szczegolne-wystawiania-faktur/; tabela trybów, wersja 12
- Obowiązuje: od 2026-02-01 (KSeF 2.0), bez daty końca
- Obszary mapy: `faktury.ksef`
- Pewność: wysoka
- Wzorzec: poziom 1, tabela trybów, wersja 12; KSeF TEST
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.5

#### RP-TRYB-02. Tryb offline24

- Reguła: Faktura wystawiona w trybie offline24 (art. 106nda i 106nha) jest dosyłana do KSeF najpóźniej następnego dnia roboczego.
- Podstawa: Strona MF o trybach i tabela trybów, wersja 12 (adresy w TRYB-01)
- Obowiązuje: od 2026-02-01 (KSeF 2.0), bez daty końca
- Obszary mapy: `faktury.ksef`, `ksef.dosylanie`
- Pewność: wysoka
- Wzorzec: poziom 1, tabela trybów, wersja 12
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.5

#### RP-TRYB-03. Niedostępność KSeF

- Reguła: Przy niedostępności KSeF (art. 106nh) fakturę dosyła się w 1 dzień roboczy po końcu niedostępności.
- Podstawa: Strona MF o trybach i tabela trybów, wersja 12
- Obowiązuje: od 2026-02-01 (KSeF 2.0), bez daty końca
- Obszary mapy: `faktury.ksef`, `ksef.dosylanie`
- Pewność: wysoka
- Wzorzec: poziom 1, tabela trybów, wersja 12
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.5

#### RP-TRYB-04. Tryb awaryjny

- Reguła: W trybie awaryjnym (art. 106nf) fakturę dosyła się w 7 dni roboczych po końcu awarii.
- Podstawa: Strona MF o trybach i tabela trybów, wersja 12
- Obowiązuje: od 2026-02-01 (KSeF 2.0), bez daty końca
- Obszary mapy: `faktury.ksef`, `ksef.dosylanie`
- Pewność: wysoka
- Wzorzec: poziom 1, tabela trybów, wersja 12
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.5

#### RP-TRYB-05. Awaria całkowita

- Reguła: Przy awarii całkowitej (art. 106ng) faktura jest wystawiana poza KSeF i nie jest dosyłana.
- Podstawa: Strona MF o trybach i tabela trybów, wersja 12
- Obowiązuje: od 2026-02-01 (KSeF 2.0), bez daty końca
- Obszary mapy: `faktury.ksef`
- Pewność: wysoka
- Wzorzec: poziom 1, tabela trybów, wersja 12
- Do rozstrzygnięcia: prawnik: jak program ma rozpoznać, że ogłoszono awarię całkowitą, i skąd wziąć komunikat
- Odczyt: 2026-11-08
- Kroki planu: 1.5

#### RP-TRYB-06. Kody QR

- Reguła: W trybie online faktura ma jeden kod QR z numerem KSeF. W trybie offline ma dwa kody: OFFLINE i CERTYFIKAT.
- Podstawa: Strona MF o trybach i tabela trybów, wersja 12
- Obowiązuje: od 2026-02-01 (KSeF 2.0), bez daty końca
- Obszary mapy: `faktury.pdf`, `faktury.ksef`
- Pewność: wysoka
- Wzorzec: poziom 1, wizualizacja z generatora MF (ksef-pdf-generator, licencja MIT)
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 1.5

#### RP-TRYB-07. Kary z art. 106ni

- Reguła: Projekt odracza kary z art. 106ni do 31.12.2027. Do uchwalenia program traktuje kary jako obowiązujące od 1.01.2027.
- Podstawa: Rada Ministrów, podatki.gov.pl 22.10.2026, https://www.podatki.gov.pl/aktualnosci/rada-ministrow-za-odroczeniem-kar-za-bledy-w-ksef-i-przedluzeniem-odwrotnego-obciazenia-vat
- Obowiązuje: od 2027-01-01 albo 2028-01-01, bez daty końca
- Obszary mapy: `faktury.ksef`, `ksef.kary`
- Pewność: średnia
- Wzorzec: poziom 4, komunikat podatki.gov.pl o projekcie
- Do rozstrzygnięcia: prawnik: czy ustawa odraczająca została uchwalona i opublikowana
- Odczyt: 2026-11-08
- Kroki planu: 1.5, 1.6


## VATOKR: Okresy rozliczeń VAT

#### RP-VATOKR-01. Rozliczenie kwartalne VAT

- Reguła: Rozliczenie kwartalne przysługuje małemu podatnikowi (sprzedaż do 2 mln euro z VAT), nie w pierwszych 12 miesiącach. Zawiadomienie składa się do 25. dnia drugiego miesiąca kwartału.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00232
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.vat`, `jpk.v7`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl 00232
- Do rozstrzygnięcia: księgowa: czy pierwsze 12 miesięcy liczy się od rejestracji, czy od pierwszej sprzedaży
- Odczyt: 2026-11-08
- Kroki planu: 4.1

#### RP-VATOKR-02. Ewidencja JPK, metoda kasowa i VAT-UE

- Reguła: Ewidencja JPK jest składana co miesiąc. Metoda kasowa jest dopuszczalna tylko przy rozliczeniu kwartalnym. Informacja VAT-UE jest zawsze miesięczna, do 25. dnia.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00232
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `jpk.v7`, `ksiegowosc.vat`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl 00232
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.1, 4.5, 4.6

#### RP-VATOKR-03. VAT-8 i VAT-9M

- Reguła: VAT-8 dotyczy zwolnionego podatnika zarejestrowanego jako VAT-UE przy wewnątrzwspólnotowym nabyciu towarów. VAT-9M dotyczy importu usług u podatnika zwolnionego.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00232 i https://www.biznes.gov.pl/pl/portal/00272
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.vat`
- Pewność: średnia
- Wzorzec: poziom 4, strony biznes.gov.pl 00232 i 00272
- Do rozstrzygnięcia: księgowa: terminy, progi i wzory obu deklaracji, bo strony opisują je skrótowo
- Odczyt: 2026-11-08
- Kroki planu: 4.6


## LIM: Limity 2026

#### RP-LIM-01. Mały podatnik VAT

- Reguła: Limit małego podatnika w 2026 r. to 8 517 000 zł.
- Podstawa: podatki.gov.pl, https://podatki.gov.pl/pit/limity (15.12.2025)
- Obowiązuje: od 2026-01-01, do 2026-12-31
- Obszary mapy: `ksiegowosc.parametry`
- Pewność: wysoka
- Wzorzec: poziom 4, tabela limitów podatki.gov.pl
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.1

#### RP-LIM-02. Limit ryczałtu

- Reguła: Limit przychodów do ryczałtu w 2026 r. to 8 517 200 zł.
- Podstawa: podatki.gov.pl/pit/limity (15.12.2025)
- Obowiązuje: od 2026-01-01, do 2026-12-31
- Obszary mapy: `ksiegowosc.parametry`, `ksiegowosc.ryczalt`
- Pewność: wysoka
- Wzorzec: poziom 4, tabela limitów podatki.gov.pl
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.1, 5.2

#### RP-LIM-03. Limit ryczałtu kwartalnego

- Reguła: Limit przychodów dla ryczałtu rozliczanego kwartalnie w 2026 r. to 851 720 zł.
- Podstawa: podatki.gov.pl/pit/limity (15.12.2025)
- Obowiązuje: od 2026-01-01, do 2026-12-31
- Obszary mapy: `ksiegowosc.parametry`
- Pewność: wysoka
- Wzorzec: poziom 4, tabela limitów podatki.gov.pl
- Do rozstrzygnięcia: księgowa: relacja do progu 200 000 euro z PITKW-02 (strony podają różne liczby)
- Odczyt: 2026-11-08
- Kroki planu: 4.1

#### RP-LIM-04. Jednorazowa amortyzacja

- Reguła: Jednorazowa amortyzacja w 2026 r.: 50 000 euro, czyli 213 000 zł.
- Podstawa: podatki.gov.pl/pit/limity (15.12.2025)
- Obowiązuje: od 2026-01-01, do 2026-12-31
- Obszary mapy: `ksiegowosc.parametry`, `ksiegowosc.st`
- Pewność: wysoka
- Wzorzec: poziom 4, tabela limitów podatki.gov.pl
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 5.1

#### RP-LIM-05. Księgi rachunkowe

- Reguła: Obowiązek ksiąg rachunkowych powstaje od 2,5 mln euro, w 2026 r. 10 646 500 zł.
- Podstawa: podatki.gov.pl/pit/limity (15.12.2025)
- Obowiązuje: od 2026-01-01, do 2026-12-31
- Obszary mapy: `ksiegowosc.parametry`
- Pewność: wysoka
- Wzorzec: poziom 4, tabela limitów podatki.gov.pl
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 5.9


## PITKW: Zaliczki kwartalne PIT

#### RP-PITKW-01. Zaliczki kwartalne

- Reguła: Zaliczki kwartalne mogą płacić mali podatnicy i rozpoczynający działalność. Termin: do 20. dnia po kwartale, za IV kwartał do 20 stycznia.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00264
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.pit`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl 00264
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.1

#### RP-PITKW-02. Ryczałt kwartalny

- Reguła: Ryczałt może być rozliczany kwartalnie do 200 000 euro przychodu.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00264
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.ryczalt`
- Pewność: średnia
- Wzorzec: poziom 4, strona biznes.gov.pl 00264
- Do rozstrzygnięcia: księgowa: czy 200 000 euro to ten sam próg co 851 720 zł z LIM-03 i skąd w programie brać kurs do przeliczenia
- Odczyt: 2026-11-08
- Kroki planu: 4.1


## KASPIT: Kasowy PIT

#### RP-KASPIT-01. Metoda kasowa w PIT

- Reguła: Kasowy PIT: JDG z przychodem z poprzedniego roku do 2 mln zł. Oświadczenie do 20 lutego (przy starcie w trakcie roku do 20. dnia następnego miesiąca). Przychód powstaje w dniu zapłaty, najpóźniej po 2 latach od wystawienia faktury. Dostępne przy skali, liniowym, IP Box i ryczałcie.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/005347 (sprawdzone 8.11.2026)
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.pit`, `ksiegowosc.pkpir`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl 005347
- Do rozstrzygnięcia: księgowa: jak liczyć koszty przy metodzie kasowej i co z fakturami nieopłaconymi po 2 latach
- Odczyt: 2026-11-08
- Kroki planu: 4.2


## ST: Środki trwałe i struktury JPK

#### RP-ST-01. Środki trwałe

- Reguła: Środek trwały to składnik o wartości powyżej 10 000 zł (netto u czynnych podatników VAT, brutto u zwolnionych), używany dłużej niż rok. Wpis najpóźniej w miesiącu przekazania do używania, z KŚT i stawką. Ewidencja wyposażenia zniesiona od 2020 r.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00233
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.st`, `ksiegowosc.pkpir`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl 00233
- Do rozstrzygnięcia: księgowa: sprawdzenie stawek amortyzacji i KŚT na złotych przypadkach
- Odczyt: 2026-11-08
- Kroki planu: 5.1

#### RP-ST-02. JPK_ST, JPK_PKPIR i JPK_EWP: kto i kiedy

- Reguła: Według gov.pl obowiązek prowadzenia ksiąg w programie dla grupy V7M zaczyna się od 2026 r., a dla pozostałych od 2027 r. JPK_PKPIR i JPK_EWP składa się w terminie zeznania, JPK_ST obok nich. Terminy dla poszczególnych grup nie są jednoznaczne w źródłach.
- Podstawa: MF, https://www.gov.pl/web/finanse/nowe-zasady-dokumentacji-ksiegowej-w-podatku-pit-od-2026-r-wazne-informacje (16.10.2025); broszura JPK_ST(1), https://www.podatki.gov.pl/media/jikpuwwp/broszura_informacyjna_dot_jpk_st-1.pdf
- Obowiązuje: od 2026-01-01 (V7M) i 2027-01-01 (pozostali), bez daty końca
- Obszary mapy: `jpk.st`, `jpk.pkpir`, `jpk.ewp`
- Pewność: średnia
- Wzorzec: poziom 4, strona gov.pl i broszury MF
- Do rozstrzygnięcia: księgowa: w którym roku która grupa składa JPK z księgami po raz pierwszy (czy za 2027 r. w 2028 r.) i czy pytanie dotyczy tylko grupy V7M
- Odczyt: 2026-11-08
- Kroki planu: 5.1, 5.6


## AUTO: Samochód w firmie

#### RP-AUTO-01. VAT od samochodu

- Reguła: Odliczenie VAT wynosi 100 % przy złożonym VAT-26 i prowadzeniu ewidencji przebiegu, inaczej 50 %.
- Podstawa: Ustawa o VAT (ISAP z sekcji 11), art. 86a (odliczenie 50 %, warunki 100 %: VAT-26 i ewidencja przebiegu)
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.vat`, `koszty.auto`
- Pewność: średnia
- Wzorzec: poziom 4, ustawa o VAT, bez osobnego przykładu urzędowego w sekcji 11
- Do rozstrzygnięcia: księgowa: warunki 100 % (VAT-26, ewidencja przebiegu) i terminy zgłoszenia; brak osobnego źródła w sekcji 11
- Odczyt: 2026-11-08
- Kroki planu: 4.7

#### RP-AUTO-02. PIT od samochodu o użytku mieszanym

- Reguła: Przy użytku mieszanym w koszty idzie 75 % wydatków (art. 23 ust. 1 pkt 4 ustawy o PIT).
- Podstawa: Odpowiedź MF na interpelację 11803 z 24.09.2025, https://api.sejm.gov.pl/sejm/term10/interpellations/attachment/ATTDLZHXM/i11803-o1.pdf
- Obowiązuje: od 2026-01-01, bez daty końca
- Obszary mapy: `ksiegowosc.pit`, `koszty.auto`
- Pewność: średnia
- Wzorzec: poziom 4, odpowiedź MF na interpelację
- Do rozstrzygnięcia: księgowa: odniesienie do zasady 20 % z samochodu przy użytku mieszanym; stan z przepisów
- Odczyt: 2026-11-08
- Kroki planu: 4.7

#### RP-AUTO-03. Limity kosztu samochodu od 2026 r.

- Reguła: Dla aut wprowadzonych do ewidencji od 1.01.2026 limity kosztu to 150 000 zł (emisja poniżej 50 g CO2/km), 100 000 zł (co najmniej 50 g CO2/km) i 225 000 zł (elektryczne i wodorowe), art. 23 ust. 1 pkt 4 i art. 47a ustawy o PIT.
- Podstawa: Odpowiedź MF na interpelację 11803 z 24.09.2025 (adres w AUTO-02)
- Obowiązuje: od 2026-01-01, bez daty końca
- Obszary mapy: `ksiegowosc.parametry`, `koszty.auto`
- Pewność: wysoka
- Wzorzec: poziom 4, odpowiedź MF na interpelację
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.7


## BL: Biała lista

#### RP-BL-01. Płatność na rachunek spoza wykazu

- Reguła: Płatność ponad 15 000 zł na rachunek spoza wykazu: brak kosztu i solidarna odpowiedzialność, chyba że zawiadomienie urzędu w 7 dni. Starsza strona gov.pl mówi o 14 dniach.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00226
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `koszty.platnosci`, `vat.biala_lista`
- Pewność: średnia
- Wzorzec: poziom 4, strona biznes.gov.pl 00226
- Do rozstrzygnięcia: księgowa albo prawnik: 7 czy 14 dni na zawiadomienie (źródła się różnią), do czasu rozstrzygnięcia program ostrzega z krótszym terminem
- Odczyt: 2026-11-08
- Kroki planu: 3.4


## ZUS: ZUS

#### RP-ZUS-01. DRA co miesiąc

- Reguła: Deklaracja rozliczeniowa DRA jest obowiązkowa co miesiąc od 2022 r. dla wszystkich przedsiębiorców.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00287
- Obowiązuje: od 2022-01-01, bez daty końca
- Obszary mapy: `ksiegowosc.zus`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl 00287
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.4

#### RP-ZUS-02. Import plików KEDU w ePłatniku

- Reguła: ePłatnik importuje pliki w formacie KEDU.
- Podstawa: zus.pl, https://www.zus.pl/portal/pomoc/epl0017.html
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.zus`
- Pewność: wysoka
- Wzorzec: poziom 1, import pliku w ePłatniku
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.4

#### RP-ZUS-03. Mały ZUS Plus 2026

- Reguła: Warunki: przychód do 120 000 zł, co najmniej 60 dni działalności w poprzednim roku, 36 miesięcy w ciągu 60. Podstawa to 50 % przeciętnego miesięcznego dochodu (ryczałt: dochód to 50 % przychodu), w granicach 1 441,80-5 652 zł. Zgłoszenie do 31 stycznia.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/00284
- Obowiązuje: od 2026-01-01, do 2026-12-31
- Obszary mapy: `ksiegowosc.zus`, `ksiegowosc.parametry`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl 00284
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.3

#### RP-ZUS-04. Wakacje składkowe

- Reguła: Wakacje składkowe: do 10 ubezpieczonych, przychód do 2 mln euro w jednym z 2 poprzednich lat, wniosek RWS w poprzednim miesiącu przez PUE. Nie zwalniają ze zdrowotnej, DRA składa się i tak.
- Podstawa: biznes.gov.pl, https://www.biznes.gov.pl/pl/portal/ou710
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.zus`
- Pewność: wysoka
- Wzorzec: poziom 4, strona biznes.gov.pl ou710
- Do rozstrzygnięcia: brak
- Odczyt: 2026-11-08
- Kroki planu: 4.3, 4.4

#### RP-ZUS-05. Roczne rozliczenie składki zdrowotnej

- Reguła: Roczne rozliczenie zdrowotnej jest w DRA za kwiecień, do 20 maja.
- Podstawa: Komunikaty ZUS, do potwierdzenia na zus.pl (krok 5.7)
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.zus`
- Pewność: średnia
- Wzorzec: poziom 4, komunikaty ZUS, bez przykładu urzędowego
- Do rozstrzygnięcia: księgowa: potwierdzić termin i sposób na zus.pl
- Odczyt: 2026-11-08
- Kroki planu: 5.7


## KASA: Kasy rejestrujące

#### RP-KASA-01. Obowiązek kasy i zwolnienia

- Reguła: Osoby fizyczne zaczynają ewidencjonować na kasie po przekroczeniu 20 000 zł sprzedaży. Zwolnienia z rozporządzenia obowiązują do 31.12.2027.
- Podstawa: Dz.U. 2024 poz. 1902 (zmiana 2026 poz. 420), https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20240001902; https://www.biznes.gov.pl/pl/portal/00243
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), zwolnienia do 2027-12-31
- Obszary mapy: `kasa`
- Pewność: wysoka
- Wzorzec: poziom 4, rozporządzenie w ISAP
- Do rozstrzygnięcia: prawnik: które zwolnienia dotyczą klientów FaktWay i jak to zmienia KSEF-04
- Odczyt: 2026-11-08
- Kroki planu: 9.3


## OSS: OSS

#### RP-OSS-01. Próg OSS

- Reguła: Próg 10 000 euro obejmuje łącznie sprzedaż na odległość i usługi elektroniczne.
- Podstawa: Objaśnienia MF z 2021 r., https://www.podatki.gov.pl/media/b0mptv5d/objasnienia-podatkowe-vat-e-commerce.pdf
- Obowiązuje: od 2021-07-01, bez daty końca
- Obszary mapy: `vat.oss`
- Pewność: wysoka
- Wzorzec: poziom 4, objaśnienia MF z 2021 r.
- Do rozstrzygnięcia: księgowa: sposób liczenia progu przy kilku krajach i walutach
- Odczyt: 2026-11-08
- Kroki planu: 9.4, 2.3


## ZLED: Złe długi

#### RP-ZLED-01. Korekta VAT na złych długach

- Reguła: Korekta podstawy VAT z tytułu złego długu jest raportowana w JPK polami KorektaPodstawyOpodt, TerminPlatnosci i DataZaplaty.
- Podstawa: Broszura JPK_VAT z deklaracją od 1.02.2026 (adres w FP-02)
- Obowiązuje: od 2026-02-01, bez daty końca
- Obszary mapy: `jpk.v7`, `ksiegowosc.vat`
- Pewność: średnia
- Wzorzec: poziom 4, broszura JPK_VAT 2026
- Do rozstrzygnięcia: księgowa: liczba dni i okres korekty (nie ma ich w źródłach sekcji 11)
- Odczyt: 2026-11-08
- Kroki planu: 3.5

#### RP-ZLED-02. Ulga na złe długi w PIT

- Reguła: Ulga na złe długi w PIT wynika z ustawy o zatorach płatniczych.
- Podstawa: Dz.U. 2019 poz. 1649, https://isap.sejm.gov.pl/isap.nsf/download.xsp/WDU20190001649/T/D20191649L.pdf
- Obowiązuje: od 2020-01-01, bez daty końca
- Obszary mapy: `ksiegowosc.pit`
- Pewność: średnia
- Wzorzec: poziom 4, tekst ustawy
- Do rozstrzygnięcia: księgowa: warunki i terminy ulgi oraz skutek dla PKPiR
- Odczyt: 2026-11-08
- Kroki planu: 3.5


## WAL: Waluty

#### RP-WAL-01. Kurs NBP do VAT

- Reguła: Podstawę opodatkowania w walucie obcej przelicza się według kursu NBP zgodnie z art. 31a ustawy o VAT.
- Podstawa: Ustawa o VAT art. 31a, ISAP z sekcji 11
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `faktury.waluty`, `jpk.v7`
- Pewność: wysoka
- Wzorzec: poziom 4, tekst ustawy, kursy z nbp.pl
- Do rozstrzygnięcia: księgowa: który dzień kursu przy fakturze z datą sprzedaży innej niż wystawienia
- Odczyt: 2026-11-08
- Kroki planu: 2.1

#### RP-WAL-02. Kurs i różnice kursowe w PIT

- Reguła: Dzień kursu i różnice kursowe w PIT regulują art. 24c ustawy o PIT oraz odpowiednie przepisy dla przychodów. Sekcja 11 planu nie ma osobnego źródła, więc wpis wymaga potwierdzenia.
- Podstawa: Ustawa o PIT art. 24c (brak osobnego adresu w sekcji 11)
- Obowiązuje: data wejścia do uzupełnienia (obowiązuje w dniu odczytu 2026-11-08), bez daty końca
- Obszary mapy: `ksiegowosc.pit`, `faktury.waluty`
- Pewność: średnia
- Wzorzec: poziom 3, do potwierdzenia przez dwie księgowe
- Do rozstrzygnięcia: księgowa: dzień kursu dla przychodu i kosztu oraz ujęcie różnic kursowych w KPiR
- Odczyt: 2026-11-08
- Kroki planu: 2.1, 3.6


## Tabela zbiorcza

| Id | Tytuł | Pewność | Kroki |
|---|---|---|---|
| RP-KSEF-01 | Zakres obowiązkowego KSeF od 2027 r. | wysoka | 1.1, 1.3, 1.6 |
| RP-KSEF-02 | Dokumenty poza KSeF | wysoka | 1.6, 2.4, 2.9 |
| RP-KSEF-03 | Przechowywanie faktur w KSeF | wysoka | 6.4 |
| RP-KSEF-04 | Paragon z NIP i kasy od 2027 r. (projekt) | niska | 1.3 |
| RP-FP-01 | Faktura do paragonu tylko z NIP | wysoka | 1.2 |
| RP-FP-02 | Typ dokumentu FP w JPK_V7 | średnia | 1.2, 4.5 |
| RP-PLAT-01 | Numer KSeF w tytule przelewu | wysoka | 1.4, 3.2 |
| RP-PLAT-02 | Identyfikator zbiorczy | wysoka | 1.4 |
| RP-PLAT-03 | Podstawa prawna obowiązku w tytule przelewu | średnia | 1.4 |
| RP-TRYB-01 | Tryb online | wysoka | 1.5 |
| RP-TRYB-02 | Tryb offline24 | wysoka | 1.5 |
| RP-TRYB-03 | Niedostępność KSeF | wysoka | 1.5 |
| RP-TRYB-04 | Tryb awaryjny | wysoka | 1.5 |
| RP-TRYB-05 | Awaria całkowita | wysoka | 1.5 |
| RP-TRYB-06 | Kody QR | wysoka | 1.5 |
| RP-TRYB-07 | Kary z art. 106ni | średnia | 1.5, 1.6 |
| RP-VATOKR-01 | Rozliczenie kwartalne VAT | wysoka | 4.1 |
| RP-VATOKR-02 | Ewidencja JPK, metoda kasowa i VAT-UE | wysoka | 4.1, 4.5, 4.6 |
| RP-VATOKR-03 | VAT-8 i VAT-9M | średnia | 4.6 |
| RP-LIM-01 | Mały podatnik VAT | wysoka | 4.1 |
| RP-LIM-02 | Limit ryczałtu | wysoka | 4.1, 5.2 |
| RP-LIM-03 | Limit ryczałtu kwartalnego | wysoka | 4.1 |
| RP-LIM-04 | Jednorazowa amortyzacja | wysoka | 5.1 |
| RP-LIM-05 | Księgi rachunkowe | wysoka | 5.9 |
| RP-PITKW-01 | Zaliczki kwartalne | wysoka | 4.1 |
| RP-PITKW-02 | Ryczałt kwartalny | średnia | 4.1 |
| RP-KASPIT-01 | Metoda kasowa w PIT | wysoka | 4.2 |
| RP-ST-01 | Środki trwałe | wysoka | 5.1 |
| RP-ST-02 | JPK_ST, JPK_PKPIR i JPK_EWP: kto i kiedy | średnia | 5.1, 5.6 |
| RP-AUTO-01 | VAT od samochodu | średnia | 4.7 |
| RP-AUTO-02 | PIT od samochodu o użytku mieszanym | średnia | 4.7 |
| RP-AUTO-03 | Limity kosztu samochodu od 2026 r. | wysoka | 4.7 |
| RP-BL-01 | Płatność na rachunek spoza wykazu | średnia | 3.4 |
| RP-ZUS-01 | DRA co miesiąc | wysoka | 4.4 |
| RP-ZUS-02 | Import plików KEDU w ePłatniku | wysoka | 4.4 |
| RP-ZUS-03 | Mały ZUS Plus 2026 | wysoka | 4.3 |
| RP-ZUS-04 | Wakacje składkowe | wysoka | 4.3, 4.4 |
| RP-ZUS-05 | Roczne rozliczenie składki zdrowotnej | średnia | 5.7 |
| RP-KASA-01 | Obowiązek kasy i zwolnienia | wysoka | 9.3 |
| RP-OSS-01 | Próg OSS | wysoka | 9.4, 2.3 |
| RP-ZLED-01 | Korekta VAT na złych długach | średnia | 3.5 |
| RP-ZLED-02 | Ulga na złe długi w PIT | średnia | 3.5 |
| RP-WAL-01 | Kurs NBP do VAT | wysoka | 2.1 |
| RP-WAL-02 | Kurs i różnice kursowe w PIT | średnia | 2.1, 3.6 |

Wpisów: 44.
