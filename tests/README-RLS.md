# Izolowane testy RLS

Testy w `rls-isolation.test.ts` tworzą konta, modyfikują członkostwa i faktury oraz usuwają dane przez `service_role`. Ich stałe identyfikatory i adresy testowe nie chronią istniejących danych przed kolizją. Wolno je uruchamiać wyłącznie na osobnej, jednorazowej bazie z fikcyjnymi danymi.

## Warunki dopuszczenia celu

`helpers/rls-environment.ts` sprawdza konfigurację przed utworzeniem klientów Supabase. Wymaga wszystkich parametrów przekazanych jawnie do procesu:

- `RLS_TEST_SUPABASE_URL`: numeryczny loopback, np. `http://127.0.0.1:54321` lub `http://[::1]:54321`. Adres nie może zawierać danych logowania, ścieżki, query ani fragmentu.
- `RLS_TEST_SUPABASE_ANON_KEY` i `RLS_TEST_SUPABASE_SERVICE_ROLE_KEY`: osobne klucze jednorazowej bazy testowej.
- `RLS_TEST_ALLOW_DESTRUCTIVE=isolated-local-database`: świadome potwierdzenie, że wskazana baza jest przeznaczona do tworzenia i usuwania danych testowych.
- `RLS_TEST_DATABASE_URL` (testy `rls-kolejkowanie-wysylki.test.ts`, `rls-kontrola-dziennik-prob.test.ts` i `rls-kontrola-offline24.test.ts`): połączenie `postgresql://` do TEJ SAMEJ lokalnej bazy, też wyłącznie numeryczny loopback — pg-boss zapisuje zlecenia w transakcji z RPC cyklu życia faktury, a sekcje 12 i 4a `scripts/ops/kontrola-faktur-ksef.sh` czytają bazę programem `psql` (musi być w `PATH`).

Zdalne adresy, także prywatna sieć i staging, oraz nazwy DNS, w tym `localhost`, są zablokowane. Nie ma przełącznika dopuszczającego zdalną bazę. Jeżeli proces otrzyma również konfigurację aplikacji, guard odrzuci ten sam lokalny cel lub ponowne użycie jej kluczy. Komunikaty błędów nie wypisują adresów ani wartości kluczy.

Nie wczytuj do testów plików środowiskowych aplikacji ani produkcyjnych sekretów. Nie usuwaj konfiguracji aplikacji tylko po to, aby obejść wykryty konflikt: przygotuj osobną bazę i klucze.

## Granice ochrony

Loopback ogranicza cel połączenia do lokalnej maszyny, lecz nie dowodzi tożsamości bazy za tym adresem. **Zakazane są tunele, przekierowania portów i lokalne proxy do produkcji lub współdzielonej bazy.** Administrator środowiska musi sprawdzić, co rzeczywiście nasłuchuje na porcie, oraz niezależność danych i kluczy. Guard nie wykonuje zapytań, nie sprawdza zawartości bazy i nie potwierdza jej izolacji.

Zgodność z konfiguracją aplikacji można wykryć tylko wtedy, gdy jest ona obecna w procesie. Różne wartości kluczy, pusta baza i samo potwierdzenie `RLS_TEST_ALLOW_DESTRUCTIVE` również nie stanowią dowodu izolacji. Zdalne testy pozostają zablokowane do czasu przygotowania odrębnego mechanizmu identyfikacji środowiska i kontroli jego dostępu.

## Uruchamianie i dowody

Zwykły Vitest wyklucza mutujące RLS i nie wczytuje plików `.env`. Hermetyczne testy guardu można uruchomić bez bazy:

```text
corepack pnpm exec vitest run tests/unit/rls-environment.test.ts
```

Dopiero po przygotowaniu i sprawdzeniu osobnej lokalnej bazy przez jej administratora oraz uzyskaniu zgody na mutujący test można użyć jawnej konfiguracji:

```text
corepack pnpm exec vitest run --config vitest.rls.config.ts
```

Ten dokument nie uruchamia ani nie zleca migracji. Do dziennika należy wpisać oddzielnie wynik hermetycznych testów guardu i wynik testu izolacji na bazie. Zielony test guardu nie potwierdza działania RLS ani zastosowania migracji na jakimkolwiek serwerze.
