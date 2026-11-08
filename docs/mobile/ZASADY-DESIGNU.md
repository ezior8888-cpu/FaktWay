# Zasady designu aplikacji FaktWay na telefon

> Obowiązuje każdego agenta (Claude, Codex) i każdy ekran aplikacji w `mobile/`.
> Plan prac: [`PLAN-APLIKACJA-MOBILNA.md`](../koordynacja/PLAN-APLIKACJA-MOBILNA.md).
> Wersja 1 z 08.11.2026, przed pracą projektanta. Gdy projektant odda system
> (kolory, typografia, ikona, ekrany kluczowe), jego decyzje nadpisują
> sekcje 3 i 4, a reszta zostaje.

Ten plik dotyczy **aplikacji natywnej** (Expo, React Native). Nie dotyczy PWA
ani strony: tam obowiązują `components/ui` (shadcn) i zasady z `AGENTS.md`.

---

## 1. Zasada nadrzędna: system najpierw, marka na końcu

Aplikacja ma wyglądać i zachowywać się jak aplikacja zrobiona przez Apple na
iPhonie i przez Google na Androidzie. Prestiż bierze się z natywnych elementów
i porządku, nie z efektów.

1. **Najpierw element systemowy.** Zanim narysujesz własny komponent, sprawdź,
   czy jest systemowy: zakładki, stos ekranów, lista, arkusz, menu, przełącznik,
   wybór daty, pole wyszukiwania, alert. Jeśli jest, używasz go. Własny
   komponent wymaga zdania uzasadnienia w opisie PR.
2. **Marka to tylko:** kolor akcentu, logo, ikona aplikacji, ilustracje
   pustych ekranów i ton tekstów. Wszystko inne (tła, czcionka, odstępy list,
   paski) jest systemowe.
3. **Nie przenosimy wyglądu strony na telefon.** Żadnych komponentów shadcn,
   kafli z pulpitu, tabel, kart z cieniem, gradientów i świecących kul ze
   strony głównej. To one robią „dziwne” wrażenie w obecnym PWA.
4. **Jeden ekran, jedno zadanie.** Telefon nie jest pomniejszonym pulpitem.
   Gdy ekran ma dwa równorzędne cele, dzielimy go na dwa ekrany.

## 2. Nawigacja

| Wzorzec | Jak | Nie |
|---|---|---|
| Główne sekcje | natywne zakładki (`expo-router/native-tabs`), 4 do 5 pozycji, ikona i krótka nazwa | własny pasek dolny, menu „hamburger” |
| Przejście w głąb | natywny stos: ekran wjeżdża z prawej, cofanie przeciągnięciem od lewej krawędzi działa zawsze | podmiana treści w miejscu, własny przycisk „wstecz” |
| Tytuł | duży tytuł na ekranach zakładek, zwija się przy przewijaniu; mały tytuł na ekranach w głębi | tytuł w treści ekranu zamiast w pasku |
| Tworzenie i edycja | arkusz od dołu („Anuluj” po lewej, „Zapisz” albo „Wystaw” po prawej w pasku) | okno na środku ekranu |
| Wybór z kilku opcji | menu systemowe z przycisku albo arkusz akcji | własna rozwijana lista |
| Potwierdzenie usunięcia | systemowy arkusz akcji z czerwoną opcją | własne okno „Czy na pewno?” |
| Wyszukiwanie | pole wyszukiwania w pasku nawigacji listy | osobny ekran wyszukiwarki |

Główna akcja („Nowa faktura”) ma jedno stałe miejsce. Jakie dokładnie, decyduje
Bartosz po obejrzeniu wariantów w symulatorze (plan, decyzja D7).

## 3. Typografia i odstępy

- **Tylko systemowa czcionka** (SF Pro na iOS, Roboto na Androidzie) i tylko
  **systemowe style tekstu**. Na iOS: Large Title 34, Title 1 28, Title 2 22,
  Title 3 20, Headline 17 półgruby, Body 17, Callout 16, Subheadline 15,
  Footnote 13, Caption 12 i 11. Nie wpisujesz rozmiarów spoza tej skali.
- **Dynamic Type obowiązkowo.** Każdy ekran działa przy największym tekście
  z ustawień dostępności: tekst się zawija, nic się nie ucina, układ może przejść
  z poziomego w pionowy.
- **Kwoty** pisane cyframi o stałej szerokości (`fontVariant: ['tabular-nums']`),
  w listach wyrównane do prawej, format z `lib/format` („1 234,56 zł”, twarda
  spacja przed „zł”). Kwota jest najważniejszą liczbą w wierszu, więc ma
  styl Headline albo Body, nie Caption.
- **Odstępy ze skali 4, 8, 12, 16, 20, 24, 32** (plus 2 tylko między liniami
  tekstu w jednym wierszu listy). Margines boczny treści 16. Nie wpisujesz
  wartości spoza skali; skala leży w `mobile/src/wyglad/odstepy.ts`.
- **Cel dotyku minimum 44 × 44 pt** na iOS i 48 × 48 dp na Androidzie, także
  dla ikon w pasku.

## 4. Kolor, ikony, tryb ciemny

- **Kolory semantyczne systemu**: etykieta główna i drugorzędna, tło
  systemowe i tło grupowanej listy, separator. Nie wpisujesz szarości na
  sztywno.
- **Jeden kolor akcentu:** niebieski FaktWay (`--primary` w `app/globals.css`)
  do czasu decyzji projektanta. Akcent oznacza „to jest klikalne” albo
  „to jest główna akcja”, nic więcej.
- **Kolory statusów** tylko systemowe: zielony (przyjęta przez KSeF, zapłacona),
  pomarańczowy (czeka, po terminie do 7 dni), czerwony (odrzucona, po terminie
  dłużej, akcje niszczące). Status zawsze ma też tekst, nie tylko kolor.
- **Tryb ciemny obowiązkowo** od pierwszego ekranu, zawsze z kolorów
  semantycznych.
- **Ikony:** SF Symbols na iOS (`expo-symbols`), odpowiedniki Material na
  Androidzie. Nie mieszamy zestawów i nie rysujemy własnych ikon interfejsu.

## 5. Listy i stany ekranu

- **Natywna lista**, w długich listach z recyklingiem wierszy (FlashList).
  Wiersz faktury: kontrahent (Body), numer i data (Subheadline, drugorzędny),
  kwota po prawej, status tekstem.
- **Gesty na wierszu:** przesunięcie w lewo daje akcje (np. „Zapłacona”),
  przytrzymanie daje menu kontekstowe z podglądem. Każda akcja z gestu jest
  też dostępna na ekranie szczegółu.
- **Odświeżanie pociągnięciem** na każdej liście z danymi z serwera.
- **Każdy ekran ma cztery stany:** ładowanie (szkielet w kształcie treści,
  nie kręciołek na cały ekran), pusty (jedno zdanie i jedna akcja), błąd (co
  się stało, przycisk „Spróbuj ponownie”), treść.
- **Najpierw pokazujemy to, co mamy.** Dane z poprzedniego otwarcia widać od
  razu, świeże dociągają się w tle. Aplikacja nie startuje od pustego ekranu.
- **Zmiany natychmiast.** „Zapłacona” zmienia wiersz od razu i daje „Cofnij”;
  błąd serwera cofa zmianę i mówi dlaczego.

## 6. Formularze

- Natywne pola, właściwa klawiatura: kwoty `decimal-pad`, NIP `number-pad`,
  e-mail `email-address`. Podpowiedzi autouzupełniania (`textContentType`,
  `autoComplete`) w polach logowania i danych firmy.
- „Dalej” na klawiaturze przechodzi do następnego pola, ostatnie pole zatwierdza.
  Klawiatura nigdy nie zasłania aktywnego pola.
- Walidacja tymi samymi schematami Zod co na stronie. Błąd pod polem, jednym
  zdaniem, po polsku, z tym, co poprawić.
- Zamknięcie arkusza z niezapisanymi zmianami pyta „Odrzucić zmiany?”
  (arkusz akcji), nigdy nie gubi danych po cichu.

## 7. Ruch i wibracje

- **Ruch tylko systemowy albo sprężynowy** (Reanimated). Nie animujemy
  pojawiania się każdego elementu przy wejściu na ekran, nie robimy
  „podskakujących” liczb ani animowanego ekranu startowego.
- **Szanujemy „Ogranicz ruch”** z ustawień dostępności.
- **Wibracje oszczędnie i zawsze z sensem** (`expo-haptics`):

| Moment | Wibracja |
|---|---|
| Zmiana wartości w wyborze, przełącznik | selection |
| Gest przesunięcia wiersza przekracza próg akcji | light impact |
| Faktura przyjęta przez KSeF, wydatek zapisany | success |
| Odrzucenie przez KSeF, błąd zapisu | error |

Bez wibracji przy przewijaniu, zwykłym dotknięciu przycisku i nawigacji.

## 8. Teksty

- Po polsku, krótko, czasownikami na przyciskach („Wystaw”, „Zapisz”,
  „Oznacz jako zapłaconą”).
- Nazwa produktu tylko „FaktWay”.
- Bez długich myślników (— i –): przecinek, dwukropek albo kropka.
- Bez plakietek nad nagłówkami („Nowość”, „Wkrótce”), bez iskierek i emoji
  w interfejsie.
- Komunikat blokady zawsze mówi, której faktury dotyczy i co zrobić
  (`AGENTS.md`, protokół naprawy, punkt 4).

## 9. Dostępność i prywatność

- Każda ikona bez tekstu ma etykietę dla VoiceOver i TalkBack.
- Kontrast tekstu co najmniej taki jak w kolorach systemowych; akcent na
  tle sprawdzany w obu trybach.
- Kwoty i dane kontrahentów nie trafiają do treści powiadomień push (RODO).
- Opcjonalna blokada aplikacji Face ID albo odciskiem palca.

## 10. Android

Ten sam kod, ale konwencje Androida: systemowy przycisk wstecz, górny pasek
Material, efekt fali przy dotknięciu. Elementy z bibliotek (nawigacja, menu,
arkusze) same dobierają wygląd do systemu i tak ma zostać. Nie przenosimy na
Androida wyglądu z iOS ani odwrotnie.

## 11. Wzorce

Zrzuty ekranów cudzych aplikacji (Mobbin, własne zrzuty) leżą **poza gitem**,
w `.agents/mobile-wzorce/`, bo repozytorium jest publiczne. Każdy ekran
FaktWay ma wskazany wzorzec (plik albo aplikację i ekran), z którym go
porównujemy. Z aplikacji open source (Bluesky, Expensify, Ice Cubes)
podglądamy rozwiązania, nie kopiujemy kodu.

## 12. Checklista przed oddaniem ekranu

Zrzuty z symulatora dołączasz do PR. Ekran jest gotowy, gdy:

- [ ] używa elementów systemowych z sekcji 2; każdy własny komponent ma uzasadnienie w PR
- [ ] zrzuty: tryb jasny i ciemny, najmniejszy i największy iPhone w symulatorze
- [ ] zrzut przy największym tekście z ustawień dostępności, nic się nie ucina
- [ ] cztery stany: ładowanie, pusty, błąd, treść
- [ ] cofanie przeciągnięciem działa, klawiatura nie zasłania pól
- [ ] tylko style tekstu i odstępy ze skali z sekcji 3
- [ ] etykiety dla czytnika ekranu na ikonach
- [ ] porównanie ze wzorcem: co jest inaczej i dlaczego (jedno zdanie)
- [ ] teksty zgodne z sekcją 8
- [ ] dane do skopiowania (kwoty, NIP, numer KSeF) mają `selectable`
- [ ] przejrzana lista 20 cech „sztucznego” wyglądu z
      `.claude/skills/expo-design-system/references/native-slop.md`; żadna nie występuje
      (najczęstsze: okno na środku zamiast arkusza, alert zamiast cofnięcia, karta wokół każdego wiersza,
      cienie, ramki 1 px, ten sam odstęp wszędzie, animowane wejście listy)
