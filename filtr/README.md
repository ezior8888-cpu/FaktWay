# Żelazny filtr: dane

Wiedza filtra zmian z ryzykiem prawnym. Plan i zasady:
[`docs/koordynacja/PLAN-ZELAZNY-FILTR.md`](../docs/koordynacja/PLAN-ZELAZNY-FILTR.md).

## Mapa ryzyka (`mapa-ryzyka.json`, krok F1)

Każdy plik kodu ma poziom:

| Poziom | Znaczenie |
|---|---|
| R1 | krytyczny: zły wynik zmienia kwotę podatku albo składki, termin, dokument dla urzędu albo kontrahenta (faktura, JPK, KSeF) albo przechowywanie danych |
| R2 | wprowadza w błąd: szacunki, pulpit, przypomnienia, teksty o podatkach, regulamin |
| R3 | pomocniczy: kod, z którego korzystają R1 i R2 (daty, formatowanie, ekrany) |
| R0 | bez ryzyka prawnego |

Zasady:

- Plik w ścieżce obszaru dziedziczy jego poziom. Kilka obszarów: wygrywa
  najwyższy.
- Plik kodu spoza obszarów, w którym jest sygnał (VAT, ZUS, PIT, składka,
  termin, kurs, JPK, KSeF, `P_\d+`, import pliku R1 i inne z listy
  `sygnaly`), jest **niesklasyfikowany** i zatrzymuje zmianę.
- Dopisanie pliku do obszaru wolno bez zgody. Usunięcie obszaru, niższy
  poziom, usunięta ścieżka, nowe wyłączenie, mniej sygnałów: tylko za zgodą
  Bartosza (etykieta `zgoda:zmiana-filtra`).
- Nowa migracja nie dziedziczy poziomu po starych. Jeśli ma sygnał, dopisz ją
  do obszaru `sql.*` (R1, gdy liczy, numeruje, blokuje albo usuwa dane;
  `sql.schemat`, gdy tylko zmienia schemat).

Polecenia:

```bash
pnpm filtr:mapa --skan
```

```bash
pnpm filtr:mapa --diff origin/main
```

```bash
pnpm filtr:mapa lib/ksiegowosc/zus.ts
```

```bash
pnpm filtr:testy
```

Test `tests/filtr/mapa.test.ts` skanuje całe repozytorium przy każdym
`pnpm vitest run` (także w CI): czerwony znaczy, że plik z sygnałem nie trafił
na mapę albo wpis mapy wskazuje plik, którego już nie ma.

Składnia ścieżek: `**` dowolna liczba katalogów, `*` dowolne znaki bez `/`,
`?` jeden znak, `{a,b}` alternatywa. Nawiasy okrągłe i kwadratowe są
dosłowne (`app/(dashboard)/invoices/[id]/`).

## Straż w CI (`scripts/filtr/straz.mjs`, krok F2)

Kontrola „Filtr: straż” (`.github/workflows/filtr-straz.yml`) ocenia każdy PR
kodem i mapą z `main`; z PR czyta tylko dane przez API. Wymaga:

| Zmiana | Wymaga |
|---|---|
| plik z sygnałem poza mapą | dopisania do mapy |
| maszyneria filtra (`.github/workflows/**`, `scripts/filtr/**`, `scripts/ci/**`, `.githooks/**`, `.claude/**`, szablon PR, `filtr/zgody.json`), osłabienie mapy, wzrost zapadki, zmieniona albo usunięta linia w `tests/filtr/**` | `zgoda:zmiana-filtra` |
| wiedza prawna (`filtr/przepisy/**`, `lib/ksiegowosc/parametry/**`, złote przypadki, przykłady urzędowe, wyrocznia, schematy `lib/**/schemas/**`) | `zgoda:wiedza-prawna` i źródło w karcie |
| nowy komentarz `filtr-wyjatek`, kod R1 bez nowego albo zmienionego testu | `zgoda:wyjatek-filtra` i powód w karcie |
| PR R1 albo R2 | karta zmiany prawnej z szablonu PR, każde pole wypełnione |

Etykieta liczy się tylko od osoby z `zgody.json` (z `main`) i tylko nadana po
ostatnim pushu; każdy push ją zdejmuje. Etykiety zakłada
`./scripts/ops/filtr-etykiety.sh` (uruchamia Bartosz). Lokalnie:

```bash
node scripts/filtr/straz.mjs --pr 488 --tylko-raport
```
