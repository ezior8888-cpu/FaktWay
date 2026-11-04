# Import historii KSeF: stawki VAT, data sprzedaży, adnotacje i kwoty pozycji (W9, C5a, C5b, C5c)

Plan „zero zgubionych faktur”, sesje C5a (stawki) i C5b (data sprzedaży,
adnotacje, oznaczenia). Kod: `lib/xml/fa3-p12.ts` (stawki),
`lib/xml/fa3-annotations.ts` (odczyt adnotacji, dat i oznaczeń),
`lib/import/fa3-parser.ts` (import), `lib/import/fa3-content.ts` (co trafia
na wiersz), `lib/import/fa3-line-amounts.ts` (kwoty pozycji, C5c), `lib/exports/jpk-fa-generator.ts` (`JpkDocumentNotSupportedError`),
`lib/exports/jpk-fa-readiness.ts` (paczka Co-Pilot).

## Co import zapisuje jako stawkę pozycji

| P_12 w pliku FA(3) | `invoice_line_items.vat_rate` | JPK |
|---|---|---|
| `23`, `8`, `5`, `zw`, `oo` | to samo | wykazuje |
| `0 KR` | `0` | wykazuje (P_13_6 / K_13) |
| `np I` | `np` | wykazuje (P_13_5 / K_11) |
| `np II` | `np_ii` | wykazuje (P_13_5 + P_18 / K_11 + K_12) |
| `0 WDT`, `0 EX`, `22`, `7`, `4`, `3` | **ten sam kod, dosłownie** | **odmawia** z numerem faktury |
| brak P_12 | stawka z nagłówka, gdy jednoznaczna (jedna niezerowa suma; 23/22 i 8/7 z proporcji podatku; bez sum przy `P_19 = 1` — `zw`; zwolnienie obok innej sumy — `nieznana`) | jak wyżej |
| brak P_12 bez jednoznacznej sumy, kod spoza FA(3) | `nieznana` | **odmawia** z numerem faktury |
| gołe `0` / `np` (pliki FA(2)) | wariant z jedynej niezerowej sumy rodziny (P_13_6_1/2/3, P_13_8/9), inaczej `nieznana` | jak wyżej |

Dlaczego dosłownie, a nie „0” albo „23”: WDT i eksport mają w JPK_V7M własne
pola (K_21, K_22), a „22” → „23” zmieniłoby wyliczony podatek. Lepiej, żeby
plik nie powstał, niż żeby sprzedaż trafiła do złego pola albo wypadła.

Faktura z importu, której pozycje **nie sumują się do netto albo VAT
faktury**, jest odmawiana z numerem — inaczej sprzedaż po cichu wypadłaby
z pól stawek albo JPK różniłby się od KSeF o grosze. Kwoty pozycji (także
ceny brutto) — sekcja „Kwoty pozycji i ceny brutto (C5c)”.

Zaimportowane **korekty, zaliczki i ROZ** import zapisuje jako zwykłe
(`invoice_kind = regular`, rodzaj z pliku w `invoice_type`), bo nie zna ich
powiązań. JPK też ich odmawia z numerem dokumentu.

## Data sprzedaży (C5b)

| Plik | `invoices.sale_date` | `fa3_data.saleDates` | JPK |
|---|---|---|---|
| `P_6` (bez `P_6A` albo wszystkie `P_6A` równe `P_6`) | `P_6` — także gdy równa dacie wystawienia (wiersz wierny plikowi) | — | JPK_FA `P_6` / V7M `DataSprzedazy`, gdy różna od daty wystawienia |
| `OkresFa` (`P_6_Od`, `P_6_Do`) | `P_6_Do` (data zakończenia) | `period` | jak wyżej |
| bez `P_6`, ta sama `P_6A` na każdej pozycji | ta data | `lines` | jak wyżej |
| bez daty sprzedaży | NULL (sprzedaż = data wystawienia) | — | bez `P_6` |
| kilka dat: `P_6`/`P_6_Do` i `P_6A` różne, `P_6A` poza `OkresFa`, część pozycji bez `P_6A` | `P_6` / `P_6_Do` albo NULL | `lines`, `unclear` | **odmawia** z numerem (JPK ma jedną datę sprzedaży dokumentu) |
| data nieczytelna (np. `2026-02-30`) | NULL | `unclear` | **odmawia** z numerem |
| zaliczka, korekta | NULL zawsze (P_6 to tam data zaliczki / stan po korekcie) | jak wyżej | odmawia — rodzaj (C5a) |

## Adnotacje i oznaczenia (C5b)

Import zapisuje je w `fa3_data.annotations` w kluczach FaktFlow, liczbami
1|2 (jak faktury z aplikacji), a nieczytelne w `fa3_data.annotationProblems`
— **nigdy domyślne „nie”**.

| Plik | Klucz | JPK_FA | JPK_V7M | Uwaga |
|---|---|---|---|---|
| `P_16` | `cashMethod` | `P_16` | — (okres wg daty wystawienia — ustalenie C5b-f) | korekta dziedziczy |
| `P_17` | `selfInvoicing` | `P_17` z pliku | — | decyzja Bartosza 06.10 |
| `P_18` | `reverseCharge` | `P_18` z pliku (bez klucza — z pozycji `oo` / `np_ii`) | — | decyzja Bartosza 06.10 |
| `P_18A` | `splitPayment` | `P_18A` | — | korekta dziedziczy |
| `P_19` + `P_19A` / `P_19B` / `P_19C` | `vatExemptionBasis` + `vatExemptionBasisKind` | `P_19A` / `P_19B` / `P_19C` z pliku | — | zwolnienie niezgodne ze stawkami pozycji → **odmowa** |
| `P_23 = 1` | `simplifiedProcedure` | **odmowa** | **odmowa** (bez TT_D) | |
| `P_22 = 1` | `newMeansOfTransport` | **odmowa** | **odmowa** | szczegóły w archiwum XML |
| `PMarzy` (`P_PMarzy_*`) | `marginScheme` | **odmowa** | **odmowa** (bez MR_T / MR_UZ) | |
| `FP`, `TP`, podmiot upoważniony (`RolaPU`), `GTU`, `Procedura` | `fa3_data.ksefMarkers` | **odmowa** | **odmowa** | decyzja Bartosza 06.10: wykrywać i zatrzymywać |
| adnotacja nieczytelna | `annotationProblems` | **odmowa** | **odmowa** | |

JPK_FA(4) umiałby wpisać `P_23` i `P_106E_*`, ale JPK_V7M (to samo
`amountsOf`) nie ma tych oznaczeń ani kwot marży — odmowa obu plików jest
celowa, nie „do poprawienia tylko w JPK_FA”.

## Kwoty pozycji i ceny brutto (C5c)

Podstawa: art. 106e ust. 7–11 ustawy o VAT. Prawdą są **sumy stawek
z nagłówka** (`P_13_x` netto, `P_14_x` VAT): przy cenach brutto podatek liczy
się od sumy brutto stawki (`KP = WB × SP / (100 + SP)`, ust. 7), netto stawki to
`WB − KP` (ust. 9); przy cenach netto też od sumy (ust. 1 pkt 14), chyba że
faktura podaje VAT przy pozycji (`P_11Vat`, ust. 10). Import dzieli VAT
nagłówka na pozycje metodą największej reszty (każda pozycja dostaje swój
udział w dół albo w górę) — dla faktur brutto **i netto** (decyzja Bartosza
06.10.2026), więc JPK_FA i V7M mają co do grosza sumy z KSeF.

| Plik | Pozycja w bazie | JPK_FA(4) `FakturaWiersz` |
|---|---|---|
| ceny netto (`P_9A`, `P_11`) | netto z pliku, VAT z podziału nagłówka | pola z pliku (`P_9A`, `P_11`) |
| ceny brutto (`P_9B`, `P_11A`) | brutto z pliku, VAT z podziału, netto = brutto − VAT (**podział FaktFlow, nie dana z faktury**); cena netto pusta | `P_9B`, `P_11A` z pliku, bez wyliczonego netto; suma kontrolna tylko z `P_11` |
| `P_11Vat` przy każdej pozycji, suma = `P_14_x` | VAT z pliku | jak wyżej (JPK_FA nie ma `P_11Vat`) |
| `P_11` i `P_11A` przy pozycji | VAT = `P_11A − P_11` | oba pola |
| `P_10` (rabat) | bez wpływu na kwoty (`P_11`/`P_11A` są po rabacie) | `P_10` z pliku |
| faktura bez sum stawek (uproszczona), ceny netto albo brutto | VAT od sumy wartości każdej stawki (ust. 7 / ust. 1 pkt 14), zaokrąglony do grosza (ust. 11), podzielony; całość = `P_15`. Jedna stawka netto bez VAT pozycji, gdy suma ≠ `P_15` (wystawca zsumował VAT pozycji): VAT stawki z `P_15`, jeśli mieści się w podziale | pola z pliku |

**Faktura bez sum stawek** (żadnego `P_13_x` / `P_14_x`): netto i VAT
faktury (`invoices.net_total` / `vat_total`) import liczy z pozycji — parser nie
ma ich skąd wziąć (przy cenach brutto dałby netto 0, przy zw „KPiR i CSV
działają” byłoby nieprawdą). Gdy plik ma sumy innych stawek, brak sumy stawki
liczy się jako 0: pozycje tej stawki sumujące się do 0 przechodzą, inne są
zatrzymane.

**Zatrzymane z numerem** (pozycje tej stawki zostają jak dotąd, nic nie
zgadujemy; JPK_FA i V7M odmawiają, raport importu ostrzega): pozycje netto
i brutto w jednej stawce; `P_11Vat` tylko przy części pozycji albo jego suma
≠ VAT nagłówka (decyzja Bartosza 06.10: zatrzymać); VAT nagłówka poza
możliwym zakresem podziału; brutto pozycji ≠ netto + VAT nagłówka; netto
pozycji ≠ netto nagłówka (dokładnie, bez tolerancji); suma stawki bez pozycji;
kwota nieczytelna; pozycja bez wartości; powtórzone `NrWierszaFa` przy cenach
brutto; ceny brutto przy taksówkach (4%/3%). **Kwoty faktury nieznane**
(`fa3_data.lineAmountTotalsUnknown`): pozycje stawki bez jej sum w nagłówku,
a przy fakturze bez sum stawek — pozycje ≠ `P_15`, brak `P_15` albo pozycja
nieczytelna. Komunikat mówi wtedy wprost, że **KPiR i CSV też ich nie
pokażą** i fakturę trzeba wprowadzić z księgową.

**Faktura z importu sprzed C5c** (bez `fa3_data.ksefLineFields`): JPK liczy
ją jak dotąd z pozycji w bazie (kontrola VAT pozycji = VAT faktury co do
grosza). Ponowny import tej samej faktury trafia w gałąź duplikatu i **nie
przepisuje pozycji** — w odróżnieniu od dat i adnotacji C5b. Gdy taka faktura
jest zatrzymana różnicą VAT, wyjście to JPK z księgową (KPiR i CSV działają);
przepisanie pozycji starych importów to osobna decyzja.

## Co widzi klient

- **Import:** pierwsze ostrzeżenie w raporcie — numer faktury, numer KSeF,
  wszystkie powody (stawka, rodzaj, adnotacja, oznaczenie, daty pozycji)
  i miesiąc, za który JPK nie powstanie w FaktFlow. Faktura jest zapisana
  i liczy się do KPiR i CSV.
- **Faktura z importu sprzed C5b** (bez adnotacji): JPK odmawia z podpowiedzią
  „ponów import historii z KSeF za ten okres”. Ponowny import tej samej
  faktury dopisuje datę sprzedaży i adnotacje z oryginału (raport: „uzupełniono
  datę sprzedaży i adnotacje”) — decyzja Bartosza 06.10.2026.
- **Eksport JPK_FA / JPK_V7M:** zadanie kończy się od razu (bez ponowień)
  powodem „JPK wstrzymany: faktura … ma stawkę VAT „0 WDT” (…) … JPK za ten
  okres trzeba przygotować poza FaktFlow (KPiR i CSV z FaktFlow działają)”,
  widocznym w Centrum eksportu pod pozycją eksportu. Portal księgowej: 422
  z tym samym tekstem.
- **Ponowny import** faktury wystawionej w FaktFlow (np. własnej korekty)
  nie daje ostrzeżenia — w bazie ma właściwy rodzaj i stawki.
- **Paczka Co-Pilot:** zamiast JPK_FA dostaje CSV (jak przy korekcie w okresie).
- **Karta faktury:** stawka z opisem, np. „0 WDT (wewnątrzwspólnotowa dostawa
  towarów, 0%)”.

## Co robi operator

1. Lista dokumentów: `./scripts/ops/kontrola-faktur-ksef.sh`, sekcja 8 (od C5b
   także „sprzedaż z importu, której JPK nie wykaże przez treść z pliku”,
   z powodem).
2. **Nie przepisujesz stawek faktur przyjętych w KSeF** — to treść
   wystawionego dokumentu (00119/00132), a stawka FaktFlow nie wyraża WDT ani
   eksportu.
3. Klientowi: JPK za ten okres przygotowuje księgowa (z KPiR/CSV FaktFlow i
   faktur w KSeF). Wiersze ze **starym surowym kodem** (`0 KR`, `np I`,
   `np II` — import sprzed W9) to co innego: da się je znormalizować migracją
   z licznikiem, **za zgodą Bartosza** (na produkcji 05.10.2026: 0 takich
   wierszy, 0 faktur z importu).
4. Rozszerzenie stawek FaktFlow o WDT / eksport (z polami K_21 / K_22) zwolni
   te dokumenty — osobna sesja (ustalenie W9-g w dzienniku planu).
5. Faktury z importu sprzed C5b: klient ponawia import historii (uzupełnienie
   jest warunkowe i idempotentne). **Nie** dopisujesz adnotacji ręcznie
   UPDATE-em — to treść z oryginału, którą czyta import.

## Czego te sesje nie zmieniają (dalej otwarte)

- **C5c-b** — import pliku JPK_FA (`jpk-fa-parser.ts`) czyta tylko `P_9A`/`P_11`
  (szkice z netto 0 przy cenach brutto). **C5c-c** — własne faktury FaktFlow
  mają `P_14_x` = suma VAT pozycji bez `P_11Vat` (art. 106e ust. 10 vs ust. 1
  pkt 14) — pytanie do doradcy podatkowego. **C5c-e** — brak `P_8B` zapisuje
  ilość 0. **PR C** — oryginał w cenach brutto nie da się dziś wyrazić treścią
  FaktFlow (generatory piszą tylko `P_9A`/`P_11`, korekta odmawia bez ceny
  netto): przed PR C zatrzymać albo ustalić regułę.
- **C5b-d** (rozszerzone o C5c): cena brutto (`P_9B`) na PDF i karcie
  faktury; dziś PDF drukuje cenę netto 0 dla pozycji z cenami brutto.
- **C5b-b** — nabywca z `NrID` (zagraniczny bez VAT-UE) i `JST`/`GV` z pliku
  (dziś stałe 2). **C5b-c** — `ksef_accepted_at` = chwila importu, `notes`
  „[import]…” drukowane na PDF, Stopka z pliku pomijana. **C5b-d** — PDF bez
  wzmianki o `P_17`, jawnym `P_18`, `P_23`, marży i `OkresFa`; karta faktury
  bez adnotacji. Wszystkie przed D-A4-1b-3 PR C.
- **C5b-e** — korekta faktury z importu z `P_17`/`P_22`/`P_23`/marżą/`P_19B-C`
  wpisuje 2/N (`fa3-correction-generator.ts`) — warunek C4 (zdjęcie KOR_HOLD).
- **C5b-f** — JPK_V7M liczy okres po dacie wystawienia, nie po momencie
  powstania obowiązku (metoda kasowa, `P_6` w innym miesiącu, `OkresFa`);
  dotyczy też faktur FaktFlow.
