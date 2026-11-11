# Złote przypadki G15-G30: arkusz do policzenia (część 2)

Krok 0.1 planu `docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md` (sekcja 7.2), stan
9.11.2026. Wszystkie tabele „Wynik” są puste: kwoty liczy księgowa,
niezależnie od programu. Wspólne założenia (część 3), parametry, sposób
liczenia i wpisywania wyników (części 2 i 5) oraz forma podpisu są w części 1,
`docs/ksiegowosc/ZLOTE-PRZYPADKI.md`. Tu są tylko różnice. Przypadki G1-G14
zostają w części 1 bez zmian.

## 1. Co jest inne niż w części 1

1. **Okres.** Przypadki G15-G30 dotyczą roku 2027. Przypadek G17 sięga
   wstecz do 2025 r. (faktura z 15.11.2025), a G16 i G18 używają danych z 2026 r.
   Wiersz „grudzień 2026” jest tam, gdzie ma wpływ na 2027 r.
2. **Kursy walut** w G20, G21, G29 to kursy przyjęte w przykładzie. Są podane
   w danych i nie są kursami NBP. Księgowa liczy z podanych kursów, a nie z tabel NBP.
3. **Przypadki roczne** (G24-G27) liczą zeznanie albo roczne rozliczenie za 2027 r.
   Dane roczne są w tabelach „Dane”, część z nich jest podana wprost jako suma roku.
4. **Pola deklaracji i oznaczenia** (JPK_V7M, JPK_V7K, VAT-UE, VAT-8, VAT-9M)
   wpisuje księgowa według aktualnych wzorów. Gdy w tabeli jest kolumna „Pole”,
   wpisujemy numer pola albo oznaczenie, a w kolumnie obok kwotę w złotych.
5. **Pytania do księgowej.** Gdzie reguła jest sporna albo zależy od interpretacji,
   przypadek ma pod założeniami krótką listę pytań. Odpowiedź wpisujemy w polu `uwagi`
   i liczymy dalej według tej odpowiedzi.
6. **Składki ZUS** tam, gdzie wynik zależy od składek, liczy się według parametrów
   z części 1 (sekcja 4) i z tabeli poniżej. Koszty w KPiR przy skali i liniowym nie
   zawierają Funduszu Pracy i Funduszu Solidarnościowego (część 1, sekcja 3 pkt 5).

## 2. Parametry potrzebne w części 2

Tu są tylko parametry, których nie ma w części 1. Pozostałe (płace, stopy składek,
progi zdrowotnej, skala, stawka liniowa) wpisuje się w tabeli z części 1, sekcja 4,
i obowiązują te same wartości. Pole „uzupełnia księgowa” znaczy, że wartość trzeba
wpisać wraz ze źródłem; wartość podana w tabeli trzeba potwierdzić źródłem.

| Parametr | Wartość albo „uzupełnia księgowa” | Źródło do sprawdzenia |
|---|---|---|
| Limit przychodu w 2026 r. dla Małego ZUS Plus | 120 000,00 | ustawa o systemie ubezpieczeń społecznych, art. 18c; do potwierdzenia |
| Mały ZUS Plus: dolna granica podstawy (30 % minimalnego wynagrodzenia) | uzupełnia księgowa | ustawa o systemie ubezpieczeń społecznych, art. 18c; płaca minimalna 2027 |
| Mały ZUS Plus: górna granica podstawy (60 % prognozowanego przeciętnego wynagrodzenia) | uzupełnia księgowa | ustawa o systemie ubezpieczeń społecznych, art. 18c; wynagrodzenie prognozowane 2027 |
| Mały ZUS Plus: sposób liczenia podstawy z dochodu (skala) i z ryczałtu | uzupełnia księgowa | art. 18c ustawy o systemie ubezpieczeń społecznych; komunikat ZUS |
| Limit przychodu w 2026 r. dla ryczałtu płaconego kwartalnie | uzupełnia księgowa | ustawa o ryczałcie, art. 21 |
| Limit przychodu w 2025 r. dla kasowego PIT | 2 000 000,00 | ustawa o PIT, przepisy o metodzie kasowej; do potwierdzenia |
| Limit odliczenia składki zdrowotnej w PIT-36L | 2027: uzupełnia księgowa | ustawa o PIT, art. 30c; obwieszczenie |
| Ulga na dziecko, kwota na jedno dziecko w roku | 2027: uzupełnia księgowa | ustawa o PIT, art. 27f |
| Zasady odliczenia straty z lat ubiegłych (udział rocznie i odliczenie jednorazowe) | uzupełnia księgowa | ustawa o PIT, art. 9 ust. 3 |
| Stawka amortyzacji liniowej serwera | uzupełnia księgowa | Klasyfikacja Środków Trwałych (rozporządzenie Rady Ministrów) i wykaz stawek |
| Stawka amortyzacji maszyny, współczynnik amortyzacji degresywnej | uzupełnia księgowa | KŚT, ustawa o PIT, art. 22i |
| Limit jednorazowej amortyzacji de minimis w 2027 r. | uzupełnia księgowa | ustawa o PIT, art. 22k ust. 7 |
| Granica wartości początkowej środka trwałego (odpisy jednorazowe poniżej) | 10 000,00 | ustawa o PIT, art. 22d ust. 1; do potwierdzenia |
| Limit wartości samochodu osobowego: emisja poniżej 50 g CO2/km | 150 000,00 | ustawa o PIT, art. 23 ust. 1 pkt 4 i 4a, od 1.01.2026; do potwierdzenia |
| Limit wartości samochodu osobowego: emisja co najmniej 50 g CO2/km | 100 000,00 | ustawa o PIT, art. 23; do potwierdzenia |
| Limit wartości samochodu osobowego: elektryczny i wodorowy | 225 000,00 | ustawa o PIT, art. 23; do potwierdzenia |
| Odliczenie VAT przy użytku mieszanym bez ewidencji przebiegu (%) | 50 | ustawa o VAT, art. 86a; do potwierdzenia |
| Koszty uzyskania przychodu z samochodu o użytku mieszanym bez ewidencji przebiegu (%) | 75 | ustawa o PIT, art. 23 ust. 1 pkt 46 i 46a; do potwierdzenia |
| Złe długi: liczba dni od terminu płatności i liczba lat | 90 dni, 3 lata | ustawa o VAT, art. 89a i 89b; ustawa o PIT, art. 26i; do potwierdzenia |
| Termin rocznego rozliczenia składki zdrowotnej za 2027 r. | uzupełnia księgowa | ustawa o świadczeniach opieki zdrowotnej; komunikat ZUS |
| Wakacje składkowe: warunki (liczba ubezpieczonych, limit przychodu) | do 10 ubezpieczonych, poniżej 2 mln euro | ustawa o systemie ubezpieczeń społecznych; do potwierdzenia |
| Termin złożenia i zapłaty ryczałtu kwartalnego, zaliczki kwartalnej, VAT kwartalnego | uzupełnia księgowa | ustawy o ryczałcie, PIT i VAT |

## 3. Przypadki

| # | Przypadek | Tabele wyników | Krok planu |
|---|---|---|---|
| G15 | VAT kwartalny (JPK_V7K) z korektą w drugim miesiącu kwartału | ewidencja miesięczna, deklaracja kwartalna, terminy | 4.1 |
| G16a | Zaliczki kwartalne, skala, cały 2027 r. | składki, zdrowotna, zaliczka kwartalna z terminem | 4.1 |
| G16b | Ryczałt 12 % kwartalny, cały 2027 r. | składki, zdrowotna, odliczenia, ryczałt kwartalny z terminem | 4.1 |
| G17 | Kasowy PIT, skala: faktury z płatnością w kolejnym miesiącu, częściową i niezapłaconą | przychód, koszty i zaliczka PIT w każdym miesiącu | 4.2 |
| G18a | Mały ZUS Plus 2027, skala | składki społeczne w każdym miesiącu | 4.3 |
| G18b | Mały ZUS Plus 2027, ryczałt | składki społeczne w każdym miesiącu | 4.3 |
| G19 | Wakacje składkowe w lipcu 2027 r. z chorobowym | składki za czerwiec, lipiec i sierpień, DRA, terminy | 4.3 |
| G20a | Import usług, czynny VAT | pola JPK_V7M, VAT-UE, terminy | 4.5, 4.6 |
| G20b | Import usług, zwolniony z VAT | deklaracja, kwoty, VAT-UE, terminy | 4.5, 4.6 |
| G21 | WDT i eksport | pola JPK_V7M w marcu, kwietniu i maju, VAT-UE | 2.3, 4.5 |
| G22 | Samochód osobowy w leasingu operacyjnym | VAT do odliczenia i koszt w KPiR w każdym miesiącu | 4.7 |
| G23 | Środki trwałe: liniowa, degresywna, jednorazowa i sprzedaż | odpisy w każdym miesiącu, koszt w KPiR, skutek sprzedaży | 5.1 |
| G24 | PIT-36 za 2027 r., skala | pola zeznania | 5.3 |
| G25 | PIT-36L za 2027 r., liniowy | pola zeznania | 5.3 |
| G26 | PIT-28 za 2027 r., dwie stawki i najem | pola zeznania, dopłata albo nadpłata | 5.2 |
| G27a | Roczna zdrowotna za 2027 r., ryczałt | składka za rok, różnica, termin | 5.7 |
| G27b | Roczna zdrowotna za 2027 r., liniowy | składka za rok, różnica, termin | 5.7 |
| G28 | Złe długi: wierzyciel i dłużnik | korekty JPK_V7M, skutek w zaliczce PIT | 3.5 |
| G29 | Faktura w EUR z zaliczką | VAT w zł, przychód w KPiR, różnice kursowe | 2.1, 3.6 |
| G30 | Faktura do paragonu | ewidencja i deklaracja JPK_V7M, przychód w KPiR | 1.2 |

### G15. VAT kwartalny (JPK_V7K) z korektą w drugim miesiącu kwartału

**Założenia**

- Czynny podatnik VAT, mały podatnik, rozliczenie VAT kwartalne (JPK_V7K) od I kwartału 2027 r. Zawiadomienie o wyborze rozliczenia kwartalnego złożone w terminie, rejestracja VAT sprzed lat. Forma opodatkowania: skala (nie wpływa na VAT).
- Sprzedaż krajowa 23 % i zakupy krajowe z odliczeniem 100 % w każdym miesiącu. Kwoty netto, VAT 23 %.
- W lutym 2027 r. wystawiona korekta in minus do faktury sprzedaży z 20.01.2027 (obniżka ceny o 10 000,00 zł netto, VAT 2 300,00 zł). Dokumentacja uzgodnienia warunków korekty z nabywcą pochodzi z lutego 2027 r.
- Nadwyżka VAT z IV kwartału 2026 r. do przeniesienia: brak (0,00 zł).

**Pytania do księgowej**

1. W którym miesiącu kwartału ujmuje się korektę in minus (styczeń czy luty) przy dokumentacji uzgodnienia z lutego?
2. Czy korekta zmienia ewidencję za luty i za styczeń, czy tylko za jeden z nich?

**Dane**

| Miesiąc | Sprzedaż netto 23 % | Zakupy netto (odliczenie 100 %, VAT 23 %) | Korekta in minus (netto) |
|---|---|---|---|
| styczeń | 50 000,00 | 20 000,00 | brak |
| luty | 40 000,00 | 15 000,00 | 10 000,00 do faktury ze stycznia |
| marzec | 60 000,00 | 25 000,00 | brak |

**Wynik: ewidencja co miesiąc**

| Miesiąc | Sprzedaż netto | Podatek należny | Zakupy netto | Podatek naliczony |
|---|---|---|---|---|
| styczeń |   |   |   |   |
| luty |   |   |   |   |
| marzec |   |   |   |   |

**Wynik: deklaracja za I kwartał 2027 r. (JPK_V7K, część deklaracyjna)**

| Okres | P_38 | P_39 | P_48 | P_51 | P_62 |
|---|---|---|---|---|---|
| I kwartał 2027 |   |   |   |   |   |

**Wynik: terminy**

| Obowiązek za I kwartał 2027 r. | Termin |
|---|---|
| JPK_V7K (ewidencja i deklaracja) |   |
| Wpłata VAT |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G16. Zaliczki kwartalne: skala (G16a) i ryczałt 12 % (G16b)

#### G16a. Skala, zaliczki kwartalne przez cały 2027 r.

**Założenia**

- Skala podatkowa, mały podatnik, wpłata zaliczek na PIT kwartalnie przez cały 2027 r. (wybór złożony w terminie). Zwolnienie podmiotowe z VAT, rozliczenie VAT nie wchodzi do przypadku.
- ZUS pełny w 2026 i 2027 r., chorobowe: nie. Składki płacone w następnym miesiącu, w kwocie z obliczeń.
- W każdym miesiącu 2026 r.: przychód 15 000,00 zł, koszty w KPiR 5 000,00 zł. Kwoty 2027 r. w tabeli.
- Kolumna „Koszty w KPiR” nie zawiera Funduszu Pracy i Funduszu Solidarnościowego (część 1, sekcja 3 pkt 5).

**Dane**

| Miesiąc | Przychód | Koszty w KPiR | Etap ZUS | Zapłacone składki za |
|---|---|---|---|---|
| grudzień 2026 | 15 000,00 | 5 000,00 | pełny | listopad 2026 |
| styczeń | 18 000,00 | 5 000,00 | pełny | grudzień 2026 |
| luty | 20 000,00 | 6 000,00 | pełny | styczeń |
| marzec | 22 000,00 | 7 000,00 | pełny | luty |
| kwiecień | 20 000,00 | 6 000,00 | pełny | marzec |
| maj | 24 000,00 | 6 000,00 | pełny | kwiecień |
| czerwiec | 24 000,00 | 8 000,00 | pełny | maj |
| lipiec | 22 000,00 | 6 000,00 | pełny | czerwiec |
| sierpień | 18 000,00 | 5 000,00 | pełny | lipiec |
| wrzesień | 20 000,00 | 6 000,00 | pełny | sierpień |
| październik | 26 000,00 | 7 000,00 | pełny | wrzesień |
| listopad | 26 000,00 | 8 000,00 | pełny | październik |
| grudzień | 28 000,00 | 8 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |   |   |   |   |   |   |   |
| styczeń |   |   |   |   |   |   |   |
| luty |   |   |   |   |   |   |   |
| marzec |   |   |   |   |   |   |   |
| kwiecień |   |   |   |   |   |   |   |
| maj |   |   |   |   |   |   |   |
| czerwiec |   |   |   |   |   |   |   |
| lipiec |   |   |   |   |   |   |   |
| sierpień |   |   |   |   |   |   |   |
| wrzesień |   |   |   |   |   |   |   |
| październik |   |   |   |   |   |   |   |
| listopad |   |   |   |   |   |   |   |
| grudzień |   |   |   |   |   |   |   |

**Wynik: składka zdrowotna**

| Miesiąc | Podstawa | Składka |
|---|---|---|
| grudzień 2026 |   |   |
| styczeń |   |   |
| luty |   |   |
| marzec |   |   |
| kwiecień |   |   |
| maj |   |   |
| czerwiec |   |   |
| lipiec |   |   |
| sierpień |   |   |
| wrzesień |   |   |
| październik |   |   |
| listopad |   |   |
| grudzień |   |   |

**Wynik: zaliczka PIT za kwartały, kolumny narastająco od 1 stycznia 2027 r.**

| Kwartał | Przychód narastająco | Koszty narastająco | Dochód narastająco | Społeczne odliczone narastająco | Podstawa narastająco | Podatek narastająco | Zaliczka do zapłaty | Termin zapłaty |
|---|---|---|---|---|---|---|---|---|
| I kwartał |   |   |   |   |   |   |   |   |
| II kwartał |   |   |   |   |   |   |   |   |
| III kwartał |   |   |   |   |   |   |   |   |
| IV kwartał |   |   |   |   |   |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

#### G16b. Ryczałt 12 % kwartalny, przychód 2026 r. poniżej limitu

**Założenia**

- Ryczałt 12 % dla całego przychodu, zwolnienie podmiotowe z VAT, ryczałt płacony kwartalnie przez cały 2027 r. Przychód 2026 r. (96 000,00 zł) poniżej limitu uprawniającego do rozliczeń kwartalnych.
- ZUS pełny w 2026 i 2027 r., chorobowe: nie. Składki płacone w następnym miesiącu, w kwocie z obliczeń.
- W każdym miesiącu 2026 r.: przychód 8 000,00 zł. Kwoty 2027 r. w tabeli. Odliczenia składek jak w części 1 (sekcja 3 pkt 5), ale ryczałt płaci się za kwartał, więc odliczenia podaje się za kwartał.

**Dane**

| Miesiąc | Przychód 12 % | Etap ZUS | Zapłacone składki za |
|---|---|---|---|
| grudzień 2026 | 8 000,00 | pełny | listopad 2026 |
| styczeń | 8 000,00 | pełny | grudzień 2026 |
| luty | 9 000,00 | pełny | styczeń |
| marzec | 10 000,00 | pełny | luty |
| kwiecień | 8 000,00 | pełny | marzec |
| maj | 9 000,00 | pełny | kwiecień |
| czerwiec | 10 000,00 | pełny | maj |
| lipiec | 8 000,00 | pełny | czerwiec |
| sierpień | 9 000,00 | pełny | lipiec |
| wrzesień | 10 000,00 | pełny | sierpień |
| październik | 10 000,00 | pełny | wrzesień |
| listopad | 11 000,00 | pełny | październik |
| grudzień | 12 000,00 | pełny | listopad |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| grudzień 2026 |   |   |   |   |   |   |   |
| styczeń |   |   |   |   |   |   |   |
| luty |   |   |   |   |   |   |   |
| marzec |   |   |   |   |   |   |   |
| kwiecień |   |   |   |   |   |   |   |
| maj |   |   |   |   |   |   |   |
| czerwiec |   |   |   |   |   |   |   |
| lipiec |   |   |   |   |   |   |   |
| sierpień |   |   |   |   |   |   |   |
| wrzesień |   |   |   |   |   |   |   |
| październik |   |   |   |   |   |   |   |
| listopad |   |   |   |   |   |   |   |
| grudzień |   |   |   |   |   |   |   |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| grudzień 2026 |   |   |   |   |
| styczeń |   |   |   |   |
| luty |   |   |   |   |
| marzec |   |   |   |   |
| kwiecień |   |   |   |   |
| maj |   |   |   |   |
| czerwiec |   |   |   |   |
| lipiec |   |   |   |   |
| sierpień |   |   |   |   |
| wrzesień |   |   |   |   |
| październik |   |   |   |   |
| listopad |   |   |   |   |
| grudzień |   |   |   |   |

**Wynik: ryczałt, odliczenia za kwartał**

| Kwartał | Społeczne zapłacone w kwartale | 50 % zapłaconej zdrowotnej | Nadwyżka z poprzednich kwartałów | Odliczono w kwartale | Nadwyżka na kolejne kwartały |
|---|---|---|---|---|---|
| I kwartał |   |   |   |   |   |
| II kwartał |   |   |   |   |   |
| III kwartał |   |   |   |   |   |
| IV kwartał |   |   |   |   |   |

**Wynik: ryczałt za kwartał**

| Kwartał | Przychód 12 % | Podstawa 12 % | Ryczałt do zapłaty | Termin zapłaty |
|---|---|---|---|---|
| I kwartał |   |   |   |   |
| II kwartał |   |   |   |   |
| III kwartał |   |   |   |   |
| IV kwartał |   |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G17. Kasowy PIT, skala

**Założenia**

- Skala podatkowa i zwolnienie podmiotowe z VAT (kwoty z tabel są kwotami przychodu i kosztów). Rozliczenie miesięczne (zaliczki PIT miesięczne).
- Metoda kasowa od 1 stycznia 2026 r., oświadczenie o wyborze złożone w terminie. Przychód w 2025 r. poniżej 2 mln zł.
- Przychód i koszty ujmowane są wg dat zapłaty z tabel, nie wg dat wystawienia faktur.
- Faktura z 15.11.2025 na 18 000,00 zł została wystawiona w 2025 r., przychód z niej ujęto wtedy według zasad obowiązujących przed zmianą metody. Do 31.12.2027 nie zapłacono jej wcale.
- Składki społeczne zapłacone w każdym miesiącu 2027 r. (kwota podana, nie liczymy jej): 1 500,00 zł, odliczane w miesiącu zapłaty. Fundusz Pracy pomijamy.

**Pytania do księgowej**

1. Czy i w jakim miesiącu faktura z 15.11.2025 (niezapłacona do końca 2027 r.) wpływa na przychód albo zaliczki w 2027 r.?
2. Jak ujmować przychód z faktury zapłaconej częściowo: w kwotach zapłat czy w kwocie całej faktury od pierwszej zapłaty?

**Dane: faktury sprzedaży**

| Faktura | Wystawiona | Kwota | Zapłata |
|---|---|---|---|
| F1 | 10.03.2027 | 20 000,00 | 25.03.2027, całość |
| F2 | 25.03.2027 | 15 000,00 | 10.04.2027, całość |
| F3 | 20.05.2027 | 30 000,00 | częściowa: 12 000,00 w dniu 10.06.2027 i 18 000,00 w dniu 14.08.2027 |
| F4 | 12.07.2027 | 10 000,00 | 12.07.2027, całość |
| F5 | 28.10.2027 | 25 000,00 | 15.12.2027, całość |
| F6 (z 2025 r.) | 15.11.2025 | 18 000,00 | niezapłacona do 31.12.2027 |

**Dane: koszty**

| Dokument | Data | Kwota | Zapłata |
|---|---|---|---|
| K1 | 28.02.2027 | 4 000,00 | 05.03.2027 |
| K2 | 15.03.2027 | 6 000,00 | 20.05.2027 |
| K3 | 10.07.2027 | 3 000,00 | 10.07.2027 |
| K4 | 18.09.2027 | 2 500,00 | 30.10.2027 |

**Wynik: przychód, koszty i zaliczka PIT w każdym miesiącu 2027 r.**

| Miesiąc | Przychód w miesiącu | Koszty w miesiącu | Przychód narastająco | Koszty narastająco | Dochód narastająco | Społeczne odliczone narastająco | Podstawa narastająco | Podatek narastająco | Zaliczka do zapłaty |
|---|---|---|---|---|---|---|---|---|---|
| styczeń |   |   |   |   |   |   |   |   |   |
| luty |   |   |   |   |   |   |   |   |   |
| marzec |   |   |   |   |   |   |   |   |   |
| kwiecień |   |   |   |   |   |   |   |   |   |
| maj |   |   |   |   |   |   |   |   |   |
| czerwiec |   |   |   |   |   |   |   |   |   |
| lipiec |   |   |   |   |   |   |   |   |   |
| sierpień |   |   |   |   |   |   |   |   |   |
| wrzesień |   |   |   |   |   |   |   |   |   |
| październik |   |   |   |   |   |   |   |   |   |
| listopad |   |   |   |   |   |   |   |   |   |
| grudzień |   |   |   |   |   |   |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G18. Mały ZUS Plus w 2027 r.: skala (G18a) i ryczałt (G18b)

#### G18a. Skala

**Założenia**

- Skala podatkowa, zwolnienie podmiotowe z VAT. Działalność przez cały 2026 r., w 2026 r. pełny ZUS.
- W 2026 r.: przychód 96 000,00 zł, koszty 36 000,00 zł, dochód 60 000,00 zł (cały rok, z pełnych 12 miesięcy), czyli przychód do 120 000,00 zł.
- Zgłoszenie do Małego ZUS Plus złożone do 31.01.2027, wcześniej z niego nie korzystał. Chorobowe: nie. Składka wypadkowa jak w części 1.
- Wyniki za każdy miesiąc 2027 r.

**Pytania do księgowej**

1. Jak liczy się podstawę wymiaru z dochodu: czy trzeba uwzględnić składki odliczone w 2026 r. i zaokrąglenie podstawy?
2. Czy dolna granica podstawy wynika z płacy minimalnej 2027 r. i czy działa tu zmiana parametrów w kwietniu 2027 r. (składka wypadkowa)?

**Dane**

| Pozycja | Kwota |
|---|---|
| Przychód 2026 | 96 000,00 |
| Koszty 2026 | 36 000,00 |
| Dochód 2026 | 60 000,00 |
| Miesiące działalności w 2026 r. | 12 |

**Wynik: składki społeczne w każdym miesiącu 2027 r.**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| styczeń |   |   |   |   |   |   |   |
| luty |   |   |   |   |   |   |   |
| marzec |   |   |   |   |   |   |   |
| kwiecień |   |   |   |   |   |   |   |
| maj |   |   |   |   |   |   |   |
| czerwiec |   |   |   |   |   |   |   |
| lipiec |   |   |   |   |   |   |   |
| sierpień |   |   |   |   |   |   |   |
| wrzesień |   |   |   |   |   |   |   |
| październik |   |   |   |   |   |   |   |
| listopad |   |   |   |   |   |   |   |
| grudzień |   |   |   |   |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

#### G18b. Ryczałt

**Założenia**

- Ryczałt 12 % (dla całego przychodu), zwolnienie podmiotowe z VAT. Działalność przez cały 2026 r., pełny ZUS w 2026 r.
- W 2026 r.: przychód 96 000,00 zł (cały rok, z pełnych 12 miesięcy), czyli poniżej limitu 120 000,00 zł. Koszty nie obowiązują przy ryczałcie.
- Zgłoszenie do Małego ZUS Plus złożone do 31.01.2027, wcześniej z niego nie korzystał. Chorobowe: nie.
- Wyniki za każdy miesiąc 2027 r.

**Pytania do księgowej**

1. Jak ustala się podstawę z przychodu przy ryczałcie (dochód z ryczałtu, odliczenia składek, koszty)?

**Dane**

| Pozycja | Kwota |
|---|---|
| Przychód 2026 | 96 000,00 |
| Miesiące działalności w 2026 r. | 12 |

**Wynik: składki społeczne w każdym miesiącu 2027 r.**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| styczeń |   |   |   |   |   |   |   |
| luty |   |   |   |   |   |   |   |
| marzec |   |   |   |   |   |   |   |
| kwiecień |   |   |   |   |   |   |   |
| maj |   |   |   |   |   |   |   |
| czerwiec |   |   |   |   |   |   |   |
| lipiec |   |   |   |   |   |   |   |
| sierpień |   |   |   |   |   |   |   |
| wrzesień |   |   |   |   |   |   |   |
| październik |   |   |   |   |   |   |   |
| listopad |   |   |   |   |   |   |   |
| grudzień |   |   |   |   |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G19. Wakacje składkowe w lipcu 2027 r.

**Założenia**

- Ryczałt 12 % (usługi), zwolnienie podmiotowe z VAT, rozliczenie miesięczne. Jedna osoba bez pracowników, ZUS pełny, dobrowolne chorobowe: tak.
- Wniosek RWS o zwolnienie ze składek za lipiec 2027 r. złożony w czerwcu 2027 r. przez PUE. Warunki spełnione: płatnik zgłasza do 10 ubezpieczonych, przychód w poprzednim roku poniżej 2 mln euro, spełnione pozostałe wymogi.
- W lipcu 2027 r. 10 dni zwolnienia lekarskiego (od 5.07 do 14.07.2027).
- Przychód w każdym miesiącu od stycznia do sierpnia 2027 r.: 20 000,00 zł. Składki płacone w następnym miesiącu.

**Pytania do księgowej**

1. Czy zwolnienie z wakacji składkowych obejmuje także dobrowolną składkę chorobową oraz Fundusz Pracy i Fundusz Solidarnościowy?
2. Jak wpływa 10 dni zwolnienia lekarskiego w lipcu na podstawę chorobowej i na DRA?
3. Czy za lipiec trzeba złożyć DRA mimo zwolnienia ze składek?

**Dane**

| Miesiąc | Przychód 12 % | Etap ZUS | Uwagi |
|---|---|---|---|
| styczeń | 20 000,00 | pełny | brak |
| luty | 20 000,00 | pełny | brak |
| marzec | 20 000,00 | pełny | brak |
| kwiecień | 20 000,00 | pełny | brak |
| maj | 20 000,00 | pełny | brak |
| czerwiec | 20 000,00 | pełny | brak |
| lipiec | 20 000,00 | pełny | RWS: zwolnienie ze składek, 10 dni zwolnienia lekarskiego |
| sierpień | 20 000,00 | pełny | brak |

**Wynik: składki społeczne**

| Miesiąc | Podstawa | Emerytalna | Rentowe | Chorobowa | Wypadkowa | Razem bez FP | FP i FS |
|---|---|---|---|---|---|---|---|
| czerwiec |   |   |   |   |   |   |   |
| lipiec |   |   |   |   |   |   |   |
| sierpień |   |   |   |   |   |   |   |

**Wynik: składka zdrowotna**

| Miesiąc | Przychód narastająco | Próg | Podstawa | Składka |
|---|---|---|---|---|
| czerwiec |   |   |   |   |
| lipiec |   |   |   |   |
| sierpień |   |   |   |   |

**Wynik: DRA i terminy**

| Za miesiąc | Termin zapłaty składek | DRA do złożenia (tak/nie) | Termin DRA |
|---|---|---|---|
| czerwiec |   |   |   |
| lipiec |   |   |   |
| sierpień |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G20. Import usług: czynny VAT (G20a) i zwolniony z VAT (G20b)

**Założenia**

- Dwie usługi nabyte w marcu 2027 r.: usługa reklamowa od firmy z Niemiec za 1 000 EUR (usługa wykonana 10.03.2027, faktura z 12.03.2027) i licencja od firmy z USA za 500 USD (faktura z 18.03.2027, bez podatku, kontrahent nie jest zarejestrowany w Polsce).
- Kursy przyjęte w przykładzie (nie są kursami NBP): 1 EUR = 4,3000 zł, 1 USD = 4,0000 zł, jeden kurs dla każdej waluty dla całego przypadku.
- Obie usługi są kosztami firmy w KPiR. Forma opodatkowania: skala.

**Dane (obie części)**

| Usługa | Kontrahent | Kwota w walucie | Data faktury | Kurs przyjęty |
|---|---|---|---|---|
| Reklama | firma z Niemiec | 1 000 EUR | 12.03.2027 | 4,3000 |
| Licencja | firma z USA | 500 USD | 18.03.2027 | 4,0000 |

#### G20a. Czynny podatnik VAT

**Założenia**

- Czynny podatnik VAT, rozliczenie miesięczne (JPK_V7M). Poza importem w marcu 2027 r.: sprzedaż krajowa 50 000,00 zł netto (VAT 23 %) i zakupy krajowe 10 000,00 zł netto (VAT 23 %, odliczenie 100 %). Nadwyżka z lutego: brak.
- Obie usługi są związane ze sprzedażą opodatkowaną, odliczenie 100 %.

**Pytania do księgowej**

1. Czy VAT-UE składa się za nabyte usługi od kontrahenta z Niemiec, a jeśli tak, w którym miesiącu?
2. Czy firma musi być zarejestrowana jako podatnik VAT UE, aby takie nabycie obsługiwać, i czy zawiadomienie (aktualizacja VAT-R) jest potrzebne?

**Wynik: wiersze ewidencji JPK_V7M za marzec 2027 r.**

| Dokument | Oznaczenie | Pole podstawy | Podstawa w zł | Pole podatku należnego | Podatek należny w zł | Pole podatku naliczonego | Podatek naliczony w zł |
|---|---|---|---|---|---|---|---|
| Reklama (Niemcy) |   |   |   |   |   |   |   |
| Licencja (USA) |   |   |   |   |   |   |   |

**Wynik: deklaracja JPK_V7M za marzec 2027 r.**

| Okres | P_38 | P_39 | P_48 | P_51 | P_62 |
|---|---|---|---|---|---|
| marzec 2027 |   |   |   |   |   |

**Wynik: VAT-UE, rejestracja i terminy**

| Pozycja | Wpis |
|---|---|
| VAT-UE za marzec: czy składać (tak/nie), pozycja i kwota |   |
| Czy potrzebna rejestracja VAT-UE (tak/nie) i kiedy |   |
| Termin JPK_V7M i zapłaty VAT za marzec |   |
| Termin VAT-UE (jeśli składać) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

#### G20b. Podatnik zwolniony z VAT (art. 113)

**Założenia**

- Zwolnienie podmiotowe z VAT (art. 113), rozliczenie miesięczne, brak zarejestrowania jako podatnik VAT czynny. Poza importem w marcu 2027 r. brak innych transakcji z zagranicą.
- Ta sama sytuacja co w G20a: reklama od firmy z Niemiec 1 000 EUR i licencja od firmy z USA 500 USD, te same kursy przyjęte.

**Pytania do księgowej**

1. Który dokument obowiązuje przy imporcie usług u zwolnionego: VAT-8 czy VAT-9M, i za jaki okres?
2. Czy potrzebna jest rejestracja VAT-UE albo VAT-R przed złożeniem informacji lub deklaracji?

**Wynik: deklaracja i kwoty**

| Pozycja | Wpis |
|---|---|
| Rodzaj deklaracji (VAT-8 albo VAT-9M), do rozstrzygnięcia przez księgową |   |
| Reklama (Niemcy): podstawa w zł |   |
| Reklama (Niemcy): podatek należny w zł |   |
| Licencja (USA): podstawa w zł |   |
| Licencja (USA): podatek należny w zł |   |
| Razem podatek do wpłaty w zł |   |
| Termin złożenia deklaracji i zapłaty |   |
| VAT-UE: czy składać (tak/nie), kwoty |   |
| Czy potrzebna rejestracja VAT-UE (tak/nie) |   |
| Termin VAT-UE (jeśli składać) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G21. WDT i eksport

**Założenia**

- Czynny podatnik VAT, rozliczenie miesięczne (JPK_V7M). Skala. Poza opisanymi transakcjami w marcu, kwietniu i maju 2027 r. brak innej sprzedaży i zakupów.
- WDT do firmy z Czech (numer VAT-UE kontrahenta sprawdzony w VIES, fikcyjny numer CZ12345678) za 10 000 EUR: dostawa 10.03.2027, faktura 15.03.2027, dowód dostawy otrzymany 10.05.2027.
- Eksport do Norwegii za 5 000 EUR: wywóz towaru 20.03.2027, faktura 21.03.2027, potwierdzenie wywozu (komunikat IE-599) otrzymane 15.04.2027.
- Kursy przyjęte w przykładzie (nie są kursami NBP): WDT 1 EUR = 4,3000 zł, eksport 1 EUR = 4,3200 zł.

**Pytania do księgowej**

1. Czy WDT w marcu ujmuje się pierwotnie ze stawką 0 % i dopiero potem poprawia, jeśli dowód nie jest jeszcze w ręku w terminie JPK za marzec (25.04.2027)? W którym miesiącu pojawia się korekta?
2. W którym miesiącu ujmuje się eksport, skoro potwierdzenie wywozu przychodzi dopiero w kwietniu?

**Dane**

| Transakcja | Wartość w EUR | Kurs przyjęty | Data wywozu albo dostawy | Faktura | Dowód albo potwierdzenie |
|---|---|---|---|---|---|
| WDT do Czech | 10 000 | 4,3000 | 10.03.2027 | 15.03.2027 | 10.05.2027 |
| Eksport do Norwegii | 5 000 | 4,3200 | 20.03.2027 | 21.03.2027 | 15.04.2027 |

**Wynik: pola JPK_V7M: wiersze i kwoty w złotych (podstawa opodatkowania, podatek)**

| Miesiąc | Transakcja | Pole | Kwota w zł | Stawka |
|---|---|---|---|---|
| marzec | WDT |   |   |   |
| marzec | eksport |   |   |   |
| kwiecień | WDT |   |   |   |
| kwiecień | eksport |   |   |   |
| maj | WDT |   |   |   |
| maj | eksport |   |   |   |

**Wynik: deklaracja JPK_V7M, część deklaracyjna**

| Okres | P_38 | P_39 | P_48 | P_51 | P_62 |
|---|---|---|---|---|---|
| marzec 2027 |   |   |   |   |   |
| kwiecień 2027 |   |   |   |   |   |
| maj 2027 |   |   |   |   |   |

**Wynik: VAT-UE za marzec 2027 r.**

| Pozycja | Wpis |
|---|---|
| Czy składać VAT-UE za marzec (tak/nie) |   |
| Kod kraju i numer kontrahenta |   |
| Wartość WDT w zł |   |
| Termin złożenia |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G22. Samochód osobowy w leasingu operacyjnym od 1.02.2027

**Założenia**

- Skala, czynny podatnik VAT, rozliczenie miesięczne. Leasing operacyjny od 1.02.2027 r., 36 miesięcy rat, samochód osobowy o wartości 180 000,00 zł netto, emisja CO2 140 g/km (powyżej 50 g/km, czyli limit wartości jak w tabeli parametrów).
- Samochód używany także prywatnie (użytek mieszany). Podatnik nie składa VAT-26 i nie prowadzi ewidencji przebiegu.
- Raty leasingu płatne w miesiącu: część kapitałowa 3 600,00 zł netto i część odsetkowa 900,00 zł netto, VAT 23 % od sumy (1 035,00 zł).
- Paliwo co miesiąc od lutego do grudnia: 1 000,00 zł netto, VAT 230,00 zł. Ubezpieczenie AC opłacone w lutym 2027 r. na 12 miesięcy: 3 600,00 zł (ubezpieczenie nie ma VAT). Naprawa w czerwcu 2027 r.: 2 000,00 zł netto, VAT 460,00 zł.
- Wszystkie wydatki udokumentowane fakturami z miesiąca zapłaty. Opłata wstępna: brak.

**Pytania do księgowej**

1. Czy ubezpieczenie AC zapłacone za 12 miesięcy w lutym rozlicza się w kosztach jednorazowo, czy w czasie?
2. Jak liczy się koszt raty przy użytku mieszanym: stosunek limitu do wartości (część kapitałowa) i 75 % dla pozostałych kosztów?

**Dane**

| Miesiąc | Rata kapitałowa netto | Rata odsetkowa netto | VAT od raty | Paliwo netto | VAT od paliwa | Inne wydatki |
|---|---|---|---|---|---|---|
| luty | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | AC 3 600,00, bez VAT |
| marzec | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| kwiecień | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| maj | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| czerwiec | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | naprawa 2 000,00 netto, VAT 460,00 |
| lipiec | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| sierpień | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| wrzesień | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| październik | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| listopad | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |
| grudzień | 3 600,00 | 900,00 | 1 035,00 | 1 000,00 | 230,00 | brak |

**Wynik: VAT do odliczenia i koszt w KPiR**

| Miesiąc | VAT do odliczenia razem | Koszt: część kapitałowa | Koszt: część odsetkowa | Koszt: paliwo | Koszt: ubezpieczenie | Koszt: naprawa | Razem koszt w KPiR |
|---|---|---|---|---|---|---|---|
| luty |   |   |   |   |   |   |   |
| marzec |   |   |   |   |   |   |   |
| kwiecień |   |   |   |   |   |   |   |
| maj |   |   |   |   |   |   |   |
| czerwiec |   |   |   |   |   |   |   |
| lipiec |   |   |   |   |   |   |   |
| sierpień |   |   |   |   |   |   |   |
| wrzesień |   |   |   |   |   |   |   |
| październik |   |   |   |   |   |   |   |
| listopad |   |   |   |   |   |   |   |
| grudzień |   |   |   |   |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G23. Środki trwałe: liniowa, degresywna, jednorazowa i sprzedaż

**Założenia**

- Skala, czynny podatnik VAT (odliczenie 100 %, kwoty netto), rozliczenie miesięczne. Rok 2027.
- Serwer: wartość początkowa 15 000,00 zł netto, przyjęty do używania 10.02.2027, amortyzacja liniowa (stawkę z KŚT ustala księgowa). Sprzedaż serwera 20.11.2027 za 9 000,00 zł netto.
- Maszyna A: 80 000,00 zł netto, przyjęta 3.03.2027, amortyzacja degresywna (stawkę z KŚT i współczynnik ustala księgowa).
- Maszyna B: 120 000,00 zł netto, fabrycznie nowa, przyjęta 5.04.2027, jednorazowa amortyzacja de minimis (mały podatnik). Z pomocy de minimis klient nie korzystał wcześniej.
- Laptop: 6 000,00 zł netto, kupiony 12.05.2027, poniżej granicy wartości środka trwałego. Klient wybiera ujęcie w kosztach jednorazowo w miesiącu zakupu.

**Pytania do księgowej**

1. Od którego miesiąca naliczać odpis (od miesiąca przyjęcia czy od następnego) i czy w miesiącu sprzedaży serwera nalicza się odpis?
2. Czy laptop o wartości poniżej granicy trzeba traktować jako środek trwały i co z ujęciem jednorazowym?
3. Jak liczy się odpisy degresywne w pierwszym roku i jaka jest wartość netto serwera w dniu sprzedaży?

**Wynik: odpisy w każdym miesiącu i koszt w KPiR**

| Miesiąc | Odpis: serwer | Odpis: maszyna A | Odpis: maszyna B | Laptop | Razem koszt w KPiR |
|---|---|---|---|---|---|
| styczeń |   |   |   |   |   |
| luty |   |   |   |   |   |
| marzec |   |   |   |   |   |
| kwiecień |   |   |   |   |   |
| maj |   |   |   |   |   |
| czerwiec |   |   |   |   |   |
| lipiec |   |   |   |   |   |
| sierpień |   |   |   |   |   |
| wrzesień |   |   |   |   |   |
| październik |   |   |   |   |   |
| listopad |   |   |   |   |   |
| grudzień |   |   |   |   |   |

**Wynik: skutek sprzedaży serwera**

| Pozycja | Kwota |
|---|---|
| Przychód ze sprzedaży serwera (miesiąc: listopad) |   |
| Wartość początkowa |   |
| Odpisy zrealizowane do dnia sprzedaży |   |
| Wartość netto w dniu sprzedaży |   |
| Koszt uzyskania przychodu ze sprzedaży |   |
| Skutek w KPiR (dochód albo strata ze sprzedaży) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G24. PIT-36 za 2027 r., skala

**Założenia**

- Skala podatkowa, rozliczenie roczne bez wspólnego rozliczenia (samotnie), jedno źródło przychodu: działalność. Zwolnienie podmiotowe z VAT.
- Przychód 260 000,00 zł, koszty 160 000,00 zł, dochód z działalności 100 000,00 zł (kwoty podane, nie liczymy ich).
- Składki społeczne zapłacone w 2027 r.: 18 000,00 zł, odliczane w roku zapłaty. Zdrowotna na skali nie jest odliczana.
- Strata z 2025 r. do odliczenia: 20 000,00 zł. Zaliczki PIT zapłacone w 2027 r.: 9 000,00 zł.
- Jedno dziecko wychowywane przez cały 2027 r., roczny dochód podatnika poniżej limitu uprawniającego do ulgi. Bez innych odliczeń.

**Pytania do księgowej**

1. W jakiej wysokości można odliczyć stratę z 2025 r. w 2027 r. (ograniczenia roczne)?
2. Jak liczy się podstawę opodatkowania po odliczeniach (zaokrąglenia do pełnych złotych)?

**Wynik: główne pola zeznania**

| Pole | Kwota |
|---|---|
| Dochód z działalności |   |
| Odliczone składki społeczne |   |
| Odliczona strata z 2025 r. |   |
| Podstawa obliczenia podatku (zaokrąglona) |   |
| Podatek według skali |   |
| Kwota zmniejszająca podatek |   |
| Podatek po zmniejszeniu |   |
| Ulga na dziecko |   |
| Podatek należny po ulgach |   |
| Zaliczki zapłacone |   |
| Do zapłaty albo zwrot (z oznaczeniem) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G25. PIT-36L za 2027 r., liniowy

**Założenia**

- Podatek liniowy 19 %, zwolnienie podmiotowe z VAT, rozliczenie roczne samotnie.
- Przychód 480 000,00 zł, koszty 240 000,00 zł, dochód 240 000,00 zł. Składki społeczne zapłacone w 2027 r.: 22 000,00 zł.
- Składka zdrowotna zapłacona co miesiąc w 2027 r. w kwocie 1 600,00 zł, razem 19 200,00 zł. Odliczenie do rocznego limitu z tabeli parametrów.
- Zaliczki PIT zapłacone w 2027 r.: 39 000,00 zł. Bez innych odliczeń i ulg.

**Pytania do księgowej**

1. Który limit odliczenia zdrowotnej obowiązuje za 2027 r. i czy zapłata za grudzień 2026 r. w styczniu 2027 r. wchodzi do roku?

**Dane**

| Miesiąc | Zdrowotna zapłacona |
|---|---|
| styczeń | 1 600,00 |
| luty | 1 600,00 |
| marzec | 1 600,00 |
| kwiecień | 1 600,00 |
| maj | 1 600,00 |
| czerwiec | 1 600,00 |
| lipiec | 1 600,00 |
| sierpień | 1 600,00 |
| wrzesień | 1 600,00 |
| październik | 1 600,00 |
| listopad | 1 600,00 |
| grudzień | 1 600,00 |

**Wynik: pola zeznania**

| Pole | Kwota |
|---|---|
| Dochód z działalności |   |
| Odliczone składki społeczne |   |
| Zdrowotna zapłacona razem |   |
| Limit odliczenia zdrowotnej |   |
| Odliczona zdrowotna (do limitu) |   |
| Podstawa obliczenia podatku (zaokrąglona) |   |
| Podatek 19 % |   |
| Zaliczki zapłacone |   |
| Do zapłaty albo zwrot (z oznaczeniem) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G26. PIT-28 za 2027 r.: działalność ze stawkami 12 % i 8,5 % oraz najem prywatny

**Założenia**

- Ryczałt od przychodów ewidencjonowanych, rozliczenie roczne PIT-28, zwolnienie podmiotowe z VAT. Ryczałt płacony miesięcznie i zapłacony w całości w 2027 r.
- Działalność: usługi opodatkowane stawką 12 % i usługi opodatkowane stawką 8,5 %. Dodatkowo najem prywatny lokalu mieszkalnego (stawka 8,5 % do progu z tabeli parametrów).
- Składki społeczne zapłacone w 2027 r.: 22 000,00 zł. Składka zdrowotna zapłacona w 2027 r.: 10 800,00 zł (50 % do odliczenia).
- Ryczałt zapłacony w 2027 r. (suma przelewów): 15 000,00 zł.

**Pytania do księgowej**

1. Jak rozdzielić odliczenia składek między stawki 12 % i 8,5 %?
2. Czy najem prywatny wchodzi do jednego PIT-28 razem z działalnością i jak wpływa na składki?

**Dane**

| Źródło | Stawka | Przychód w 2027 r. |
|---|---|---|
| Działalność, usługi | 12 % | 120 000,00 |
| Działalność, usługi | 8,5 % | 80 000,00 |
| Najem prywatny | 8,5 % | 60 000,00 |

**Wynik: pola zeznania**

| Pole | Kwota |
|---|---|
| Przychód 12 % |   |
| Przychód 8,5 % (działalność i najem) |   |
| Odliczone składki społeczne |   |
| Odliczona zdrowotna (50 %) |   |
| Podstawa 12 % |   |
| Podstawa 8,5 % |   |
| Ryczałt 12 % |   |
| Ryczałt 8,5 % |   |
| Ryczałt razem (zaokrąglony) |   |
| Ryczałt zapłacony |   |
| Dopłata albo nadpłata (z oznaczeniem) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G27. Roczne rozliczenie składki zdrowotnej za 2027 r.: ryczałt (G27a) i liniowy (G27b)

#### G27a. Ryczałt, próg 60 000 zł przekroczony we wrześniu

**Założenia**

- Ryczałt 12 % (usługi), zwolnienie podmiotowe z VAT, pełny ZUS, chorobowe: nie. Rok 2027.
- Przychód miesięczny w tabeli. Składka zdrowotna płacona co miesiąc w kwocie wynikającej z progu przychodu narastająco (część 1, sekcja 5). Zapłacone składki to dokładnie te kwoty; księgowa wylicza je według parametrów.

**Pytania do księgowej**

1. Czy dla ryczałtu w 2027 r. jest w ogóle roczne rozliczenie zdrowotnej i czy składka za rok wynika z progu rocznego, czy z sumy miesięcznych?

**Dane**

| Miesiąc | Przychód 12 % |
|---|---|
| styczeń | 7 000,00 |
| luty | 7 000,00 |
| marzec | 7 000,00 |
| kwiecień | 7 000,00 |
| maj | 7 000,00 |
| czerwiec | 7 000,00 |
| lipiec | 7 000,00 |
| sierpień | 7 000,00 |
| wrzesień | 8 000,00 |
| październik | 10 000,00 |
| listopad | 10 000,00 |
| grudzień | 10 000,00 |

**Wynik: składka miesięczna według progu**

| Miesiąc | Przychód narastająco | Próg | Składka należna za miesiąc | Składka zapłacona za miesiąc |
|---|---|---|---|---|
| styczeń |   |   |   |   |
| luty |   |   |   |   |
| marzec |   |   |   |   |
| kwiecień |   |   |   |   |
| maj |   |   |   |   |
| czerwiec |   |   |   |   |
| lipiec |   |   |   |   |
| sierpień |   |   |   |   |
| wrzesień |   |   |   |   |
| październik |   |   |   |   |
| listopad |   |   |   |   |
| grudzień |   |   |   |   |

**Wynik: roczne rozliczenie**

| Pozycja | Wpis |
|---|---|
| Składka należna za rok |   |
| Składka zapłacona za rok |   |
| Różnica (dopłata albo nadpłata, z oznaczeniem) |   |
| Termin rozliczenia |   |
| Dokument rozliczenia (nazwa, kto składa) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

#### G27b. Liniowy, dochód podany miesięcznie

**Założenia**

- Podatek liniowy 19 %, zwolnienie podmiotowe z VAT, pełny ZUS, chorobowe: nie. Rok 2027.
- Dochód miesięczny w tabeli. Zapłacona składka zdrowotna za każdy miesiąc jest podana w tabeli (kwoty podane, nie przeliczamy ich).

**Pytania do księgowej**

1. Jak liczy się składkę należną za rok (4,9 % dochodu rocznego, minimum roczne) i czy zapłacone składki z grudnia 2026 r. wchodzą do rozliczenia?

**Dane**

| Miesiąc | Dochód | Składka zdrowotna zapłacona |
|---|---|---|
| styczeń | 10 000,00 | 490,00 |
| luty | 10 000,00 | 490,00 |
| marzec | 12 000,00 | 490,00 |
| kwiecień | 12 000,00 | 588,00 |
| maj | 14 000,00 | 588,00 |
| czerwiec | 14 000,00 | 686,00 |
| lipiec | 16 000,00 | 686,00 |
| sierpień | 16 000,00 | 784,00 |
| wrzesień | 18 000,00 | 784,00 |
| październik | 18 000,00 | 882,00 |
| listopad | 20 000,00 | 882,00 |
| grudzień | 20 000,00 | 980,00 |

**Wynik: roczne rozliczenie**

| Pozycja | Wpis |
|---|---|
| Dochód roczny |   |
| Składka należna za rok (z uwzględnieniem minimum rocznego) |   |
| Składka zapłacona za rok |   |
| Różnica (dopłata albo nadpłata, z oznaczeniem) |   |
| Termin rozliczenia |   |
| Dokument rozliczenia (nazwa, kto składa) |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G28. Złe długi: wierzyciel i dłużnik

**Założenia**

- Wierzyciel: skala podatkowa, czynny podatnik VAT, rozliczenie miesięczne (JPK_V7M). Dłużnik: podatek liniowy, czynny podatnik VAT, rozliczenie miesięczne.
- Faktura wierzyciela z 10.01.2027 na 12 300,00 zł brutto (10 000,00 zł netto, VAT 23 %, 2 300,00 zł), termin zapłaty 31.01.2027. Dłużnik zaksięgował koszt (10 000,00 zł netto) i odliczył VAT (2 300,00 zł) w styczniu 2027 r.
- Częściowa zapłata 4 000,00 zł (brutto) w dniu 20.08.2027. Reszta (8 300,00 zł) niezapłacona do 31.12.2027.
- Obaj są podatnikami czynnymi na dzień dostawy i na dzień korekty, wierzytelność nie jest przedawniona, warunki ulgi na złe długi (w tym zawiadomienie dłużnika i brak postępowania upadłościowego) są spełnione.
- Skutek w zaliczce PIT: wierzyciel ma w 2027 r. dochód narastająco powyżej progu skali (zaliczki liczone po stawce wyższej), dłużnik liczy po 19 %. Poza tą fakturą zaliczek nie zmieniają inne zdarzenia.

**Pytania do księgowej**

1. W jakim miesiącu wierzyciel koryguje podstawę i podatek, skoro 90 dni od terminu płatności mija 1.05.2027, a częściowa zapłata jest w sierpniu?
2. Jaka kwota podlega korekcie po częściowej zapłacie i czy korekta dłużnika wynosi tyle samo?
3. Jaki skutek ma ulga w PIT: zmniejszenie przychodu wierzyciela i zwiększenie przychodu (albo korekta kosztu) dłużnika, w którym miesiącu?

**Wynik: wierzyciel: korekty JPK_V7M**

| Miesiąc | Pole | Podstawa w zł | Podatek w zł | Oznaczenie |
|---|---|---|---|---|
|   |   |   |   |   |
|   |   |   |   |   |
|   |   |   |   |   |

**Wynik: wierzyciel: skutek w zaliczce PIT**

| Miesiąc | Zmiana przychodu w KPiR | Zmiana zaliczki PIT |
|---|---|---|
|   |   |   |
|   |   |   |
|   |   |   |

**Wynik: dłużnik: korekty JPK_V7M**

| Miesiąc | Pole | Podstawa w zł | Podatek w zł | Oznaczenie |
|---|---|---|---|---|
|   |   |   |   |   |
|   |   |   |   |   |
|   |   |   |   |   |

**Wynik: dłużnik: skutek w zaliczce PIT**

| Miesiąc | Zmiana przychodu albo kosztów w KPiR | Zmiana zaliczki PIT |
|---|---|---|
|   |   |   |
|   |   |   |
|   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G29. Faktura w EUR z zaliczką

**Założenia**

- Podatek liniowy, czynny podatnik VAT, rozliczenie miesięczne. Kontrahent z Polski, sprzedaż towarów za 10 000 EUR netto, VAT 23 %, kwoty w EUR, rozliczenie w zł.
- Zaliczka 30 % wartości netto (3 000 EUR) otrzymana 10.03.2027, w tym dniu wystawiona faktura zaliczkowa.
- Dostawa i faktura końcowa 20.04.2027 na całą wartość z odliczeniem zaliczki. Zapłata reszty (7 000 EUR netto plus VAT od reszty) w dniu 15.05.2027.
- Kursy przyjęte w przykładzie (nie są kursami NBP): dla 10.03.2027 kurs z 9.03.2027 = 4,3000, dla 20.04.2027 kurs z 19.04.2027 = 4,2500, dla 15.05.2027 kurs z 14.05.2027 = 4,2000 (15.05.2027 to sobota, więc kurs z dnia poprzedniego).

**Pytania do księgowej**

1. Jakim kursem przelicza się przychód z zaliczki, z faktury końcowej i z zapłaty reszty w PIT, a jakim VAT?
2. Gdzie i w którym miesiącu ujmuje się różnice kursowe od zaliczki i od zapłaty reszty?

**Dane**

| Data kursu | Kurs 1 EUR w zł |
|---|---|
| 09.03.2027 | 4,3000 |
| 19.04.2027 | 4,2500 |
| 14.05.2027 | 4,2000 |

**Wynik: VAT w złotych na każdej fakturze**

| Faktura | Wartość netto w zł | VAT w zł | Brutto w zł | Odliczona zaliczka (netto, VAT) |
|---|---|---|---|---|
| Zaliczkowa (10.03.2027) |   |   |   | nie dotyczy |
| Końcowa (20.04.2027) |   |   |   |   |

**Wynik: przychód w KPiR**

| Miesiąc | Przychód w KPiR w zł | Podstawa (kurs i data) |
|---|---|---|
| marzec |   |   |
| kwiecień |   |   |
| maj |   |   |

**Wynik: różnice kursowe**

| Zdarzenie | Kwota różnicy w zł | Dodatnia czy ujemna | Miesiąc ujęcia |
|---|---|---|---|
| Zaliczka (rozliczenie z fakturą końcową) |   |   |   |
| Zapłata reszty 15.05.2027 |   |   |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

### G30. Faktura do paragonu

**Założenia**

- Skala, czynny podatnik VAT, rozliczenie miesięczne (JPK_V7M). Sklep z kasą rejestrującą. Sprzedaż 23 %.
- Sprzedaż w marcu 2027 r. z raportów kasy (suma): 123 000,00 zł brutto, czyli 100 000,00 zł netto i 23 000,00 zł VAT. Zakupy krajowe w marcu: 20 000,00 zł netto, VAT 4 600,00 zł, odliczenie 100 %. Nadwyżka z lutego: brak.
- W tej sumie jest paragon z 15.03.2027 na 1 230,00 zł brutto (1 000,00 zł netto, VAT 230,00 zł). Firma z NIP na paragonie poprosiła w dniu 10.04.2027 o fakturę do paragonu, wystawiona w KSeF 10.04.2027 (FP).
- W kwietniu 2027 r. poza FP: sprzedaż z raportów kasy 61 500,00 zł brutto (50 000,00 zł netto, VAT 11 500,00 zł), zakupy 10 000,00 zł netto, VAT 2 300,00 zł.

**Pytania do księgowej**

1. W którym miesiącu ujmuje się fakturę do paragonu w ewidencji (marzec czy kwiecień) i z jakim oznaczeniem, żeby nie podwoić sprzedaży?
2. Jak ujmować w KPiR przychód z paragonu i z faktury do paragonu, aby przychód nie powstał dwa razy?

**Dane**

| Miesiąc | Sprzedaż z kasy brutto | Zakupy netto (VAT 23 %) | Faktura do paragonu |
|---|---|---|---|
| marzec | 123 000,00 (w tym paragon 1 230,00) | 20 000,00 | brak |
| kwiecień | 61 500,00 | 10 000,00 | FP wystawiona 10.04.2027 do paragonu z 15.03.2027 na 1 230,00 brutto |

**Wynik: ewidencja JPK_V7M: wiersze za marzec i kwiecień 2027 r.**

| Miesiąc | Wiersz | Oznaczenie | Podstawa w zł | Podatek należny w zł |
|---|---|---|---|---|
| marzec | sprzedaż z raportów kasy |   |   |   |
| marzec | faktura do paragonu (jeśli ujęta) |   |   |   |
| kwiecień | sprzedaż z raportów kasy |   |   |   |
| kwiecień | faktura do paragonu (jeśli ujęta) |   |   |   |

**Wynik: deklaracja JPK_V7M**

| Miesiąc | P_38 | P_39 | P_48 | P_51 | P_62 |
|---|---|---|---|---|---|
| marzec |   |   |   |   |   |
| kwiecień |   |   |   |   |   |

**Wynik: przychód w KPiR**

| Miesiąc | Przychód w KPiR w zł |
|---|---|
| marzec |   |
| kwiecień |   |

**Podpis**

| Pole | Wpis |
|---|---|
| `policzyla`: imię i nazwisko osoby, która policzyła |   |
| `data`: dzień zakończenia obliczeń |   |
| `uwagi`: założenia, wątpliwości, podstawa prawna |   |

## 4. Przeniesienie wyniku do testów (dla zespołu FaktWay)

Obowiązuje część 7 z `docs/ksiegowosc/ZLOTE-PRZYPADKI.md`: pliki
`tests/fixtures/ksiegowosc/zlote/G<n>.json`, kwoty w groszach (pola `_gr`),
daty `RRRR-MM-DD`, słowniki, blok wyniku nieliczony przez przypadek ma wartość
`null`, a `policzyla`, `data` i `uwagi` przepisujemy z podpisu dosłownie.
Nazwy nowych bloków JSON (np. dla JPK_V7K, kasowego PIT, importu usług, zeznań
rocznych) ustala krok planu, który buduje dany silnik; do tego czasu przypadek
zostaje w arkuszu bez pliku testowego. Przypadek bez `policzyla` i `data` nie jest
złotym przypadkiem i nie trafia do testów jako złoty.
