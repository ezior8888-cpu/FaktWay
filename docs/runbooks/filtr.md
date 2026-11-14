# Żelazny filtr: gdy coś zablokuje

> Plan: `docs/koordynacja/PLAN-ZELAZNY-FILTR.md` (B6). Dane filtra: `filtr/`
> (`README.md` w skrócie). Etykiety zgody nadaje tylko Bartosz.

## Gdzie filtr łapie i co dalej

| Gdzie | Co widać | Co zrobić |
|---|---|---|
| hook Claude po edycji | `[FILTR] … jest poza mapą ryzyka` (kod 2) | dopisać plik do obszaru w `filtr/mapa-ryzyka.json`; sprawdzić `pnpm filtr:mapa <plik>` |
| hook Claude przed poleceniem | `[FILTR] Polecenie zablokowane (…)` | nie omijać; etykiety i ustawienia GitHuba robi Bartosz |
| pre-push | `pre-push: żelazny filtr…` albo `testy żelaznego filtra … czerwone` | poprawić i wypchnąć ponownie; `pnpm filtr:lokalnie` pokazuje to samo |
| „Filtr: straż” w PR | lista wymogów: plik, co zrobić, kto daje wyjątek | uzupełnić kartę, mapę albo testy; o etykietę poprosić Bartosza po ostatnim pushu |
| test `tests/filtr/mapa.test.ts` | plik z sygnałem poza mapą albo martwy wzorzec | dopisać plik do mapy; martwy wzorzec poprawić albo usunąć |

Lokalnie przed PR:

```bash
pnpm filtr:lokalnie
```

```bash
node scripts/filtr/straz.mjs --pr 488 --tylko-raport
```

## Wyjątki

Wyjątek zwalnia tylko z wymogu straży (karta, test przy kodzie R1, komentarz
`filtr-wyjatek`), nigdy z czerwonego testu prawnego. Wymaga etykiety
`zgoda:wyjatek-filtra` i powodu w karcie (pole „Wyjątki od filtra”). Rejestr
wyjątków: `docs/filtr/WYJATKI.md` (od pierwszego wyjątku): data, PR, reguła,
powód, kto, do kiedy.

## Awaria filtra (pilna poprawka produkcji)

1. Czerwony wymóg straży: `zgoda:wyjatek-filtra` z powodem w karcie.
2. Czerwony test filtra, a poprawka dotyczy czego innego: najpierw osobny PR
   poprawiający test albo filtr (`zgoda:zmiana-filtra`), potem poprawka.
3. Ostateczność: Bartosz zdejmuje „Filtr: straż” z wymaganych kontroli
   (Settings, Rules, Rulesets), scala, przywraca kontrolę tego samego dnia
   i wpisuje wyjątek.
4. W ciągu 24 godzin sesja uruchamia pełny filtr na `main`
   (`pnpm filtr:testy`, `pnpm filtr:mapa --skan`) i zapisuje wynik w dzienniku
   planu.
5. Każda awaria filtra to znalezisko z przyczyną i testem filtra.

## Alarmy FILTR-RT

Strażnicy w działającej aplikacji (F13, plan B4.10, `lib/bezpieczniki/`)
sprawdzają kwoty i terminy tuż przed pokazaniem, zatwierdzeniem
i przypomnieniem, plik JPK_V7M przed pobraniem i wysyłką, a pliki JPK_EWP
i JPK_PKPIR przed pobraniem, a plik FA(3) przed wysyłką do KSeF (na razie
tylko alarm, niżej). W module księgowości blokują od razu (D-F7): pozycja, która nie przejdzie kontroli,
staje się brakiem z komunikatem „Tej kwoty nie pokazujemy, bo kontrola
spójności wykryła błąd po naszej stronie. Zgłosiliśmy go.”, plik nie wychodzi
(niżej), a operator dostaje alarm. Strażnik niczego nie zapisuje w bazie: po
naprawie pozycja wraca sama przy następnym odczycie, a plik powstaje przy
następnym pobraniu albo wysyłce.

### „Ten miesiąc” (`lib/bezpieczniki/ten-miesiac.ts`)

Sprawdza wynik `czytajTenMiesiac` po bramce D7, więc strona „Ten miesiąc”,
zatwierdzenie, push o wyliczeniu (`ksiegowosc-miesiac`), przypomnienie
o terminie (`ksiegowosc-terminy`) i „Odłóż na podatek” dostają już
sprawdzone pozycje.

| Kod | Co znaczy | Co widzi klient |
|---|---|---|
| `FILTR-RT-TM-01` | kwota pozycji nie jest całkowitą liczbą groszy od zera w górę (ułamek grosza, kwota ujemna, poza zakresem liczb całkowitych) | komunikat zamiast kwoty, termin zostaje |
| `FILTR-RT-TM-02` | ryczałt, zaliczka PIT albo VAT z groszami, a te kwoty są w pełnych złotych (art. 63 § 1 Ordynacji podatkowej); składek ZUS i zdrowotnej, liczonych w groszach, to nie dotyczy | komunikat zamiast kwoty, termin zostaje |
| `FILTR-RT-TM-03` | kwota pozycji (przy składkach społecznych także część bez FP) różni się od wyniku silnika albo wynik nie ma jej źródła | komunikat zamiast kwoty, termin zostaje |
| `FILTR-RT-TM-04` | termin w sobotę, niedzielę, dzień ustawowo wolny albo nie jest datą (także przy pozycji bez kwoty) | komunikat i bez terminu |

Zatrzymanej pozycji nie da się zatwierdzić, push o wyliczeniu i „Odłóż na
podatek” jej nie liczą, a przypomnienie o terminie bierze kwotę ostatniej
zatwierdzonej wersji z bazy albo wychodzi bez kwoty.

### Przypomnienia o terminach (`lib/bezpieczniki/przypomnienia.ts`)

Sprawdza przypomnienie w `cron.ksiegowosc-terminy` tuż przed mailem, pushem
i wpisem w dzwonku. Pozycje szkicu przeszły już strażnika „Ten miesiąc”, ale
kwota z zatwierdzonej wersji rozliczenia i termin z kalendarza przypomnienia
idą inną drogą. Tag `straznik` to `przypomnienia`, `rodzaj` to rodzaj
rozliczenia (przy terminie `termin`), a `miesiac` to okres rozliczenia.

| Kod | Co znaczy | Co widzi klient |
|---|---|---|
| `FILTR-RT-PRZ-01` | kwota pozycji nie jest całkowitą liczbą groszy od zera w górę, albo ryczałt, zaliczka PIT lub VAT ma grosze (art. 63 § 1 Ordynacji podatkowej) | przypomnienie o terminie bez tej kwoty, jak przy braku podpisu księgowej (D7) |
| `FILTR-RT-PRZ-02` | termin przypomnienia nie przypada w dzień roboczy albo nie jest datą | brak przypomnienia; oba etapy (5 dni i 1 dzień przed) mają ten sam termin, więc oba są wstrzymane; „Ten miesiąc” pokazuje termin po swojej kontroli |

Przy PRZ-01 sprawdzić zatwierdzoną wersję rozliczenia firmy za ten miesiąc
(kwota zapisana przy zatwierdzeniu) i silnik, który ją policzył; przy PRZ-02
kalendarz terminów (`lib/ksiegowosc/kalendarz.ts`, RP-TERM-02). Naprawa
według protokołu (`AGENTS.md`). Przy PRZ-02 dotyczy to wszystkich firm
w pilotażu z tym terminem: po naprawie kalendarza codzienny przebieg liczy
etapy od poprawionego terminu, więc przypomnienia wyjdą, jeśli ich dni są
jeszcze przed nami; gdy termin jest bliżej niż 5 dni, Bartosz decyduje, czy
uprzedzić firmy z alarmu (tag `tenantId`) inną drogą.

### JPK_V7M (`lib/bezpieczniki/jpk-v7m.ts`)

Sprawdza gotowy plik JPK_V7M(3) po kontroli XSD, we wspólnym
`plikMiesiaca` (`app/actions/ksiegowosc-vat.ts`), więc i pobranie z ekranu
VAT, i wysyłkę do MF. Wzory są z opisów i komentarzy pól w schemacie MF
(`lib/exports/schemas/jpk-v7m3/schemat.xsd`), cytowane w nagłówku strażnika;
te same listy pól czyta test filtra `tests/filtr/xsd/jpk-v7m.test.ts`. Plik
z alarmem nie trafia ani do klienta, ani do bramki MF: nie ma wiersza
w `jpk_submissions` ani wpisu `jpk_v7m.downloaded` w audycie. Klient widzi
„Plik JPK_V7M wstrzymany: kontrola spójności wykryła błąd po naszej stronie
(kod). Zgłosiliśmy go. Termin złożenia się nie przesuwa, więc w razie
potrzeby złóż plik z księgową.”, z kodem pierwszego alarmu. Tag `straznik`
to `jpk-v7m`, `rodzaj` to `vat`, `miesiac` to okres pliku.

| Kod | Co znaczy |
|---|---|
| `FILTR-RT-JPK-01` | `LiczbaWierszySprzedazy` albo `LiczbaWierszyZakupow` różni się od liczby wierszy albo nie jest liczbą; także plik bez ewidencji albo bez `SprzedazCtrl`, `ZakupCtrl` |
| `FILTR-RT-JPK-02` | `PodatekNalezny` różni się od sumy K_16, K_18, K_20, K_24, K_26, K_28, K_30, K_32, K_33, K_34 minus K_35, K_36, K_360 z wierszy sprzedaży bez faktur FP, albo któraś z tych kwot nie jest kwotą |
| `FILTR-RT-JPK-03` | `PodatekNaliczony` różni się od sumy K_41, K_43, K_44, K_45, K_46, K_47 z wierszy zakupów, albo któraś z tych kwot nie jest kwotą |
| `FILTR-RT-JPK-04` | deklaracja niezgodna ze wzorem z opisu albo komentarza pola: sumy P_37, P_38, P_48, granice P_49 i P_50, wzory P_51, P_53 i P_62; także pole deklaracji, które nie jest kwotą, i plik bez deklaracji |
| `FILTR-RT-JPK-05` | pole deklaracji (P_10 do P_36, P_360, P_40 do P_47) różni się od sumy tego samego pola K_ z wierszy o więcej niż 50 gr, czyli o więcej niż zaokrąglenie do pełnych złotych (NZ-VAT-02) |

Poza tym strażnikiem: P_39 (kwota z poprzedniej deklaracji), P_52 (ulga na
kasy rejestrujące), zwrot P_54 do P_61, kwoty wierszy wobec faktur i kosztów
(pilnuje ich test filtra) i plik z Centrum eksportu (`exports-generate.ts`,
kolejna część F13).

### JPK_EWP i JPK_PKPIR (`lib/bezpieczniki/jpk-ewp.ts`, `jpk-pkpir.ts`)

Sprawdzają gotowy plik JPK_EWP(4) albo JPK_PKPIR(3) po kontroli XSD,
w `pobierzJpkEwpAction` i `pobierzJpkPkpirAction`
(`app/actions/ksiegowosc-ewidencja.ts`), jedynej drodze tych plików do
klienta (pobranie na ekranie ewidencji). Wzory są z opisów pól w schematach
MF (`lib/exports/schemas/jpk-ewp4/schemat.xsd`, `jpk-pkpir3/schemat.xsd`),
cytowane w nagłówkach strażników; wspólny odczyt pliku i sum kontrolnych to
`lib/bezpieczniki/jpk-ctrl.ts`. Plik z alarmem nie trafia do klienta i nie ma
wpisu `jpk_ewp.downloaded` ani `jpk_pkpir.downloaded` w audycie. Klient widzi
„Plik JPK_EWP wstrzymany: kontrola spójności wykryła błąd po naszej stronie
(kod). Zgłosiliśmy go. Jeśli urząd wyznaczył termin, przygotuj plik
z księgową.” (przy KPiR „Plik JPK_PKPIR wstrzymany: …”), z kodem pierwszego
alarmu. Tag `straznik` to `jpk-ewp` albo `jpk-pkpir`, `rodzaj` to
`ewidencja` albo `kpir`, a `miesiac` to miesiąc końca okresu pliku (plik
zawsze zaczyna się 1 stycznia tego roku).

| Kod | Co znaczy |
|---|---|
| `FILTR-RT-EWP-01` | `LiczbaWierszy` w `EWPCtrl` różni się od liczby wierszy `EWPWiersz` albo nie jest liczbą; także plik bez `EWPCtrl` |
| `FILTR-RT-EWP-02` | `SumaPrzychodow` różni się od sumy K_8 z wierszy (korekty in minus ze znakiem), albo któraś z tych kwot nie jest kwotą |
| `FILTR-RT-PKPIR-01` | `LiczbaWierszy` w `PKPIRCtrl` różni się od liczby wierszy `PKPIRWiersz` albo nie jest liczbą; także plik bez `PKPIRCtrl` |
| `FILTR-RT-PKPIR-02` | `SumaPrzychodow` różni się od sumy K_9 z wierszy albo `SumaPrzychodow2` od sumy K_9A (pola nieobowiązkowego nie ma, to 0), albo któraś z tych kwot nie jest kwotą |
| `FILTR-RT-PKPIR-03` | w co najmniej jednym wierszu K_9 różni się od K_7 plus K_8, albo któraś z tych kwot nie jest kwotą |
| `FILTR-RT-PKPIR-04` | w co najmniej jednym wierszu K_14 różni się od K_12 plus K_13, albo któraś z tych kwot nie jest kwotą |

Kolumna „razem” (PKPIR-03, PKPIR-04) daje jeden alarm na plik, nie na
wiersz; który wiersz, pokaże plik odtworzony dla firmy i okresu. Poza tymi
strażnikami: P_3 i P_4 w `PKPIRInfo` (opis pola odsyła do objaśnień do KPiR
i nie podaje wzoru; program liczy je według RP-SPIS-01), wartości spisu
z natury (P_1, P_2, P_5B), kolumny bez wzoru w opisie (K_10, K_11, K_15,
K_16B) i kwoty wierszy wobec faktur, kosztów i wpisów (silniki ewidencji
i KPiR, testy filtra).

### FA(3) przed wysyłką do KSeF (`lib/bezpieczniki/fa3.ts`)

Sprawdza gotowy plik FA(3) po kontroli XSD, w `submitInvoiceFullFlow`
(`lib/ksef/submit-invoice-full.ts`), jedynym miejscu, w którym FaktWay
buduje XML faktury do KSeF (faktura zwykła, korekta, zaliczka, rozliczenie).
Wzory są z opisów pól w schemacie MF (`lib/xml/schemas/fa3/schemat.xsd`)
i z rejestru (`RP-FA-SUMY-01`, `RP-FA-KOR-01`, `RP-FA-ZAL-01`,
`RP-FA-ROZ-01`), cytowane w nagłówku strażnika.

**Na razie tylko alarm (D-F7).** Faktura idzie do KSeF tak jak dotąd, klient
niczego nie widzi. Po dwóch tygodniach bez fałszywych alarmów blokada
(faktura czeka z komunikatem) wymaga zgody Bartosza. Tag `straznik` to
`fa3`, `rodzaj` to `RodzajFaktury` małymi literami (`vat`, `kor`, `zal`,
`roz`), a `miesiac` to miesiąc daty wystawienia (`P_1`).

| Kod | Co znaczy |
|---|---|
| `FILTR-RT-FA3-01` | `P_15` różni się od sumy pól `P_13_x` i `P_14_x` wszystkich stawek (bez `P_14_xW`), albo któreś z tych pól nie jest kwotą; także plik bez węzła `Faktura/Fa` |
| `FILTR-RT-FA3-02` | faktura VAT: `P_13_x` różni się od sumy `P_11` pozycji w tej stawce, albo pole nie jest kwotą |
| `FILTR-RT-FA3-03` | faktura VAT i zaliczkowa: `P_14_x` różni się od `P_13_x` razy stawka o więcej niż zaokrąglenie, czyli (100 + stawka) / 2 setnych grosza na pozycję w tej stawce (pokrywa podatek od netto i od brutto, np. fakturę za abonament i wzór zaliczki z art. 106f ust. 1 pkt 3), albo pozycje jednej grupy mają różne stawki |
| `FILTR-RT-FA3-04` | pozycja „zw” bez `P_19 = 1` i podstawy zwolnienia (`P_19A`, `P_19B` albo `P_19C`); w fakturze VAT `P_19 = 1` bez pozycji „zw”; pozycja „oo” albo „np II” bez `P_18 = 1` |

Faktura z alarmem jest już w KSeF (albo za chwilę będzie). Kolejność:
znaleźć plik po identyfikatorze faktury z pola `extra.dokumentId` zgłoszenia
(archiwum XML w R2, ścieżka w `xml_documents`), porównać z danymi faktury,
a przy prawdziwym błędzie
generatora naprawić go według protokołu (`AGENTS.md`). Czy firmy dostają
fakturę korygującą, decyduje Bartosz z księgową. Poza tym strażnikiem:
kontrola 02 dla korekt, zaliczek i rozliczeń oraz 03 dla korekt i rozliczeń
(ich sumy sprawdzają testy filtra `tests/filtr/xsd/fa3-*.test.ts`), faktura
z pozycją w stawce spoza
listy albo bez `P_11` (wzoru nie da się sprawdzić z pliku), stawka
z podatkiem u firmy zwolnionej z art. 113 (zatrzymuje ją kolejka wysyłki,
F12-G6b) i daty (NZ-FA-07).

**Przejście na blokadę (D-F7, decyzja Bartosza).** Warunki, wszystkie naraz:
1. dwa tygodnie liczone od wdrożenia workera z tym strażnikiem (wysyłka do
   KSeF działa w workerze), bez fałszywego alarmu `straznik:fa3` w Sentry;
   każdy alarm z tego okresu rozpatrzony: błąd generatora naprawiony według
   protokołu albo strażnik poprawiony;
2. tekst dla klienta w miejscu, w którym faktura czeka (nazwa faktury, kod
   pierwszego alarmu, że błąd jest po naszej stronie i co dalej), w tym samym
   duchu co odmowa pliku JPK_V7M;
3. ścieżka operatora: ponowienie wysyłki po naprawie generatora albo
   strażnika, bez ręcznej zmiany pliku;
4. wyłącznik: możliwość powrotu do trybu „tylko alarm” bez wdrożenia.
Do tego czasu ogólne zdania tej sekcji o blokadzie („zła kwota do klienta nie
doszła”, „plik nie wychodzi”) faktur FA(3) nie dotyczą.

### Co zrobić

1. **Sentry.** Zgłoszenie ma poziom `error`, tag `area:filtr.bezpieczniki`
   i odcisk (kod, rodzaj, miesiąc): ten sam błąd wszystkich firm i wszystkich
   odczytów to jedno zgłoszenie. Tagi: `kod`, `straznik`, `rodzaj`, `miesiac`,
   `tenantId` (lista firm to wartości tego tagu), w cronach także
   `runtime:pgboss-worker`. Kwot ani danych osobowych w alarmie nie ma
   z założenia; przypadek odtwarza się z firmy, miesiąca i rodzaju.
2. **`/admin/centrum` bez zmian.** Alarmy FILTR-RT jeszcze się tam nie
   pokazują (tak samo `critical-alerts-monitor`); to kolejna część F13.
   Panel nie ma też akcji dla tych alarmów: klient nie musi nic robić, bo zła
   kwota do niego nie doszła. Wyjątki: pliki JPK (punkt 4) i faktury FA(3)
   w trybie „tylko alarm”, które idą do KSeF mimo alarmu (sekcja FA(3) wyżej).
3. **Zakres.** Jedna firma czy wiele, jeden miesiąc czy kilka. Gdy błąd może
   dotyczyć liczb, których strażnik nie sprawdza (odliczenia w opisie pod
   kaflami, nadwyżka VAT na następny miesiąc), Bartosz decyduje
   o wyłączeniu: firma w `/admin/flags` (kolumna „Księgowość (pilotaż)”),
   cały moduł flagą `killKsiegowosc` w `global_feature_flags` (UPDATE jak
   `killFloAgent` w `flo-incident.md`).
4. **Termin przy plikach JPK.** Przy JPK_V7M odmowa pliku nie przesuwa terminu złożenia
   (25. dzień miesiąca po okresie, przesunięty na dzień roboczy). Klient wie
   z komunikatu, że może złożyć plik z księgową. Gdy naprawa nie zdąży przed
   terminem, Bartosz decyduje, czy uprzedzić firmy z tagu `tenantId`. Obejścia
   strażnika w aplikacji nie ma (pliku z alarmem nie da się pobrać ani
   wysłać), więc do naprawy wyjściem dla klienta jest plik od księgowej.
   **Przy JPK_EWP i JPK_PKPIR** odmowa też nie przesuwa terminu: przy pliku
   za rok to termin zeznania rocznego (RP-JPK-PIT-01), przy pliku na żądanie
   (za część roku, RP-JPK-CEL-01) termin z żądania urzędu. Stąd w komunikacie
   „Jeśli urząd wyznaczył termin, przygotuj plik z księgową”; reszta jak przy
   JPK_V7M.
5. **Naprawa według protokołu z `AGENTS.md`:** najpierw czerwony test z tym
   samym przypadkiem (dane firmy tylko do odczytu, w teście fikcyjny NIP
   `1234567890`), potem naprawa silnika albo generatora pliku (przy JPK_V7M
   `lib/exports/jpk-v7m-generator.ts`, przy JPK_EWP i JPK_PKPIR
   `lib/ksiegowosc/jpk-ewp.ts`, `jpk-pkpir.ts` i silniki `ewidencja.ts`,
   `kpir.ts`) we wszystkich miejscach, osobny PR.
6. **Fałszywy alarm** (wynik był dobry, myli się strażnik): poprawka
   strażnika osobnym PR z testem i wzorcem z `docs/koordynacja/ZRODLA-PRAWDY.md`,
   za zgodą Bartosza. Do tego czasu klient widzi brak zamiast dobrej kwoty
   albo odmowę zamiast dobrego pliku: błąd bezpieczny, ale błąd.
