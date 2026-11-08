# Logo FaktWay: brief i koncepcje

Stan: 24.10.2026. **Wybrany kierunek: A „Przesunięcie”** (Bartosz, 24.10.2026). Zestaw logo i instrukcja: [README.md](README.md).

## Brief

| | |
|---|---|
| **W jednym zdaniu** | FaktWay wystawia i odbiera faktury przez KSeF za mikrofirmę i księgowego, bez urzędowego stresu. |
| **Odbiorcy** | mikroprzedsiębiorcy i biura rachunkowe w Polsce; spotykają znak w ikonie aplikacji (PWA), na stronie, w mailach i na PDF faktury |
| **Charakter** | pewny i spokojny, szybki i lekki |
| **Nie chcemy** | urzędowego chłodu, krzykliwości, efekciarstwa |
| **Obietnica** | faktura sama idzie prostą drogą do KSeF i z powrotem, a Ty masz spokój |
| **Typ znaku** | czysty znak abstrakcyjny + napis (wybór Bartosza); dla porównania jeden kierunek oparty na napisie |
| **Styl** | geometryczny minimalizm (Stripe, Linear, Vercel) |
| **Kolor** | niebieski aplikacji (`--primary` z `app/globals.css`); koncepcje najpierw w szarości |
| **Musi działać** | favicon 16 px, ikona PWA, nagłówek strony i aplikacji, nagłówek PDF faktury, maile, tryb ciemny, jeden kolor |
| **Kryteria sukcesu** | czytelny w 16 px; nie wygląda jak kartka z zagiętym rogiem ani „ptaszek”; da się opowiedzieć jednym zdaniem |
| **Decyduje** | Bartosz |

**Założenia (do poprawy):** nazwa zawsze „FaktWay”, bez hasła pod logo; stare zielone logo FaktFlow nie ma kapitału do zachowania; napis rysowany od zera z figur geometrycznych (brak licencji fontu do rozwiązania).

## Kategoria i klisze

Programy do faktur i księgowości (inFakt, Fakturownia, wFirma, iFirma) i szerzej fintech. Klisze, których unikamy: kartka z zagiętym rogiem, paragon z ząbkami, ptaszek „zatwierdzone”, strzałka w górę i wykres, tarcza i kłódka, moneta, znak procentu, litera F w zaokrąglonym kwadracie. Biblioteka wzorców (37 znaków z fintechu): dominuje koło i niebieski, często podział kolorem i przestrzeń negatywna.

## Mapa słów (skrót)

- **Fakt** → pewność, coś stałego, blok, zapis, „załatwione”
- **Way** → droga, pas ruchu, zakręt, kierunek, przejazd
- **spokojny, pewny** → poziom, równowaga, koło, symetria, porządek równoległych linii
- **szybki, lekki** → przesunięcie, pochylenie naprzód, jedna ciągła linia
- **KSeF** → wysyłasz i odbierasz: ruch w dwie strony

Przecięcia: całość, która się przesuwa (spokój + ruch); dwa równoległe pasy jednej drogi (porządek + kierunek); kreska, która łączy „Fakt” z „Way”.

## Lista koncepcji (runda 1)

Ocena 1-5: idea / wyróżnienie / prostota / związek z marką / 16 px.

| # | Koncepcja (jedno zdanie) | Ocena | Decyzja |
|---|---|---|---|
| 1 | **Przesunięcie:** koło przecięte na pół, połówki przesunięte w przeciwne strony: faktury wychodzą i wracają, a całość dalej się zgadza. | 5/4/5/4/5 | **A** |
| 2 | **Dwa pasy:** dwie równoległe drogi skręcające razem naprzód; przy okazji układają się w F. | 4/4/4/4/4 | **B** |
| 3 | **Złączenie:** w napisie poprzeczka „t” biegnie prosto w „W”, czyli Fakt przechodzi w Way. | 4/4/4/5/3 | **C** |
| 4 | Kwadrat przecięty schodkowym kanałem pod 45° (droga przez blok). | 3/2/4/3/4 | odpada: czyta się jak wykres w górę |
| 5 | Rzędy faktury ułożone schodkowo w strzałkę. | 3/2/4/3/3 | odpada: za blisko Retool, Flutter, Stencil |
| 6 | Kafel z kanałem w kształcie ćwiartki łuku (Truchet). | 3/3/4/3/3 | odpada: słaby w małym rozmiarze |
| 7 | Otwarty pierścień z kropką w przerwie. | 2/2/5/2/4 | odpada: czyta się jako litera C |
| 8 | Dwa bloki z zaokrąglonym czołem, drugi krok wyżej. | 3/2/5/3/4 | odpada: wykres wzrostu, klisza |
| 9 | Kwadrat z jednym zaokrąglonym rogiem natarcia. | 2/1/5/2/5 | odpada: litera D, bez własnego detalu |
| 10 | F jako droga: trzon skręca w górne ramię. | 3/1/4/3/4 | odpada: zwykłe F |
| 11 | Koło przecięte pionowo, połówki w górę i w dół. | 3/3/5/3/4 | odpada: czyta się „CD”, wariant 1 lepszy |

## Pliki rundy 1

- `koncepcje-runda1.png`: arkusz do oceny (znak duży, z napisem, 64/32/16 px)
- arkusz testów (`preview_sheet.py`): rozmiary, tła, jeden kolor, rozmycie, odbicie, kontekst ikony, półka z logo fintechu; nie trafia do repozytorium, bo zawiera cudze logo z biblioteki skilla (odtworzenie: `preview_sheet.py koncepcje/*-v4.svg --refs-industry payments-fintech`)
- `koncepcje/*-v4.svg`: aktualne wersje (v1-v3 zostają do porównania)

Testy wykonane: `svg_audit.py` (99-100/100, kąty W złapane na dokładne 15°), arkusz testów obejrzany w przeglądarce, porównanie z wzorcowymi znakami z biblioteki, powiększenia połączeń kresek w napisie (naprawiona szczelina między „t” a „W”).
