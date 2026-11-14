# Pytania z rejestru przepisów

> Plik generowany: `node scripts/filtr/rejestr.mjs --pytania`. Nie edytuj ręcznie; test
> `tests/filtr/rejestr.test.ts` pilnuje, żeby był aktualny. Źródło: pola
> `do_rozstrzygniecia` w `filtr/przepisy/*.json` (plan żelaznego filtra, B4.1 pkt 4).
> Materiał dla księgowej i prawnika przed bramą B2 i B4 planu księgowości.
>
> Numery artykułów w regułach spisała sesja agenta z planu księgowości i źródeł urzędowych;
> prawnik sprawdza każdy przed podpisem (`sprawdzil.prawnik`), także w regułach bez pytania.

## Dla księgowej (24)

- **RP-FA-ROZ-01** (pewność średnia): Czy na fakturze rozliczającej (art. 106f ust. 3) P_13_x i P_14_x to wartość i podatek zamówienia pomniejszone o zaliczki w tej samej stawce, przy pełnych pozycjach FaWiersz? Opis pól w schemacie potwierdza tylko P_15 (kwota pozostała do zapłaty). Przypadki: zamówienie 10 000 zł netto 23%, zaliczka 2 460 zł brutto: P_13_1 = 8 000, P_14_1 = 1 840, P_15 = 9 840.
  - Reguła: Faktura rozliczająca: pozycje (FaWiersz) pokazują pełne zamówienie, a P_13_x i P_14_x to wartość i podatek zamówienia w stawce pomniejszone o zaliczki w tej stawce (rozbicie z faktury zaliczkowej ma pierwszeństwo przed wzorem); P_15 to kwota pozostała do zapłaty.
  - Podstawa: art. 106f ust. 3 (ustawa o podatku od towarów i usług); opis pola P_15 (schemat FA(3) Ministerstwa Finansów (lib/xml/schemas/fa3/schemat.xsd)).
  - Jak liczy program: P_13_x i P_14_x faktury rozliczającej po odjęciu zaliczek w tej samej stawce, pozycje pełne (zmiana z 28.09.2026; wcześniej zaliczki odejmowało Rozliczenie/Odliczenia i VAT zaliczek był na fakturze drugi raz).
- **RP-DATA-01** (pewność średnia): Czy pominięcie zapłaty otrzymanej przed wystawieniem faktury (bez faktury zaliczkowej) jest bezpieczne dla JDG w pilotażu?
  - Reguła: Dzień przychodu to dzień wydania rzeczy albo wykonania usługi, nie później niż dzień wystawienia faktury albo zapłaty; ewidencja i KPiR liczą go tą samą funkcją.
  - Podstawa: art. 14 ust. 1c (ustawa o podatku dochodowym od osób fizycznych); art. 6 ust. 1a (ustawa o zryczałtowanym podatku dochodowym od niektórych przychodów osiąganych przez osoby fizyczne).
  - Jak liczy program: Program zna datę sprzedaży i wystawienia; zapłaty przed wystawieniem (poza zaliczką) nie bierze pod uwagę.
- **RP-KOR-01** (pewność średnia): Korekta z powodu błędu rachunkowego albo oczywistej omyłki zmienia okres pierwotny; program tego nie rozpozna. Czy wystarczy komunikat dla klienta, czy potrzebny jest znacznik przy korekcie?
  - Reguła: Korekta przychodu wchodzi różnicą (także ujemną) w okresie wystawienia faktury korygującej, chyba że wynika z błędu rachunkowego albo oczywistej omyłki (wtedy okres pierwotny).
  - Podstawa: art. 14 ust. 1m (ustawa o podatku dochodowym od osób fizycznych); art. 6 ust. 1a (ustawa o zryczałtowanym podatku dochodowym od niektórych przychodów osiąganych przez osoby fizyczne).
  - Jak liczy program: Program nie rozpozna korekty z powodu błędu rachunkowego: każdą korektę ujmuje w dniu jej wystawienia.
- **RP-KOR-02** (pewność średnia): Czy przeniesienie ujemnej reszty korekty w obrębie tej samej stawki ryczałtu jest zgodne z praktyką (G12)? Przypadki: G12.
  - Reguła: Korekta większa niż przychód okresu zmniejsza przychód tej samej stawki w kolejnych okresach roku; ujemna reszta po grudniu zostaje do zeznania rocznego.
  - Podstawa: art. 14 ust. 1n (ustawa o podatku dochodowym od osób fizycznych); art. 6 ust. 1a (ustawa o zryczałtowanym podatku dochodowym od niektórych przychodów osiąganych przez osoby fizyczne).
- **RP-ZAL-01** (pewność niska): Art. 14 ust. 3 pkt 1 ustawy o PIT: zaliczka na dostawę wykonaną w następnym okresie nie jest przychodem. Czy zaliczka ma wchodzić w miesiącu zaliczki, czy dopiero w miesiącu wykonania? Zmiana dotyczy też KPiR.
  - Reguła: Zaliczka nie jest liczona dwa razy: faktura zaliczkowa wchodzi w miesiącu zaliczki, a faktura rozliczająca pomniejszona o rozliczone zaliczki (tak samo w ewidencji i KPiR).
  - Podstawa: art. 14 ust. 1c i ust. 3 pkt 1 (ustawa o podatku dochodowym od osób fizycznych).
  - Jak liczy program: Zaliczka wchodzi do przychodu w miesiącu jej otrzymania (faktury zaliczkowej).
- **RP-FP-01** (pewność wysoka): Czy porównanie raportów kasy z miesiąca paragonu z sumą faktur do paragonów z tego miesiąca (kwoty netto) wystarcza, żeby uznać, że sprzedaż z FP weszła już do ewidencji i KPiR? Rodzaj wpisu „Raport z kasy rejestrującej” ma w formularzu wartość domyślną, więc o pokryciu decydują też kwoty. Przypadki: G30.
  - Reguła: Faktura do paragonu (FP) nie jest drugim przychodem, jeśli sprzedaż weszła już z raportu kasy fiskalnej.
  - Podstawa: art. 14 ust. 1 (ustawa o podatku dochodowym od osób fizycznych); PLAN-KSIEGOWOSC-JDG §4 pkt 2 (zasada programu).
  - Jak liczy program: Raport kasy to wpis ręczny „Raport z kasy rejestrującej” (w KPiR w kolumnie 7). FP jest poza ewidencją i KPiR, gdy raporty kasy z miesiąca dnia przychodu FP (dnia paragonu) są nie niższe niż suma faktur do paragonów z tego miesiąca (netto w złotych); bez raportu kasy, przy niższej kwocie oraz przy FP w walucie, korekcie, zaliczce albo z kwotą nie większą niż 0 jest brak z wyjściem.
- **RP-FP-02** (pewność wysoka): Czy JPK_V7M za miesiąc wystawienia FP do paragonu z wcześniejszego miesiąca jest kompletny bez wierszy RO, gdy w tym miesiącu nie było sprzedaży z kasy, i czy wiersz FP ma pełne kwoty w polach K_10-K_36? Przypadki: G30.
  - Reguła: Faktura do paragonu (FP) w JPK_V7M: wiersz ewidencji sprzedaży z oznaczeniem TypDokumentu FP w okresie wystawienia, z pełnymi kwotami w polach K_; kwoty FP nie wchodzą do PodatekNalezny ani do części deklaracyjnej, bo sprzedaż z paragonu wykazuje raport z kasy (RO). FaktWay nie wykazuje raportów z kasy, więc FP z paragonem z miesiąca pliku daje odmowę.
  - Podstawa: art. 109 ust. 3d (ustawa o podatku od towarów i usług); TDowoduSprzedazy (RO, WEW, FP) według § 10 ust. 5 rozporządzenia MFiR z 15.10.2019 (Dz.U. 2019 poz. 1988); opis pola PodatekNalezny (schemat JPK_V7M(3), CRWDE 2025/12/19/14090 (lib/exports/schemas/jpk-v7m3/schemat.xsd)); oznaczenia dokumentów, pytania 15, 17, 18, 20, 22, 23 (MF, Pytania i odpowiedzi JPK_VAT z deklaracją).
  - Jak liczy program: Plik jest za miesiąc wystawienia, więc FP ze sprzedażą (paragonem) z tego samego miesiąca wymagałaby w pliku raportu z kasy z tą sprzedażą: odmowa z wyjściem (JpkV7mReceiptSaleInPeriodError). FP z paragonem z wcześniejszego miesiąca: wiersz FP bez podatku należnego. Korekta FP i FP z innym oznaczeniem z pliku KSeF (TP, GTU, procedury): odmowa jak dotąd.
- **RP-RYCZ-STAWKI-02** (pewność średnia): Czy podział składek społecznych proporcjonalnie do przychodu z każdej stawki jest akceptowany (G4)? Przypadki: G4.
  - Reguła: Przy kilku stawkach odliczenia dzieli się proporcjonalnie do przychodu z każdej stawki (co do grosza); podstawę każdej stawki i ryczałt z sumy zaokrągla się do pełnych złotych.
  - Podstawa: art. 11 ust. 1 i 1a, art. 12 (ustawa o zryczałtowanym podatku dochodowym od niektórych przychodów osiąganych przez osoby fizyczne).
- **RP-NAJEM-01** (pewność średnia): Korekta najmu po progu: czy kolejność (najpierw nadwyżka 12,5 %) jest właściwa (G3)? Przypadki: G3.
  - Reguła: Przychód z najmu do 100 tys. zł w roku: 8,5 %, nadwyżka 12,5 %; wiersz przekraczający próg dzieli się, a korekta in minus po przekroczeniu progu najpierw zmniejsza nadwyżkę 12,5 %.
  - Podstawa: art. 12 ust. 1 pkt 3 lit. a (ustawa o zryczałtowanym podatku dochodowym od niektórych przychodów osiąganych przez osoby fizyczne).
- **RP-ZALICZKA-PIT-01** (pewność średnia): Potwierdzić zaliczki skali i liniowego na przypadkach G8-G11 (strata miesiąca, składki do wysokości dochodu). Przypadki: G8, G9, G10, G11.
  - Reguła: Zaliczka na PIT (skala i liniowy): dochód od początku roku z KPiR minus zapłacone w roku składki społeczne (bez FP, najwyżej do dochodu); podstawa do pełnych złotych; zaliczka to podatek od początku roku minus zaliczki należne za wcześniejsze miesiące, nie mniej niż zero.
  - Podstawa: art. 44 ust. 1a, 3f i 6 (ustawa o podatku dochodowym od osób fizycznych); art. 26 ust. 1 pkt 2 (ustawa o podatku dochodowym od osób fizycznych).
- **RP-ZDR-RYCZ-01** (pewność średnia): Potwierdzić kwoty zdrowotnej ryczałtu 2026 (498,35 / 830,58 / 1 495,04 zł) z komunikatu ZUS; źródło w planie było branżowe.
  - Reguła: Składka zdrowotna przy ryczałcie: 9 % od 60, 100 albo 180 % przeciętnego wynagrodzenia z IV kwartału roku poprzedniego, według przychodu od początku roku do 60 tys., do 300 tys. i ponad 300 tys. zł.
  - Podstawa: art. 79 ust. 1 i art. 81 ust. 2h (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków publicznych).
- **RP-ZDR-PROG-01** (pewność średnia): Czy pomniejszenie o składki społeczne dotyczy testu progu (źródła nie mówią wprost)? Przypadki: G1, G5.
  - Reguła: Próg zdrowotnej przy ryczałcie liczy się z przychodu od początku roku pomniejszonego o zapłacone składki społeczne bez FP; wyższa składka obowiązuje od miesiąca przekroczenia, bez korekty wcześniejszych miesięcy.
  - Podstawa: art. 81 ust. 2h (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków publicznych).
- **RP-ZDR-STYCZEN-01** (pewność niska): ZUS może wymagać progu za styczeń z przychodu całego poprzedniego roku. Która reguła jest właściwa? Przypadki: G5.
  - Reguła: Styczeń należy do roku składkowego luty-styczeń; program liczy próg zdrowotnej za styczeń z przychodu stycznia.
  - Podstawa: art. 81 ust. 2h (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków publicznych).
  - Jak liczy program: Kwot przed podpisem parametrów i tak nie widać (D7).
- **RP-ZDR-DOCHOD-01** (pewność średnia): Potwierdzić zdrowotną od dochodu przy stracie i za styczeń (dochód z grudnia). Przypadki: G8, G9.
  - Reguła: Składka zdrowotna przy skali 9 %, przy liniowym 4,9 % dochodu z poprzedniego miesiąca (przychód minus koszty z KPiR minus składki społeczne zapłacone w tamtym miesiącu); za styczeń dochód z grudnia; nie mniej niż minimum roku składkowego (9 % płacy minimalnej).
  - Podstawa: art. 79 ust. 1 i 1a, art. 81 ust. 2 i 2b (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków publicznych).
- **RP-ZDR-ROK-01** (pewność średnia): Potwierdzić, że kwoty i minimum zdrowotnej obowiązują od lutego, a styczeń należy do roku poprzedniego (komunikat ZUS).
  - Reguła: Rok składkowy zdrowotnej trwa od lutego do stycznia: kwoty i minimum ogłoszone na rok obowiązują od 1 lutego, styczeń należy do roku poprzedniego.
  - Podstawa: art. 81 ust. 2h (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków publicznych).
- **RP-ZUS-PELNY-01** (pewność średnia): Kwoty 2027 zależą od ustawy budżetowej i komunikatu ZUS; porównać w e-Płatniku przed styczniem (protokół ręczny F14).
  - Reguła: Pełne składki społeczne: podstawa 60 % prognozowanego przeciętnego wynagrodzenia; emerytalna 19,52 %, rentowa 8 %, chorobowa 2,45 % (dobrowolna), wypadkowa według stopy (zmiana od 1 kwietnia), Fundusz Pracy 2,45 % osobno.
  - Podstawa: art. 18 ust. 8, art. 22 (ustawa o systemie ubezpieczeń społecznych); Fundusz Pracy (ustawa o promocji zatrudnienia i instytucjach rynku pracy).
- **RP-ZUS-PREF-01** (pewność średnia): Potwierdzić preferencyjne składki 2026 (456,18 zł z chorobową) i liczenie 24 miesięcy od dnia startu etapu.
  - Reguła: Preferencyjne składki przez 24 miesiące: podstawa 30 % minimalnego wynagrodzenia, bez Funduszu Pracy.
  - Podstawa: art. 18a (ustawa o systemie ubezpieczeń społecznych).
- **RP-ZUS-ULGA-01** (pewność średnia): Potwierdzić 6 miesięcy ulgi na start liczone od dnia rozpoczęcia działalności, także w trakcie miesiąca.
  - Reguła: Ulga na start: przez 6 miesięcy bez składek społecznych, składka zdrowotna płatna.
  - Podstawa: art. 18 ust. 1 (Prawo przedsiębiorców).
- **RP-ZUS-ETAP-01** (pewność średnia): Czy pełna zdrowotna za miesiąc rozpoczęcia działalności jest właściwa (G13)? Przypadki: G13.
  - Reguła: Etap ZUS, który zaczyna się albo kończy w trakcie miesiąca (poza startem ulgi), daje brak samych składek społecznych z wyjściem (PUE ZUS, księgowa); ryczałt i zdrowotna liczą się dalej; zdrowotna za miesiąc startu w pełnej kwocie.
  - Podstawa: art. 18 ust. 8 (podstawa za niepełny miesiąc) (ustawa o systemie ubezpieczeń społecznych); PLAN-KSIEGOWOSC-JDG §5 K4 (zasada programu).
  - Jak liczy program: Podstawa proporcjonalna do dni nie jest liczona: zamiast zgadywania jest brak.
- **RP-VAT-LIM-01** (pewność średnia): Potwierdzić limit 240 000 zł na 2026 i 2027 r. oraz proporcję limitu dla firmy zakładanej w trakcie roku (art. 113 ust. 9).
  - Reguła: Limit zwolnienia podmiotowego z VAT: 240 000 zł sprzedaży w roku.
  - Podstawa: art. 113 ust. 1 (ustawa o podatku od towarów i usług).
- **RP-KPIR-BRAK-01** (pewność niska): Broszura JPK_PKPIR nie opisuje braku danych kontrahenta. Czy „BRAK” jest akceptowany?
  - Reguła: Nazwa i adres kontrahenta są w JPK_PKPIR obowiązkowe; bez danych program wpisuje „BRAK” jak w JPK_V7M.
  - Podstawa: JPK_PKPIR(3) (broszura informacyjna MF).
- **RP-SPIS-01** (pewność średnia): Przy starcie w trakcie roku spis z dnia startu trafia do PKPIRSpis, nie do P_1. Czy tak?
  - Reguła: JPK_PKPIR: P_1 to spis z 31 grudnia poprzedniego roku albo z 1 stycznia, P_2 spis z 31 grudnia (tylko w pliku za cały rok), pozostałe spisy z okresu w PKPIRSpis; P_3 to wydatki plus P_1 minus P_2, P_4 przychód minus P_3; zaliczki miesięczne spisu nie biorą.
  - Podstawa: JPK_PKPIR(3), objaśnienia do KPiR (broszura informacyjna MF).
- **RP-NRS-01** (pewność niska): Kiedy dla JDG płacącej tylko za siebie DRA jest obowiązkowa? Potwierdzić na zus.pl.
  - Reguła: Rachunek składkowy ZUS (NRS) jest indywidualny z PUE ZUS; klient wpisuje go sam, program sprawdza tylko sumę kontrolną.
  - Podstawa: art. 47a (ustawa o systemie ubezpieczeń społecznych).
- **RP-TERM-04** (pewność niska): Potwierdzić termin i zakres rocznego rozliczenia zdrowotnej dla każdej formy.
  - Reguła: Roczne rozliczenie składki zdrowotnej do 20 maja (do potwierdzenia).
  - Podstawa: art. 81 ust. 2ze (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków publicznych).

## Dla prawnika (3)

- **RP-D8-01** (pewność średnia): Gdzie przebiega granica między informacją o wyniku obliczeń a czynnością doradztwa podatkowego (art. 2 ustawy o doradztwie podatkowym) dla programu bez doradcy?
  - Reguła: Teksty modułu nie doradzają: nie zalecają, nie porównują form opodatkowania i nie mówią „zapłać”; podają, ile wychodzi z danych klienta i jaki jest termin z przepisów.
  - Podstawa: art. 2 i art. 3 (ustawa o doradztwie podatkowym); PLAN-KSIEGOWOSC-JDG D8 (zasada programu).
- **RP-ZDR-REFORMA-01** (pewność niska): Sprawdzić w styczniu 2027, czy weszła zmiana zasad składki zdrowotnej.
  - Reguła: Reforma składki zdrowotnej z 2025 r. nie weszła (weto); projekt UD428 nieuchwalony; do zmiany ustawy obowiązują zasady z art. 79-81.
  - Podstawa: art. 79-81 (ustawa o świadczeniach opieki zdrowotnej finansowanych ze środków publicznych).
- **RP-KSIEGI-01** (pewność wysoka): Wskazać przepis ustawy (PIT i ustawa o ryczałcie), który nakłada obowiązek prowadzenia ewidencji w programie i przesyłania JPK_PD, z datami dla obu grup.
  - Reguła: Od 1.01.2026 podatnicy składający JPK_V7M, a od 1.01.2027 pozostali podatnicy PIT prowadzą KPiR i ewidencję przychodów przy użyciu programu, według wzoru KPiR 2026 (numer KSeF, identyfikator kontrahenta).
  - Podstawa: Dz.U. 2025 poz. 1299 (rozporządzenie MF w sprawie prowadzenia podatkowej księgi przychodów i rozchodów); elektroniczna dokumentacja księgowa od 2026 r. (komunikat KAS).
