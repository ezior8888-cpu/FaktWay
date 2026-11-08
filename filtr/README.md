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
