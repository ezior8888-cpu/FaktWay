# Złote przypadki G1-G14: arkusz do policzenia

Krok K0 planu `docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md` (sekcja 7), stan
4.11.2026. Wszystkie tabele „Wynik” są puste: kwoty liczy księgowa,
niezależnie od programu. Szablon pliku z wynikami dla testów:
`tests/fixtures/ksiegowosc/zlote/szablon.json` (część 7).

## 1. Po co to jest

FaktWay będzie liczyć jednoosobowym działalnościom ryczałt, zaliczki na PIT,
składki ZUS, składkę zdrowotną, VAT i terminy. Zanim pokażemy to klientom,
prosimy o niezależne policzenie 14 przykładów. Program musi dać te same kwoty
co do grosza w każdym miesiącu. Podpisane przykłady stają się testami: zmiana
w programie, która zmieni choćby jeden wynik, nie przejdzie do wydania.

## 2. Jak liczyć i gdzie wpisać wynik

1. **Rok 2027.** Część parametrów będzie znana dopiero w styczniu 2027 r.
   (m.in. komunikat GUS o przeciętnym wynagrodzeniu w IV kwartale 2026 r.),
   więc przypadki liczy się po ich ogłoszeniu.
2. **Parametry** użyte do obliczeń wpisuje się raz, w tabeli w części 4,
   z wartością i źródłem. Przy rozbieżności z programem od razu widać, czy
   różnica wynika z parametru, czy z obliczenia.
3. **Dane wejściowe** są przy każdym przypadku: założenia i tabela „Dane”,
   miesiąc po miesiącu. Danych nie zmieniamy. Gdy coś jest niejasne albo
   w praktyce niemożliwe, prosimy wpisać przyjęte założenie w polu `uwagi`
   i liczyć dalej.
4. **Co policzyć:** tabele „Wynik” pod przypadkiem. Część 5 opisuje każdą
   kolumnę.
5. **Wynik** wpisuje się w puste tabele „Wynik”, jeden wiersz na miesiąc.
   Można liczyć w arkuszu kalkulacyjnym, byle wynik wrócił w tym samym
   układzie: te same tabele, kolumny i wiersze.
6. **Kwoty** w złotych z groszami, z przecinkiem: `1 234,56`. Kwotę
   zaokrągloną do pełnych złotych wpisuje się z `,00`, a brak kwoty jako
   `0,00`. Puste pole znaczy „nie policzono”. Zaokrąglenia jak w deklaracji
   i przelewie; jeśli coś zaokrągla się nietypowo, prosimy o słowo w uwagach.
7. **Daty** w formacie `DD.MM.RRRR`.
8. **Podpis:** pod każdym przypadkiem są pola `policzyla` (imię i nazwisko
   osoby, która policzyła), `data` (dzień zakończenia obliczeń)
   i `uwagi`. Przypadek bez podpisu nie trafia do testów jako złoty.

## 3. Wspólne założenia (jeśli przypadek nie mówi inaczej)

1. Jednoosobowa działalność bez pracowników, rozliczenie miesięczne, sprzedaż
   w kraju w złotych, wszystkie faktury przyjęte w KSeF.
2. Firma działa od lat; w 2026 r. tak, jak podaje przypadek.
3. Przychód: kwoty z tabeli „Dane”, data sprzedaży i wystawienia faktury:
   ostatni dzień miesiąca. Przy czynnym VAT kwoty są netto, a VAT liczy tylko
   G12.
4. Składki ZUS za miesiąc klient płaci w następnym miesiącu, przed terminem,
   w kwocie z obliczeń. Kolumna „Zapłacone składki za” podaje, za który miesiąc
   zapłacono składki w danym miesiącu.
5. Odliczenia składek: w miesiącu zapłaty, w całości, na ile pozwala przychód
   (ryczałt) albo dochód (skala, liniowy). Ryczałt: czego nie da się odliczyć,
   przechodzi na kolejne miesiące roku. Skala i liniowy: składki społeczne
   odliczane od dochodu, nie w kosztach. Liniowy: składka zdrowotna też
   odliczana od dochodu, nie w kosztach. Jeśli przepisy każą inaczej, prosimy
   o uwagę.
6. Etap ZUS i chorobowe podaje przypadek. Składka wypadkowa jak dla płatnika
   zgłaszającego do 9 osób.
7. Bez innych odliczeń i ulg (IP Box, B+R, internet, dzieci, darowizny), bez
   wspólnego rozliczenia, bez zaległości i nadpłat.
8. Rozliczenia roczne (PIT-28, PIT-36, PIT-36L, roczne rozliczenie składki
   zdrowotnej) nie wchodzą do przypadków.
9. Wiersz „grudzień 2026” jest tam, gdzie firma działała w 2026 r. Liczy się
   go według parametrów 2026, bo od niego zależą odliczenia i składka
   zdrowotna w styczniu 2027 r.

## 4. Parametry użyte do obliczeń

Stopy w procentach z przecinkiem (np. `12,34`), kwoty jak w części 2. Źródło:
akt prawny albo komunikat (np. Dz.U., M.P., komunikat GUS lub ZUS) i adres.

| Parametr | Okres | Wartość | Źródło |
|---|---|---|---|
| Minimalne wynagrodzenie | 2026 |  |  |
| Minimalne wynagrodzenie | 2027 |  |  |
| Prognozowane przeciętne wynagrodzenie (podstawa pełnych składek) | 2026 |  |  |
| Prognozowane przeciętne wynagrodzenie (podstawa pełnych składek) | 2027 |  |  |
| Przeciętne wynagrodzenie w sektorze przedsiębiorstw w IV kwartale, z wypłatami z zysku | IV kwartał 2025 |  |  |
| Przeciętne wynagrodzenie w sektorze przedsiębiorstw w IV kwartale, z wypłatami z zysku | IV kwartał 2026 |  |  |
| Składka emerytalna, stopa (%) | 2026 i 2027 |  |  |
| Składki rentowe, stopa (%) | 2026 i 2027 |  |  |
| Składka chorobowa, stopa (%) | 2026 i 2027 |  |  |
| Składka wypadkowa, płatnik do 9 osób, stopa (%) | od 1.04.2026 do 31.03.2027 |  |  |
| Składka wypadkowa, płatnik do 9 osób, stopa (%) | od 1.04.2027 |  |  |
| Fundusz Pracy i Fundusz Solidarnościowy, stopa (%) | 2026 i 2027 |  |  |
| Składka zdrowotna na ryczałcie, przychód do 60 000 zł | od lutego 2026 do stycznia 2027 |  |  |
| Składka zdrowotna na ryczałcie, przychód do 300 000 zł | od lutego 2026 do stycznia 2027 |  |  |
| Składka zdrowotna na ryczałcie, przychód ponad 300 000 zł | od lutego 2026 do stycznia 2027 |  |  |
| Składka zdrowotna na ryczałcie, przychód do 60 000 zł | od lutego 2027 do stycznia 2028 |  |  |
| Składka zdrowotna na ryczałcie, przychód do 300 000 zł | od lutego 2027 do stycznia 2028 |  |  |
| Składka zdrowotna na ryczałcie, przychód ponad 300 000 zł | od lutego 2027 do stycznia 2028 |  |  |
| Minimalna składka zdrowotna (skala, liniowy) | od lutego 2026 do stycznia 2027 |  |  |
| Minimalna składka zdrowotna (skala, liniowy) | od lutego 2027 do stycznia 2028 |  |  |
| Roczny limit odliczenia składki zdrowotnej (liniowy) | 2027 |  |  |
| Skala: próg dochodu | 2027 |  |  |
| Skala: stawka do progu (%) | 2027 |  |  |
| Skala: stawka ponad próg (%) | 2027 |  |  |
| Skala: kwota zmniejszająca podatek | 2027 |  |  |
| Podatek liniowy: stawka (%) | 2027 |  |  |
| Ryczałt: próg przychodu z najmu dla stawki 12,5 % | 2027 |  |  |
| Limit zwolnienia podmiotowego z VAT | 2027 |  |  |

## 5. Co liczymy: kolumny tabel „Wynik”

Każdy wiersz dotyczy miesiąca z pierwszej kolumny. W nawiasach pole w pliku
JSON (część 7). Gdy składki albo podatku nie ma, wpisuje się `0,00`.

**Składki społeczne** (`wynik.skladki_spoleczne`), za miesiąc z wiersza:

| Kolumna | Pole | Co wpisać |
|---|---|---|
| Podstawa | `podstawa_gr` | podstawa wymiaru składek społecznych |
| Emerytalna | `emerytalna_gr` | składka emerytalna |
| Rentowe | `rentowe_gr` | składki rentowe |
| Chorobowa | `chorobowa_gr` | dobrowolna składka chorobowa |
| Wypadkowa | `wypadkowa_gr` | składka wypadkowa |
| Razem bez FP | `razem_gr` | suma emerytalnej, rentowych, chorobowej i wypadkowej |
| FP i FS | `fundusz_pracy_gr` | Fundusz Pracy i Fundusz Solidarnościowy razem |

**Składka zdrowotna** (`wynik.zdrowotna`), za miesiąc z wiersza. Przy skali
i liniowym są tylko kolumny „Podstawa” i „Składka”.

| Kolumna | Pole | Co wpisać |
|---|---|---|
| Przychód narastająco | `przychod_narastajaco_gr` | ryczałt: przychód od początku roku, według którego ustalono próg za ten miesiąc |
| Próg | `prog` | ryczałt: „do 60 tys.”, „do 300 tys.” albo „ponad 300 tys.” |
| Podstawa | `podstawa_gr` | podstawa wymiaru składki zdrowotnej |
| Składka | `skladka_gr` | składka zdrowotna (przy skali i liniowym z uwzględnieniem minimalnej) |

**Ryczałt, odliczenia** (`wynik.ryczalt_odliczenia`):

| Kolumna | Pole | Co wpisać |
|---|---|---|
| Społeczne zapłacone w miesiącu | `spoleczne_zaplacone_gr` | składki społeczne zapłacone w tym miesiącu |
| 50 % zapłaconej zdrowotnej | `zdrowotna_50_proc_gr` | połowa składki zdrowotnej zapłaconej w tym miesiącu |
| Nadwyżka z poprzednich miesięcy | `nadwyzka_z_poprzednich_gr` | kwoty nieodliczone we wcześniejszych miesiącach roku |
| Odliczono w miesiącu | `odliczono_gr` | ile łącznie odliczono od przychodu tego miesiąca |
| Nadwyżka na kolejne miesiące | `nadwyzka_na_kolejne_gr` | co zostaje do odliczenia w następnych miesiącach |

**Ryczałt, podstawa i podatek** (`wynik.ryczalt`):

| Kolumna | Pole | Co wpisać |
|---|---|---|
| Przychód X % | `przychod_wg_stawek_gr["X"]` | przychód miesiąca opodatkowany stawką X % |
| Podstawa X % | `podstawa_wg_stawek_gr["X"]` | przychód ze stawką X % po odliczeniach, jak w deklaracji |
| Ryczałt do zapłaty | `ryczalt_gr` | kwota na przelew za miesiąc |

**Zaliczka PIT** (`wynik.pit`), kolumny narastająco od 1 stycznia 2027 r.
oprócz ostatniej:

| Kolumna | Pole | Co wpisać |
|---|---|---|
| Przychód narastająco | `przychod_narastajaco_gr` |  |
| Koszty narastająco | `koszty_narastajaco_gr` |  |
| Dochód narastająco | `dochod_narastajaco_gr` | przychód minus koszty, może być ujemny |
| Społeczne odliczone narastająco | `spoleczne_narastajaco_gr` |  |
| Zdrowotna odliczona narastająco | `zdrowotna_narastajaco_gr` | tylko liniowy |
| Podstawa narastająco | `podstawa_narastajaco_gr` | podstawa opodatkowania |
| Podatek narastająco | `podatek_narastajaco_gr` | przy skali po kwocie zmniejszającej podatek |
| Zaliczka do zapłaty | `zaliczka_gr` | kwota na przelew za miesiąc |

**VAT** (`wynik.vat`), pola części deklaracyjnej JPK_V7M:

| Kolumna | Pole | Co wpisać |
|---|---|---|
| P_38 | `p_38_gr` | podatek należny razem |
| P_39 | `p_39_gr` | nadwyżka z poprzedniej deklaracji |
| P_48 | `p_48_gr` | podatek naliczony do odliczenia razem |
| P_51 | `p_51_gr` | kwota do wpłaty |
| P_62 | `p_62_gr` | nadwyżka do przeniesienia na następny okres |

**Limit zwolnienia z VAT** (`wynik.limit_vat`):

| Kolumna | Pole | Co wpisać |
|---|---|---|
| Limit zwolnienia na 2027 r. | `limit_gr` | limit dla firmy, która zaczęła działalność w trakcie roku (ta sama kwota w każdym miesiącu) |
| Sprzedaż narastająco | `sprzedaz_narastajaco_gr` | sprzedaż wliczana do limitu, od początku działalności |

**Terminy** (`wynik.terminy`), dla obowiązków za miesiąc z wiersza:

| Kolumna | Pole | Co wpisać |
|---|---|---|
| Ryczałt albo zaliczka PIT | `ryczalt_lub_pit` | ostatni dzień zapłaty |
| ZUS | `zus` | ostatni dzień zapłaty składek |
| JPK_V7M i VAT | `vat` | ostatni dzień złożenia JPK_V7M i zapłaty VAT |

## 6. Przypadki

| # | Przypadek | Tabele wyników |
|---|---|---|
| G1 | Ryczałt 12 % (IT), VAT czynny, ulga na start, przychód 15 000 zł miesięcznie, zmiana progu zdrowotnej w trakcie roku | składki, zdrowotna, ryczałt |
| G2 | Ryczałt 12 %, ZUS preferencyjny, zwolniony z VAT, 8 000 zł miesięcznie | składki, zdrowotna, ryczałt |
| G3 | Ryczałt 8,5 % najem, przekroczenie 100 tys. zł (12,5 %) | składki, zdrowotna, ryczałt (dwie stawki) |
| G4 | Dwie stawki ryczałtu w jednym miesiącu | składki, zdrowotna, ryczałt (dwie stawki) |
| G5 | Ryczałt, pełny ZUS, przekroczenie 300 tys. zł przychodu w trakcie roku | składki, zdrowotna, ryczałt |
| G6 | Ryczałt, etat obok (bez społecznych) | składki, zdrowotna, ryczałt |
| G7 | Ryczałt, odliczenia większe niż ryczałt w miesiącu (przeniesienie) | składki, zdrowotna, ryczałt |
| G8 | Skala, ZUS preferencyjny, 6 000 zł dochodu miesięcznie | składki, zdrowotna, zaliczka PIT |
| G9 | Skala, przekroczenie 120 tys. zł w trakcie roku | składki, zdrowotna, zaliczka PIT |
| G10 | Liniowy, pełny ZUS, odliczenie zdrowotnej do limitu | składki, zdrowotna, zaliczka PIT |
| G11 | Skala albo liniowy, strata w miesiącu i minimalna zdrowotna | składki, zdrowotna, zaliczka PIT |
| G12 | VAT: 23 %, zakup z odliczeniem 50 % (samochód), korekta, nadwyżka z poprzedniego miesiąca | VAT |
| G13 | Start działalności w trakcie roku (proporcja limitu VAT, pierwszy termin) | składki, zdrowotna, ryczałt, limit VAT, pierwsze terminy |
| G14 | Grudzień i terminy w styczniu, przesunięcia weekendów | terminy |

### G1. Ryczałt 12 % (IT), VAT czynny, ulga na start, przychód 15 000 zł miesięcznie, zmiana progu zdrowotnej w trakcie roku

**Założenia**

- Działalność od 1 stycznia 2027 r., wcześniej jej nie było. Ryczałt od początku działalności, stawka 12 % dla całego przychodu.
- Czynny podatnik VAT od 1 stycznia 2027 r.: przychód to kwoty netto, VAT się tu nie liczy.
- ZUS: ulga na start od 1 stycznia do 30 czerwca 2027 r., od 1 lipca 2027 r. składki preferencyjne. Chorobowe: nie.
- Przypadek sprawdza zmianę progu zdrowotnej. Uwaga: po kwietniu przychód narastająco wynosi dokładnie 60 000,00 zł.

**Dane**

| Miesiąc | Przychód 12 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| styczeń | 15 000,00 | ulga na start | brak |
| luty | 15 000,00 | ulga na start | styczeń |
| marzec | 15 000,00 | ulga na start | luty |
| kwiecień | 15 000,00 | ulga na start | marzec |
| maj | 15 000,00 | ulga na start | kwiecień |
| czerwiec | 15 000,00 | ulga na start | maj |
| lipiec | 15 000,00 | preferencyjny | czerwiec |
| sierpień | 15 000,00 | preferencyjny | lipiec |
| wrzesień | 15 000,00 | preferencyjny | sierpień |
| październik | 15 000,00 | preferencyjny | wrzesień |
| listopad | 15 000,00 | preferencyjny | październik |
| grudzień | 15 000,00 | preferencyjny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| styczeń |  |  |  |  |
| luty |  |  |  |  |
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 12 % | Podstawa 12 % | Ryczałt do zapłaty |
|---|---|---|---|
| styczeń |  |  |  |
| luty |  |  |  |
| marzec |  |  |  |
| kwiecień |  |  |  |
| maj |  |  |  |
| czerwiec |  |  |  |
| lipiec |  |  |  |
| sierpień |  |  |  |
| wrzesień |  |  |  |
| październik |  |  |  |
| listopad |  |  |  |
| grudzień |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G2. Ryczałt 12 %, ZUS preferencyjny, zwolniony z VAT, 8 000 zł miesięcznie

**Założenia**

- Działalność od 1 stycznia 2026 r.: ulga na start od 1 stycznia do 30 czerwca 2026 r., składki preferencyjne od 1 lipca 2026 r., czyli przez cały 2027 r.
- Ryczałt 12 % dla całego przychodu i zwolnienie podmiotowe z VAT, w 2026 i 2027 r.
- Chorobowe: tak, w 2026 i 2027 r.
- Przychód w każdym miesiącu 2026 i 2027 r.: 8 000,00 zł.

**Dane**

| Miesiąc | Przychód 12 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| grudzień 2026 | 8 000,00 | preferencyjny | listopad 2026 |
| styczeń | 8 000,00 | preferencyjny | grudzień 2026 |
| luty | 8 000,00 | preferencyjny | styczeń |
| marzec | 8 000,00 | preferencyjny | luty |
| kwiecień | 8 000,00 | preferencyjny | marzec |
| maj | 8 000,00 | preferencyjny | kwiecień |
| czerwiec | 8 000,00 | preferencyjny | maj |
| lipiec | 8 000,00 | preferencyjny | czerwiec |
| sierpień | 8 000,00 | preferencyjny | lipiec |
| wrzesień | 8 000,00 | preferencyjny | sierpień |
| październik | 8 000,00 | preferencyjny | wrzesień |
| listopad | 8 000,00 | preferencyjny | październik |
| grudzień | 8 000,00 | preferencyjny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |
| styczeń |  |  |  |  |
| luty |  |  |  |  |
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 12 % | Podstawa 12 % | Ryczałt do zapłaty |
|---|---|---|---|
| styczeń |  |  |  |
| luty |  |  |  |
| marzec |  |  |  |
| kwiecień |  |  |  |
| maj |  |  |  |
| czerwiec |  |  |  |
| lipiec |  |  |  |
| sierpień |  |  |  |
| wrzesień |  |  |  |
| październik |  |  |  |
| listopad |  |  |  |
| grudzień |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G3. Ryczałt 8,5 % najem, przekroczenie 100 tys. zł (12,5 %)

**Założenia**

- Cały przychód to czynsz za najem lokalu użytkowego w ramach działalności: ryczałt 8,5 %, a od nadwyżki przychodu z najmu ponad 100 000 zł w roku 12,5 %.
- Zwolnienie podmiotowe z VAT, w 2026 i 2027 r.
- ZUS pełny, chorobowe: nie, w 2026 i 2027 r.
- Przychód w każdym miesiącu 2026 i 2027 r.: 11 000,00 zł.
- W tabeli „Wynik: ryczałt, podstawa i podatek” przychód miesiąca, w którym przychód z najmu przekracza 100 000 zł, rozkłada się na kolumny 8,5 % i 12,5 %.

**Dane**

| Miesiąc | Przychód 8,5 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| grudzień 2026 | 11 000,00 | pełny | listopad 2026 |
| styczeń | 11 000,00 | pełny | grudzień 2026 |
| luty | 11 000,00 | pełny | styczeń |
| marzec | 11 000,00 | pełny | luty |
| kwiecień | 11 000,00 | pełny | marzec |
| maj | 11 000,00 | pełny | kwiecień |
| czerwiec | 11 000,00 | pełny | maj |
| lipiec | 11 000,00 | pełny | czerwiec |
| sierpień | 11 000,00 | pełny | lipiec |
| wrzesień | 11 000,00 | pełny | sierpień |
| październik | 11 000,00 | pełny | wrzesień |
| listopad | 11 000,00 | pełny | październik |
| grudzień | 11 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |
| styczeń |  |  |  |  |
| luty |  |  |  |  |
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 8,5 % | Przychód 12,5 % | Podstawa 8,5 % | Podstawa 12,5 % | Ryczałt do zapłaty |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G4. Dwie stawki ryczałtu w jednym miesiącu

**Założenia**

- Dwa rodzaje przychodu: usługi ze stawką 12 % i sprzedaż towarów ze stawką 3 %. Stawki są dane; przypadek nie sprawdza, czy pasują do usług.
- Czynny podatnik VAT: przychód to kwoty netto, VAT się tu nie liczy.
- ZUS pełny, chorobowe: tak, w 2026 i 2027 r.
- W każdym miesiącu 2026 r.: 6 000,00 zł ze stawką 12 % i 4 000,00 zł ze stawką 3 %.
- W marcu 2027 r. jest tylko przychód ze stawką 3 %, a w kwietniu przychód ze stawką 12 % jest mały. Prosimy napisać w uwagach, od przychodu z której stawki odliczono składki i dlaczego.

**Dane**

| Miesiąc | Przychód 12 % | Przychód 3 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|---|
| grudzień 2026 | 6 000,00 | 4 000,00 | pełny | listopad 2026 |
| styczeń | 6 000,00 | 4 000,00 | pełny | grudzień 2026 |
| luty | 6 000,00 | 4 000,00 | pełny | styczeń |
| marzec | 0,00 | 9 000,00 | pełny | luty |
| kwiecień | 1 000,00 | 8 000,00 | pełny | marzec |
| maj | 6 000,00 | 4 000,00 | pełny | kwiecień |
| czerwiec | 6 000,00 | 4 000,00 | pełny | maj |
| lipiec | 6 000,00 | 4 000,00 | pełny | czerwiec |
| sierpień | 6 000,00 | 4 000,00 | pełny | lipiec |
| wrzesień | 6 000,00 | 4 000,00 | pełny | sierpień |
| październik | 6 000,00 | 4 000,00 | pełny | wrzesień |
| listopad | 6 000,00 | 4 000,00 | pełny | październik |
| grudzień | 6 000,00 | 4 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |
| styczeń |  |  |  |  |
| luty |  |  |  |  |
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 12 % | Przychód 3 % | Podstawa 12 % | Podstawa 3 % | Ryczałt do zapłaty |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G5. Ryczałt, pełny ZUS, przekroczenie 300 tys. zł przychodu w trakcie roku

**Założenia**

- Ryczałt 8,5 % dla całego przychodu (usługi).
- Czynny podatnik VAT: przychód to kwoty netto, VAT się tu nie liczy.
- ZUS pełny, chorobowe: tak, w 2026 i 2027 r.
- Przychód w każdym miesiącu 2026 i 2027 r.: 35 000,00 zł.
- Przypadek sprawdza zmianę progów zdrowotnej w trakcie roku (60 000 zł i 300 000 zł).

**Dane**

| Miesiąc | Przychód 8,5 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| grudzień 2026 | 35 000,00 | pełny | listopad 2026 |
| styczeń | 35 000,00 | pełny | grudzień 2026 |
| luty | 35 000,00 | pełny | styczeń |
| marzec | 35 000,00 | pełny | luty |
| kwiecień | 35 000,00 | pełny | marzec |
| maj | 35 000,00 | pełny | kwiecień |
| czerwiec | 35 000,00 | pełny | maj |
| lipiec | 35 000,00 | pełny | czerwiec |
| sierpień | 35 000,00 | pełny | lipiec |
| wrzesień | 35 000,00 | pełny | sierpień |
| październik | 35 000,00 | pełny | wrzesień |
| listopad | 35 000,00 | pełny | październik |
| grudzień | 35 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |
| styczeń |  |  |  |  |
| luty |  |  |  |  |
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 8,5 % | Podstawa 8,5 % | Ryczałt do zapłaty |
|---|---|---|---|
| styczeń |  |  |  |
| luty |  |  |  |
| marzec |  |  |  |
| kwiecień |  |  |  |
| maj |  |  |  |
| czerwiec |  |  |  |
| lipiec |  |  |  |
| sierpień |  |  |  |
| wrzesień |  |  |  |
| październik |  |  |  |
| listopad |  |  |  |
| grudzień |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G6. Ryczałt, etat obok (bez społecznych)

**Założenia**

- Ryczałt 8,5 % dla całego przychodu i zwolnienie podmiotowe z VAT, w 2026 i 2027 r.
- Obok działalności umowa o pracę u innego pracodawcy przez cały 2026 i 2027 r., wynagrodzenie 7 000,00 zł brutto miesięcznie (więcej niż minimalne). Z działalności klient nie płaci składek społecznych, także dobrowolnie. Składkę zdrowotną z działalności płaci.
- Przychód z działalności w każdym miesiącu 2026 i 2027 r.: 4 000,00 zł. Liczymy tylko działalność, bez etatu.

**Dane**

| Miesiąc | Przychód 8,5 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| grudzień 2026 | 4 000,00 | etat obok | listopad 2026 |
| styczeń | 4 000,00 | etat obok | grudzień 2026 |
| luty | 4 000,00 | etat obok | styczeń |
| marzec | 4 000,00 | etat obok | luty |
| kwiecień | 4 000,00 | etat obok | marzec |
| maj | 4 000,00 | etat obok | kwiecień |
| czerwiec | 4 000,00 | etat obok | maj |
| lipiec | 4 000,00 | etat obok | czerwiec |
| sierpień | 4 000,00 | etat obok | lipiec |
| wrzesień | 4 000,00 | etat obok | sierpień |
| październik | 4 000,00 | etat obok | wrzesień |
| listopad | 4 000,00 | etat obok | październik |
| grudzień | 4 000,00 | etat obok | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |
| styczeń |  |  |  |  |
| luty |  |  |  |  |
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 8,5 % | Podstawa 8,5 % | Ryczałt do zapłaty |
|---|---|---|---|
| styczeń |  |  |  |
| luty |  |  |  |
| marzec |  |  |  |
| kwiecień |  |  |  |
| maj |  |  |  |
| czerwiec |  |  |  |
| lipiec |  |  |  |
| sierpień |  |  |  |
| wrzesień |  |  |  |
| październik |  |  |  |
| listopad |  |  |  |
| grudzień |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G7. Ryczałt, odliczenia większe niż ryczałt w miesiącu (przeniesienie)

**Założenia**

- Ryczałt 15 % dla całego przychodu i zwolnienie podmiotowe z VAT, w 2026 i 2027 r.
- ZUS pełny, chorobowe: nie, w 2026 i 2027 r.
- Przychód w każdym miesiącu 2026 r.: 4 000,00 zł. W 2027 r. przychód jest nierówny (tabela).
- Przypadek sprawdza miesiące, w których składki do odliczenia są większe niż przychód, i przeniesienie nadwyżki na kolejne miesiące.

**Dane**

| Miesiąc | Przychód 15 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| grudzień 2026 | 4 000,00 | pełny | listopad 2026 |
| styczeń | 1 500,00 | pełny | grudzień 2026 |
| luty | 0,00 | pełny | styczeń |
| marzec | 800,00 | pełny | luty |
| kwiecień | 7 000,00 | pełny | marzec |
| maj | 7 000,00 | pełny | kwiecień |
| czerwiec | 7 000,00 | pełny | maj |
| lipiec | 1 200,00 | pełny | czerwiec |
| sierpień | 0,00 | pełny | lipiec |
| wrzesień | 7 000,00 | pełny | sierpień |
| październik | 7 000,00 | pełny | wrzesień |
| listopad | 7 000,00 | pełny | październik |
| grudzień | 7 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |
| styczeń |  |  |  |  |
| luty |  |  |  |  |
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 15 % | Podstawa 15 % | Ryczałt do zapłaty |
|---|---|---|---|
| styczeń |  |  |  |
| luty |  |  |  |
| marzec |  |  |  |
| kwiecień |  |  |  |
| maj |  |  |  |
| czerwiec |  |  |  |
| lipiec |  |  |  |
| sierpień |  |  |  |
| wrzesień |  |  |  |
| październik |  |  |  |
| listopad |  |  |  |
| grudzień |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G8. Skala, ZUS preferencyjny, 6 000 zł dochodu miesięcznie

**Założenia**

- Działalność od 1 stycznia 2026 r.: ulga na start od 1 stycznia do 30 czerwca 2026 r., składki preferencyjne od 1 lipca 2026 r., czyli przez cały 2027 r.
- Skala podatkowa i zwolnienie podmiotowe z VAT, w 2026 i 2027 r.
- Chorobowe: nie.
- W każdym miesiącu 2026 i 2027 r.: przychód 9 000,00 zł i koszty w KPiR 3 000,00 zł, czyli 6 000,00 zł dochodu przed odliczeniem składek.

**Dane**

| Miesiąc | Przychód | Koszty w KPiR | Etap ZUS | Zapłacone składki za |
|---|---|---|---|---|
| grudzień 2026 | 9 000,00 | 3 000,00 | preferencyjny | listopad 2026 |
| styczeń | 9 000,00 | 3 000,00 | preferencyjny | grudzień 2026 |
| luty | 9 000,00 | 3 000,00 | preferencyjny | styczeń |
| marzec | 9 000,00 | 3 000,00 | preferencyjny | luty |
| kwiecień | 9 000,00 | 3 000,00 | preferencyjny | marzec |
| maj | 9 000,00 | 3 000,00 | preferencyjny | kwiecień |
| czerwiec | 9 000,00 | 3 000,00 | preferencyjny | maj |
| lipiec | 9 000,00 | 3 000,00 | preferencyjny | czerwiec |
| sierpień | 9 000,00 | 3 000,00 | preferencyjny | lipiec |
| wrzesień | 9 000,00 | 3 000,00 | preferencyjny | sierpień |
| październik | 9 000,00 | 3 000,00 | preferencyjny | wrzesień |
| listopad | 9 000,00 | 3 000,00 | preferencyjny | październik |
| grudzień | 9 000,00 | 3 000,00 | preferencyjny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Podstawa | Składka |
|---|---|---|
| styczeń |  |  |
| luty |  |  |
| marzec |  |  |
| kwiecień |  |  |
| maj |  |  |
| czerwiec |  |  |
| lipiec |  |  |
| sierpień |  |  |
| wrzesień |  |  |
| październik |  |  |
| listopad |  |  |
| grudzień |  |  |

**Wynik: zaliczka PIT**

| Miesiąc | Przychód narastająco | Koszty narastająco | Dochód narastająco | Społeczne odliczone narastająco | Podstawa narastająco | Podatek narastająco | Zaliczka do zapłaty |
|---|---|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G9. Skala, przekroczenie 120 tys. zł w trakcie roku

**Założenia**

- Skala podatkowa i zwolnienie podmiotowe z VAT, w 2026 i 2027 r.
- ZUS pełny, chorobowe: tak, w 2026 i 2027 r.
- W każdym miesiącu 2026 i 2027 r.: przychód 18 000,00 zł i koszty w KPiR 2 000,00 zł.
- Przypadek sprawdza miesiąc, w którym podstawa narastająco przekracza 120 000 zł.

**Dane**

| Miesiąc | Przychód | Koszty w KPiR | Etap ZUS | Zapłacone składki za |
|---|---|---|---|---|
| grudzień 2026 | 18 000,00 | 2 000,00 | pełny | listopad 2026 |
| styczeń | 18 000,00 | 2 000,00 | pełny | grudzień 2026 |
| luty | 18 000,00 | 2 000,00 | pełny | styczeń |
| marzec | 18 000,00 | 2 000,00 | pełny | luty |
| kwiecień | 18 000,00 | 2 000,00 | pełny | marzec |
| maj | 18 000,00 | 2 000,00 | pełny | kwiecień |
| czerwiec | 18 000,00 | 2 000,00 | pełny | maj |
| lipiec | 18 000,00 | 2 000,00 | pełny | czerwiec |
| sierpień | 18 000,00 | 2 000,00 | pełny | lipiec |
| wrzesień | 18 000,00 | 2 000,00 | pełny | sierpień |
| październik | 18 000,00 | 2 000,00 | pełny | wrzesień |
| listopad | 18 000,00 | 2 000,00 | pełny | październik |
| grudzień | 18 000,00 | 2 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Podstawa | Składka |
|---|---|---|
| styczeń |  |  |
| luty |  |  |
| marzec |  |  |
| kwiecień |  |  |
| maj |  |  |
| czerwiec |  |  |
| lipiec |  |  |
| sierpień |  |  |
| wrzesień |  |  |
| październik |  |  |
| listopad |  |  |
| grudzień |  |  |

**Wynik: zaliczka PIT**

| Miesiąc | Przychód narastająco | Koszty narastająco | Dochód narastająco | Społeczne odliczone narastająco | Podstawa narastająco | Podatek narastająco | Zaliczka do zapłaty |
|---|---|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G10. Liniowy, pełny ZUS, odliczenie zdrowotnej do limitu

**Założenia**

- Podatek liniowy w 2026 i 2027 r. Czynny podatnik VAT: kwoty netto, VAT się tu nie liczy.
- ZUS pełny, chorobowe: nie, w 2026 i 2027 r.
- W każdym miesiącu 2026 i 2027 r.: przychód 50 000,00 zł i koszty w KPiR 10 000,00 zł.
- Przypadek sprawdza odliczenie zapłaconej składki zdrowotnej od dochodu do rocznego limitu i miesiące po jego wyczerpaniu.

**Dane**

| Miesiąc | Przychód | Koszty w KPiR | Etap ZUS | Zapłacone składki za |
|---|---|---|---|---|
| grudzień 2026 | 50 000,00 | 10 000,00 | pełny | listopad 2026 |
| styczeń | 50 000,00 | 10 000,00 | pełny | grudzień 2026 |
| luty | 50 000,00 | 10 000,00 | pełny | styczeń |
| marzec | 50 000,00 | 10 000,00 | pełny | luty |
| kwiecień | 50 000,00 | 10 000,00 | pełny | marzec |
| maj | 50 000,00 | 10 000,00 | pełny | kwiecień |
| czerwiec | 50 000,00 | 10 000,00 | pełny | maj |
| lipiec | 50 000,00 | 10 000,00 | pełny | czerwiec |
| sierpień | 50 000,00 | 10 000,00 | pełny | lipiec |
| wrzesień | 50 000,00 | 10 000,00 | pełny | sierpień |
| październik | 50 000,00 | 10 000,00 | pełny | wrzesień |
| listopad | 50 000,00 | 10 000,00 | pełny | październik |
| grudzień | 50 000,00 | 10 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Podstawa | Składka |
|---|---|---|
| grudzień 2026 |  |  |
| styczeń |  |  |
| luty |  |  |
| marzec |  |  |
| kwiecień |  |  |
| maj |  |  |
| czerwiec |  |  |
| lipiec |  |  |
| sierpień |  |  |
| wrzesień |  |  |
| październik |  |  |
| listopad |  |  |
| grudzień |  |  |

**Wynik: zaliczka PIT**

| Miesiąc | Przychód narastająco | Koszty narastająco | Dochód narastająco | Społeczne odliczone narastająco | Zdrowotna odliczona narastająco | Podstawa narastająco | Podatek narastająco | Zaliczka do zapłaty |
|---|---|---|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G11. Skala albo liniowy, strata w miesiącu i minimalna zdrowotna

**Założenia**

- Z dwóch form z planu wybraliśmy podatek liniowy (skalę sprawdzają G8 i G9).
- Działalność od 1 stycznia 2026 r.: ulga na start od 1 stycznia do 30 czerwca 2026 r., składki preferencyjne od 1 lipca 2026 r., czyli przez cały 2027 r.
- Podatek liniowy i zwolnienie podmiotowe z VAT, w 2026 i 2027 r. Chorobowe: tak.
- W każdym miesiącu 2026 r.: przychód 12 000,00 zł i koszty w KPiR 4 000,00 zł.
- W marcu 2027 r. koszty są większe niż przychód (strata w miesiącu), a w kwietniu dochód jest mały.

**Dane**

| Miesiąc | Przychód | Koszty w KPiR | Etap ZUS | Zapłacone składki za |
|---|---|---|---|---|
| grudzień 2026 | 12 000,00 | 4 000,00 | preferencyjny | listopad 2026 |
| styczeń | 12 000,00 | 4 000,00 | preferencyjny | grudzień 2026 |
| luty | 10 000,00 | 4 000,00 | preferencyjny | styczeń |
| marzec | 3 000,00 | 8 000,00 | preferencyjny | luty |
| kwiecień | 4 000,00 | 2 000,00 | preferencyjny | marzec |
| maj | 12 000,00 | 4 000,00 | preferencyjny | kwiecień |
| czerwiec | 12 000,00 | 4 000,00 | preferencyjny | maj |
| lipiec | 12 000,00 | 4 000,00 | preferencyjny | czerwiec |
| sierpień | 12 000,00 | 4 000,00 | preferencyjny | lipiec |
| wrzesień | 12 000,00 | 4 000,00 | preferencyjny | sierpień |
| październik | 12 000,00 | 4 000,00 | preferencyjny | wrzesień |
| listopad | 12 000,00 | 4 000,00 | preferencyjny | październik |
| grudzień | 12 000,00 | 4 000,00 | preferencyjny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |  |  |  |  |  |  |  |
| styczeń |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Podstawa | Składka |
|---|---|---|
| grudzień 2026 |  |  |
| styczeń |  |  |
| luty |  |  |
| marzec |  |  |
| kwiecień |  |  |
| maj |  |  |
| czerwiec |  |  |
| lipiec |  |  |
| sierpień |  |  |
| wrzesień |  |  |
| październik |  |  |
| listopad |  |  |
| grudzień |  |  |

**Wynik: zaliczka PIT**

| Miesiąc | Przychód narastająco | Koszty narastająco | Dochód narastająco | Społeczne odliczone narastająco | Zdrowotna odliczona narastająco | Podstawa narastająco | Podatek narastająco | Zaliczka do zapłaty |
|---|---|---|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |  |  |  |
| luty |  |  |  |  |  |  |  |  |
| marzec |  |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G12. VAT: 23 %, zakup z odliczeniem 50 % (samochód), korekta, nadwyżka z poprzedniego miesiąca

**Założenia**

- Czynny podatnik VAT od lat, rozliczenie miesięczne (JPK_V7M). Forma opodatkowania PIT nie ma tu znaczenia: liczymy tylko VAT.
- Z deklaracji za grudzień 2026 r. przechodzi na styczeń 2027 r. nadwyżka podatku naliczonego nad należnym: 1 200,00 zł. Klient nie wnioskuje o zwrot; nadwyżki przechodzą na następny miesiąc.
- Sprzedaż: jedna faktura w miesiącu, usługi w kraju, stawka 23 %, data sprzedaży i wystawienia: ostatni dzień miesiąca.
- Zakupy: faktury z KSeF otrzymane w miesiącu zakupu, VAT odliczany w tym samym miesiącu.
- Samochód osobowy używany także prywatnie, bez ewidencji przebiegu: z faktur za paliwo i serwis odlicza się 50 % VAT.
- Maj: faktura korygująca in minus do faktury sprzedaży z kwietnia, wystawiona w KSeF 12.05.2027 r.; warunki obniżenia uzgodnione z nabywcą w maju i udokumentowane.
- Czerwiec: dodatkowo usługa podwykonawcy z pełnym odliczeniem.

**Dane** (kwoty z faktur)

| Miesiąc | Sprzedaż 23 %: netto | Sprzedaż 23 %: VAT | Zakupy, pełne odliczenie: netto | Zakupy, pełne odliczenie: VAT | Samochód, odliczenie 50 %: netto | Samochód, odliczenie 50 %: VAT | Inne zdarzenia |
|---|---|---|---|---|---|---|---|
| styczeń | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| luty | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| marzec | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| kwiecień | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| maj | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 | korekta in minus do faktury z kwietnia: netto -2 000,00, VAT -460,00 |
| czerwiec | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 | usługa podwykonawcy: netto 40 000,00, VAT 9 200,00, pełne odliczenie |
| lipiec | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| sierpień | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| wrzesień | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| październik | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| listopad | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |
| grudzień | 30 000,00 | 6 900,00 | 8 000,00 | 1 840,00 | 1 000,00 | 230,00 |  |

**Wynik: VAT, część deklaracyjna JPK_V7M**

| Miesiąc | P_38 | P_39 | P_48 | P_51 | P_62 |
|---|---|---|---|---|---|
| styczeń |  |  |  |  |  |
| luty |  |  |  |  |  |
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G13. Start działalności w trakcie roku (proporcja limitu VAT, pierwszy termin)

**Założenia**

- Działalność od 15 marca 2027 r., wcześniej jej nie było.
- Ryczałt 8,5 % dla całego przychodu, zwolnienie podmiotowe z VAT od początku działalności.
- ZUS: ulga na start od 15 marca 2027 r., potem składki preferencyjne. W tabeli przyjęliśmy ulgę do 30 września 2027 r. (niepełny marzec i sześć pełnych miesięcy, od kwietnia do września) i składki preferencyjne od 1 października 2027 r. Jeśli według przepisów jest inaczej, prosimy poprawić kolumnę „Etap ZUS” i napisać to w uwagach.
- Chorobowe: nie.
- Przychód: w marcu 9 000,00 zł, od kwietnia 18 000,00 zł miesięcznie.
- Przypadek sprawdza limit zwolnienia z VAT w proporcji do okresu działalności i pierwsze terminy płatności.

**Dane**

| Miesiąc | Przychód 8,5 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| styczeń | brak działalności |  |  |
| luty | brak działalności |  |  |
| marzec | 9 000,00 | ulga na start (od 15.03) | brak |
| kwiecień | 18 000,00 | ulga na start | marzec |
| maj | 18 000,00 | ulga na start | kwiecień |
| czerwiec | 18 000,00 | ulga na start | maj |
| lipiec | 18 000,00 | ulga na start | czerwiec |
| sierpień | 18 000,00 | ulga na start | lipiec |
| wrzesień | 18 000,00 | ulga na start | sierpień |
| październik | 18 000,00 | preferencyjny | wrzesień |
| listopad | 18 000,00 | preferencyjny | październik |
| grudzień | 18 000,00 | preferencyjny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| marzec |  |  |  |  |  |  |  |
| kwiecień |  |  |  |  |  |  |  |
| maj |  |  |  |  |  |  |  |
| czerwiec |  |  |  |  |  |  |  |
| lipiec |  |  |  |  |  |  |  |
| sierpień |  |  |  |  |  |  |  |
| wrzesień |  |  |  |  |  |  |  |
| październik |  |  |  |  |  |  |  |
| listopad |  |  |  |  |  |  |  |
| grudzień |  |  |  |  |  |  |  |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| marzec |  |  |  |  |
| kwiecień |  |  |  |  |
| maj |  |  |  |  |
| czerwiec |  |  |  |  |
| lipiec |  |  |  |  |
| sierpień |  |  |  |  |
| wrzesień |  |  |  |  |
| październik |  |  |  |  |
| listopad |  |  |  |  |
| grudzień |  |  |  |  |

**Wynik: ryczałt, odliczenia**

| Miesiąc | Społeczne zapłacone w miesiącu | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich miesięcy | Odliczono w miesiącu | Nadwyżka na kolejne miesiące |
|---|---|---|---|---|---|
| marzec |  |  |  |  |  |
| kwiecień |  |  |  |  |  |
| maj |  |  |  |  |  |
| czerwiec |  |  |  |  |  |
| lipiec |  |  |  |  |  |
| sierpień |  |  |  |  |  |
| wrzesień |  |  |  |  |  |
| październik |  |  |  |  |  |
| listopad |  |  |  |  |  |
| grudzień |  |  |  |  |  |

**Wynik: ryczałt, podstawa i podatek**

| Miesiąc | Przychód 8,5 % | Podstawa 8,5 % | Ryczałt do zapłaty |
|---|---|---|---|
| marzec |  |  |  |
| kwiecień |  |  |  |
| maj |  |  |  |
| czerwiec |  |  |  |
| lipiec |  |  |  |
| sierpień |  |  |  |
| wrzesień |  |  |  |
| październik |  |  |  |
| listopad |  |  |  |
| grudzień |  |  |  |

**Wynik: limit zwolnienia z VAT**

| Limit zwolnienia na 2027 r. | Kwota |
|---|---|
| dla firmy, która zaczęła działalność 15 marca 2027 r. |  |

| Miesiąc | Sprzedaż narastająco |
|---|---|
| marzec |  |
| kwiecień |  |
| maj |  |
| czerwiec |  |
| lipiec |  |
| sierpień |  |
| wrzesień |  |
| październik |  |
| listopad |  |
| grudzień |  |

**Wynik: pierwsze terminy**

| Obowiązek za marzec 2027 r. | Termin |
|---|---|
| Ryczałt |  |
| Składki ZUS |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

### G14. Grudzień i terminy w styczniu, przesunięcia weekendów

**Założenia**

- Ryczałt, czynny podatnik VAT (JPK_V7M), ZUS pełny, rozliczenie miesięczne. Kwot nie liczymy, tylko terminy.
- W każdym wierszu: ostatni dzień zapłaty ryczałtu i składek ZUS za miesiąc z wiersza oraz ostatni dzień złożenia JPK_V7M i zapłaty VAT za ten miesiąc. Wiersz „grudzień 2026” to terminy w styczniu 2027 r., a wiersz „grudzień” (2027 r.) to terminy w styczniu 2028 r.
- Prosimy uwzględnić soboty, niedziele i dni ustawowo wolne od pracy, od 2025 r. także Wigilię.

**Dane:** nie są potrzebne, liczymy tylko terminy.

**Wynik: terminy**

| Rozliczenie za | Ryczałt albo zaliczka PIT | ZUS | JPK_V7M i VAT |
|---|---|---|---|
| grudzień 2026 |  |  |  |
| styczeń |  |  |  |
| luty |  |  |  |
| marzec |  |  |  |
| kwiecień |  |  |  |
| maj |  |  |  |
| czerwiec |  |  |  |
| lipiec |  |  |  |
| sierpień |  |  |  |
| wrzesień |  |  |  |
| październik |  |  |  |
| listopad |  |  |  |
| grudzień |  |  |  |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |  |
| `data`: dzień zakończenia obliczeń |  |
| `uwagi`: założenia, wątpliwości, podstawa prawna |  |

## 7. Przeniesienie wyniku do testów (dla zespołu FaktWay)

- Każdy podpisany przypadek to plik `tests/fixtures/ksiegowosc/zlote/G<n>.json`
  (np. `G1.json`), kopia `szablon.json`. Sam `szablon.json` nie jest
  przypadkiem i test go pomija.
- `miesiace`: jeden wpis na wiersz tabel, najpierw `2026-12` (jeśli
  przypadek go ma), potem `2027-01` do `2027-12`. Miesiące bez
  działalności (G13: styczeń i luty 2027) mają
  `"dzialalnosc": false`.
- `historia` (wypełnia zespół FaktWay, nie księgowa): miesiące 2026 r.
  przed pierwszym wierszem, tylko `wejscie`, przepisane z założeń
  przypadku (przychód „w każdym miesiącu 2026 r.”, etapy ZUS, składki
  płacone w kolejnym miesiącu). Program liczy je bez porównania, żeby
  grudzień 2026 r. miał przychód narastająco, próg najmu i zapłacone
  składki z całego roku. Składek za grudzień 2025 r. i zdrowotnej za
  styczeń 2026 r. program nie liczy (brak parametrów 2025 r.), więc
  w historii ich nie odlicza; jeśli wynik księgowej je uwzględnia, różnica
  wyjdzie w `zdrowotna.przychod_narastajaco_gr` za grudzień 2026 r.
- Przypadek VAT (G12) liczy `vatMiesiaca` (`lib/ksiegowosc/vat.ts`), ten
  sam kod co plik JPK_V7M: przychód ze `stawka_vat` to faktura, korekta
  (`korekta_do`) to faktura korygująca z kwotami różnicy, koszt odlicza
  `odliczenie_vat_proc` z VAT. P_39 stycznia to
  `zalozenia.nadwyzka_vat_z_poprzedniego_roku_gr`, każdego następnego
  miesiąca P_62 poprzedniego. Porównanie bierze pola bloku `vat`.
- `wejscie` przepisujemy z założeń i tabeli „Dane”: jeden wpis w
  `przychody` albo `koszty` na każdą kwotę z tabeli (w szablonie lista ma
  jeden pusty wpis, który pokazuje pola). `zaplacone_skladki_za`: miesiące
  z kolumny „Zapłacone składki za” (`"2026-12"`); „brak” to pusta lista.
  Korekta ma `korekta_do` z miesiącem korygowanej faktury (`"2027-04"`).
  Nadwyżka VAT z grudnia 2026 r. (G12) idzie do
  `zalozenia.nadwyzka_vat_z_poprzedniego_roku_gr`.
- Kwoty w groszach jako liczby całkowite (pola `_gr`): `1 234,56` to
  `123456`, kwoty ujemne ze znakiem minus. Daty w formacie `RRRR-MM-DD`,
  także `data` z podpisu.
- Blok wyniku, którego przypadek nie liczy (np. `vat` w G1), ma wartość
  `null`.
- Klucze map `przychod_wg_stawek_gr` i `podstawa_wg_stawek_gr`: stawka
  z kropką, jako tekst (`"12"`, `"8.5"`, `"12.5"`).
- `parametry`: wiersze tabeli z części 4 w tej samej kolejności; `wartosc`
  jako liczba w tekście z kropką (`"1234.56"`, `"12.34"`), `zrodlo`
  dosłownie.
- `policzyla`, `data` i `uwagi` przepisujemy z podpisu dosłownie.
  Przypadek bez `policzyla` i `data` nie jest złotym przypadkiem (warunek
  B4 w planie).
- Słowniki: `forma`: `ryczalt`, `skala`, `liniowy`; `vat`: `czynny`,
  `zwolniony`; `zus_etap`: `ulga_na_start`, `preferencyjny`, `pelny`,
  `etat_obok`; `prog`: `do_60000`, `do_300000`, `ponad_300000`;
  `stawka_vat`: `"23"` albo `"zw"`; `odliczenie_vat_proc`: `100`
  albo `50`.
