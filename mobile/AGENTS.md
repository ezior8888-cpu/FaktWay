# Aplikacja mobilna FaktWay (Expo)

Natywna aplikacja FaktWay na iPhone'a i Androida. Obowiązuje główny
[`AGENTS.md`](../AGENTS.md) (scalanie, protokół naprawy, PR) oraz:

- plan i etapy: [`docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md`](../docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md),
- wygląd: [`docs/mobile/ZASADY-DESIGNU.md`](../docs/mobile/ZASADY-DESIGNU.md), czytasz w całości przed każdym ekranem.

## Polecenia (w tym katalogu)

```bash
pnpm install                # własny workspace pnpm, główny lockfile się nie zmienia
pnpm run sprawdz            # typy i eslint; przed każdym PR
npx expo install <paczka>   # zawsze zamiast pnpm add: wersje zgodne z SDK
pnpm run ios                # development build w Xcode i uruchomienie w symulatorze
pnpm start                  # sam serwer Metro, gdy build już jest w symulatorze
```

Na Macu z 16 GB budowanie w Xcode, `pnpm build` strony i Supabase w Colimie
uruchamiasz po kolei, nigdy razem.

## Układ

| Katalog | Co |
|---|---|
| `src/app/` | trasy Expo Router: `_layout.tsx` to zakładki systemowe, każdy folder zakładki ma własny `Stack` |
| `src/komponenty/` | wygląd FaktWay (plan D12): `Tekst`, `EkranListy`, `Sekcja` (karta), `Wiersz`, `WierszFaktury` (gesty, podgląd, menu), `PrzyciskGlowny`, `Dotyk` (animacja wciśnięcia), `Ikona` i `KoloIkony` (Remix), `Znacznik` (plakietka statusu), `NaglowekKwoty`, `Kafle`, `Wykres` (SVG: słupki, linia, pierścień), `Kubelki`, `Kalendarz`, `LogoFaktWay`, `PasekMarki`, pola formularza (`formularz.tsx`); ekrany składasz tylko z nich i z komponentów systemowych |
| `src/stan/` | stan wspólny dla ekranów na danych przykładowych: faktury, cykliczne, wydatki, przełączniki ustawień |
| `src/wyglad/` | paleta strony (jasna i ciemna), czcionki i skala tekstu, odstępy i kształty, opcje pasków (`naglowki.ts`), ikony paska (`ikony-paska.ts`); jedyne miejsce na wartości wyglądu |
| `assets/fonts/`, `assets/zakladki/`, `assets/pasek/` | Outfit i IBM Plex Mono (OFL, `LICENCJE.txt`); ikony Remix zakładek i paska jako obrazy szablonowe |
| `scripts/ikony-remix.cjs` | generuje `src/komponenty/ikony-remix.ts` z pakietu `@remixicon/react` strony; nową ikonę dopisz tam |
| `src/lib/` | formatowanie i logika bez interfejsu |
| `src/dane-przykladowe/` | dane do etapów M2 do M4 (zmyślone firmy, NIP testowy) |

## Expo zmienia się z każdym SDK: nie ufaj pamięci

1. Sprawdź wersję `expo` w `package.json` (dziś SDK 58).
2. API sprawdzaj w typach w `node_modules` albo w dokumentacji dla tej wersji:
   `https://docs.expo.dev/versions/v58.0.0/`, indeks: https://docs.expo.dev/llms.txt
3. Skille Expo (kopie z github.com/expo/skills, MIT) leżą w `../.claude/skills/expo-*`.

## Zasady techniczne

- Trasy tylko w `src/app/`; reszta kodu poza nim.
- Katalogi `ios/` i `android/` są generowane (Continuous Native Generation) i nie
  trafiają do gita. Ustawienia natywne tylko w `app.json` i pluginach.
- Po dodaniu biblioteki z kodem natywnym potrzebny jest nowy build (`pnpm run ios`);
  Expo Go nie pokazuje natywnych zakładek ani efektu szkła, więc go nie używamy.
- Teksty po polsku, nazwa produktu tylko „FaktWay” (pilnuje `tests/unit/nazwa-produktu.test.ts`).

## Pułapki (sprawdzone w symulatorze)

- `Link` z `asChild` spłaszcza style dziecka (`StyleSheet.flatten`), więc styl
  w postaci funkcji (`({ pressed }) => ...`) ginie. Stan wciśnięcia trzymaj w
  `useState` (`onPressIn`, `onPressOut`), jak w `komponenty/wiersz-faktury.tsx`.
- `Stack.Toolbar placement="bottom"` chowa się pod paskiem zakładek. Główna
  akcja ekranu idzie do treści (`komponenty/przycisk-glowny`).
- Ekran otwierany też jako podgląd (`Link.Preview`) nie może ustawiać paska:
  `Stack.Screen` i `Stack.Toolbar` tylko gdy `!useIsPreview()`.
- Typy tras (`/koszty/[id]`) generuje Metro przy starcie: po dodaniu trasy
  uruchom `pnpm start`, zanim `tsc` przestanie zgłaszać błąd.
- Zmiana pliku ze stanem (`src/stan/`) przy szybkim odświeżaniu zeruje stan
  aplikacji; to nie błąd.
- Ekran zakładki otwarty linkiem (`faktway://...`) ma pod spodem listę tylko
  dzięki `unstable_settings = { anchor: 'index' }` w `_layout.tsx` stosu.
  Formularz faktury otwierany z innego stosu (Popraw, Korekta, Duplikuj, karta
  kontrahenta) nie ma pod sobą wyboru rodzaju: przekaż `wprost: '1'`, wtedy
  formularz pokazuje „Anuluj”. Stanu nawigacji (`getState()`) nie czytaj przy
  rysowaniu: przy pierwszym rysowaniu bywa nieaktualny.
- Parametr trasy czytany w `useState(...)` nie zmienia się, gdy ekran już
  jest otwarty. Gdy link ma przełączyć widok, porównuj z poprzednim
  parametrem (wzór w `app/faktury/index.tsx`).
- Timery w ekranach arkuszy czyść przy zamknięciu (`useEffect` ze sprzątaniem):
  arkusz zamknięty gestem nie może potem nawigować ani zapisywać.
- Pole formularza ma etykietę zawsze nad polem (jak na stronie), więc nie
  łamie słów przy długich wartościach i dużym tekście. Pola mają własne
  odstępy (`pole = true` na komponencie), karta nie rysuje między nimi linii.
- Obchód w symulatorze: linki otwieraj narzędziem symulatora (`open_url`), nie
  `xcrun simctl openurl`, który pokazuje systemowe pytanie „Otworzyć w
  FaktWay?”.
- Pasek nawigacji bez `headerStyle`/`headerLargeStyle` z kolorem tła: na iOS 27
  chowa wtedy duży tytuł. Opcje pasków tylko z `wyglad/naglowki.ts`.
- Własna czcionka: wagę wybiera plik (`czcionka('semibold')`), nie
  `fontWeight` (na Androidzie wraca wtedy czcionka systemowa).
- Wartości Reanimated w zdarzeniach i efektach zapisuj przez `.set()`, nie
  `.value =`: lint React Compiler (`react-hooks/immutability`) odrzuca przypisanie.
- `borderStyle: 'dashed'` z obwódką z jednej strony nie działa w React Native;
  przerywane linie rysuj w SVG (`Line strokeDasharray`).
- Linki z innej zakładki nie przejdą, gdy na wierzchu jest arkusz (np. „Nowa
  faktura”): przy obchodzie zamknij arkusz albo uruchom aplikację od nowa.
