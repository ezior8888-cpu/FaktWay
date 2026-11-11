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
i przypomnieniem, a plik JPK_V7M przed pobraniem i wysyłką. W module
księgowości blokują od razu (D-F7): pozycja, która nie przejdzie kontroli,
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
(pilnuje ich test filtra), plik z Centrum eksportu (`exports-generate.ts`)
oraz JPK_EWP i JPK_PKPIR (kolejne części F13).

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
   kwota do niego nie doszła. Wyjątek to JPK_V7M (punkt 4).
3. **Zakres.** Jedna firma czy wiele, jeden miesiąc czy kilka. Gdy błąd może
   dotyczyć liczb, których strażnik nie sprawdza (odliczenia w opisie pod
   kaflami, nadwyżka VAT na następny miesiąc), Bartosz decyduje
   o wyłączeniu: firma w `/admin/flags` (kolumna „Księgowość (pilotaż)”),
   cały moduł flagą `killKsiegowosc` w `global_feature_flags` (UPDATE jak
   `killFloAgent` w `flo-incident.md`).
4. **Termin przy JPK_V7M.** Odmowa pliku nie przesuwa terminu złożenia
   (25. dzień miesiąca po okresie, przesunięty na dzień roboczy). Klient wie
   z komunikatu, że może złożyć plik z księgową. Gdy naprawa nie zdąży przed
   terminem, Bartosz decyduje, czy uprzedzić firmy z tagu `tenantId`. Obejścia
   strażnika w aplikacji nie ma (pliku z alarmem nie da się pobrać ani
   wysłać), więc do naprawy wyjściem dla klienta jest plik od księgowej.
5. **Naprawa według protokołu z `AGENTS.md`:** najpierw czerwony test z tym
   samym przypadkiem (dane firmy tylko do odczytu, w teście fikcyjny NIP
   `1234567890`), potem naprawa silnika albo generatora pliku (przy JPK_V7M
   `lib/exports/jpk-v7m-generator.ts`) we wszystkich miejscach, osobny PR.
6. **Fałszywy alarm** (wynik był dobry, myli się strażnik): poprawka
   strażnika osobnym PR z testem i wzorcem z `docs/koordynacja/ZRODLA-PRAWDY.md`,
   za zgodą Bartosza. Do tego czasu klient widzi brak zamiast dobrej kwoty
   albo odmowę zamiast dobrego pliku: błąd bezpieczny, ale błąd.
