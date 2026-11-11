# Zasady designu aplikacji FaktWay na telefon

> Obowiązuje każdego agenta (Claude, Codex) i każdy ekran aplikacji w `mobile/`.
> Plan prac: [`PLAN-APLIKACJA-MOBILNA.md`](../koordynacja/PLAN-APLIKACJA-MOBILNA.md).
> Wersja 2 z 10.11.2026 (decyzja D12: wygląd FaktWay zamiast „produktu Apple”).
> Gdy projektant odda system (D6), jego decyzje nadpisują sekcje 3 i 4.

Ten plik dotyczy **aplikacji natywnej** (Expo, React Native). Nie dotyczy PWA
ani strony: tam obowiązują `components/ui` i zasady z `AGENTS.md`.

---

## 1. Zasada nadrzędna: treść jak FaktWay na komputerze, zachowanie natywne

Aplikacja ma wyglądać jak FaktWay, a nie jak aplikacja zrobiona przez Apple
(Bartosz, 10.11.2026). Prestiż bierze się z jednego języka wizualnego na
komputerze i telefonie oraz z płynności, którą daje system.

1. **Treść mówi językiem strony.** Czcionki, kolory, karty, ikony, statusy
   i wykresy bierzemy z wersji na komputer (plan Finora, D2): Outfit, IBM Plex
   Mono w liczbach, preset „Modern Minimal”, płaskie karty z cienką obwódką,
   ikony Remix, plakietki statusów, wykresy w odcieniach niebieskiego.
   Wartości leżą w `mobile/src/wyglad/` i pochodzą z `app/globals.css`.
2. **Zachowanie zostaje systemowe.** Stos ekranów z gestem wstecz, pasek
   zakładek, arkusze od dołu, menu i podgląd przy przytrzymaniu, arkusz akcji,
   kalendarz, przełącznik, klawiatura, wibracje. Tego nie rysujemy sami: to
   daje płynność.
3. **Komponenty strony przerabiamy, nie kopiujemy.** Kartę, kafel statystyki,
   plakietkę, zakładki sekcji czy wykres przenosimy z ich wyglądem, ale na
   telefon: większy cel dotyku, większy tekst, jedna kolumna. Nie przenosimy
   tabel szerokich jak ekran komputera, gradientów i świecących kul ze strony
   głównej.
4. **Jeden ekran, jedno zadanie.** Telefon nie jest pomniejszonym pulpitem.
   Gdy ekran ma dwa równorzędne cele, dzielimy go na dwa ekrany.

## 2. Nawigacja

| Wzorzec | Jak | Nie |
|---|---|---|
| Główne sekcje | natywne zakładki (`expo-router/native-tabs`), 5 pozycji, ikony Remix z menu strony (kontur w spoczynku, wypełnienie po wybraniu), napisy w Outfit | własny pasek dolny, menu „hamburger” |
| Przejście w głąb | natywny stos: ekran wjeżdża z prawej, cofanie przeciągnięciem od lewej krawędzi działa zawsze | podmiana treści w miejscu, własny przycisk „wstecz” |
| Tytuł | duży tytuł w Outfit na ekranach zakładek, zwija się przy przewijaniu; mały w głębi. Pulpit ma zamiast tytułu pasek z logo FaktWay i awatarem | tytuł w treści ekranu zamiast w pasku |
| Tworzenie i edycja | arkusz od dołu („Anuluj” po lewej, „Zapisz” albo „Wystaw” po prawej w pasku) | okno na środku ekranu |
| Wybór z kilku opcji | pole jak na stronie, lista w systemowym arkuszu akcji | własna rozwijana lista |
| Potwierdzenie usunięcia | systemowy arkusz akcji z czerwoną opcją | własne okno „Czy na pewno?” |
| Wyszukiwanie | pole wyszukiwania w pasku nawigacji listy | osobny ekran wyszukiwarki |
| Podzakładki sekcji | zakładki jak na stronie (`section-tabs.tsx`): napisy w rzędzie, kreska pod aktywną przesuwa się na sprężynie | systemowy przełącznik segmentowy |

Główna akcja sekcji ma jedno stałe miejsce: szeroki bloczek u góry listy, pod
podsumowaniem (decyzja D7, 09.11.2026: „Nowa faktura” w bloczku, nie plus w pasku).

**Główna akcja ekranu w treści, nie w dolnym pasku narzędzi.** W aplikacji z
zakładkami dolny pasek narzędzi chowa się pod paskiem zakładek (sprawdzone w M3).
Akcję w rodzaju „Oznacz jako zapłaconą” stawiamy pod nagłówkiem ekranu jako
`PrzyciskGlowny`: pełne tło w kolorze marki, rogi jak na stronie, na całą
szerokość. Przycisk główny jest jeden na ekran; cofnięcie tej samej akcji ma
wariant drugorzędny (obwódka, wariant `outline` strony).

Przyciski w pasku u góry (filtr, kalendarz, udostępnij, więcej) mają ikony
Remix z `wyglad/ikony-paska.ts`; pozycje menu systemowego zostają z ikonami
SF, bo menu iOS przyjmuje tylko je.

## 3. Typografia i odstępy

- **Outfit na interfejs, IBM Plex Mono na liczby**, numery faktur, NIP-y,
  daty i procenty, jak na stronie (`app/layout.tsx`). Czcionki są wbudowane
  w aplikację (`app.json`, plugin `expo-font`, pliki w `mobile/assets/fonts/`
  z licencją OFL). Wagę wybiera się plikiem (`czcionka()` w `typografia.ts`),
  nie `fontWeight`.
- **Tylko style ze skali** w `mobile/src/wyglad/typografia.ts` (od Large Title
  30 do Caption 11). Nie wpisujesz rozmiarów spoza skali.
- **Dynamic Type obowiązkowo.** Każdy ekran działa przy największym tekście
  z ustawień dostępności: tekst się zawija, nic się nie ucina, układ może przejść
  z poziomego w pionowy (wiersze, kafle po jednym w rzędzie).
- **Kwoty** w IBM Plex Mono, w listach wyrównane do prawej, format z
  `lib/format` („1 234,56 zł”, twarda spacja przed „zł”). Wartość z cyframi
  idzie czcionką liczb sama (`Wiersz`, `Kafle`, `NaglowekKwoty`); słowo
  („Połączone”, „Biuro”) zostaje w Outfit.
- **Odstępy ze skali 4, 8, 12, 16, 20, 24, 32** (plus 2 tylko między liniami
  tekstu w jednym wierszu listy). Margines boczny treści 16. Skala leży w
  `mobile/src/wyglad/odstepy.ts`.
- **Cel dotyku minimum 44 × 44 pt** na iOS i 48 × 48 dp na Androidzie, także
  dla ikon w pasku.

## 4. Kolor, ikony, tryb ciemny

- **Paleta strony** (`app/globals.css`, preset „Modern Minimal”), przeliczona
  na HEX w `mobile/src/wyglad/kolory.ts`, jasna i ciemna. Tekst główny `#333333`
  (nie czarny), drugorzędny niebieskawoszary, obwódki `#E4E8EF`, tło pod kartami
  jak tło menu strony. Nie wpisujesz kolorów na sztywno w komponentach.
- **Niebieski FaktWay** `#2463EF` (w ciemnym `#61A4F7` z ciemnym napisem, jak
  na stronie) oznacza „to jest klikalne” albo „to jest główna akcja”.
- **Statusy jak na stronie** (`components/invoices/status-badge.tsx`): plakietka
  z napisem w kolorze roli na jej 10% tle (zielony, bursztynowy, czerwony,
  błękitny, fioletowy, neutralny). Status zawsze ma też tekst, nie tylko kolor.
- **Wykresy w odcieniach niebieskiego** (`--chart-1` do `--chart-5`); kolor
  oceny (czerwony, zielony) tylko tam, gdzie niesie sens (wpływy i koszty).
- **Ikony Remix**, te same co w menu i kartach strony (`komponenty/ikona.tsx`,
  kształty z `@remixicon/react`, generuje je `scripts/ikony-remix.cjs`). W
  wierszach i kaflach jako okrągła ikona na 10% tle (`KoloIkony`).
- **Tryb ciemny obowiązkowo** od pierwszego ekranu, z palety ciemnej.

## 5. Karty, listy i stany ekranu

- **Karta jak `Card` strony:** płaska, cienka obwódka, rogi 2 pt (na stronie
  ostre), tytuł i opis w środku karty u góry, link po prawej tytułu (np.
  „Faktury”), dopisek na dole. Bez cieni. Kafle wskaźników to osobne karty
  (`Sekcja bezKarty`), wykres i kalendarz leżą w karcie (`swobodna`).
- **Wiersze w karcie** z linią na całą szerokość karty, jak w tabelach strony.
  Wiersz faktury: kontrahent (Outfit Medium), numer i data (Plex Mono,
  drugorzędne), kwota po prawej (Plex Mono), status jako plakietka.
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
  (kwoty, NIP, numer faktury) w Plex Mono. Wybór z opcji to takie samo pole ze
  strzałką, a lista otwiera się w arkuszu akcji. Data otwiera systemowy
  kalendarz pod polem.
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
z odpowiednikiem na stronie z mapy 3a planu. Zrzuty cudzych aplikacji leżą
**poza gitem**, w `.agents/mobile-wzorce/`, bo repozytorium jest publiczne.

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
- [ ] teksty zgodne z sekcją 8
- [ ] dane do skopiowania (kwoty, NIP, numer KSeF) mają `selectable`
- [ ] przejrzana lista cech „sztucznego” wyglądu z
      `.claude/skills/expo-design-system/references/native-slop.md`. Wyjątek z D12:
      cienka obwódka kart i pól to wygląd FaktWay, nie błąd. Reszta listy
      obowiązuje (okno na środku zamiast arkusza, alert zamiast cofnięcia, cienie,
      ten sam odstęp wszędzie, animowane wejście listy)
