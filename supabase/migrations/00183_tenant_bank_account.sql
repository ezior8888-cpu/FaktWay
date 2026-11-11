-- 00183: rachunek firmy (plan kompletnej aplikacji, krok 3.4, część 2:
-- plik przelewów z listy „Do zapłaty”).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem (addytywna: nowa kolumna NULL, CHECK na
-- nowej kolumnie, GRANT SELECT). Kod czyta kolumnę odpornie (brak kolumny =
-- brak rachunku, plik przelewów odmawia z komunikatem, co uzupełnić), ale
-- zapis rachunku w Ustawieniach wymaga kolumny.
--
-- Po co: plik przelewów Elixir-0 potrzebuje rachunku zleceniodawcy (i z niego
-- numeru rozliczeniowego banku). Firma nie miała dotąd w ustawieniach żadnego
-- rachunku. NULL = rachunek nieustawiony (stan każdej istniejącej firmy).
--
-- Format: 26 cyfr NRB bez „PL” i spacji. Liczbę kontrolną sprawdza aplikacja
-- (`normalizujRachunekFirmy`); CHECK pilnuje samego zapisu.
--
-- Uprawnienia: od 00112 rola `authenticated` czyta kolumny `tenants` tylko po
-- jawnym GRANT SELECT (AUD-103; pilnuje
-- tests/unit/dane-ksef-uprawnienia-kolumn.test.ts). Zapis idzie kluczem
-- serwisowym w `updateCompanyBankAccountAction` po sprawdzeniu roli
-- właściciela albo administratora, bez nowych uprawnień UPDATE.
--
-- Bez DROP tabel i kolumn, bez zmian istniejących wierszy.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS bank_account TEXT;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_bank_account_check;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_bank_account_check
  CHECK (bank_account IS NULL OR bank_account ~ '^[0-9]{26}$');

GRANT SELECT (bank_account) ON public.tenants TO authenticated;

COMMENT ON COLUMN public.tenants.bank_account IS
  'Rachunek firmy (NRB, 26 cyfr): rachunek zleceniodawcy w pliku przelewów z listy „Do zapłaty”. NULL = nieustawiony.';

NOTIFY pgrst, 'reload schema';
