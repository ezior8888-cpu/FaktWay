# Zasady designu aplikacji FaktWay na telefon

> Obowiązuje każdego agenta (Claude, Codex) i każdy ekran aplikacji w `mobile/`.
> Plan prac: [`PLAN-APLIKACJA-MOBILNA.md`](../koordynacja/PLAN-APLIKACJA-MOBILNA.md).
> Wersja 3 z 12.11.2026 (decyzja D15: wykończenie jak Copilot, układ według D14).
> Wersja 2 z 10.11.2026 wprowadziła wygląd FaktWay zamiast „produktu Apple” (D12).
> Gdy projektant odda system (D6), jego decyzje nadpisują sekcje 3 i 4.

Ten plik dotyczy **aplikacji natywnej** (Expo, React Native). Nie dotyczy PWA
ani strony: tam obowiązują `components/ui` i zasady z `AGENTS.md`.

---

## 1. Zasada nadrzędna: marka FaktWay, wykończenie jak Copilot, zachowanie natywne

Aplikacja ma wyglądać jak FaktWay, a nie jak aplikacja zrobiona przez Apple
(Bartosz, 10.11.2026). Od 12.11.2026 wykończenie bierzemy z Copilota,
najładniejszej aplikacji finansowej w Mobbin (D15): ludzie mają chwalić design.
Prestiż bierze się z marki wspólnej z komputerem, wykończenia na poziomie
najlepszych aplikacji finansowych i płynności, którą daje system.

1. **Marka jak na stronie, wykończenie jak Copilot.** Ze strony (plan Finora,
   D2) bierzemy Outfit, paletę „Modern Minimal”, ikony Remix, plakietki
   statusów i wykresy w odcieniach niebieskiego. Z Copilota (D15): miękki
   gradient pod nagłówkiem, zaokrąglone karty bez obwódki, kolorowe kategorie,
   grosze w indeksie w dużych kwotach, liczby w Outfit. Wartości leżą w
   `mobile/src/wyglad/`; kolory marki pochodzą z `app/globals.css`, nowe
   (gradient, tło pod kartami, kategorie) opisuje sekcja 4.
2. **Zachowanie zostaje systemowe.** Stos ekranów z gestem wstecz, pasek
   zakładek, arkusze od dołu, menu i podgląd przy przytrzymaniu, arkusz akcji,
   kalendarz, przełącznik, klawiatura, wibracje. Tego nie rysujemy sami: to
   daje płynność.
3. **Komponenty strony przerabiamy, nie kopiujemy.** Kartę, kafel statystyki,
   plakietkę, zakładki sekcji czy wykres przenosimy z ich wyglądem, ale na
   telefon: większy cel dotyku, większy tekst, jedna kolumna. Nie przenosimy
   tabel szerokich jak ekran komputera ani świecących kul ze strony głównej;
   jedyny gradient to ten pod nagłówkiem (sekcja 4).
4. **Jeden ekran, jedno zadanie.** Telefon nie jest pomniejszonym pulpitem.
   Gdy ekran ma dwa równorzędne cele, dzielimy go na dwa ekrany.

## 2. Nawigacja

| Wzorzec | Jak | Nie |
|---|---|---|
| Główne sekcje | natywne zakładki (`expo-router/native-tabs`), 5 pozycji, ikony Remix z menu strony (kontur w spoczynku, wypełnienie po wybraniu), napisy w Outfit | własny pasek dolny, menu „hamburger” |
| Przejście w głąb | natywny stos: ekran wjeżdża z prawej, cofanie przeciągnięciem od lewej krawędzi działa zawsze | podmiana treści w miejscu, własny przycisk „wstecz” |
| Tytuł | duży tytuł w Outfit na ekranach zakładek, zwija się przy przewijaniu; mały w głębi. Pulpit ma zamiast tytułu pasek z logo FaktWay i awatarem. Na gradiencie tytuł, logo (wersja biała, `docs/brand/logo/zestaw/svg/faktway-logo-biale.svg`) i okrągłe przyciski paska są białe; po zwinięciu pasek wraca do zwykłych kolorów | tytuł w treści ekranu zamiast w pasku; przekolorowane logo podstawowe |
| Tworzenie i edycja | arkusz od dołu („Anuluj” po lewej, „Zapisz” albo „Wystaw” po prawej w pasku) | okno na środku ekranu |
| Wybór z kilku opcji | pole jak na stronie, lista w systemowym arkuszu akcji | własna rozwijana lista |
| Potwierdzenie usunięcia | systemowy arkusz akcji z czerwoną opcją | własne okno „Czy na pewno?” |
| Wyszukiwanie | pole wyszukiwania w pasku nawigacji listy | osobny ekran wyszukiwarki |
| Podzakładki sekcji | pigułki (`Segmenty`, wzór Revolut Business, D14): wybrana w kolorze marki, pozostałe białe, liczba przy pigułce („Po terminie 2”) | systemowy przełącznik segmentowy, zakładki z kreską |

Główna akcja sekcji ma jedno stałe miejsce: szeroki bloczek u góry listy, pod
podsumowaniem (decyzja D7, 09.11.2026: „Nowa faktura” w bloczku, nie plus w pasku).

**Główna akcja ekranu w treści, nie w dolnym pasku narzędzi.** W aplikacji z
zakładkami dolny pasek narzędzi chowa się pod paskiem zakładek (sprawdzone w M3).
Na listach i w formularzach to `PrzyciskGlowny`: pełne tło w kolorze marki,
rogi 16 pt, na całą szerokość; w formularzu wystawienia przypięty na dole obok
okrągłego „Podgląd” (wzór Revolut Business, D14). Przycisk główny jest jeden na
ekran. Na szczegółach dokumentu akcje stoją pod kwotą w rzędzie białych
pigułek z ikoną („Zapłacona”, „Wyślij”, „PDF”), reszta w menu „Więcej”.
Akcja drugorzędna w karcie (np. „Zatwierdź kategorie”) i cofnięcie mają
wariant tonalny: jasnoniebieskie tło, niebieski napis. Druga droga na tle
ekranu („Zaloguj przez Google”) to biały przycisk z cieniem karty (wariant
`karta`). Gdy akcja trwa (logowanie, wysyłka), przycisk pokazuje kółko
ładowania zamiast napisu i nie reaguje na kolejne dotknięcie.

Przyciski w pasku u góry (filtr, kalendarz, udostępnij, więcej) mają ikony
Remix z `wyglad/ikony-paska.ts`; pozycje menu systemowego zostają z ikonami
SF, bo menu iOS przyjmuje tylko je.

## 3. Typografia i odstępy

- **Outfit na wszystko, także liczby** (D15): kwoty, numery faktur, NIP-y,
  daty i procenty mają cyfry tabelaryczne (`fontVariant: ['tabular-nums']`;
  Outfit ma tę funkcję, sprawdzone 12.11), więc kolumny kwot się nie
  rozjeżdżają. IBM Plex Mono z wersji na komputer na telefonie nie występuje.
  Czcionka jest wbudowana w aplikację (`app.json`, plugin `expo-font`, pliki
  w `mobile/assets/fonts/` z licencją OFL). Wagę wybiera się plikiem
  (`czcionka()` w `typografia.ts`), nie `fontWeight`.
- **Tylko style ze skali** w `mobile/src/wyglad/typografia.ts` (od Large Title
  30 do Caption 11). Nie wpisujesz rozmiarów spoza skali.
- **Dynamic Type obowiązkowo.** Każdy ekran działa przy największym tekście
  z ustawień dostępności: tekst się zawija, nic się nie ucina, układ może przejść
  z poziomego w pionowy (wiersze, kafle po jednym w rzędzie).
- **Kwoty** w listach wyrównane do prawej, format z `lib/format`
  („1 234,56 zł”, twarda spacja przed „zł”).
- **Duże kwoty** (nagłówek ekranu, suma „Do zapłaty”, szczegół dokumentu,
  podsumowanie) mają grosze w indeksie górnym, o połowę mniejsze i bez
  przecinka: „23 280⁰⁰ zł” (D15). Czytnik ekranu dostaje pełną kwotę w
  `accessibilityLabel`. W wierszach list i w polach grosze zostają po przecinku.
- **Odstępy ze skali 4, 8, 12, 16, 20, 24, 32** (plus 2 tylko między liniami
  tekstu w jednym wierszu listy). Margines boczny treści 16. Skala leży w
  `mobile/src/wyglad/odstepy.ts`.
- **Cel dotyku minimum 44 × 44 pt** na iOS i 48 × 48 dp na Androidzie, także
  dla ikon w pasku.

## 4. Kolor, ikony, tryb ciemny

- **Paleta strony** (`app/globals.css`, preset „Modern Minimal”), przeliczona
  na HEX w `mobile/src/wyglad/kolory.ts`, jasna i ciemna. Tekst główny `#333333`
  (nie czarny), drugorzędny niebieskawoszary, obwódki pól `#E4E8EF`, tło pod
  kartami chłodnoszare `#F2F4F7` (D15; w ciemnym tło `#161616`, karty
  `#262626`). Nie wpisujesz kolorów na sztywno w komponentach.
- **Gradient pod nagłówkiem** (D15) na ekranach zakładek z dużym tytułem, na
  Pulpicie (pod paskiem z logo) i na szczegółach dokumentu: od `#1D4EDA` przez `#2463EF` i `#6E99F4` do tła, na wysokości
  około 380 pt; w ciemnym od `#1D3FAD` przez `#1E3A8B` do tła. Rysowany w SVG
  (`react-native-svg`, bez nowej paczki natywnej) i przewija się z treścią.
  Na gradiencie leżą tylko tytuł, logo, awatar i okrągłe przyciski (biel na
  20% bieli); treść zaczyna się w białej karcie, która na niego nachodzi.
  Tekst bez karty nie schodzi niżej niż połowa gradientu, bo traci kontrast.
  Mały tytuł szczegółu (numer faktury) jest biały, dopóki pod paskiem leży
  gradient, i ciemny po przewinięciu (`useTytulNaGradiencie`). Arkusze i
  ekrany z małym tytułem bez dużej kwoty zostają bez gradientu.
- **Kategorie kosztów w kolorach** (D15): plakietka wersalikami 11 pt na
  jasnym tle tonu. Status ma zdanie zwykłymi literami, kategoria wersaliki,
  więc się nie mylą. Kolor kategorii nic nie mówi o podatku.

| Ton | Kategorie | Jasny: tekst, tło | Ciemny: tekst, tło |
|---|---|---|---|
| turkus | Telekomunikacja, Energia | `#0E6E8C`, `#E3F4F8` | `#7DD3E8`, `#1E3A42` |
| fiolet | Czynsz, Usługi obce | `#6D28D9`, `#F2EBFD` | `#C4B5FD`, `#33303B` |
| bursztyn | Materiały biurowe | `#7A5200`, `#FBF3DB` | `#FCD34D`, `#3B3526` |
| pomarańcz | Paliwo, Podróże służbowe | `#B23C0A`, `#FDEDE3` | `#FDBA8C`, `#40291E` |
| róż | Reprezentacja, Marketing | `#B0175A`, `#FCE8F1` | `#F9A8D4`, `#3F2632` |
| błękit | Oprogramowanie | `#0369A1`, `#E6F3F9` | `#38BDF8`, `#28353B` |
| szary | Pozostałe wydatki | tekst drugorzędny na tle neutralnym | jak w jasnym |

Kontrast tych par (4.5:1 w obu trybach) sprawdza test, zanim trafią do `kolory.ts`.

- **Niebieski FaktWay** `#2463EF` (w ciemnym `#61A4F7` z ciemnym napisem, jak
  na stronie) oznacza „to jest klikalne” albo „to jest główna akcja”.
- **Statusy jak na stronie** (`components/invoices/status-badge.tsx`): plakietka
  z napisem w kolorze roli na jej 10% tle (zielony, bursztynowy, czerwony,
  błękitny, fioletowy, neutralny). Status zawsze ma też tekst, nie tylko kolor.
- **Wykresy w odcieniach niebieskiego** (`--chart-1` do `--chart-5`); kolor
  oceny (czerwony, zielony) tylko tam, gdzie niesie sens (wpływy i koszty).
  Porównanie z innym okresem albo średnią rysujemy szarą linią przerywaną,
  wynik plakietką przy końcu linii („+18 285 zł ponad średnią”), jak w Copilocie.
- **Ikony Remix**, te same co w menu i kartach strony (`komponenty/ikona.tsx`,
  kształty z `@remixicon/react`, generuje je `scripts/ikony-remix.cjs`), w
  pasku zakładek, przyciskach i pasku nawigacji. Okrągła ikona w wierszu albo
  kaflu tylko wtedy, gdy mówi o stanie (błąd, ostrzeżenie, sukces); ozdobne
  ikony przy każdym wierszu zaśmiecały ekrany (Bartosz, 12.11.2026).
  Wyjątek: znak Face ID to systemowy symbol `faceid` (Remix go nie ma, a
  klient zna go z innych aplikacji); na Androidzie odcisk palca z Remix.
- **Logowanie i blokada** (M5a): ekrany logowania mają nagłówek w treści
  (białe logo, tytuł, jedno zdanie) na gradiencie i karty niżej, jak reszta
  aplikacji. Blokada i zasłona w przełączniku aplikacji leżą na pełnym
  gradiencie (od `gradientGora` do `gradientSrodek`) z białym tekstem; jedyny
  przycisk na nim jest biały z napisem w kolorze `gradientGora`
  (`PrzyciskGlowny wariant="naGradiencie"`).
- **Tryb ciemny obowiązkowo** od pierwszego ekranu, z palety ciemnej.

## 5. Karty, listy i stany ekranu

- **Karta jak w Copilocie** (D15): białe tło, rogi 18 pt, bez obwódki,
  delikatny cień (w jasnym dwie warstwy: 0 1 2 przy 4% i 0 8 24 przy 6%
  czerni; w ciemnym bez cienia, kartę odróżnia jaśniejsze tło), wcięcie 16 do
  18 pt. Wykres i kalendarz leżą w karcie.
- **Nagłówek sekcji nad kartą** wersalikami 12 pt (Outfit SemiBold, odstęp
  liter), z linkiem i strzałką po prawej („Skrzynka KSeF ›”). W listach
  dokumentów grupy (Revolut, D14) mają nad kartą tytuł 18 pt: stan („Do
  dokończenia”) albo czas („Ten tydzień”), z liczbą albo sumą po prawej. W
  formularzu nagłówek karty („Nabywca”, „Pozycje”) stoi w karcie.
- **Zamiast kafli jedna karta wyniku:** liczba główna, pod nią wykres i rząd
  trzech mniejszych liczb (`KartaWyniku`, `RzadLiczb`). Lista i zadania mają
  być widoczne bez przewijania; karty, które nie mieszczą się na ekranie
  zakładki, idą na osobny ekran (np. Finanse z Pulpitu), nie znikają (D3).
- **Wiersze w karcie bez linii**, oddziela je wysokość (44 pt w jednej
  linii, 66 pt z podtytułem); linia zostaje tylko w długich tabelach (KPiR,
  ewidencja). Wiersz faktury: okrągła ikona stanu 40 pt, kontrahent (Medium
  16), numer i termin pod spodem (drugorzędne), kwota po prawej; plakietka
  statusu tylko przy wyjątkach (Odrzucona, Szkic, po terminie). Wiersz
  kosztu: dostawca, kolorowa kategoria, kwota, niebieska kropka „do opisania”.
- **Gesty na wierszu:** przesunięcie w lewo daje akcje (np. „Zapłacona”),
  przytrzymanie daje podgląd i menu (`Link.Preview`, `Link.Menu`). Każda akcja
  z gestu jest też dostępna na ekranie szczegółu. Akcja przesunięcia jest
  widoczna tylko w trakcie gestu, a ekran pokazany w podglądzie nie ustawia
  paska nawigacji (`useIsPreview`).
- **Odświeżanie pociągnięciem** na każdej liście z danymi z serwera.
- **Każdy ekran ma cztery stany:** ładowanie (szkielet w kształcie treści,
  nie kręciołek na cały ekran), pusty (okrągła ikona, jedno zdanie i jedna
  akcja), błąd (co się stało, przycisk „Spróbuj ponownie”), treść.
- **Najpierw pokazujemy to, co mamy.** Dane z poprzedniego otwarcia widać od
  razu, świeże dociągają się w tle. Aplikacja nie startuje od pustego ekranu.
- **Zmiany natychmiast.** „Zapłacona” zmienia wiersz od razu i daje „Cofnij”;
  błąd serwera cofa zmianę i mówi dlaczego.

## 6. Formularze

- **Pole jak na stronie:** etykieta nad polem, pole z cienką obwódką, która
  przy pisaniu płynnie przechodzi w kolor marki, przy błędzie czerwona. Liczby
  (kwoty, NIP, numer faktury) z cyframi tabelarycznymi. Wybór z opcji to takie
  samo pole ze strzałką, a lista otwiera się w arkuszu akcji. Data otwiera
  systemowy kalendarz pod polem.
- **Formularz dokumentu z kart** (Revolut, D14): Nabywca, Szczegóły, Pozycje.
  Ustawione wartości stoją po prawej w kolorze marki i otwierają wybór w
  arkuszu; pełne pola pokazujemy dopiero przy edycji pozycji.
- Właściwa klawiatura: kwoty `decimal-pad`, NIP `number-pad`, e-mail
  `email-address`. Podpowiedzi autouzupełniania (`textContentType`,
  `autoComplete`) w polach logowania i danych firmy.
- „Dalej” na klawiaturze przechodzi do następnego pola, ostatnie pole zatwierdza.
  Klawiatura nigdy nie zasłania aktywnego pola.
- Walidacja tymi samymi schematami Zod co na stronie. Błąd pod polem, jednym
  zdaniem, po polsku, z tym, co poprawić; w długim formularzu lista błędów
  stoi też nad przyciskiem wysyłki.
- Zamknięcie arkusza z niezapisanymi zmianami pyta „Odrzucić zmiany?”
  (arkusz akcji), nigdy nie gubi danych po cichu.

## 7. Ruch i wibracje

- **Ruch systemowy albo sprężynowy** (Reanimated, wątek interfejsu): przycisk
  i kafel lekko się zmniejszają przy wciśnięciu (`komponenty/dotyk.tsx`),
  kreska zakładek przesuwa się na sprężynie, obwódka pola zmienia kolor
  płynnie. Wykresy wchodzą raz, przy pokazaniu danych (słupki rosną, linia się
  rysuje, pierścień rozwija), jak na stronie. Nie animujemy pojawiania się
  każdego wiersza i nie robimy „podskakujących” liczb.
- **Szanujemy „Ogranicz ruch”** z ustawień dostępności.
- **Wibracje oszczędnie i zawsze z sensem** (`expo-haptics`):

| Moment | Wibracja |
|---|---|
| Przycisk główny | light impact |
| Gest przesunięcia wiersza przekracza próg akcji | light impact |
| Faktura przyjęta przez KSeF, wydatek zapisany | success |
| Błąd w formularzu, odrzucenie przez KSeF | warning albo error |

Bez wibracji przy przewijaniu, zwykłych wierszach i nawigacji.

## 8. Teksty

- Po polsku, krótko, czasownikami na przyciskach („Wystaw”, „Zapisz”,
  „Oznacz jako zapłaconą”).
- Nazwa produktu tylko „FaktWay”.
- Bez długich myślników (— i –): przecinek, dwukropek albo kropka.
- Bez plakietek nad nagłówkami („Nowość”, „Wkrótce”), bez iskierek i emoji
  w interfejsie. Plakietka statusu w wierszu albo kaflu jest w porządku.
- Bez Flo (decyzja D13): żadnych tekstów asystenta w pierwszej osobie.
- Komunikat blokady zawsze mówi, której faktury dotyczy i co zrobić
  (`AGENTS.md`, protokół naprawy, punkt 4).

## 9. Dostępność i prywatność

- Każda ikona bez tekstu ma etykietę dla VoiceOver i TalkBack.
- Kontrast: kolory palety przeszły test WCAG AA na stronie
  (`tests/unit/finora-motyw.test.ts`); nowy kolor sprawdzasz w obu trybach.
- Kwoty i dane kontrahentów nie trafiają do treści powiadomień push (RODO).
- Opcjonalna blokada aplikacji Face ID albo odciskiem palca.

## 10. Android

Ten sam kod i ten sam wygląd treści (karty, czcionki, ikony, wykresy rysowane
w SVG), ale konwencje Androida w zachowaniu: systemowy przycisk wstecz, górny
pasek Material, efekt fali przy dotknięciu, menu Material w polach wyboru.

## 11. Wzorce

Wzorcem jest **wersja FaktWay na komputer** (`components/dashboard/`,
`components/invoices/`, `components/ui/`): każdy ekran telefonu porównujemy
z odpowiednikiem na stronie z mapy 3a planu.

**Mobbin** (od 12.11.2026, Mobbin Pro przez serwer MCP w Claude Code) daje
wzorce zachowania: układ, kolejność, przepływy, stany ekranu, gesty. Wzór
całej aplikacji (D14): szkielet z Copilota, faktury z Revolut Business. Przed
każdym nowym albo przerabianym ekranem 2 do 4 wyszukiwań w aplikacjach
biznesowych i fintech; wygląd według sekcji 1. Przegląd z 12.11
i lista poprawek: [`WZORCE-MOBBIN.md`](WZORCE-MOBBIN.md). Do repozytorium
trafiają tylko linki do Mobbin, nigdy zrzuty cudzych aplikacji, bo
repozytorium jest publiczne.

## 12. Checklista przed oddaniem ekranu

Zrzuty z symulatora dołączasz do PR. Ekran jest gotowy, gdy:

- [ ] wygląd z komponentów `mobile/src/komponenty/` (karta, wiersz, kafel, pole, plakietka, wykres); nowy komponent ma uzasadnienie w PR
- [ ] zachowanie z elementów systemowych z sekcji 2
- [ ] zrzuty: tryb jasny i ciemny, najmniejszy i największy iPhone w symulatorze
- [ ] zrzut przy największym tekście z ustawień dostępności, nic się nie ucina
- [ ] cztery stany: ładowanie, pusty, błąd, treść
- [ ] cofanie przeciągnięciem działa, klawiatura nie zasłania pól
- [ ] tylko style tekstu, kolory i odstępy z `mobile/src/wyglad/`
- [ ] etykiety dla czytnika ekranu na ikonach
- [ ] porównanie z odpowiednikiem na stronie: co jest inaczej i dlaczego (jedno zdanie)
- [ ] wzorzec z Mobbin: link w PR i jedno zdanie, co z niego wzięliśmy, a czego świadomie nie
- [ ] teksty zgodne z sekcją 8
- [ ] dane do skopiowania (kwoty, NIP, numer KSeF) mają `selectable`
- [ ] przejrzana lista cech „sztucznego” wyglądu z
      `.claude/skills/expo-design-system/references/native-slop.md`. Wyjątki z
      D15: delikatny cień kart i gradient pod nagłówkiem to wzór Copilota, nie
      błąd; obwódka zostaje tylko na polach formularza. Reszta listy obowiązuje
      (okno na środku zamiast arkusza, alert zamiast cofnięcia, ciężkie cienie,
      ten sam odstęp wszędzie, animowane wejście listy)
