# Wgrywanie migracji na produkcję

> Wydzielone z `AGENTS.md` 05.11.2026 (plan usprawnień, 2.1), treść bez zmian.
> Jedną linią: `./scripts/ops/wgraj-migracje.sh 00157 00158`. Niżej zasady i droga ręczna.
> Adresy: `source .agents/infra.env` (`AGENTS.md`, „Skąd wziąć adresy”).
> Powiązane: [`scalanie-pr.md`](scalanie-pr.md), [`wgrywanie-migracji.md`](wgrywanie-migracji.md), [`wdrozenie-produkcji.md`](wdrozenie-produkcji.md), [`coolify-pulapki.md`](coolify-pulapki.md).

## Wgrywanie migracji na produkcję

**Pięć zasad, zanim cokolwiek wgrasz:**

1. **Tylko pliki z `main`** (ze scalonego PR). Migracji z nie-scalonej
   gałęzi nie wgrywa się — PR może się jeszcze zmienić, a baza nie.
2. **Numer z rejestru.** Rejestr jest w `docs/koordynacja/CLAUDE-DO-CODEXA.md`
   (sekcja „Rejestr numerów migracji”, wiersz „następny wolny”). Nowa
   migracja bierze ten numer i w TYM SAMYM PR dopisuje wiersz do rejestru.
   Szkice Codexa mają numery 00083–00101, które częściowo kolidują z `main`
   — przy przenoszeniu przenumeruj od następnego wolnego. `00200` jest zajęte
   (wyjątek z audytu bloku 1).
3. **Przed czy PO wdrożeniu** — mówi nagłówek migracji. Domyślnie przed
   (addytywne: nowa tabela, kolumna, funkcja, luźniejszy CHECK). PO
   wdrożeniu idą migracje, które odbierają coś staremu kodowi (uprawnienia,
   kolumny, które stary kod jeszcze czyta) — np. 00112.
4. **DROP.** `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM` — tylko
   za zgodą Bartosza. `DROP CONSTRAINT` + `ADD CONSTRAINT` (zmiana warunku
   albo akcji klucza obcego) i `DROP NOT NULL` są dozwolone, jeśli nagłówek
   to opisuje i dane się nie zmieniają.
5. **Kto wgrywa.** Sesja lokalna z `.agents/infra.env` i kluczem SSH. Sesja
   bez dostępu (chmura, brak `ssh`) NIE wgrywa: wpisuje w opis PR „Do
   wgrania: 00NNN, przed/po wdrożeniu” i zostawia to sesji lokalnej.
   Klucza SSH nie kopiuje się do chmury.

Po wgraniu i weryfikacji zaktualizuj stan w rejestrze („wgrana na db-1
DD.MM”) przy najbliższym PR.

NAJPIERW przeczytaj plik migracji i sprawdź, czy nie ma `DROP`, `TRUNCATE`
ani `DELETE FROM`. Dopiero potem uruchamiaj.

Jedną linią robi to `./scripts/ops/wgraj-migracje.sh 00157 00158`: pliki
z `origin/main`, jedna transakcja na plik, `schema_migrations`, `NOTIFY pgrst`
i sprawdzenie PostgREST-a. Poniżej ta sama droga ręcznie.

```bash
source .agents/infra.env          # daje $K, $DB, $PGC
M=00063_nazwa

scp -i $K supabase/migrations/$M.sql root@$DB:/tmp/
ssh -i $K root@$DB "docker cp /tmp/$M.sql $PGC:/tmp/ && \
  docker exec $PGC psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  --single-transaction -f /tmp/$M.sql"
```

Po wykonaniu ZAWSZE dwie rzeczy, inaczej migracja jest połowiczna:

```bash
ssh -i $K root@$DB "docker exec $PGC psql -U postgres -d postgres \
  -c \"INSERT INTO supabase_migrations.schema_migrations (version, name)
        VALUES ('00063','nazwa') ON CONFLICT (version) DO NOTHING;\" \
  -c \"NOTIFY pgrst, 'reload schema';\""
```

Bez `NOTIFY pgrst` nowe tabele istnieją w bazie, ale aplikacja zwraca
`PGRST205 Could not find the table`. To nie jest teoria, potknęliśmy się
o to przy migracji 00060.

**Trzy rzeczy do sprawdzenia PRZED uruchomieniem, poza `DROP`/`TRUNCATE`:**

- **`UPDATE` na istniejących wierszach** — policz najpierw, ilu dotknie:
  `SELECT count(*) FROM tabela WHERE <ten sam warunek>;`. Zero wierszy
  znaczy, że możesz uruchamiać spokojnie; tysiąc znaczy, że najpierw pytasz
  właściciela.
- **Polityki RLS** — sprawdź nazwy kolumn w tabelach, do których się
  odwołujesz. `memberships` ma `organization_id`, NIE `tenant_id`; tabele
  agenta używają helpera `public.get_current_tenant_id()`. Zła kolumna =
  wycofana transakcja (to akurat kończy się bezpiecznie dzięki
  `--single-transaction`, ale kosztuje przebieg).
- **Numer migracji** — musi być kolejny i niezajęty:
  `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;`

**Weryfikacja PO wgraniu — nie ufaj samemu „CREATE TABLE" w wyjściu.**
Sprawdź trzy rzeczy: obiekt istnieje, wpis w `schema_migrations` jest,
a PostgREST naprawdę go widzi:

```bash
ssh -i $K root@$DB "docker exec $PGC psql -U postgres -d postgres \
  -c \"\\d nazwa_tabeli\" \
  -c \"SELECT version, name FROM supabase_migrations.schema_migrations
        ORDER BY version DESC LIMIT 3;\""
```

Test PostgREST-a (najważniejszy, bo to on wywala `PGRST205`) — z `db-1`,
przez adres kontenera, bo sam kontener nie ma `curl`:

```bash
ssh -i $K root@$DB 'IP=$(docker inspect -f \
  "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" \
  '"$RESTC"')
curl -s "http://$IP:3000/nazwa_tabeli?limit=1"'
```

(`$RESTC` jest zmienną lokalną z `infra.env`, dlatego wychodzi poza
apostrofy — wewnątrz nich zdalna powłoka zobaczyłaby pusty napis.)

**Jak czytać wynik:** `42501 permission denied` to ODPOWIEDŹ POPRAWNA —
znaczy, że PostgREST znalazł tabelę i odmówił dopiero na autoryzacji
(zapytanie leci bez tokenu). Dopiero `PGRST205` (brak tabeli) albo
`PGRST204` (brak kolumny) oznaczają nieprzeładowany cache schematu.

**Typy bazy (`types/database.ts`) po migracji zmieniającej schemat** — nie
poprawiaj ich ręcznie, wygeneruj z produkcji (tylko odczyt schematu, przez
`postgres-meta` na `db-1`) i dołącz do najbliższego PR:

```bash
ssh -i $K root@$DB 'C=$(docker ps --format "{{.Names}}" | grep supabase-meta)
IP=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" $C)
curl -sf "http://$IP:8080/generators/typescript?included_schemas=graphql_public,public&detect_one_to_one_relationships=true"' \
  > /tmp/database.ts
```

Zachowaj nagłówek pliku i blok `__InternalSupabase` (wersja PostgREST
z obrazu `$RESTC`), potem `pnpm typecheck`.

Job CI „RLS isolation” porównuje ten plik ze schematem zbudowanym z migracji
(`scripts/ci/typy-bazy-zgodne.mjs`). Coś w typach, czego migracje nie tworzą,
to błąd (dryf produkcji albo ręczna edycja). Migracja jeszcze nie w typach to
ostrzeżenie, które znika po tym kroku.
